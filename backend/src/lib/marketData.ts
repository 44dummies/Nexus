import { metrics } from './metrics';
import { tickLogger } from './logger';
import { OrderBook } from './orderBook';
import { RingBuffer } from './ringBuffer';
import { getOrCreateConnection, registerConnectionReadyListener, registerStreamingListener, sendMessage } from './wsManager';
import { subscribeTicks } from './tickStream';
import { throttleSubscription } from './subscriptionThrottle';
import { recordOrderBook } from './marketDataRecorder';

interface OrderBookMessageLevel {
    price?: number | string;
    amount?: number | string;
    size?: number | string;
}

interface OrderBookMessage {
    msg_type?: string;
    order_book?: {
        symbol?: string;
        bids?: OrderBookMessageLevel[];
        asks?: OrderBookMessageLevel[];
    };
    subscription?: { id: string };
    error?: { message: string };
}

type MarketDataMode = 'order_book' | 'synthetic';

class SyntheticBook {
    private lastPrice: number | null = null;
    private lastDeltaAbs: number | null = null;
    private deltaBuffer: RingBuffer;
    private priceBuffer: RingBuffer;
    private timeBuffer: RingBuffer;

    constructor(depth: number) {
        this.deltaBuffer = new RingBuffer(depth);
        this.priceBuffer = new RingBuffer(depth);
        this.timeBuffer = new RingBuffer(depth);
    }

    update(price: number, tsMs: number): void {
        if (!Number.isFinite(price)) return;
        if (this.lastPrice !== null) {
            const delta = price - this.lastPrice;
            this.deltaBuffer.push(delta);
            this.lastDeltaAbs = Math.abs(delta);
        }
        this.lastPrice = price;
        this.priceBuffer.push(price);
        this.timeBuffer.push(tsMs);
    }

    getMid(): number | null {
        return this.lastPrice;
    }

    getSpread(): number | null {
        return this.lastDeltaAbs;
    }

    getImbalanceTopN(levels: number): number | null {
        const depth = Math.max(1, Math.floor(levels));
        if (this.deltaBuffer.length === 0) return null;
        const view = this.deltaBuffer.getView(depth);
        let up = 0;
        let down = 0;
        for (let i = 0; i < view.length; i++) {
            const delta = view.get(i);
            if (delta > 0) up += delta;
            if (delta < 0) down += Math.abs(delta);
        }
        const denom = up + down;
        if (denom <= 0) return null;
        return (up - down) / denom;
    }

    getMomentum(windowMs: number): number | null {
        const latestPrice = this.lastPrice;
        if (latestPrice === null || this.timeBuffer.length === 0) return null;
        const latestIdx = this.timeBuffer.length - 1;
        const latestTs = this.timeBuffer.get(latestIdx);
        const cutoff = latestTs - windowMs;
        let earliestPrice: number | null = null;

        for (let i = latestIdx; i >= 0; i--) {
            const ts = this.timeBuffer.get(i);
            if (ts < cutoff) break;
            earliestPrice = this.priceBuffer.get(i);
        }

        if (earliestPrice === null || !Number.isFinite(earliestPrice)) return null;
        if (earliestPrice === 0) return null;
        return (latestPrice - earliestPrice) / earliestPrice;
    }
}

interface SymbolMarketData {
    accountId: string;
    symbol: string;
    mode: MarketDataMode;
    orderBook: OrderBook | null;
    synthetic: SyntheticBook;
    orderBookSubscriptionId?: string;
    orderBookReady: boolean;
}

const ENABLE_ORDER_BOOK = (process.env.ENABLE_ORDER_BOOK || 'true') === 'true';
const ORDER_BOOK_DEPTH = Math.max(1, Number(process.env.ORDER_BOOK_DEPTH) || 10);
const SYNTHETIC_DEPTH = Math.max(10, Number(process.env.SYNTHETIC_DEPTH) || 100);

const marketData = new Map<string, SymbolMarketData>();
const registeredAccounts = new Set<string>();

function getKey(accountId: string, symbol: string): string {
    return `${accountId}:${symbol}`;
}

function normalizeLevels(levels: OrderBookMessageLevel[] = []) {
    return levels
        .map(level => ({
            price: Number(level.price),
            size: Number(level.amount ?? level.size ?? 0),
        }))
        .filter(level => Number.isFinite(level.price) && Number.isFinite(level.size));
}

function getOrCreateState(accountId: string, symbol: string): SymbolMarketData {
    const key = getKey(accountId, symbol);
    let state = marketData.get(key);
    if (!state) {
        state = {
            accountId,
            symbol,
            mode: 'synthetic',
            orderBook: null,
            synthetic: new SyntheticBook(SYNTHETIC_DEPTH),
            orderBookReady: false,
        };
        marketData.set(key, state);
    }
    return state;
}

