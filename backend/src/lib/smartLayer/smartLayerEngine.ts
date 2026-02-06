/**
 * Smart Layer Engine
 *
 * Given a FeatureSnapshot and RegimeState, suggests parameter overrides.
 * Each parameter suggestion includes a reason code for explainability.
 *
 * INVARIANT: Never auto-fills Stake, Stop-Loss, or Take-Profit.
 * Every output is bounded by SmartParamBounds.
 */

import type {
    FeatureSnapshot,
    RegimeState,
    SmartParamSuggestion,
    SmartParamBounds,
    SmartReasonCode,
    SmartLayerDecision,
    RiskGateState,
    BotTelemetry,
} from './types';
import { DEFAULT_PARAM_BOUNDS } from './types';
import { hashFeatures } from './featureExtractor';

// ==================== CONFIGURATION ====================

const SPREAD_GATE_THRESHOLD = 0.15; // spreadQuality below this → halt
const SPREAD_WARN_THRESHOLD = 0.4;  // below this → reduced risk
const STALE_TICK_MS = 10_000;       // 10s without a tick → halt
const LOSS_STREAK_COOLDOWN_SCALE = 3_000; // ms added per consecutive loss
const HIGH_VOL_CONCURRENT_CAP = 2;
const TREND_MAX_CONCURRENT = 5;
const RANGE_MAX_CONCURRENT = 3;
const HIGH_VOL_COOLDOWN_MS = 10_000;
const RANGE_COOLDOWN_MS = 5_000;
const TREND_COOLDOWN_MS = 2_000;
const CONFIDENCE_FLOOR_HIGH_VOL = 0.7;
const CONFIDENCE_FLOOR_RANGE = 0.5;
const CONFIDENCE_FLOOR_TREND = 0.4;

let correlationCounter = 0;

function nextCorrelationId(): string {
    correlationCounter += 1;
    return `SL-${Date.now().toString(36)}-${correlationCounter.toString(36).padStart(4, '0')}`;
}

// ==================== CLAMPING ====================

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

// ==================== ENGINE ====================

/**
 * Compute risk gate state from features.
 */
function computeRiskGate(
    features: FeatureSnapshot,
    regime: RegimeState,
    telemetry: BotTelemetry | null,
    reasons: SmartReasonCode[]
): RiskGateState {
    // Stale tick → halt
    if (features.lastTickAge > STALE_TICK_MS) {
        reasons.push({
            param: 'riskGate',
            reason: `Tick stale for ${features.lastTickAge}ms (>${STALE_TICK_MS}ms)`,
            newValue: 'HALT',
            trigger: 'lastTickAge',
            boundsApplied: false,
        });
        return 'HALT';
    }

    // Spread too poor → halt
    if (features.spreadQuality !== null && features.spreadQuality < SPREAD_GATE_THRESHOLD) {
        reasons.push({
            param: 'riskGate',
            reason: `Spread quality ${features.spreadQuality.toFixed(3)} < ${SPREAD_GATE_THRESHOLD}`,
            newValue: 'HALT',
            trigger: 'spreadQuality',
            boundsApplied: false,
        });
        return 'HALT';
    }

    // Low liquidity regime → halt
    if (regime.current === 'REGIME_LOW_LIQUIDITY' && regime.confidence > 0.6) {
        reasons.push({
            param: 'riskGate',
            reason: 'Low liquidity regime with confidence > 0.6',
            newValue: 'HALT',
            trigger: 'regime',
            boundsApplied: false,
        });
        return 'HALT';
    }

    // High error rate → halt
    if (telemetry && telemetry.errorRate > 0.3) {
        reasons.push({
            param: 'riskGate',
            reason: `Error rate ${(telemetry.errorRate * 100).toFixed(1)}% > 30%`,
            newValue: 'HALT',
            trigger: 'errorRate',
            boundsApplied: false,
        });
        return 'HALT';
    }

    // Marginal spread → reduced
    if (features.spreadQuality !== null && features.spreadQuality < SPREAD_WARN_THRESHOLD) {
        reasons.push({
            param: 'riskGate',
            reason: `Spread quality ${features.spreadQuality.toFixed(3)} < ${SPREAD_WARN_THRESHOLD}`,
            newValue: 'REDUCED_RISK',
            trigger: 'spreadQuality',
            boundsApplied: false,
        });
        return 'REDUCED_RISK';
    }

    // Uncertain regime → reduced
    if (regime.current === 'REGIME_UNCERTAIN') {
        reasons.push({
            param: 'riskGate',
            reason: 'Uncertain regime — reducing risk',
            newValue: 'REDUCED_RISK',
            trigger: 'regime',
            boundsApplied: false,
        });
        return 'REDUCED_RISK';
    }

    // High consecutive losses → reduced
    if (telemetry && telemetry.consecutiveLosses >= 4) {
        reasons.push({
            param: 'riskGate',
            reason: `${telemetry.consecutiveLosses} consecutive losses`,
            newValue: 'REDUCED_RISK',
            trigger: 'consecutiveLosses',
            boundsApplied: false,
        });
        return 'REDUCED_RISK';
    }

    reasons.push({
        param: 'riskGate',
        reason: 'All conditions nominal',
        newValue: 'ALLOW_TRADE',
        trigger: 'default',
        boundsApplied: false,
    });
    return 'ALLOW_TRADE';
}

