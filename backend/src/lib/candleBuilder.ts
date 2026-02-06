/**
 * Server-side Candle Builder
 * Aggregates raw ticks into properly time-aligned OHLC candles.
 * 
 * Architecture:
 * - Listens to tick events from tickStream
 * - Builds candles for multiple timeframes (1s, 5s, 15s, 1m, 5m)
 * - Can fetch historical candles from Deriv API (ticks_history style:candles)
 * - Exposes SSE streaming for frontend consumption
 * - Provides getCandles() for backend strategy use
 */

import { performance } from 'perf_hooks';
import type { TickData } from './tickStream';
import { sendMessage } from './wsManager';
import { tickLogger } from './logger';
import { metrics } from './metrics';
import type { Response } from 'express';

// ==================== Types ====================

export interface OHLCCandle {
    /** Candle open time in epoch seconds, aligned to timeframe boundary */
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    /** Number of ticks aggregated in this candle */
    tickCount: number;
    /** Whether this candle is still forming (current period) */
    isLive: boolean;
}

export type CandleTimeframe = '1s' | '5s' | '15s' | '1m' | '5m';

export const TIMEFRAME_SECONDS: Record<CandleTimeframe, number> = {
    '1s': 1,
    '5s': 5,
    '15s': 15,
    '1m': 60,
    '5m': 300,
};

const ALL_TIMEFRAMES: CandleTimeframe[] = ['1s', '5s', '15s', '1m', '5m'];

/** Maximum number of completed candles to keep per symbol per timeframe */
const MAX_CANDLE_HISTORY = 200;

// ==================== Per-symbol Candle State ====================

interface CandleState {
    /** Completed candles (oldest first) */
    candles: OHLCCandle[];
    /** Currently forming candle */
    current: OHLCCandle | null;
}

/** Key: `${accountId}:${symbol}:${timeframe}` */
const candleStates = new Map<string, CandleState>();

/** SSE subscribers: key = `${accountId}:${symbol}` */
const sseSubscribers = new Map<string, Set<{ res: Response; timeframe: CandleTimeframe }>>();

// ==================== Key helpers ====================

function stateKey(accountId: string, symbol: string, tf: CandleTimeframe): string {
    return `${accountId}:${symbol}:${tf}`;
}

function sseKey(accountId: string, symbol: string): string {
    return `${accountId}:${symbol}`;
}

function getOrCreateState(accountId: string, symbol: string, tf: CandleTimeframe): CandleState {
    const key = stateKey(accountId, symbol, tf);
    let state = candleStates.get(key);
    if (!state) {
        state = { candles: [], current: null };
        candleStates.set(key, state);
    }
    return state;
}

/**
 * Align an epoch timestamp to the floor of the given timeframe interval.
 * e.g., epoch 1234567 with 60s → 1234560
 */
function alignTime(epoch: number, timeframeSec: number): number {
    return Math.floor(epoch / timeframeSec) * timeframeSec;
}

// ==================== Core candle ingestion ====================

/**
 * Feed a tick into the candle builder. Call this from the tick stream listener.
 * Builds candles for ALL timeframes simultaneously.
 */
