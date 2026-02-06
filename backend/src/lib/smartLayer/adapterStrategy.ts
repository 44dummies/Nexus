/**
 * Adapter SmartLayer Strategy
 *
 * A meta-strategy that performs regime detection → strategy routing → risk gating
 * to dynamically select the best sub-strategy per tick cycle.
 *
 * Sub-strategies:
 *   ADAPTER_TREND_PULLBACK  — Trend pullback-to-EMA entries
 *   ADAPTER_MEAN_REVERSION  — Zscore band fading at extremes
 *   ADAPTER_BREAKOUT_GUARD  — Range breakout with strict confidence
 *   ADAPTER_SAFE_MODE       — No trade, halt, escalate cooldown
 *
 * Regime features are computed incrementally (O(1) per tick via EWMA).
 * Hysteresis prevents regime flip-flop between cycles.
 */

import type { PriceSeries } from '../ringBuffer';
import type { TradeSignal, StrategyEvaluation } from '../strategyEngine';
import { calculateEMA, calculateATR, calculateRSI, calculateSMA } from '../strategyEngine';

// ==================== TYPES ====================

export type AdapterRegime = 'TREND' | 'RANGE' | 'HIGH_VOL' | 'BAD_LIQUIDITY' | 'UNCERTAIN';

export type AdapterSubStrategy =
    | 'ADAPTER_TREND_PULLBACK'
    | 'ADAPTER_MEAN_REVERSION'
    | 'ADAPTER_BREAKOUT_GUARD'
    | 'ADAPTER_SAFE_MODE';

export interface AdapterFeatures {
    /** EWMA fast volatility (log returns) */
    volFast: number | null;
    /** EWMA slow volatility (log returns) */
    volSlow: number | null;
    /** EMA fast - EMA slow slope persistence */
    trendSlope: number | null;
    /** Absolute trend strength */
    trendStrength: number | null;
    /** Chop score: sign-change density of short returns */
    chopScore: number | null;
    /** Spread % from order book or fallback */
    spreadPct: number | null;
    /** Current RSI */
    rsi: number | null;
    /** Mean distance from SMA */
    meanDistance: number | null;
    /** Last tick age in ms */
    tickAge: number;
}

export interface AdapterDecision {
    regime: AdapterRegime;
    regimeConfidence: number;
    subStrategy: AdapterSubStrategy;
    signal: TradeSignal | null;
    confidence: number;
    reasonCodes: string[];
    cooldownMs: number;
    featuresSnapshot: AdapterFeatures;
}

export interface AdapterConfig {
    /** EWMA fast period for volatility */
    volFastPeriod: number;
    /** EWMA slow period for volatility */
    volSlowPeriod: number;
    /** EMA fast period for trend */
    emaFast: number;
    /** EMA slow period for trend */
    emaSlow: number;
    /** Chop score lookback */
    chopLookback: number;
    /** RSI period */
    rsiPeriod: number;
    /** SMA period for mean reversion */
    smaPeriod: number;
    /** Minimum ticks before producing a signal */
    minTicks: number;
    /** Stale tick threshold ms */
    staleTickMs: number;
    /** Hysteresis: cycles before regime switch */
    hysteresisCycles: number;
    /** Trend strength threshold to classify TREND */
    trendThreshold: number;
    /** Volatility ratio threshold for HIGH_VOL */
    highVolThreshold: number;
    /** Chop score threshold for RANGE */
    chopThresholdRange: number;
    /** Spread % threshold for BAD_LIQUIDITY */
    spreadThreshold: number;
    /** Confidence floor for trend pullback signal */
    trendPullbackConfidence: number;
    /** Confidence floor for mean reversion signal */
    meanRevConfidence: number;
    /** Confidence floor for breakout signal */
    breakoutConfidence: number;
    /** Breakout lookback for N-second range */
    breakoutLookback: number;
    /** Pullback proximity factor (% of ATR for pullback distance) */
    pullbackProximity: number;
    /** Mean reversion zscore threshold */
    zscoreThreshold: number;
    /** Base cooldown per sub-strategy */
    baseCooldownMs: Record<AdapterSubStrategy, number>;
}

