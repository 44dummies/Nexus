/**
 * Tick Stream Manager
 * Manages tick subscriptions for active bot runs on the backend.
 * Uses persistent WebSocket connections to receive real-time tick data.
 */

import { performance } from 'perf_hooks';
import { sendMessage, sendMessageAsync, getOrCreateConnection, registerStreamingListener, unregisterStreamingListener, registerConnectionReadyListener, unregisterConnectionReadyListener } from './wsManager';
import { tickLogger } from './logger';
import { metrics } from './metrics';
import { RingBuffer, type PriceSeries } from './ringBuffer';
import { throttleSubscription } from './subscriptionThrottle';
import { recordTick } from './marketDataRecorder';

export interface TickData {
    symbol: string;
    quote: number;
    epoch: number;
    receivedAtMs?: number;
    receivedPerfMs?: number;
}

interface TickSubscription {
    symbol: string;
    accountId: string;
    subscriptionId: string | null;
    tickBuffer: RingBuffer;
    bufferSize: number;
    lastTick: number | null;
    lastEpoch: number | null;
    listeners: Set<(tick: TickData) => void>;
    isActive: boolean;
}

const TICK_BUFFER_SIZE = 100;
const TICKS_HISTORY_COUNT = 50;

// Global subscriptions: key = `${accountId}:${symbol}`
const subscriptions = new Map<string, TickSubscription>();

// Track which accounts have streaming listeners registered
const registeredAccounts = new Set<string>();
const registeredReconnectListeners = new Set<string>();

// Store listener references for cleanup
const accountListeners = new Map<string, (accountId: string, message: { msg_type?: string; tick?: { symbol: string; quote: number; epoch: number } }) => void>();
const reconnectListenerRefs = new Map<string, (accountId: string, isReconnect: boolean) => void>();

/**
 * Create tick stream handler for WebSocket streaming messages
 */
function createTickStreamHandler(accountId: string): (accId: string, message: Record<string, unknown>) => void {
    return (_accId: string, message: Record<string, unknown>) => {
        if (message.msg_type === 'tick' && message.tick) {
            const tick = message.tick as { symbol: string; quote: number; epoch: number };
            const recvPerfTs = typeof (message as { __recvPerfTs?: number }).__recvPerfTs === 'number'
                ? (message as { __recvPerfTs?: number }).__recvPerfTs
                : undefined;
            const recvWallTs = typeof (message as { __recvWallTs?: number }).__recvWallTs === 'number'
                ? (message as { __recvWallTs?: number }).__recvWallTs
                : undefined;
            const key = getSubscriptionKey(accountId, tick.symbol);
            const subscription = subscriptions.get(key);
            if (subscription) {
                processTick(subscription, tick, recvPerfTs, recvWallTs);
            }
        }
    };
}

/**
 * Get subscription key
 */
function getSubscriptionKey(accountId: string, symbol: string): string {
    return `${accountId}:${symbol}`;
}


/**
 * Subscribe to tick stream for a symbol
 */
export async function subscribeTicks(
    accountId: string,
    token: string,
    symbol: string,
    onTick: (tick: TickData) => void
): Promise<void> {
    const key = getSubscriptionKey(accountId, symbol);

    // Check if already subscribed
    let subscription = subscriptions.get(key);

    if (subscription) {
        subscription.listeners.add(onTick);
        // If we already have ticks, immediately provide them to the new listener
        if (subscription.lastTick !== null) {
            onTick({
                symbol,
                quote: subscription.lastTick,
                epoch: subscription.lastEpoch || Date.now() / 1000,
            });
        }
        return;
    }

    // Create new subscription
    subscription = {
        symbol,
        accountId,
        subscriptionId: null,
        tickBuffer: new RingBuffer(TICK_BUFFER_SIZE),
        bufferSize: TICK_BUFFER_SIZE,
        lastTick: null,
        lastEpoch: null,
        listeners: new Set([onTick]),
        isActive: true,
    };
    subscriptions.set(key, subscription);

    try {
        // Ensure connection exists
        await getOrCreateConnection(token, accountId);

        // Register streaming listener for this account if not already registered
        if (!registeredAccounts.has(accountId)) {
            const listener = createTickStreamHandler(accountId);
            registerStreamingListener(accountId, listener);
            accountListeners.set(accountId, listener);
            registeredAccounts.add(accountId);
        }

        if (!registeredReconnectListeners.has(accountId)) {
            const reconnectListener = (_accId: string, isReconnect: boolean) => {
                if (!isReconnect) return;
                resubscribeAccountTicks(accountId).catch((error) => {
                    tickLogger.error({ accountId, error }, 'Tick resubscribe failed');
                });
            };
            registerConnectionReadyListener(accountId, reconnectListener);
            reconnectListenerRefs.set(accountId, reconnectListener);
            registeredReconnectListeners.add(accountId);
        }

        // Fetch tick history for warm start
        await fetchTickHistory(accountId, symbol, subscription);

        // Subscribe to live ticks
        await startTickSubscription(accountId, symbol, subscription);

    } catch (error) {
        tickLogger.error({ symbol, error }, 'Failed to subscribe to ticks');
        subscription.isActive = false;
        throw error;
    }
}