export function ingestTick(accountId: string, tick: TickData): void {
    const startMs = performance.now();
    const epoch = typeof tick.epoch === 'number' ? tick.epoch : Math.floor(Date.now() / 1000);
    const quote = tick.quote;

    if (!Number.isFinite(quote)) return;

    for (const tf of ALL_TIMEFRAMES) {
        const tfSec = TIMEFRAME_SECONDS[tf];
        const candleTime = alignTime(epoch, tfSec);
        const state = getOrCreateState(accountId, tick.symbol, tf);

        if (!state.current || state.current.time !== candleTime) {
            // Close previous candle if it exists
            if (state.current) {
                state.current.isLive = false;
                state.candles.push(state.current);

                // Trim history
                if (state.candles.length > MAX_CANDLE_HISTORY) {
                    state.candles = state.candles.slice(-MAX_CANDLE_HISTORY);
                }

                // Emit completed candle to SSE subscribers
                emitCandleEvent(accountId, tick.symbol, tf, 'close', state.current);
            }

            // Open new candle
            state.current = {
                time: candleTime,
                open: quote,
                high: quote,
                low: quote,
                close: quote,
                tickCount: 1,
                isLive: true,
            };

            emitCandleEvent(accountId, tick.symbol, tf, 'open', state.current);
        } else {
            // Update current candle
            state.current.high = Math.max(state.current.high, quote);
            state.current.low = Math.min(state.current.low, quote);
            state.current.close = quote;
            state.current.tickCount++;

            // Emit update (throttled for high-frequency timeframes)
            // For 1s candles, emit every tick; for larger, emit every N ticks
            const emitEvery = tf === '1s' ? 1 : tf === '5s' ? 2 : 3;
            if (state.current.tickCount % emitEvery === 0) {
                emitCandleEvent(accountId, tick.symbol, tf, 'update', state.current);
            }
        }
    }

    metrics.histogram('candle.ingest_ms', performance.now() - startMs);
}

// ==================== Historical candle fetch ====================

/**
 * Fetch historical candles from Deriv API and seed the candle state.
 * Uses ticks_history with style: 'candles'.
 * Call this when subscribing a symbol to pre-populate chart data.
 */
export async function fetchHistoricalCandles(
    accountId: string,
    symbol: string,
    timeframe: CandleTimeframe,
    count: number = 100,
): Promise<OHLCCandle[]> {
    const tfSec = TIMEFRAME_SECONDS[timeframe];

    try {
        const response = await sendMessage<{
            candles?: Array<{
                epoch: number;
                open: number;
                high: number;
                low: number;
                close: number;
            }>;
            error?: { message: string };
        }>(accountId, {
            ticks_history: symbol,
            count,
            end: 'latest',
            style: 'candles',
            granularity: tfSec,
        }, 15000);

        if (response.error) {
            tickLogger.warn({ symbol, timeframe, error: response.error.message }, 'Historical candles fetch failed');
            return [];
        }

        if (!response.candles || response.candles.length === 0) {
            return [];
        }

        const candles: OHLCCandle[] = response.candles.map(c => ({
            time: c.epoch,
            open: typeof c.open === 'string' ? parseFloat(c.open) : c.open,
            high: typeof c.high === 'string' ? parseFloat(c.high) : c.high,
            low: typeof c.low === 'string' ? parseFloat(c.low) : c.low,
            close: typeof c.close === 'string' ? parseFloat(c.close) : c.close,
            tickCount: 0, // Unknown for historical candles
            isLive: false,
        }));

        // Seed the state
        const state = getOrCreateState(accountId, symbol, timeframe);
        // Prepend historical candles that don't overlap with existing
        const existingTimes = new Set(state.candles.map(c => c.time));
        const newCandles = candles.filter(c => !existingTimes.has(c.time));
        state.candles = [...newCandles, ...state.candles]
            .sort((a, b) => a.time - b.time)
            .slice(-MAX_CANDLE_HISTORY);

        tickLogger.info({ symbol, timeframe, count: candles.length }, 'Loaded historical candles');
        metrics.counter('candle.history_fetched');
        return candles;

    } catch (error) {
        tickLogger.warn({ symbol, timeframe, error }, 'Historical candles fetch error');
        return [];
    }
}

// ==================== Query API ====================

/**
 * Get candles for a symbol + timeframe.
 * Returns completed candles + optionally the current live candle.
 */
export function getCandles(
    accountId: string,
    symbol: string,
    timeframe: CandleTimeframe,
    includeLive: boolean = true,
): OHLCCandle[] {
    const state = candleStates.get(stateKey(accountId, symbol, timeframe));
    if (!state) return [];

    const result = [...state.candles];
    if (includeLive && state.current) {
        result.push(state.current);
    }
    return result;
}