export const DEFAULT_ADAPTER_CONFIG: AdapterConfig = {
    volFastPeriod: 10,
    volSlowPeriod: 30,
    emaFast: 9,
    emaSlow: 21,
    chopLookback: 20,
    rsiPeriod: 14,
    smaPeriod: 20,
    minTicks: 30,
    staleTickMs: 10_000,
    hysteresisCycles: 4,
    trendThreshold: 0.7,
    highVolThreshold: 2.0,
    chopThresholdRange: 0.55,
    spreadThreshold: 0.005,
    trendPullbackConfidence: 0.5,
    meanRevConfidence: 0.45,
    breakoutConfidence: 0.6,
    breakoutLookback: 15,
    pullbackProximity: 1.2,
    zscoreThreshold: 1.8,
    baseCooldownMs: {
        ADAPTER_TREND_PULLBACK: 3000,
        ADAPTER_MEAN_REVERSION: 5000,
        ADAPTER_BREAKOUT_GUARD: 10000,
        ADAPTER_SAFE_MODE: 30000,
    },
};

// ==================== REGIME STATE ====================

interface AdapterRegimeState {
    current: AdapterRegime;
    stableCycles: number;
    pendingRegime: AdapterRegime | null;
    pendingCycles: number;
}

const regimeStates = new Map<string, AdapterRegimeState>();

function getKey(accountId: string, symbol: string): string {
    return `${accountId}:${symbol}`;
}

function getOrCreateRegimeState(key: string): AdapterRegimeState {
    let state = regimeStates.get(key);
    if (!state) {
        state = {
            current: 'UNCERTAIN',
            stableCycles: 0,
            pendingRegime: null,
            pendingCycles: 0,
        };
        regimeStates.set(key, state);
    }
    return state;
}

// ==================== FEATURE EXTRACTION ====================

/**
 * Compute EWMA of squared log returns (volatility proxy).
 * O(n) first time, but called once per cycle so acceptable.
 */
function ewmaVolatility(prices: PriceSeries, period: number): number | null {
    if (prices.length < period + 1) return null;
    const alpha = 2 / (period + 1);
    let ewma = 0;
    const start = prices.length - period - 1;
    for (let i = start + 1; i < prices.length; i++) {
        const prev = prices.get(i - 1);
        const curr = prices.get(i);
        if (prev <= 0 || curr <= 0) continue;
        const logReturn = Math.log(curr / prev);
        const sqReturn = logReturn * logReturn;
        ewma = alpha * sqReturn + (1 - alpha) * ewma;
    }
    return Math.sqrt(ewma);
}

/**
 * Chop score: proportion of sign changes in short returns.
 * Higher = choppier (range-bound), lower = trending.
 */
function chopScore(prices: PriceSeries, lookback: number): number | null {
    if (prices.length < lookback + 2) return null;
    let signChanges = 0;
    let total = 0;
    const start = prices.length - lookback;
    let prevSign = 0;
    for (let i = start; i < prices.length; i++) {
        const diff = prices.get(i) - prices.get(i - 1);
        const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
        if (sign !== 0) {
            if (prevSign !== 0 && sign !== prevSign) {
                signChanges++;
            }
            prevSign = sign;
            total++;
        }
    }
    if (total < 2) return null;
    return signChanges / (total - 1);
}

/**
 * Extract all adapter features from price series and external data.
 */
export function extractAdapterFeatures(
    prices: PriceSeries,
    tickAgeMs: number,
    spreadPct: number | null,
    config: AdapterConfig = DEFAULT_ADAPTER_CONFIG,
): AdapterFeatures {
    const emaFast = calculateEMA(prices, config.emaFast);
    const emaSlow = calculateEMA(prices, config.emaSlow);
    const atr = calculateATR(prices, Math.max(config.emaFast, 14));
    const rsi = calculateRSI(prices, config.rsiPeriod);
    const sma = calculateSMA(prices, config.smaPeriod);
    const lastPrice = prices.length > 0 ? prices.get(prices.length - 1) : 0;

    const trendStrength = (emaFast !== null && emaSlow !== null && atr !== null && atr > 0)
        ? Math.abs(emaFast - emaSlow) / atr
        : null;

    const trendSlope = (emaFast !== null && emaSlow !== null)
        ? emaFast - emaSlow
        : null;

    const meanDistance = (sma !== null && atr !== null && atr > 0)
        ? (lastPrice - sma) / atr
        : null;

    return {
        volFast: ewmaVolatility(prices, config.volFastPeriod),
        volSlow: ewmaVolatility(prices, config.volSlowPeriod),
        trendSlope,
        trendStrength,
        chopScore: chopScore(prices, config.chopLookback),
        spreadPct,
        rsi,
        meanDistance,
        tickAge: tickAgeMs,
    };
}

