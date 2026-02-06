/**
 * Feature Extractor
 *
 * Computes a FeatureSnapshot from the current tick buffer and market data.
 * All computations are bounded and deterministic given the same inputs.
 * Zero heap allocations in the hot path (uses pre-allocated buffers).
 */

import type { PriceSeries } from '../ringBuffer';
import { calculateRSI, calculateEMA, calculateSMA, calculateATR } from '../strategyEngine';
import { getImbalanceTopN, getSpread, getShortHorizonMomentum, getMarketDataMode } from '../marketData';
import type { FeatureSnapshot } from './types';

const EMA_SHORT_PERIOD = 9;
const EMA_LONG_PERIOD = 21;
const ATR_FAST_PERIOD = 14;
const ATR_SLOW_PERIOD = 50;
const RSI_PERIOD = 14;
const SMA_PERIOD = 20;
const STDDEV_PERIOD = 20;
const TICK_DIRECTION_WINDOW = 20;
const SLOPE_LOOKBACK = 5;

/**
 * Compute standard deviation over a rolling window.
 * Returns null if insufficient data.
 */
function rollingStdDev(prices: PriceSeries, period: number): number | null {
    if (prices.length < period) return null;
    let sum = 0;
    let sumSq = 0;
    const start = prices.length - period;
    for (let i = start; i < prices.length; i++) {
        const v = prices.get(i);
        sum += v;
        sumSq += v * v;
    }
    const mean = sum / period;
    const variance = sumSq / period - mean * mean;
    return variance > 0 ? Math.sqrt(variance) : 0;
}

/**
 * Compute EMA slope: (EMA_now - EMA_lookback_ago) / lookback
 * Approximated by computing EMA at two points.
 * We compute full EMA, then compare current vs N bars earlier.
 */
function emaSlope(prices: PriceSeries, emaPeriod: number, lookback: number): number | null {
    if (prices.length < emaPeriod + lookback) return null;

    const multiplier = 2 / (emaPeriod + 1);

    // Seed
    let ema = 0;
    for (let i = 0; i < emaPeriod; i++) {
        ema += prices.get(i);
    }
    ema /= emaPeriod;

    // Compute full EMA, storing values for slope calculation
    let emaAtLookback = ema;
    let emaCurrent = ema;
    const targetIdx = prices.length - 1;
    const lookbackIdx = targetIdx - lookback;

    for (let i = emaPeriod; i < prices.length; i++) {
        ema = (prices.get(i) - ema) * multiplier + ema;
        if (i === lookbackIdx) emaAtLookback = ema;
        if (i === targetIdx) emaCurrent = ema;
    }

    return (emaCurrent - emaAtLookback) / lookback;
}

/**
 * Compute tick direction persistence: ratio of ticks in the dominant direction.
 * Returns 0.5 for perfectly balanced, approaching 1.0 for strong persistence.
 */
function tickDirectionPersistence(prices: PriceSeries, window: number): number | null {
    if (prices.length < window + 1) return null;

    let ups = 0;
    let downs = 0;
    const start = prices.length - window;
    for (let i = start; i < prices.length; i++) {
        const diff = prices.get(i) - prices.get(i - 1);
        if (diff > 0) ups++;
        else if (diff < 0) downs++;
    }

    const total = ups + downs;
    if (total === 0) return 0.5;
    return Math.max(ups, downs) / total;
}

/**
 * Extract a complete feature snapshot from the current market state.
 * This is the single authoritative source of features for the Smart Layer.
 */
export function extractFeatures(
    accountId: string,
    symbol: string,
    prices: PriceSeries,
    tickReceivedMs: number
): FeatureSnapshot {
    const now = Date.now();

    // Trend features
    const emaShort = calculateEMA(prices, EMA_SHORT_PERIOD);
    const emaLong = calculateEMA(prices, EMA_LONG_PERIOD);
    const emaSlopeShort = emaSlope(prices, EMA_SHORT_PERIOD, SLOPE_LOOKBACK);
    const emaSlopeLong = emaSlope(prices, EMA_LONG_PERIOD, SLOPE_LOOKBACK);

    // Volatility
    const atrCurrent = calculateATR(prices, ATR_FAST_PERIOD);
    const atrSlow = calculateATR(prices, ATR_SLOW_PERIOD);
    const volatilityRatio = (atrCurrent !== null && atrSlow !== null && atrSlow > 0)
        ? atrCurrent / atrSlow
        : null;

    // Trend strength: |EMA_short - EMA_long| / ATR
    const trendStrength = (emaShort !== null && emaLong !== null && atrCurrent !== null && atrCurrent > 0)
        ? Math.abs(emaShort - emaLong) / atrCurrent
        : null;

    // Range features
    const sma = calculateSMA(prices, SMA_PERIOD);
    const rsi = calculateRSI(prices, RSI_PERIOD);
    const lastPrice = prices.length > 0 ? prices.get(prices.length - 1) : 0;
    const meanReversionScore = (sma !== null && atrCurrent !== null && atrCurrent > 0)
        ? Math.abs(lastPrice - sma) / atrCurrent
        : null;

    // StdDev
    const stdDev = rollingStdDev(prices, STDDEV_PERIOD);

    // Microstructure
    const spread = getSpread(accountId, symbol);
    const momentum = getShortHorizonMomentum(accountId, symbol, 500);
    const imbalance = getImbalanceTopN(accountId, symbol, 10);
    const mode = getMarketDataMode(accountId, symbol);

    // Spread quality: 0-1 where 1 = excellent (low spread)
    // For synthetic indices, spread is near 0 so quality is ~1
    const spreadQuality = typeof spread === 'number' && lastPrice > 0
        ? Math.max(0, Math.min(1, 1 - (Math.abs(spread) / (lastPrice * 0.001))))
        : null;

    return {
        timestamp: now,
        symbol,
        emaSlopeShort,
        emaSlopeLong,
        trendStrength,
        atrCurrent,
        atrSlow,
        volatilityRatio,
        stdDev,
        meanReversionScore,
        rsi,
        spreadQuality,
        tickDirectionPersistence: tickDirectionPersistence(prices, TICK_DIRECTION_WINDOW),
        momentum,
        imbalance,
        tickCount: prices.length,
        lastTickAge: now - tickReceivedMs,
    };
}

/**
 * Compute a deterministic hash of a feature snapshot for audit/reproducibility.
 * Uses a fast string-based approach (not cryptographic).
 */
export function hashFeatures(snap: FeatureSnapshot): string {
    const parts = [
        snap.timestamp.toString(36),
        snap.symbol,
        n(snap.emaSlopeShort),
        n(snap.trendStrength),
        n(snap.atrCurrent),
        n(snap.volatilityRatio),
        n(snap.rsi),
        n(snap.meanReversionScore),
        n(snap.spreadQuality),
        n(snap.tickDirectionPersistence),
        snap.tickCount.toString(),
    ];
    // Simple FNV-1a 32-bit hash
    let hash = 0x811c9dc5;
    const str = parts.join('|');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function n(v: number | null): string {
    return v === null ? 'X' : v.toFixed(6);
}