/**
 * Suggest maxConcurrentTrades based on regime + conditions.
 */
function suggestMaxConcurrent(
    regime: RegimeState,
    riskGate: RiskGateState,
    bounds: SmartParamBounds,
    reasons: SmartReasonCode[]
): number {
    let value: number;
    let trigger: string;

    if (riskGate === 'REDUCED_RISK') {
        value = 1;
        trigger = 'reduced_risk_gate';
    } else if (regime.current === 'REGIME_HIGH_VOL') {
        value = HIGH_VOL_CONCURRENT_CAP;
        trigger = 'high_vol_regime';
    } else if (regime.current === 'REGIME_RANGE') {
        value = RANGE_MAX_CONCURRENT;
        trigger = 'range_regime';
    } else if (regime.current === 'REGIME_TREND') {
        value = TREND_MAX_CONCURRENT;
        trigger = 'trend_regime';
    } else {
        value = 2; // conservative default for uncertain
        trigger = 'uncertain_default';
    }

    const clamped = clamp(value, bounds.maxConcurrentTrades.min, bounds.maxConcurrentTrades.max);
    reasons.push({
        param: 'maxConcurrentTrades',
        reason: `Regime ${regime.current} → ${clamped} concurrent trades`,
        newValue: clamped,
        trigger,
        boundsApplied: clamped !== value,
    });
    return clamped;
}

/**
 * Suggest cooldown based on regime + loss streak.
 */
function suggestCooldown(
    regime: RegimeState,
    telemetry: BotTelemetry | null,
    bounds: SmartParamBounds,
    reasons: SmartReasonCode[]
): number {
    let base: number;
    let trigger: string;

    switch (regime.current) {
        case 'REGIME_HIGH_VOL':
            base = HIGH_VOL_COOLDOWN_MS;
            trigger = 'high_vol_regime';
            break;
        case 'REGIME_RANGE':
            base = RANGE_COOLDOWN_MS;
            trigger = 'range_regime';
            break;
        case 'REGIME_TREND':
            base = TREND_COOLDOWN_MS;
            trigger = 'trend_regime';
            break;
        default:
            base = 8_000; // conservative
            trigger = 'uncertain_default';
    }

    // Scale up cooldown on loss streak
    const lossScaling = telemetry ? telemetry.consecutiveLosses * LOSS_STREAK_COOLDOWN_SCALE : 0;
    const value = base + lossScaling;

    const clamped = clamp(value, bounds.cooldownMs.min, bounds.cooldownMs.max);
    const adjustedTrigger = lossScaling > 0 ? `${trigger}+loss_streak(${telemetry!.consecutiveLosses})` : trigger;
    reasons.push({
        param: 'cooldownMs',
        reason: `Base ${base}ms + loss scaling ${lossScaling}ms = ${clamped}ms`,
        newValue: clamped,
        trigger: adjustedTrigger,
        boundsApplied: clamped !== value,
    });
    return clamped;
}

/**
 * Suggest signal confidence threshold.
 */
function suggestConfidenceThreshold(
    regime: RegimeState,
    riskGate: RiskGateState,
    bounds: SmartParamBounds,
    reasons: SmartReasonCode[]
): number {
    let value: number;
    let trigger: string;

    if (riskGate === 'REDUCED_RISK') {
        value = 0.75; // higher bar when risk is elevated
        trigger = 'reduced_risk_gate';
    } else if (regime.current === 'REGIME_HIGH_VOL') {
        value = CONFIDENCE_FLOOR_HIGH_VOL;
        trigger = 'high_vol_regime';
    } else if (regime.current === 'REGIME_RANGE') {
        value = CONFIDENCE_FLOOR_RANGE;
        trigger = 'range_regime';
    } else if (regime.current === 'REGIME_TREND') {
        value = CONFIDENCE_FLOOR_TREND;
        trigger = 'trend_regime';
    } else {
        value = 0.6;
        trigger = 'uncertain_default';
    }

    const clamped = clamp(value, bounds.signalConfidenceThreshold.min, bounds.signalConfidenceThreshold.max);
    reasons.push({
        param: 'signalConfidenceThreshold',
        reason: `Regime ${regime.current} → confidence floor ${clamped}`,
        newValue: clamped,
        trigger,
        boundsApplied: clamped !== value,
    });
    return clamped;
}

/**
 * Suggest spread filter based on current spread quality.
 */