async function subscribeOrderBook(accountId: string, token: string, symbol: string): Promise<void> {
    const state = getOrCreateState(accountId, symbol);
    if (!ENABLE_ORDER_BOOK) return;
    if (state.orderBookReady) return;

    try {
        await getOrCreateConnection(token, accountId);
        await throttleSubscription(accountId);
        const response = await sendOrderBookRequest(accountId, symbol);
        if (response.error) {
            metrics.counter('marketdata.orderbook_error');
            state.mode = 'synthetic';
            return;
        }
        if (response.order_book) {
            const ob = state.orderBook ?? new OrderBook(symbol);
            ob.updateFromSnapshot({
                symbol,
                bids: normalizeLevels(response.order_book.bids),
                asks: normalizeLevels(response.order_book.asks),
            });
            state.orderBook = ob;
            state.mode = 'order_book';
            state.orderBookReady = true;
        }
        if (response.subscription?.id) {
            state.orderBookSubscriptionId = response.subscription.id;
        }
    } catch {
        metrics.counter('marketdata.orderbook_error');
        state.mode = 'synthetic';
    }
}

async function sendOrderBookRequest(accountId: string, symbol: string) {
    return sendMessage<OrderBookMessage>(accountId, {
        order_book: symbol,
        subscribe: 1,
        depth: ORDER_BOOK_DEPTH,
    }, 5000);
}

function handleOrderBookMessage(accountId: string, message: Record<string, unknown>): void {
    if (message.msg_type !== 'order_book' || !message.order_book) return;
    const payload = message as OrderBookMessage;
    const symbol = payload.order_book?.symbol;
    if (!symbol) return;
    const state = getOrCreateState(accountId, symbol);
    const updateStart = Date.now();
    if (!state.orderBook) {
        state.orderBook = new OrderBook(symbol);
    }
    state.orderBook.updateFromSnapshot({
        symbol,
        bids: normalizeLevels(payload.order_book?.bids),
        asks: normalizeLevels(payload.order_book?.asks),
    });
    recordOrderBook(symbol, payload.order_book?.bids ?? [], payload.order_book?.asks ?? [], Date.now());
    state.mode = 'order_book';
    state.orderBookReady = true;
    metrics.histogram('marketdata.orderbook_update_ms', Date.now() - updateStart);
}

export async function ensureMarketData(accountId: string, token: string, symbol: string): Promise<void> {
    const state = getOrCreateState(accountId, symbol);
    if (!registeredAccounts.has(accountId)) {
        registerStreamingListener(accountId, (accId, message) => {
            handleOrderBookMessage(accId, message);
        });
        registerConnectionReadyListener(accountId, (_accId, isReconnect) => {
            if (!isReconnect) return;
            for (const entry of marketData.values()) {
                if (entry.accountId !== accountId || entry.mode !== 'order_book') continue;
                subscribeOrderBook(accountId, token, entry.symbol).catch((error) => {
                    metrics.counter('marketdata.orderbook_resubscribe_error');
                    tickLogger.error({ error, accountId, symbol: entry.symbol }, 'Order book resubscribe failed');
                });
            }
        });
        registeredAccounts.add(accountId);
    }

    await subscribeOrderBook(accountId, token, symbol);

    if (!state.orderBookReady) {
        state.mode = 'synthetic';
    }

    // Always attach a tick listener to support synthetic fallback + momentum
    if (!(state as { tickListener?: (tick: { quote: number; receivedAtMs?: number }) => void }).tickListener) {
        const tickListener = (tick: { quote: number; receivedAtMs?: number }) => {
            const start = Date.now();
            const ts = tick.receivedAtMs ?? Date.now();
            state.synthetic.update(tick.quote, ts);
            metrics.histogram('marketdata.synthetic_update_ms', Date.now() - start);
        };
        (state as { tickListener?: (tick: { quote: number; receivedAtMs?: number }) => void }).tickListener = tickListener;
        await subscribeTicks(accountId, token, symbol, tickListener);
    }
}

export function getMid(accountId: string, symbol: string): number | null {
    const state = marketData.get(getKey(accountId, symbol));
    if (!state) return null;
    if (state.mode === 'order_book' && state.orderBook) return state.orderBook.getMid();
    return state.synthetic.getMid();
}

export function getSpread(accountId: string, symbol: string): number | null {
    const state = marketData.get(getKey(accountId, symbol));
    if (!state) return null;
    if (state.mode === 'order_book' && state.orderBook) return state.orderBook.getSpread();
    return state.synthetic.getSpread();
}

export function getMicroPrice(accountId: string, symbol: string): number | null {
    const state = marketData.get(getKey(accountId, symbol));
    if (!state) return null;
    if (state.mode === 'order_book' && state.orderBook) return state.orderBook.getMicroPrice();
    return state.synthetic.getMid();
}

export function getImbalanceTopN(accountId: string, symbol: string, levels: number): number | null {
    const state = marketData.get(getKey(accountId, symbol));
    if (!state) return null;
    if (state.mode === 'order_book' && state.orderBook) return state.orderBook.getImbalanceTopN(levels);
    return state.synthetic.getImbalanceTopN(levels);
}

export function getShortHorizonMomentum(accountId: string, symbol: string, windowMs: number): number | null {
    const state = marketData.get(getKey(accountId, symbol));
    if (!state) return null;
    return state.synthetic.getMomentum(windowMs);
}

export function getMarketDataMode(accountId: string, symbol: string): MarketDataMode | null {
    const state = marketData.get(getKey(accountId, symbol));
    return state?.mode ?? null;
}