// ==================== REGIME CLASSIFICATION ====================

function classifyRegime(features: AdapterFeatures, config: AdapterConfig): { regime: AdapterRegime; confidence: number; reasons: string[] } {
    const reasons: string[] = [];

    // BAD_LIQUIDITY: stale ticks or wide spreads
    if (features.tickAge > config.staleTickMs) {
        reasons.push(`STALE_TICK:${features.tickAge}ms`);
        return { regime: 'BAD_LIQUIDITY', confidence: 0.9, reasons };
    }
    if (features.spreadPct !== null && features.spreadPct > config.spreadThreshold) {
        reasons.push(`WIDE_SPREAD:${(features.spreadPct * 100).toFixed(3)}%`);
        return { regime: 'BAD_LIQUIDITY', confidence: 0.8, reasons };
    }

    // HIGH_VOL: fast vol >> slow vol
    if (features.volFast !== null && features.volSlow !== null && features.volSlow > 0) {
        const volRatio = features.volFast / features.volSlow;
        if (volRatio > config.highVolThreshold) {
            reasons.push(`VOL_RATIO:${volRatio.toFixed(2)}`);
            return { regime: 'HIGH_VOL', confidence: Math.min(0.95, 0.5 + (volRatio - config.highVolThreshold) * 0.2), reasons };
        }
    }

    // TREND: strong directional EMA separation
    if (features.trendStrength !== null && features.trendStrength > config.trendThreshold) {
        const conf = Math.min(0.95, 0.5 + (features.trendStrength - config.trendThreshold) * 0.3);
        // Additional: low chop confirms trend
        if (features.chopScore !== null && features.chopScore < config.chopThresholdRange) {
            reasons.push(`TREND_STRENGTH:${features.trendStrength.toFixed(2)}`);
            reasons.push(`LOW_CHOP:${features.chopScore.toFixed(2)}`);
            return { regime: 'TREND', confidence: Math.min(0.95, conf + 0.1), reasons };
        }
        reasons.push(`TREND_STRENGTH:${features.trendStrength.toFixed(2)}`);
        return { regime: 'TREND', confidence: conf, reasons };
    }

    // RANGE: high chop + bounded movement
    if (features.chopScore !== null && features.chopScore >= config.chopThresholdRange) {
        reasons.push(`HIGH_CHOP:${features.chopScore.toFixed(2)}`);
        const conf = Math.min(0.85, 0.4 + features.chopScore * 0.3);
        return { regime: 'RANGE', confidence: conf, reasons };
    }

    // UNCERTAIN: mixed signals
    reasons.push('MIXED_SIGNALS');
    return { regime: 'UNCERTAIN', confidence: 0.3, reasons };
}

/**
 * Apply hysteresis to regime transitions.
 * Won't switch unless the new regime persists for N cycles.
 */
function applyHysteresis(
    key: string,
    proposed: AdapterRegime,
    config: AdapterConfig
): AdapterRegime {
    const state = getOrCreateRegimeState(key);

    if (proposed === state.current) {
        state.stableCycles++;
        state.pendingRegime = null;
        state.pendingCycles = 0;
        return state.current;
    }

    // Different regime proposed
    if (state.pendingRegime !== proposed) {
        // New candidate
        state.pendingRegime = proposed;
        state.pendingCycles = 1;
        return state.current;
    }

    // Same pending candidate
    state.pendingCycles++;
    if (state.pendingCycles >= config.hysteresisCycles) {
        // Transition confirmed
        state.current = proposed;
        state.stableCycles = 1;
        state.pendingRegime = null;
        state.pendingCycles = 0;
        return proposed;
    }

    return state.current;
}

// ==================== SUB-STRATEGY SIGNALS ====================

