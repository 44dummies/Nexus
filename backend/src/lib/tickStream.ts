/**
 * Tick Stream Manager
 * Manages tick subscriptions for active bot runs on the backend.
 * Uses persistent WebSocket connections to receive real-time tick data.
 */

import { sendMessage, sendMessageAsync, getOrCreateConnection, registerStreamingListener, unregisterStreamingListener, registerConnectionReadyListener } from './wsManager';
import { tickLogger } from './logger';

interface TickData {
    symbol: string;
    quote: number;
    epoch: number;
}

interface TickSubscription {
    symbol: string;
    accountId: string;
    subscriptionId: string | null;
    tickBuffer: number[];
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

/**
 * Create tick stream handler for WebSocket streaming messages
 */
function createTickStreamHandler(accountId: string): (accId: string, message: Record<string, unknown>) => void {
    return (_accId: string, message: Record<string, unknown>) => {
        if (message.msg_type === 'tick' && message.tick) {
            const tick = message.tick as { symbol: string; quote: number; epoch: number };
            const key = getSubscriptionKey(accountId, tick.symbol);
            const subscription = subscriptions.get(key);
            if (subscription) {
                processTick(subscription, tick);
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
        tickBuffer: [],
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
            registerStreamingListener(accountId, createTickStreamHandler(accountId));
            registeredAccounts.add(accountId);
        }

        if (!registeredReconnectListeners.has(accountId)) {
            registerConnectionReadyListener(accountId, (_accId, isReconnect) => {
                if (!isReconnect) return;
                resubscribeAccountTicks(accountId).catch((error) => {
                    tickLogger.error({ accountId, error }, 'Tick resubscribe failed');
                });
            });
            registeredReconnectListeners.add(accountId);
        }

        // Fetch tick history for warm start
        await fetchTickHistory(accountId, symbol, subscription);

        // Subscribe to live ticks
        await startTickSubscription(accountId, symbol, subscription);

    } catch (error) {
        console.error(`Failed to subscribe to ticks for ${symbol}:`, error);
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
            subscription.tickBuffer = response.history.prices.slice(-subscription.bufferSize);
            if (subscription.tickBuffer.length > 0) {
                subscription.lastTick = subscription.tickBuffer[subscription.tickBuffer.length - 1];
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
    tick: { quote: number; epoch: number; symbol: string }
): void {
    if (!subscription.isActive) return;

    const quote = typeof tick.quote === 'string' ? parseFloat(tick.quote) : tick.quote;
    if (!Number.isFinite(quote)) return;

    // Update buffer
    subscription.tickBuffer.push(quote);
    if (subscription.tickBuffer.length > subscription.bufferSize) {
        subscription.tickBuffer.shift();
    }

    subscription.lastTick = quote;
    subscription.lastEpoch = tick.epoch;

    // Notify listeners
    const tickData: TickData = {
        symbol: subscription.symbol,
        quote,
        epoch: tick.epoch,
    };

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
            console.error(`Failed to unsubscribe from ${symbol}:`, error);
        }
    }

    tickLogger.info({ symbol }, 'Unsubscribed from ticks');
}

/**
 * Get current tick buffer for a symbol
 */
export function getTickBuffer(accountId: string, symbol: string): number[] {
    const key = getSubscriptionKey(accountId, symbol);
    const subscription = subscriptions.get(key);
    return subscription?.tickBuffer.slice() || [];
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