export async function resubscribeAccountTicks(accountId: string): Promise<void> {
    const resubscribeTasks: Promise<void>[] = [];

    for (const [key, subscription] of subscriptions.entries()) {
        if (!key.startsWith(`${accountId}:`)) continue;
        if (!subscription.isActive) continue;
        resubscribeTasks.push(
            startTickSubscription(accountId, subscription.symbol, subscription).catch((error) => {
                tickLogger.error({ accountId, symbol: subscription.symbol, error }, 'Tick resubscribe error');
            })
        );
    }

    if (resubscribeTasks.length > 0) {
        await Promise.all(resubscribeTasks);
    }
}

/**
 * Fetch tick history for warm start
 */
async function fetchTickHistory(
    accountId: string,
    symbol: string,
    subscription: TickSubscription
): Promise<void> {
    try {
        const response = await sendMessage<{
            history?: {
                prices: number[];
                times: number[];
            };
            error?: { message: string };
        }>(accountId, {
            ticks_history: symbol,
            count: TICKS_HISTORY_COUNT,
            end: 'latest',
            style: 'ticks',
        }, 10000);

        if (response.error) {
            console.warn(`Tick history fetch failed for ${symbol}:`, response.error.message);
            return;
        }

        if (response.history?.prices) {
            const recent = response.history.prices.slice(-subscription.bufferSize);
            for (const price of recent) {
                if (Number.isFinite(price)) {
                    subscription.tickBuffer.push(price);
                }
            }
            if (subscription.tickBuffer.length > 0) {
                subscription.lastTick = subscription.tickBuffer.getLatest();
                if (response.history.times && response.history.times.length > 0) {
                    subscription.lastEpoch = response.history.times[response.history.times.length - 1];
                }
            }
            tickLogger.info({ symbol, count: subscription.tickBuffer.length }, 'Loaded historical ticks');
        }
    } catch (error) {
        tickLogger.warn({ symbol, error }, 'Tick history fetch error');
    }
}

/**
 * Start live tick subscription
 */
async function startTickSubscription(
    accountId: string,
    symbol: string,
    subscription: TickSubscription
): Promise<void> {
    await throttleSubscription(accountId);
    const response = await sendMessage<{
        tick?: {
            id: string;
            quote: number;
            epoch: number;
            symbol: string;
        };
        subscription?: { id: string };
        error?: { message: string };
    }>(accountId, {
        ticks: symbol,
        subscribe: 1,
    }, 10000);

    if (response.error) {
        throw new Error(response.error.message);
    }

    if (response.subscription?.id) {
        subscription.subscriptionId = response.subscription.id;
    }

    // Process initial tick if present
    if (response.tick) {
        processTick(subscription, response.tick);
    }

    tickLogger.info({ symbol, subscriptionId: subscription.subscriptionId }, 'Subscribed to live ticks');
}

/**
 * Process incoming tick and notify listeners
 */