function trendPullbackSignal(
    prices: PriceSeries,
    features: AdapterFeatures,
    config: AdapterConfig,
): StrategyEvaluation {
    if (features.trendSlope === null || features.rsi === null) return { signal: null };

    const emaFast = calculateEMA(prices, config.emaFast);
    if (emaFast === null) return { signal: null };

    const lastPrice = prices.get(prices.length - 1);
    const direction = features.trendSlope > 0 ? 'CALL' : 'PUT';

    // Check pullback: price is near EMA fast (within pullbackProximity * ATR)
    const atr = calculateATR(prices, config.emaFast);
    if (atr === null || atr <= 0) return { signal: null };

    const distanceToEma = Math.abs(lastPrice - emaFast);
    const pullbackZone = atr * config.pullbackProximity;

    if (distanceToEma > pullbackZone) {
        return { signal: null }; // Not in pullback zone
    }

    // Check momentum resumption: RSI confirming direction
    const rsiConfirm =
        (direction === 'CALL' && features.rsi > 45 && features.rsi < 70) ||
        (direction === 'PUT' && features.rsi < 55 && features.rsi > 30);

    if (!rsiConfirm) return { signal: null };

    // Confidence: stronger trend + closer to EMA = higher
    const trendConf = features.trendStrength !== null ? Math.min(1, features.trendStrength / 2) : 0.3;
    const proximityConf = 1 - (distanceToEma / pullbackZone);
    const confidence = Math.min(0.95, (trendConf * 0.6 + proximityConf * 0.4));

    if (confidence < config.trendPullbackConfidence) return { signal: null };

    return {
        signal: direction as TradeSignal,
        confidence,
        detail: `TrendPullback:dist=${distanceToEma.toFixed(4)},rsi=${features.rsi.toFixed(1)}`,
        reasonCodes: ['ADAPTER_TREND_PULLBACK', `DIR:${direction}`, `CONF:${confidence.toFixed(2)}`],
    };
}

function meanReversionSignal(
    prices: PriceSeries,
    features: AdapterFeatures,
    config: AdapterConfig,
): StrategyEvaluation {
    if (features.meanDistance === null || features.rsi === null) return { signal: null };

    const zscore = features.meanDistance; // already normalized by ATR
    const absZ = Math.abs(zscore);

    if (absZ < config.zscoreThreshold) return { signal: null }; // Not extreme enough

    // Fade the extreme: buy at negative extreme, sell at positive extreme
    const direction: TradeSignal = zscore < 0 ? 'CALL' : 'PUT';

    // Check momentum stalling (RSI not trending further into extreme)
    const momentumStall =
        (direction === 'CALL' && features.rsi > 25 && features.rsi < 45) ||
        (direction === 'PUT' && features.rsi < 75 && features.rsi > 55);

    if (!momentumStall) return { signal: null };

    const confidence = Math.min(0.9, 0.3 + (absZ - config.zscoreThreshold) * 0.25);

    if (confidence < config.meanRevConfidence) return { signal: null };

    return {
        signal: direction,
        confidence,
        detail: `MeanRev:zscore=${zscore.toFixed(2)},rsi=${features.rsi.toFixed(1)}`,
        reasonCodes: ['ADAPTER_MEAN_REVERSION', `ZSCORE:${zscore.toFixed(2)}`, `CONF:${confidence.toFixed(2)}`],
    };
}

function breakoutGuardSignal(
    prices: PriceSeries,
    features: AdapterFeatures,
    config: AdapterConfig,
): StrategyEvaluation {
    const lookback = config.breakoutLookback;
    if (prices.length < lookback + 2) return { signal: null };

    const lastPrice = prices.get(prices.length - 1);
    const endIdx = prices.length - 1;
    const startIdx = Math.max(0, endIdx - lookback);

    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let i = startIdx; i < endIdx; i++) {
        const p = prices.get(i);
        if (p > high) high = p;
        if (p < low) low = p;
    }

    const range = high - low;
    if (range <= 0) return { signal: null };

    // Break above range
    if (lastPrice > high) {
        const breakMagnitude = (lastPrice - high) / range;
        const confidence = Math.min(0.85, 0.4 + breakMagnitude * 0.3);
        if (confidence < config.breakoutConfidence) return { signal: null };
        return {
            signal: 'CALL',
            confidence,
            detail: `Breakout:high=${high.toFixed(4)},mag=${breakMagnitude.toFixed(3)}`,
            reasonCodes: ['ADAPTER_BREAKOUT_GUARD', 'BREAK_HIGH', `CONF:${confidence.toFixed(2)}`],
        };
    }

    // Break below range
    if (lastPrice < low) {
        const breakMagnitude = (low - lastPrice) / range;
        const confidence = Math.min(0.85, 0.4 + breakMagnitude * 0.3);
        if (confidence < config.breakoutConfidence) return { signal: null };
        return {
            signal: 'PUT',
            confidence,
            detail: `Breakout:low=${low.toFixed(4)},mag=${breakMagnitude.toFixed(3)}`,
            reasonCodes: ['ADAPTER_BREAKOUT_GUARD', 'BREAK_LOW', `CONF:${confidence.toFixed(2)}`],
        };
    }

    return { signal: null };
}