/**
 * Get just the current forming candle (useful for real-time display).
 */
export function getCurrentCandle(
    accountId: string,
    symbol: string,
    timeframe: CandleTimeframe,
): OHLCCandle | null {
    const state = candleStates.get(stateKey(accountId, symbol, timeframe));
    return state?.current ?? null;
}

// ==================== SSE Streaming ====================

/**
 * Subscribe a response stream to candle updates for a symbol.
 * Returns an unsubscribe function.
 */
export function subscribeCandleStream(
    accountId: string,
    symbol: string,
    timeframe: CandleTimeframe,
    res: Response,
): () => void {
    const key = sseKey(accountId, symbol);
    let subscribers = sseSubscribers.get(key);
    if (!subscribers) {
        subscribers = new Set();
        sseSubscribers.set(key, subscribers);
    }

    const entry = { res, timeframe };
    subscribers.add(entry);

    // Send initial snapshot
    const candles = getCandles(accountId, symbol, timeframe, true);
    if (candles.length > 0) {
        const data = JSON.stringify({ type: 'snapshot', timeframe, candles });
        res.write(`data: ${data}\n\n`);
    }

    metrics.counter('candle.sse_subscribe');

    return () => {
        subscribers?.delete(entry);
        if (subscribers && subscribers.size === 0) {
            sseSubscribers.delete(key);
        }
        metrics.counter('candle.sse_unsubscribe');
    };
}

function emitCandleEvent(
    accountId: string,
    symbol: string,
    timeframe: CandleTimeframe,
    eventType: 'open' | 'update' | 'close',
    candle: OHLCCandle,
): void {
    const key = sseKey(accountId, symbol);
    const subscribers = sseSubscribers.get(key);
    if (!subscribers || subscribers.size === 0) return;

    const data = JSON.stringify({ type: eventType, timeframe, candle });
    const message = `data: ${data}\n\n`;

    for (const sub of subscribers) {
        // Only send events matching the subscriber's requested timeframe
        if (sub.timeframe !== timeframe) continue;
        try {
            sub.res.write(message);
        } catch {
            // Dead connection — will be cleaned on next heartbeat or unsubscribe
            subscribers.delete(sub);
        }
    }
}

// ==================== Cleanup ====================

/**
 * Clear all candle state for an account:symbol pair.
 */
export function clearCandles(accountId: string, symbol: string): void {
    for (const tf of ALL_TIMEFRAMES) {
        candleStates.delete(stateKey(accountId, symbol, tf));
    }
    // Close SSE connections
    const key = sseKey(accountId, symbol);
    const subscribers = sseSubscribers.get(key);
    if (subscribers) {
        for (const sub of subscribers) {
            try { sub.res.end(); } catch { /* ignore */ }
        }
        sseSubscribers.delete(key);
    }
}

/**
 * Clear all candle state (shutdown).
 */
export function resetCandleBuilder(): void {
    candleStates.clear();
    for (const [, subscribers] of sseSubscribers) {
        for (const sub of subscribers) {
            try { sub.res.end(); } catch { /* ignore */ }
        }
    }
    sseSubscribers.clear();
}

/**
 * Get diagnostic stats for health checks.
 */
export function getCandleBuilderStats(): {
    totalStates: number;
    totalSubscribers: number;
    symbols: string[];
} {
    const symbols = new Set<string>();
    for (const key of candleStates.keys()) {
        const parts = key.split(':');
        if (parts.length >= 3) {
            symbols.add(`${parts[0]}:${parts[1]}`);
        }
    }

    let totalSubs = 0;
    for (const subs of sseSubscribers.values()) {
        totalSubs += subs.size;
    }

    return {
        totalStates: candleStates.size,
        totalSubscribers: totalSubs,
        symbols: [...symbols],
    };
}
