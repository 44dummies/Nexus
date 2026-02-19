/**
 * Backend Strategy Engine
 * Evaluates trading strategies on the server using the unified tick stream.
 * EVERY strategy MUST return a computed confidence score (0.0–1.0).
 * Signals without confidence are treated as 0.0 and will be blocked.
 */

import type { PriceSeries } from './ringBuffer';
import { evaluateMicrostructureSignals, type MicrostructureContext } from './microSignals';
import type { TradeSignal } from './strategyTypes';
export type { TradeSignal } from './strategyTypes';

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

export class UnknownStrategyError extends Error {
    strategyId: string;

    constructor(strategyId: string) {
        super(`Unknown strategy: ${strategyId}`);
        this.strategyId = strategyId;
    }
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
    'adapter': {
        // Adapter uses its own internal config; this is a stub for the registry
        rsiPeriod: 14,
        emaFast: 9,
        emaSlow: 21,
    },
};

// ==================== HELPERS ====================

/**
 * Compute tick direction persistence: ratio of ticks in the dominant direction.
 * Returns 0.5 for balanced, approaching 1.0 for strong persistence.
 */
function computeTickPersistence(prices: PriceSeries, window: number): number | null {
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

// ==================== STRATEGY IMPLEMENTATIONS ====================

function evaluateRsiStrategy(ctx: StrategyContext, config: StrategyConfig): StrategyEvaluation {
    const period = config.rsiPeriod ?? 14;
    const lower = config.rsiLower ?? 30; // Tightened from 32
    const upper = config.rsiUpper ?? 70; // Tightened from 68

    const rsi = calculateRSI(ctx.prices, period);
    if (rsi === null) return { signal: null, confidence: 0 };

    // EMA slope for momentum alignment
    const emaFast = calculateEMA(ctx.prices, 9);
    const emaSlow = calculateEMA(ctx.prices, 21);
    const atr = calculateATR(ctx.prices, 14);

    if (emaFast === null || emaSlow === null || atr === null || atr <= 0) {
        return { signal: null, confidence: 0 };
    }

    // Momentum check: is price actually reversing?
    const prevPrice = ctx.prevPrice;
    const priceMovingUp = prevPrice !== null && ctx.lastPrice > prevPrice;
    const priceMovingDown = prevPrice !== null && ctx.lastPrice < prevPrice;

    // EMA slope direction
    const emaTrendUp = emaFast > emaSlow;
    const emaTrendDown = emaFast < emaSlow;

    let signal: TradeSignal | null = null;
    let confidence = 0;
    const reasonCodes: string[] = [];

    if (rsi < lower) {
        // Oversold — only CALL if momentum is turning up
        if (!priceMovingUp) {
            // Price still falling — no reversal confirmation yet
            return { signal: null, confidence: 0, detail: `RSI ${rsi.toFixed(1)} oversold but no reversal` };
        }
        signal = 'CALL';
        // RSI extremity: how far below threshold (0 = at threshold, 1 = RSI near 0)
        const rsiExtremity = Math.min(1, (lower - rsi) / lower);
        // Momentum alignment: bonus if EMA supports the reversal direction
        const momentumBonus = emaTrendUp ? 0.15 : 0;
        // Trend alignment: slight bonus if with-trend (counter-trend gets penalty)
        const trendPenalty = emaTrendDown ? -0.1 : 0;

        confidence = Math.min(0.95, 0.35 + rsiExtremity * 0.35 + momentumBonus + trendPenalty);
        reasonCodes.push(`RSI:${rsi.toFixed(1)}`, `EXT:${rsiExtremity.toFixed(2)}`, 'MOM:UP');
    } else if (rsi > upper) {
        // Overbought — only PUT if momentum is turning down
        if (!priceMovingDown) {
            return { signal: null, confidence: 0, detail: `RSI ${rsi.toFixed(1)} overbought but no reversal` };
        }
        signal = 'PUT';
        const rsiExtremity = Math.min(1, (rsi - upper) / (100 - upper));
        const momentumBonus = emaTrendDown ? 0.15 : 0;
        const trendPenalty = emaTrendUp ? -0.1 : 0;

        confidence = Math.min(0.95, 0.35 + rsiExtremity * 0.35 + momentumBonus + trendPenalty);
        reasonCodes.push(`RSI:${rsi.toFixed(1)}`, `EXT:${rsiExtremity.toFixed(2)}`, 'MOM:DOWN');
    }

    if (!signal) return { signal: null, confidence: 0 };

    return {
        signal,
        confidence,
        detail: `RSI ${rsi.toFixed(1)} | conf ${confidence.toFixed(2)}`,
        reasonCodes,
    };
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

    if (emaFast === null || emaSlow === null || rsi === null || atr === null || atr <= 0) {
        return { signal: null, confidence: 0 };
    }

    const trendStrength = Math.abs(emaFast - emaSlow) / atr;
    if (trendStrength < strengthMultiplier) return { signal: null, confidence: 0 };

    // Tick direction persistence: checks if recent ticks agree with trend
    const tickDirPersistence = computeTickPersistence(ctx.prices, 15);

    const trendUp = emaFast > emaSlow && ctx.lastPrice > emaFast && rsi > rsiUpper;
    const trendDown = emaFast < emaSlow && ctx.lastPrice < emaFast && rsi < rsiLower;

    if (!trendUp && !trendDown) return { signal: null, confidence: 0 };

    const signal: TradeSignal = trendUp ? 'CALL' : 'PUT';

    // Check tick direction agrees with signal
    const tickAgrees = trendUp
        ? (tickDirPersistence !== null && tickDirPersistence > 0.55)
        : (tickDirPersistence !== null && tickDirPersistence > 0.55);

    // Confidence: trend strength × RSI alignment × direction persistence
    const strengthScore = Math.min(1, trendStrength / 2);
    const rsiScore = trendUp
        ? Math.min(1, (rsi - rsiUpper) / (100 - rsiUpper))
        : Math.min(1, (rsiLower - rsi) / rsiLower);
    const directionScore = tickAgrees ? 0.2 : 0;

    const confidence = Math.min(0.95, 0.3 + strengthScore * 0.35 + rsiScore * 0.2 + directionScore);

    return {
        signal,
        confidence,
        detail: `EMA ${emaFast.toFixed(2)} vs ${emaSlow.toFixed(2)} | str ${trendStrength.toFixed(2)} | RSI ${rsi.toFixed(1)} | conf ${confidence.toFixed(2)}`,
        reasonCodes: [`TREND:${trendStrength.toFixed(2)}`, `RSI:${rsi.toFixed(1)}`, `DIR:${tickDirPersistence?.toFixed(2) ?? 'N/A'}`],
    };
}

function evaluateBreakoutAtrStrategy(ctx: StrategyContext, config: StrategyConfig): StrategyEvaluation {
    const atrFastPeriod = config.atrFast ?? 10;
    const atrSlowPeriod = config.atrSlow ?? 30;
    const lookback = config.breakoutLookback ?? 15;
    const bufferMultiplier = config.breakoutBufferMultiplier ?? 0.1;
    const expansionMultiplier = config.breakoutExpansionMultiplier ?? 1.05;

    const atrFast = calculateATR(ctx.prices, atrFastPeriod);
    const atrSlow = calculateATR(ctx.prices, atrSlowPeriod);

    if (atrFast === null || atrSlow === null || atrSlow <= 0) return { signal: null, confidence: 0 };

    // Volume expansion check: ATR ratio must confirm real breakout, not noise
    const volExpansionRatio = atrFast / atrSlow;
    if (volExpansionRatio < 1.2) return { signal: null, confidence: 0 };

    const expanding = atrFast > atrSlow * expansionMultiplier;
    if (!expanding) return { signal: null, confidence: 0 };

    const endIdx = ctx.prices.length - 1;
    const startIdx = Math.max(0, endIdx - lookback);
    if (endIdx - startIdx < lookback) return { signal: null, confidence: 0 };

    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let i = startIdx; i < endIdx; i++) {
        const price = ctx.prices.get(i);
        if (price > high) high = price;
        if (price < low) low = price;
    }

    const range = high - low;
    if (range <= 0) return { signal: null, confidence: 0 };

    const buffer = atrFast * bufferMultiplier;

    if (ctx.lastPrice > high + buffer) {
        const breakMagnitude = (ctx.lastPrice - high) / range;
        const volScore = Math.min(1, (volExpansionRatio - 1) * 0.5);
        const confidence = Math.min(0.9, 0.3 + breakMagnitude * 0.3 + volScore * 0.25);
        return {
            signal: 'CALL',
            confidence,
            detail: `Breakout HIGH +${buffer.toFixed(2)} | ATR ${atrFast.toFixed(3)} | volX ${volExpansionRatio.toFixed(2)} | conf ${confidence.toFixed(2)}`,
            reasonCodes: [`BREAK:HIGH`, `MAG:${breakMagnitude.toFixed(3)}`, `VOLX:${volExpansionRatio.toFixed(2)}`],
        };
    }
    if (ctx.lastPrice < low - buffer) {
        const breakMagnitude = (low - ctx.lastPrice) / range;
        const volScore = Math.min(1, (volExpansionRatio - 1) * 0.5);
        const confidence = Math.min(0.9, 0.3 + breakMagnitude * 0.3 + volScore * 0.25);
        return {
            signal: 'PUT',
            confidence,
            detail: `Breakout LOW -${buffer.toFixed(2)} | ATR ${atrFast.toFixed(3)} | volX ${volExpansionRatio.toFixed(2)} | conf ${confidence.toFixed(2)}`,
            reasonCodes: [`BREAK:LOW`, `MAG:${breakMagnitude.toFixed(3)}`, `VOLX:${volExpansionRatio.toFixed(2)}`],
        };
    }

    return { signal: null, confidence: 0 };
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

    if (atrFast === null || atrSlow === null || rsi === null || sma === null || atrFast <= 0) {
        return { signal: null, confidence: 0 };
    }

    const calmMarket = atrFast < atrSlow * calmMultiplier;
    if (!calmMarket) return { signal: null, confidence: 0 };

    const distanceFromMean = Math.abs(ctx.lastPrice - sma);
    if (distanceFromMean > atrFast * meanDistanceMultiplier) return { signal: null, confidence: 0 };

    let signal: TradeSignal | null = null;
    let confidence = 0;
    const reasonCodes: string[] = [];

    if (rsi < rsiLower) {
        signal = 'CALL';
        // Bounce probability: how extreme the RSI + how close to SMA
        const rsiExtremity = Math.min(1, (rsiLower - rsi) / rsiLower);
        const proximityScore = 1 - (distanceFromMean / (atrFast * meanDistanceMultiplier));
        // Calmness: how much below the threshold
        const calmnessScore = Math.min(1, (atrSlow * calmMultiplier - atrFast) / (atrSlow * calmMultiplier));

        confidence = Math.min(0.9, 0.25 + rsiExtremity * 0.3 + proximityScore * 0.2 + calmnessScore * 0.15);
        reasonCodes.push(`RSI:${rsi.toFixed(1)}`, `PROX:${proximityScore.toFixed(2)}`, `CALM:${calmnessScore.toFixed(2)}`);
    } else if (rsi > rsiUpper) {
        signal = 'PUT';
        const rsiExtremity = Math.min(1, (rsi - rsiUpper) / (100 - rsiUpper));
        const proximityScore = 1 - (distanceFromMean / (atrFast * meanDistanceMultiplier));
        const calmnessScore = Math.min(1, (atrSlow * calmMultiplier - atrFast) / (atrSlow * calmMultiplier));

        confidence = Math.min(0.9, 0.25 + rsiExtremity * 0.3 + proximityScore * 0.2 + calmnessScore * 0.15);
        reasonCodes.push(`RSI:${rsi.toFixed(1)}`, `PROX:${proximityScore.toFixed(2)}`, `CALM:${calmnessScore.toFixed(2)}`);
    }

    if (!signal) return { signal: null, confidence: 0 };

    return {
        signal,
        confidence,
        detail: `RSI ${rsi.toFixed(1)} | calm | conf ${confidence.toFixed(2)}`,
        reasonCodes,
    };
}