// ==================== MAIN ADAPTER EVALUATOR ====================

/**
 * Evaluate the Adapter strategy for one tick cycle.
 *
 * Pipeline: features → regime (+ hysteresis) → sub-strategy → signal
 *
 * This is deterministic given the same inputs.
 */
export function evaluateAdapter(
    accountId: string,
    symbol: string,
    prices: PriceSeries,
    tickAgeMs: number,
    spreadPct: number | null,
    config: AdapterConfig = DEFAULT_ADAPTER_CONFIG,
): AdapterDecision {
    const key = getKey(accountId, symbol);

    // Insufficient data → safe mode
    if (prices.length < config.minTicks) {
        return safeModeDecision(
            { regime: 'UNCERTAIN', confidence: 0.1, reasons: ['INSUFFICIENT_DATA'] },
            extractAdapterFeatures(prices, tickAgeMs, spreadPct, config),
            config,
        );
    }

    // Extract features
    const features = extractAdapterFeatures(prices, tickAgeMs, spreadPct, config);

    // Classify regime (raw)
    const rawClassification = classifyRegime(features, config);

    // Apply hysteresis
    const stableRegime = applyHysteresis(key, rawClassification.regime, config);

    // Route to sub-strategy
    let subStrategy: AdapterSubStrategy;
    let evaluation: StrategyEvaluation;

    switch (stableRegime) {
        case 'TREND':
            subStrategy = 'ADAPTER_TREND_PULLBACK';
            evaluation = trendPullbackSignal(prices, features, config);
            break;
        case 'RANGE':
            subStrategy = 'ADAPTER_MEAN_REVERSION';
            evaluation = meanReversionSignal(prices, features, config);
            break;
        case 'HIGH_VOL':
            // Only if liquidity OK
            if (features.spreadPct !== null && features.spreadPct <= config.spreadThreshold) {
                subStrategy = 'ADAPTER_BREAKOUT_GUARD';
                evaluation = breakoutGuardSignal(prices, features, config);
            } else {
                return safeModeDecision(rawClassification, features, config);
            }
            break;
        case 'BAD_LIQUIDITY':
        case 'UNCERTAIN':
        default:
            return safeModeDecision(rawClassification, features, config);
    }

    const reasonCodes = [
        `REGIME:${stableRegime}`,
        `REGIME_CONF:${rawClassification.confidence.toFixed(2)}`,
        `SUB:${subStrategy}`,
        ...rawClassification.reasons,
        ...(evaluation.reasonCodes ?? []),
    ];

    return {
        regime: stableRegime,
        regimeConfidence: rawClassification.confidence,
        subStrategy,
        signal: evaluation.signal,
        confidence: evaluation.confidence ?? 0,
        reasonCodes,
        cooldownMs: config.baseCooldownMs[subStrategy],
        featuresSnapshot: features,
    };
}

function safeModeDecision(
    classification: { regime: AdapterRegime; confidence: number; reasons: string[] },
    features: AdapterFeatures,
    config: AdapterConfig,
): AdapterDecision {
    return {
        regime: classification.regime,
        regimeConfidence: classification.confidence,
        subStrategy: 'ADAPTER_SAFE_MODE',
        signal: null,
        confidence: 0,
        reasonCodes: [
            `REGIME:${classification.regime}`,
            'SUB:ADAPTER_SAFE_MODE',
            'FORCE_HALT',
            ...classification.reasons,
        ],
        cooldownMs: config.baseCooldownMs.ADAPTER_SAFE_MODE,
        featuresSnapshot: features,
    };
}

// ==================== REQUIRED TICKS ====================

export function getAdapterRequiredTicks(config: AdapterConfig = DEFAULT_ADAPTER_CONFIG): number {
    return Math.max(
        config.volSlowPeriod + 2,
        config.emaSlow + 2,
        config.chopLookback + 2,
        config.rsiPeriod + 2,
        config.smaPeriod + 2,
        config.breakoutLookback + 2,
        config.minTicks,
    );
}

// ==================== CLEANUP ====================

export function resetAdapterState(accountId: string, symbol: string): void {
    regimeStates.delete(getKey(accountId, symbol));
}

export function resetAllAdapterState(): void {
    regimeStates.clear();
}
