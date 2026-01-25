/**
 * Backend Strategy Engine
 * Evaluates trading strategies on the server using the unified tick stream.
 * Ports indicator calculations from frontend with optimizations.
 */

import type { PriceSeries } from './ringBuffer';
import { evaluateMicrostructureSignals, type MicrostructureContext } from './microSignals';

// ==================== INDICATORS ====================

/**
 * Calculate RSI using rolling calculation (optimized)
 */
export function calculateRSI(prices: PriceSeries, period: number = 14): number | null {
    if (prices.length < period + 1) return null;

    let gains = 0;
    let losses = 0;

    // Initial average
    for (let i = 1; i <= period; i++) {
        const change = prices.get(prices.length - period - 1 + i) - prices.get(prices.length - period - 1 + i - 1);
        if (change > 0) {
            gains += change;
        } else {
            losses += Math.abs(change);
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

/**
 * Calculate EMA with proper seeding
 */
export function calculateEMA(prices: PriceSeries, period: number): number | null {
    if (prices.length < period) return null;

    const multiplier = 2 / (period + 1);

    // Seed with SMA
    let ema = 0;
    for (let i = 0; i < period; i++) {
        ema += prices.get(i);
    }
    ema /= period;

    // Calculate EMA from there
    for (let i = period; i < prices.length; i++) {
        ema = (prices.get(i) - ema) * multiplier + ema;
    }

    return ema;
}

/**
 * Calculate SMA
 */
export function calculateSMA(prices: PriceSeries, period: number): number | null {
    if (prices.length < period) return null;

    let sum = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        sum += prices.get(i);
    }
    return sum / period;
}

/**
 * Calculate ATR (using simplified true range for tick data)
 */
export function calculateATR(prices: PriceSeries, period: number): number | null {
    if (prices.length < period + 1) return null;

    let atr = 0;
    const startIdx = prices.length - period;

    for (let i = startIdx; i < prices.length; i++) {
        const tr = Math.abs(prices.get(i) - prices.get(i - 1));
        atr += tr;
    }

    return atr / period;
}

// ==================== STRATEGY TYPES ====================

export type TradeSignal = 'CALL' | 'PUT';

export interface StrategyConfig {
    // RSI
    rsiPeriod?: number;
    rsiLower?: number;
    rsiUpper?: number;
    // Trend Rider
    emaFast?: number;
    emaSlow?: number;
    trendStrengthMultiplier?: number;
    trendRsiLower?: number;
    trendRsiUpper?: number;
    // Breakout ATR
    atrFast?: number;
    atrSlow?: number;
    breakoutLookback?: number;
    breakoutBufferMultiplier?: number;
    breakoutExpansionMultiplier?: number;
    // Capital Guard
    smaPeriod?: number;
    capitalRsiLower?: number;
    capitalRsiUpper?: number;
    capitalCalmMultiplier?: number;
    capitalMeanDistanceMultiplier?: number;
    // Recovery Lite
    recoveryRsiLower?: number;
    recoveryRsiUpper?: number;
    recoveryMaxLossStreak?: number;
    recoveryStepMultiplier?: number;
    recoveryMaxSteps?: number;
    // Microstructure
    imbalanceLevels?: number;
    imbalanceThreshold?: number;
    spreadThreshold?: number;
    momentumWindowMs?: number;
    momentumThreshold?: number;
    minConfidence?: number;
    enableImbalance?: boolean;
    enableMomentum?: boolean;
}

export interface StrategyEvaluation {
    signal: TradeSignal | null;
    detail?: string;
    stakeMultiplier?: number;
    confidence?: number;
    reasonCodes?: string[];
}

export interface StrategyContext {
    prices: PriceSeries;
    lastPrice: number;
    prevPrice: number | null;
    lossStreak: number;
}

// ==================== DEFAULT CONFIGS ====================

export const DEFAULT_STRATEGY_CONFIGS: Record<string, StrategyConfig> = {
    rsi: {
        rsiPeriod: 14,
        rsiLower: 32,
        rsiUpper: 68,
    },
    'trend-rider': {
        emaFast: 9,
        emaSlow: 21,
        trendStrengthMultiplier: 0.4,
        rsiPeriod: 14,
        trendRsiLower: 40,
        trendRsiUpper: 60,
    },
    'breakout-atr': {
        atrFast: 10,
        atrSlow: 30,
        breakoutLookback: 15,
        breakoutBufferMultiplier: 0.1,
        breakoutExpansionMultiplier: 1.05,
    },
    'capital-guard': {
        atrFast: 10,
        atrSlow: 40,
        smaPeriod: 20,
        rsiPeriod: 14,
        capitalRsiLower: 28,
        capitalRsiUpper: 72,
        capitalCalmMultiplier: 1.0,
        capitalMeanDistanceMultiplier: 1.5,
    },
    'recovery-lite': {
        rsiPeriod: 14,
        recoveryRsiLower: 32,
        recoveryRsiUpper: 68,
        recoveryMaxLossStreak: 4,
        recoveryStepMultiplier: 0.15,
        recoveryMaxSteps: 3,
    },
    'microstructure': {
        imbalanceLevels: 10,
        imbalanceThreshold: 0.15,
        spreadThreshold: 0,
        momentumWindowMs: 500,
        momentumThreshold: 0.0005,
        minConfidence: 0.4,
        enableImbalance: true,
        enableMomentum: true,
    },
};

// ==================== STRATEGY IMPLEMENTATIONS ====================

function evaluateRsiStrategy(ctx: StrategyContext, config: StrategyConfig): StrategyEvaluation {
    const period = config.rsiPeriod ?? 14;
    const lower = config.rsiLower ?? 32;
    const upper = config.rsiUpper ?? 68;

    const rsi = calculateRSI(ctx.prices, period);
    if (rsi === null) return { signal: null };

    if (rsi < lower) return { signal: 'CALL', detail: `RSI ${rsi.toFixed(1)}` };
    if (rsi > upper) return { signal: 'PUT', detail: `RSI ${rsi.toFixed(1)}` };

    return { signal: null };
}

function evaluateTrendRiderStrategy(ctx: StrategyContext, config: StrategyConfig): StrategyEvaluation {
    const emaFastPeriod = config.emaFast ?? 9;
    const emaSlowPeriod = config.emaSlow ?? 21;
    const rsiPeriod = config.rsiPeriod ?? 14;
    const strengthMultiplier = config.trendStrengthMultiplier ?? 0.4;
    const rsiLower = config.trendRsiLower ?? 40;
    const rsiUpper = config.trendRsiUpper ?? 60;

    const emaFast = calculateEMA(ctx.prices, emaFastPeriod);
    const emaSlow = calculateEMA(ctx.prices, emaSlowPeriod);
    const atr = calculateATR(ctx.prices, Math.max(emaSlowPeriod, 14));
    const rsi = calculateRSI(ctx.prices, rsiPeriod);

    if (emaFast === null || emaSlow === null || rsi === null || atr === null) {
        return { signal: null };
    }

    const trendStrength = Math.abs(emaFast - emaSlow);
    if (trendStrength < atr * strengthMultiplier) return { signal: null };

    const trendUp = emaFast > emaSlow && ctx.lastPrice > emaFast && rsi > rsiUpper;
    const trendDown = emaFast < emaSlow && ctx.lastPrice < emaFast && rsi < rsiLower;

    if (trendUp) {
        return { signal: 'CALL', detail: `EMA ${emaFast.toFixed(2)} > ${emaSlow.toFixed(2)} | RSI ${rsi.toFixed(1)}` };
    }
    if (trendDown) {
        return { signal: 'PUT', detail: `EMA ${emaFast.toFixed(2)} < ${emaSlow.toFixed(2)} | RSI ${rsi.toFixed(1)}` };
    }

    return { signal: null };
}

function evaluateBreakoutAtrStrategy(ctx: StrategyContext, config: StrategyConfig): StrategyEvaluation {
    const atrFastPeriod = config.atrFast ?? 10;
    const atrSlowPeriod = config.atrSlow ?? 30;
    const lookback = config.breakoutLookback ?? 15;
    const bufferMultiplier = config.breakoutBufferMultiplier ?? 0.1;
    const expansionMultiplier = config.breakoutExpansionMultiplier ?? 1.05;

    const atrFast = calculateATR(ctx.prices, atrFastPeriod);
    const atrSlow = calculateATR(ctx.prices, atrSlowPeriod);

    if (atrFast === null || atrSlow === null) return { signal: null };

    const expanding = atrFast > atrSlow * expansionMultiplier;
    if (!expanding) return { signal: null };

    // Get recent high/low excluding current price
    const endIdx = ctx.prices.length - 1;
    const startIdx = Math.max(0, endIdx - lookback);
    if (endIdx - startIdx < lookback) return { signal: null };

    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let i = startIdx; i < endIdx; i++) {
        const price = ctx.prices.get(i);
        if (price > high) high = price;
        if (price < low) low = price;
    }

    const buffer = atrFast * bufferMultiplier;

    if (ctx.lastPrice > high + buffer) {
        return { signal: 'CALL', detail: `Breakout +${buffer.toFixed(2)} | ATR ${atrFast.toFixed(3)}` };
    }
    if (ctx.lastPrice < low - buffer) {
        return { signal: 'PUT', detail: `Breakout -${buffer.toFixed(2)} | ATR ${atrFast.toFixed(3)}` };
    }

    return { signal: null };
}

function evaluateCapitalGuardStrategy(ctx: StrategyContext, config: StrategyConfig): StrategyEvaluation {
    const atrFastPeriod = config.atrFast ?? 10;
    const atrSlowPeriod = config.atrSlow ?? 40;
    const rsiPeriod = config.rsiPeriod ?? 14;
    const smaPeriod = config.smaPeriod ?? 20;
    const rsiLower = config.capitalRsiLower ?? 28;
    const rsiUpper = config.capitalRsiUpper ?? 72;
    const calmMultiplier = config.capitalCalmMultiplier ?? 1.0;
    const meanDistanceMultiplier = config.capitalMeanDistanceMultiplier ?? 1.5;

    const atrFast = calculateATR(ctx.prices, atrFastPeriod);
    const atrSlow = calculateATR(ctx.prices, atrSlowPeriod);
    const rsi = calculateRSI(ctx.prices, rsiPeriod);
    const sma = calculateSMA(ctx.prices, smaPeriod);

    if (atrFast === null || atrSlow === null || rsi === null || sma === null) {
        return { signal: null };
    }

    const calmMarket = atrFast < atrSlow * calmMultiplier;
    if (!calmMarket) return { signal: null };

    const distanceFromMean = Math.abs(ctx.lastPrice - sma);
    if (distanceFromMean > atrFast * meanDistanceMultiplier) return { signal: null };

    if (rsi < rsiLower) return { signal: 'CALL', detail: `RSI ${rsi.toFixed(1)} | calm` };
    if (rsi > rsiUpper) return { signal: 'PUT', detail: `RSI ${rsi.toFixed(1)} | calm` };

    return { signal: null };
}

function evaluateRecoveryLiteStrategy(ctx: StrategyContext, config: StrategyConfig): StrategyEvaluation {
    const rsiPeriod = config.rsiPeriod ?? 14;
    const lower = config.recoveryRsiLower ?? 32;
    const upper = config.recoveryRsiUpper ?? 68;
    const maxLossStreak = config.recoveryMaxLossStreak ?? 4;
    const stepMultiplier = config.recoveryStepMultiplier ?? 0.15;
    const maxSteps = config.recoveryMaxSteps ?? 3;

    const rsi = calculateRSI(ctx.prices, rsiPeriod);
    if (rsi === null) return { signal: null };
    if (ctx.lossStreak >= maxLossStreak) return { signal: null };

    let signal: TradeSignal | null = null;
    if (rsi < lower) signal = 'CALL';
    if (rsi > upper) signal = 'PUT';
    if (!signal) return { signal: null };

    const reduction = ctx.lossStreak > 0 ? Math.min(ctx.lossStreak, maxSteps) * stepMultiplier : 0;
    const multiplier = Math.max(0.5, 1 - reduction);

    return {
        signal,
        detail: `RSI ${rsi.toFixed(1)} | streak ${ctx.lossStreak}`,
        stakeMultiplier: multiplier < 1 ? multiplier : undefined,
    };
}

function evaluateMicrostructureStrategy(
    ctx: StrategyContext,
    config: StrategyConfig,
    microContext?: MicrostructureContext
): StrategyEvaluation {
    if (!microContext) return { signal: null };
    const result = evaluateMicrostructureSignals(microContext, config);
    return {
        signal: result.signal,
        detail: result.detail,
        confidence: result.confidence,
        reasonCodes: result.reasonCodes,
    };
}

// ==================== MAIN STRATEGY EVALUATOR ====================

/**
 * Evaluate a strategy given the current tick buffer
 */
export function evaluateStrategy(
    strategyId: string,
    prices: PriceSeries,
    config?: StrategyConfig,
    lossStreak: number = 0,
    microContext?: MicrostructureContext
): StrategyEvaluation {
    if (prices.length < 2) return { signal: null };

    const lastPrice = prices.get(prices.length - 1);
    if (!Number.isFinite(lastPrice)) return { signal: null };

    const ctx: StrategyContext = {
        prices,
        lastPrice,
        prevPrice: prices.length > 1 ? prices.get(prices.length - 2) : null,
        lossStreak,
    };

    const mergedConfig = {
        ...DEFAULT_STRATEGY_CONFIGS[strategyId],
        ...config,
    };

    switch (strategyId) {
        case 'rsi':
            return evaluateRsiStrategy(ctx, mergedConfig);
        case 'trend-rider':
            return evaluateTrendRiderStrategy(ctx, mergedConfig);
        case 'breakout-atr':
            return evaluateBreakoutAtrStrategy(ctx, mergedConfig);
        case 'capital-guard':
            return evaluateCapitalGuardStrategy(ctx, mergedConfig);
        case 'recovery-lite':
            return evaluateRecoveryLiteStrategy(ctx, mergedConfig);
        case 'microstructure':
            return evaluateMicrostructureStrategy(ctx, mergedConfig, microContext);
        default:
            return evaluateRsiStrategy(ctx, mergedConfig);
    }
}

/**
 * Get minimum required ticks for a strategy
 */
export function getRequiredTicks(strategyId: string, config?: StrategyConfig): number {
    const mergedConfig = {
        ...DEFAULT_STRATEGY_CONFIGS[strategyId],
        ...config,
    };

    switch (strategyId) {
        case 'rsi':
            return Math.max(5, (mergedConfig.rsiPeriod ?? 14) + 1);
        case 'trend-rider':
            return Math.max((mergedConfig.emaSlow ?? 21) + 2, (mergedConfig.rsiPeriod ?? 14) + 2, 20);
        case 'breakout-atr':
            return Math.max((mergedConfig.atrSlow ?? 30) + 2, (mergedConfig.breakoutLookback ?? 15) + 2, 30);
        case 'capital-guard':
            return Math.max(
                (mergedConfig.atrSlow ?? 40) + 2,
                (mergedConfig.smaPeriod ?? 20) + 2,
                (mergedConfig.rsiPeriod ?? 14) + 2,
                30
            );
        case 'recovery-lite':
            return Math.max(5, (mergedConfig.rsiPeriod ?? 14) + 1);
        case 'microstructure':
            return Math.max(5, (mergedConfig.imbalanceLevels ?? 10) + 1);
        default:
            return 15;
    }
}

/**
 * Get strategy name
 */
export function getStrategyName(strategyId: string): string {
    const names: Record<string, string> = {
        'rsi': 'Mean Reversion RSI',
        'trend-rider': 'Trend Rider',
        'breakout-atr': 'Breakout ATR',
        'capital-guard': 'Capital Guard',
        'recovery-lite': 'Recovery Lite',
        'microstructure': 'Microstructure',
    };
    return names[strategyId] || 'Unknown Strategy';
}