function evaluateRecoveryLiteStrategy(ctx: StrategyContext, config: StrategyConfig): StrategyEvaluation {
    const rsiPeriod = config.rsiPeriod ?? 14;
    const lower = config.recoveryRsiLower ?? 30;
    const upper = config.recoveryRsiUpper ?? 70;
    const maxLossStreak = config.recoveryMaxLossStreak ?? 4;
    const stepMultiplier = config.recoveryStepMultiplier ?? 0.15;
    const maxSteps = config.recoveryMaxSteps ?? 3;

    const rsi = calculateRSI(ctx.prices, rsiPeriod);
    if (rsi === null) return { signal: null, confidence: 0 };
    if (ctx.lossStreak >= maxLossStreak) return { signal: null, confidence: 0, detail: 'Loss streak exceeded' };

    // EMA alignment check
    const emaFast = calculateEMA(ctx.prices, 9);
    const emaSlow = calculateEMA(ctx.prices, 21);
    if (emaFast === null || emaSlow === null) return { signal: null, confidence: 0 };

    let signal: TradeSignal | null = null;
    let baseConfidence = 0;
    const reasonCodes: string[] = [];

    if (rsi < lower) {
        signal = 'CALL';
        const rsiExtremity = Math.min(1, (lower - rsi) / lower);
        // EMA alignment bonus
        const emaAligned = emaFast > emaSlow ? 0.15 : 0;
        baseConfidence = 0.35 + rsiExtremity * 0.3 + emaAligned;
        reasonCodes.push(`RSI:${rsi.toFixed(1)}`, `EXT:${rsiExtremity.toFixed(2)}`);
    } else if (rsi > upper) {
        signal = 'PUT';
        const rsiExtremity = Math.min(1, (rsi - upper) / (100 - upper));
        const emaAligned = emaFast < emaSlow ? 0.15 : 0;
        baseConfidence = 0.35 + rsiExtremity * 0.3 + emaAligned;
        reasonCodes.push(`RSI:${rsi.toFixed(1)}`, `EXT:${rsiExtremity.toFixed(2)}`);
    }

    if (!signal) return { signal: null, confidence: 0 };

    // Loss streak penalty: reduce confidence per consecutive loss
    const streakPenalty = ctx.lossStreak * 0.08;
    const confidence = Math.max(0.1, Math.min(0.9, baseConfidence - streakPenalty));

    const reduction = ctx.lossStreak > 0 ? Math.min(ctx.lossStreak, maxSteps) * stepMultiplier : 0;
    const multiplier = Math.max(0.5, 1 - reduction);

    return {
        signal,
        confidence,
        detail: `RSI ${rsi.toFixed(1)} | streak ${ctx.lossStreak} | conf ${confidence.toFixed(2)}`,
        stakeMultiplier: multiplier < 1 ? multiplier : undefined,
        reasonCodes,
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
        case 'adapter':
            // Adapter is evaluated externally by SmartLayer adapterStrategy module.
            // If called here directly (non-SmartLayer path), fall back to capital-guard.
            return evaluateCapitalGuardStrategy(ctx, mergedConfig);
        default:
            throw new UnknownStrategyError(strategyId);
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
        case 'adapter':
            return Math.max(32, (mergedConfig.emaSlow ?? 21) + 2, 30);
        default:
            throw new UnknownStrategyError(strategyId);
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
        'adapter': 'Adapter (Auto)',
    };
    return names[strategyId] || 'Unknown Strategy';
}