function processTick(
    subscription: TickSubscription,
    tick: { quote: number; epoch: number; symbol: string },
    recvPerfTs?: number,
    recvWallTs?: number
): void {
    if (!subscription.isActive) return;

    const quote = typeof tick.quote === 'string' ? parseFloat(tick.quote) : tick.quote;
    if (!Number.isFinite(quote)) return;
    if (!Number.isFinite(tick.epoch)) return;

    if (typeof subscription.lastEpoch === 'number') {
        if (tick.epoch <= subscription.lastEpoch) {
            metrics.counter('tick.out_of_order_drop');
            return;
        }
        if (tick.epoch > subscription.lastEpoch + 1) {
            metrics.counter('tick.seq_gap');
            tickLogger.warn({
                accountId: subscription.accountId,
                symbol: subscription.symbol,
                previousEpoch: subscription.lastEpoch,
                incomingEpoch: tick.epoch,
            }, 'SEQ_GAP detected in tick stream');
        }
    }

    metrics.counter('tick.received');
    const bufferStart = performance.now();
    // Update buffer
    subscription.tickBuffer.push(quote);
    const bufferEnd = performance.now();
    metrics.histogram('tick.buffer_op_ms', bufferEnd - bufferStart);
    if (typeof recvPerfTs === 'number') {
        metrics.histogram('tick.recv_to_buffer_ms', bufferStart - recvPerfTs);
    }

    subscription.lastTick = quote;
    subscription.lastEpoch = tick.epoch;

    // Notify listeners
    const tickData: TickData = {
        symbol: subscription.symbol,
        quote,
        epoch: tick.epoch,
        receivedAtMs: recvWallTs ?? Date.now(),
        receivedPerfMs: recvPerfTs ?? bufferStart,
    };
    recordTick(subscription.symbol, quote, tickData.receivedAtMs ?? Date.now());

    for (const listener of subscription.listeners) {
        try {
            listener(tickData);
        } catch (error) {
            tickLogger.error({ error }, 'Tick listener error');
        }
    }
}

/**
 * Handle incoming tick message from WebSocket
 * Call this from the WS message handler
 */
export function handleTickMessage(
    accountId: string,
    message: { msg_type?: string; tick?: { symbol: string; quote: number; epoch: number } }
): void {
    if (message.msg_type !== 'tick' || !message.tick) return;

    const key = getSubscriptionKey(accountId, message.tick.symbol);
    const subscription = subscriptions.get(key);

    if (subscription) {
        processTick(subscription, message.tick);
    }
}

/**
 * Unsubscribe a listener from tick stream
 */
export function unsubscribeTicks(
    accountId: string,
    symbol: string,
    onTick: (tick: TickData) => void
): void {
    const key = getSubscriptionKey(accountId, symbol);
    const subscription = subscriptions.get(key);

    if (!subscription) return;

    subscription.listeners.delete(onTick);

    // If no more listeners, unsubscribe from stream
    if (subscription.listeners.size === 0) {
        unsubscribeTickStream(accountId, symbol, subscription);
    }
}

/**
 * Fully unsubscribe from tick stream
 */
async function unsubscribeTickStream(
    accountId: string,
    symbol: string,
    subscription: TickSubscription
): Promise<void> {
    subscription.isActive = false;
    subscriptions.delete(getSubscriptionKey(accountId, symbol));

    if (subscription.subscriptionId) {
        try {
            sendMessageAsync(accountId, {
                forget: subscription.subscriptionId,
            });
        } catch (error) {
            tickLogger.error({ symbol, error }, 'Failed to unsubscribe from ticks');
        }
    }

    tickLogger.info({ symbol }, 'Unsubscribed from ticks');

    // Check if any subscriptions remain for this account
    let hasRemainingSubscriptions = false;
    for (const key of subscriptions.keys()) {
        if (key.startsWith(`${accountId}:`)) {
            hasRemainingSubscriptions = true;
            break;
        }
    }

    // If no subscriptions remain, cleanup listeners
    if (!hasRemainingSubscriptions) {
        // Cleanup tick listener
        const tickListener = accountListeners.get(accountId);
        if (tickListener) {
            unregisterStreamingListener(accountId, tickListener);
            accountListeners.delete(accountId);
            registeredAccounts.delete(accountId);
        }

        // Cleanup reconnect listener
        const reconnectListener = reconnectListenerRefs.get(accountId);
        if (reconnectListener) {
            unregisterConnectionReadyListener(accountId, reconnectListener);
            reconnectListenerRefs.delete(accountId);
            registeredReconnectListeners.delete(accountId);
        }
    }
}

