/**
 * Rolling Performance Tracker
 *
 * Maintains per-(strategy, regime, symbol) performance metrics over a
 * sliding window of recent trades. Used by the pre-trade gate to enforce
 * minimum expected value (EV) before allowing trades.
 *
 * Key invariant: a strategy is only "viable" if its rolling win rate
 * exceeds the breakeven threshold for the observed payout rate.
 *
 * Breakeven formula for binary options:
 *   breakevenWinRate = stake / (stake + payout)
 *
 * If payout = 0.85 * stake (typical 85% payout):
 *   breakevenWinRate = 1 / (1 + 0.85) ≈ 0.5405 (54.05%)
 */

import { metrics } from './metrics';
import { riskLogger } from './logger';

// ==================== TYPES ====================

export interface TradeOutcome {
    profit: number;
    stake: number;
    payout: number;
    timestamp: number;
}

export interface PerformanceSnapshot {
    winRate: number;
    expectancy: number;
    profitFactor: number;
    sampleSize: number;
    totalPnL: number;
    avgPayout: number;
    breakevenWinRate: number;
}

// ==================== CONFIG ====================

const DEFAULT_WINDOW_SIZE = 50;
const MIN_SAMPLE_SIZE = Math.max(5, Number(process.env.EV_GATE_MIN_SAMPLES) || 20);

/** Margin above breakeven required. e.g. 0.02 means winRate must be >= breakevenWinRate + 2% */
const EV_MARGIN = Math.max(0, Number(process.env.EV_GATE_MARGIN) || 0.02);

// ==================== STATE ====================

const windows = new Map<string, TradeOutcome[]>();
const windowSize = Math.max(10, Number(process.env.EV_GATE_WINDOW_SIZE) || DEFAULT_WINDOW_SIZE);

// ==================== CORE API ====================

/**
 * Record a trade outcome for a given strategy key.
 * Key format: "strategyId:regime:symbol"
 */
export function recordOutcome(
    key: string,
    profit: number,
    stake: number,
    payout: number
): void {
    if (!Number.isFinite(profit) || !Number.isFinite(stake) || stake <= 0) {
        return;
    }

    let window = windows.get(key);
    if (!window) {
        window = [];
        windows.set(key, window);
    }

    window.push({
        profit,
        stake,
        payout: Number.isFinite(payout) && payout > 0 ? payout : 0,
        timestamp: Date.now(),
    });

    // Evict oldest if over window size
    while (window.length > windowSize) {
        window.shift();
    }

    metrics.counter('perf_tracker.outcome_recorded');
}

/**
 * Get performance snapshot for a strategy key.
 * Returns null if no data exists.
 */
export function getPerformance(key: string): PerformanceSnapshot | null {
    const window = windows.get(key);
    if (!window || window.length === 0) {
        return null;
    }

    let wins = 0;
    let losses = 0;
    let totalProfit = 0;
    let totalLoss = 0;
    let totalPnL = 0;
    let totalPayout = 0;
    let totalStake = 0;

    for (const outcome of window) {
        totalPnL += outcome.profit;
        totalPayout += outcome.payout;
        totalStake += outcome.stake;

        if (outcome.profit >= 0) {
            wins++;
            totalProfit += outcome.profit;
        } else {
            losses++;
            totalLoss += Math.abs(outcome.profit);
        }
    }

    const sampleSize = window.length;
    const winRate = sampleSize > 0 ? wins / sampleSize : 0;
    const expectancy = sampleSize > 0 ? totalPnL / sampleSize : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;
    const avgPayout = sampleSize > 0 ? totalPayout / sampleSize : 0;
    const avgStake = sampleSize > 0 ? totalStake / sampleSize : 1;

    // Breakeven win rate: stake / (stake + avgPayout)
    // For binary options: you risk `stake` to win `payout`
    const breakevenWinRate = avgPayout > 0
        ? avgStake / (avgStake + avgPayout)
        : 0.5; // Default to coin-flip if no payout data

    return {
        winRate,
        expectancy,
        profitFactor,
        sampleSize,
        totalPnL,
        avgPayout,
        breakevenWinRate,
    };
}

/**
 * Check if a strategy is viable (positive EV) in the current window.
 *
 * Returns true (allow trades) if:
 *   1. Insufficient sample size (fail-open until data exists — don't block new strategies)
 *   2. Win rate >= breakeven win rate + EV_MARGIN
 *
 * Returns false (block trades) if:
 *   Win rate is below breakeven after sufficient samples.
 */
export function isStrategyViable(
    key: string,
    minSamples: number = MIN_SAMPLE_SIZE,
    payoutRate?: number
): boolean {
    const perf = getPerformance(key);

    // No data or insufficient samples → fail-open (allow trading to collect data)
    if (!perf || perf.sampleSize < minSamples) {
        return true;
    }

    // Use provided payout rate or computed breakeven
    const breakevenWinRate = typeof payoutRate === 'number' && payoutRate > 0
        ? 1 / (1 + payoutRate)
        : perf.breakevenWinRate;

    const threshold = breakevenWinRate + EV_MARGIN;
    const viable = perf.winRate >= threshold;

    if (!viable) {
        riskLogger.warn({
            key,
            winRate: perf.winRate.toFixed(4),
            threshold: threshold.toFixed(4),
            breakevenWinRate: breakevenWinRate.toFixed(4),
            sampleSize: perf.sampleSize,
            expectancy: perf.expectancy.toFixed(4),
        }, 'Strategy blocked by EV gate — negative expected value');
        metrics.counter('perf_tracker.ev_gate_block');
    }

    return viable;
}

// ==================== ADMIN ====================

/** Get all tracked strategy keys */
export function getTrackedKeys(): string[] {
    return Array.from(windows.keys());
}

/** Clear data for a specific key */
export function clearPerformance(key: string): void {
    windows.delete(key);
}

/** Clear all tracking data (for testing) */
export function clearAllPerformance(): void {
    windows.clear();
}

/** Get current window size config */
export function getWindowSize(): number {
    return windowSize;
}