function suggestSpreadFilter(
    features: FeatureSnapshot,
    bounds: SmartParamBounds,
    reasons: SmartReasonCode[]
): number {
    // Dynamic spread filter: tighten when spread is good, loosen when marginal
    let value: number;
    let trigger: string;

    if (features.spreadQuality !== null && features.spreadQuality > 0.8) {
        value = 0.005; // tight filter — spread is excellent
        trigger = 'excellent_spread';
    } else if (features.spreadQuality !== null && features.spreadQuality > 0.5) {
        value = 0.02;
        trigger = 'moderate_spread';
    } else {
        value = 0.04; // loose filter — poor conditions
        trigger = 'poor_spread';
    }

    const clamped = clamp(value, bounds.maxSpreadFilter.min, bounds.maxSpreadFilter.max);
    reasons.push({
        param: 'maxSpreadFilter',
        reason: `Spread quality ${features.spreadQuality?.toFixed(3) ?? 'null'} → filter ${clamped}`,
        newValue: clamped,
        trigger,
        boundsApplied: clamped !== value,
    });
    return clamped;
}

/**
 * Suggest max volatility ratio filter.
 */
function suggestVolatilityFilter(
    features: FeatureSnapshot,
    regime: RegimeState,
    bounds: SmartParamBounds,
    reasons: SmartReasonCode[]
): number {
    let value: number;
    let trigger: string;

    // In high vol regime, allow higher ratio (we're aware of it)
    if (regime.current === 'REGIME_HIGH_VOL') {
        value = 3.5;
        trigger = 'high_vol_regime_adapted';
    } else if (regime.current === 'REGIME_TREND') {
        value = 2.5;
        trigger = 'trend_regime';
    } else {
        value = 2.0;
        trigger = 'default';
    }

    const clamped = clamp(value, bounds.maxVolatilityRatio.min, bounds.maxVolatilityRatio.max);
    reasons.push({
        param: 'maxVolatilityRatio',
        reason: `Regime ${regime.current} → vol filter ${clamped}`,
        newValue: clamped,
        trigger,
        boundsApplied: clamped !== value,
    });
    return clamped;
}

/**
 * Suggest pyramiding policy.
 */
function suggestPyramiding(
    regime: RegimeState,
    riskGate: RiskGateState,
    reasons: SmartReasonCode[]
): boolean {
    // Only allow pyramiding in strong trends with clear conditions
    const value = regime.current === 'REGIME_TREND'
        && regime.confidence > 0.7
        && regime.stableCycles > 5
        && riskGate === 'ALLOW_TRADE';

    reasons.push({
        param: 'allowPyramiding',
        reason: value
            ? `Strong trend (conf=${regime.confidence.toFixed(2)}, cycles=${regime.stableCycles})`
            : `Pyramiding disabled — conditions not met`,
        newValue: value,
        trigger: value ? 'strong_trend' : 'safety',
        boundsApplied: false,
    });
    return value;
}

/**
 * Suggest entry mode.
 */
function suggestEntryMode(
    features: FeatureSnapshot,
    regime: RegimeState,
    reasons: SmartReasonCode[]
): 'MARKET' | 'HYBRID_LIMIT_MARKET' {
    // Hybrid limit only when spread is decent and not high vol
    const useHybrid = regime.current !== 'REGIME_HIGH_VOL'
        && features.spreadQuality !== null
        && features.spreadQuality > 0.5;

    const value: 'MARKET' | 'HYBRID_LIMIT_MARKET' = useHybrid ? 'HYBRID_LIMIT_MARKET' : 'MARKET';

    reasons.push({
        param: 'preferredEntryMode',
        reason: useHybrid
            ? 'Good spread quality — using hybrid limit for better fills'
            : 'High vol or poor spread — using market for certainty',
        newValue: value,
        trigger: useHybrid ? 'good_conditions' : 'adverse_conditions',
        boundsApplied: false,
    });
    return value;
}

// ==================== PUBLIC API ====================

/**
 * Suggest smart parameters for the current execution cycle.
 * Returns a full SmartLayerDecision with explainability.
 */
export function suggestParams(
    features: FeatureSnapshot,
    regime: RegimeState,
    telemetry: BotTelemetry | null,
    bounds: SmartParamBounds = DEFAULT_PARAM_BOUNDS
): SmartLayerDecision {
    const reasons: SmartReasonCode[] = [];
    const correlationId = nextCorrelationId();
    const featureHash = hashFeatures(features);

    // 1. Risk gate (must be first — other params depend on it)
    const riskGate = computeRiskGate(features, regime, telemetry, reasons);

    // 2. All parameter suggestions
    const params: SmartParamSuggestion = {
        maxConcurrentTrades: suggestMaxConcurrent(regime, riskGate, bounds, reasons),
        cooldownMs: suggestCooldown(regime, telemetry, bounds, reasons),
        signalConfidenceThreshold: suggestConfidenceThreshold(regime, riskGate, bounds, reasons),
        maxSpreadFilter: suggestSpreadFilter(features, bounds, reasons),
        maxVolatilityRatio: suggestVolatilityFilter(features, regime, bounds, reasons),
        allowPyramiding: suggestPyramiding(regime, riskGate, reasons),
        preferredEntryMode: suggestEntryMode(features, regime, reasons),
        riskGate,
    };

    return {
        correlationId,
        timestamp: Date.now(),
        featureHash,
        params,
        reasonCodes: reasons,
        regime,
    };
}