/**
 * Get current tick buffer for a symbol
 */
export function getTickBuffer(accountId: string, symbol: string): number[] {
    const key = getSubscriptionKey(accountId, symbol);
    const subscription = subscriptions.get(key);
    const sliceStart = performance.now();
    const buffer = subscription?.tickBuffer.toArray() || [];
    const sliceEnd = performance.now();
    metrics.histogram('tick.buffer_slice_ms', sliceEnd - sliceStart);
    return buffer;
}

/**
 * Get a window view into the ring buffer without copying.
 */
export function getTickWindowView(accountId: string, symbol: string, length?: number): PriceSeries | null {
    const key = getSubscriptionKey(accountId, symbol);
    const subscription = subscriptions.get(key);
    if (!subscription) return null;
    const windowSize = typeof length === 'number' ? length : subscription.tickBuffer.length;
    return subscription.tickBuffer.getView(windowSize);
}

/**
 * Get last tick for a symbol
 */
export function getLastTick(accountId: string, symbol: string): number | null {
    const key = getSubscriptionKey(accountId, symbol);
    const subscription = subscriptions.get(key);
    return subscription?.lastTick ?? null;
}

/**
 * Check if subscribed to a symbol
 */
export function isSubscribed(accountId: string, symbol: string): boolean {
    const key = getSubscriptionKey(accountId, symbol);
    return subscriptions.has(key);
}

/**
 * Get all active subscriptions for an account
 */
export function getActiveSubscriptions(accountId: string): string[] {
    const symbols: string[] = [];
    for (const [key, subscription] of subscriptions.entries()) {
        if (key.startsWith(`${accountId}:`) && subscription.isActive) {
            symbols.push(subscription.symbol);
        }
    }
    return symbols;
}

/**
 * Unsubscribe all for an account
 */
export function unsubscribeAll(accountId: string): void {
    for (const [key, subscription] of subscriptions.entries()) {
        if (key.startsWith(`${accountId}:`)) {
            subscription.isActive = false;
            subscription.listeners.clear();
            if (subscription.subscriptionId) {
                sendMessageAsync(accountId, {
                    forget: subscription.subscriptionId,
                });
            }
            subscriptions.delete(key);
        }
    }
    tickLogger.info({ accountId }, 'Unsubscribed all ticks');
}

export const __test = {
    createSubscription(accountId: string, symbol: string): void {
        const key = getSubscriptionKey(accountId, symbol);
        subscriptions.set(key, {
            symbol,
            accountId,
            subscriptionId: null,
            tickBuffer: new RingBuffer(TICK_BUFFER_SIZE),
            bufferSize: TICK_BUFFER_SIZE,
            lastTick: null,
            lastEpoch: null,
            listeners: new Set(),
            isActive: true,
        });
    },
    processTick(accountId: string, symbol: string, tick: { quote: number; epoch: number; symbol?: string }): void {
        const key = getSubscriptionKey(accountId, symbol);
        const subscription = subscriptions.get(key);
        if (!subscription) {
            throw new Error(`No test subscription for ${key}`);
        }
        processTick(subscription, {
            symbol,
            quote: tick.quote,
            epoch: tick.epoch,
        });
    },
    getSnapshot(accountId: string, symbol: string): { lastEpoch: number | null; lastTick: number | null; history: number[] } | null {
        const key = getSubscriptionKey(accountId, symbol);
        const subscription = subscriptions.get(key);
        if (!subscription) return null;
        return {
            lastEpoch: subscription.lastEpoch,
            lastTick: subscription.lastTick,
            history: subscription.tickBuffer.toArray(),
        };
    },
    clear(): void {
        subscriptions.clear();
        registeredAccounts.clear();
        registeredReconnectListeners.clear();
        accountListeners.clear();
        reconnectListenerRefs.clear();
    },
};
