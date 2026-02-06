/**
 * Regime Detector
 *
 * Classifies the current market regime from a FeatureSnapshot.
 * Uses hysteresis to prevent flip-flopping between regimes.
 *
 * Regimes:
 *   REGIME_TREND         — Strong directional movement
 *   REGIME_RANGE         — Mean-reverting, bounded movement
 *   REGIME_HIGH_VOL      — Elevated volatility (spikes, breakouts)
 *   REGIME_LOW_LIQUIDITY  — Poor spread/fill quality
 *   REGIME_UNCERTAIN      — Insufficient signal or mixed conditions
 */

import type { FeatureSnapshot, RegimeType, RegimeState } from './types';

// ==================== CONFIGURATION ====================

/** Minimum cycles a regime must hold before a switch is allowed */
const HYSTERESIS_CYCLES = 3;

/** Thresholds (tunable — these are calibrated for Deriv synthetic indices) */
const TREND_STRENGTH_THRESHOLD = 0.8;
const TREND_STRENGTH_STRONG = 1.5;
const VOLATILITY_HIGH_RATIO = 2.0;
const VOLATILITY_LOW_RATIO = 0.6;
const MEAN_REVERSION_THRESHOLD = 0.8; // close to SMA
const RSI_RANGE_LOW = 35;
const RSI_RANGE_HIGH = 65;
const SPREAD_QUALITY_MIN = 0.3;     // below this = low liquidity
const TICK_DIRECTION_PERSISTENCE_TREND = 0.7;
const MIN_TICK_COUNT = 30;          // need this many ticks for reliable detection

// ==================== SCORING ====================

interface RegimeScore {
    regime: RegimeType;
    score: number;
}

/**
 * Score each regime based on the feature snapshot.
 * Returns all regimes with their scores; highest wins.
 */
function scoreRegimes(features: FeatureSnapshot): RegimeScore[] {
    const scores: RegimeScore[] = [
        { regime: 'REGIME_TREND', score: 0 },
        { regime: 'REGIME_RANGE', score: 0 },
        { regime: 'REGIME_HIGH_VOL', score: 0 },
        { regime: 'REGIME_LOW_LIQUIDITY', score: 0 },
        { regime: 'REGIME_UNCERTAIN', score: 0 },
    ];

    // Insufficient data → uncertain
    if (features.tickCount < MIN_TICK_COUNT) {
        scores[4].score = 1.0;
        return scores;
    }

    // ---- Low Liquidity (checked first — overrides others) ----
    if (features.spreadQuality !== null && features.spreadQuality < SPREAD_QUALITY_MIN) {
        scores[3].score += 0.6;
    }
    if (features.lastTickAge > 5000) {
        scores[3].score += 0.3; // stale ticks suggest connectivity/liquidity issue
    }

    // ---- High Volatility ----
    if (features.volatilityRatio !== null && features.volatilityRatio > VOLATILITY_HIGH_RATIO) {
        scores[2].score += 0.5 + Math.min(0.5, (features.volatilityRatio - VOLATILITY_HIGH_RATIO) / 3);
    }
    if (features.stdDev !== null && features.atrSlow !== null && features.atrSlow > 0) {
        const stdDevRatio = features.stdDev / features.atrSlow;
        if (stdDevRatio > 2.0) {
            scores[2].score += 0.3;
        }
    }

    // ---- Trend ----
    if (features.trendStrength !== null) {
        if (features.trendStrength > TREND_STRENGTH_STRONG) {
            scores[0].score += 0.7;
        } else if (features.trendStrength > TREND_STRENGTH_THRESHOLD) {
            scores[0].score += 0.4;
        }
    }
    if (features.tickDirectionPersistence !== null && features.tickDirectionPersistence > TICK_DIRECTION_PERSISTENCE_TREND) {
        scores[0].score += 0.2;
    }
    if (features.emaSlopeShort !== null && features.emaSlopeLong !== null) {
        // Slopes in same direction = trend agreement
        if (Math.sign(features.emaSlopeShort) === Math.sign(features.emaSlopeLong) &&
            Math.abs(features.emaSlopeShort) > 0) {
            scores[0].score += 0.15;
        }
    }

    // ---- Range / Mean Reversion ----
    if (features.meanReversionScore !== null && features.meanReversionScore < MEAN_REVERSION_THRESHOLD) {
        scores[1].score += 0.4;
    }
    if (features.rsi !== null && features.rsi > RSI_RANGE_LOW && features.rsi < RSI_RANGE_HIGH) {
        scores[1].score += 0.2; // RSI near midpoint = ranging
    }
    if (features.volatilityRatio !== null && features.volatilityRatio < VOLATILITY_LOW_RATIO) {
        scores[1].score += 0.3; // Low vol = likely ranging
    }
    if (features.trendStrength !== null && features.trendStrength < TREND_STRENGTH_THRESHOLD * 0.5) {
        scores[1].score += 0.2; // Weak trend = ranging
    }

    // ---- Uncertain (base score + anti-signal) ----
    const maxDefiniteScore = Math.max(scores[0].score, scores[1].score, scores[2].score, scores[3].score);
    if (maxDefiniteScore < 0.3) {
        scores[4].score = 0.5; // No clear regime
    }
    // If two regimes are close, add uncertainty
    const sorted = [...scores.slice(0, 4)].sort((a, b) => b.score - a.score);
    if (sorted[0].score > 0 && sorted[1].score > 0) {
        const gap = sorted[0].score - sorted[1].score;
        if (gap < 0.15) {
            scores[4].score += 0.3; // Ambiguous
        }
    }

    return scores;
}

// ==================== STATE MANAGEMENT ====================

/** Per-symbol regime state. Keyed by `accountId:symbol` */
const regimeStates = new Map<string, RegimeState>();

function getKey(accountId: string, symbol: string): string {
    return `${accountId}:${symbol}`;
}

/**
 * Detect the current market regime.
 *
 * Uses hysteresis: a new regime must win for HYSTERESIS_CYCLES consecutive
 * evaluations before the state actually switches. This prevents flip-flopping
 * on noisy boundaries.
 */
export function detectRegime(
    accountId: string,
    symbol: string,
    features: FeatureSnapshot
): RegimeState {
    const key = getKey(accountId, symbol);
    const prev = regimeStates.get(key);

    const scores = scoreRegimes(features);
    const winner = scores.reduce((best, s) => s.score > best.score ? s : best, scores[0]);
    const confidence = Math.min(1, winner.score);

    // No previous state — initialize
    if (!prev) {
        const state: RegimeState = {
            current: winner.regime,
            confidence,
            stableCycles: 1,
            timestamp: features.timestamp,
            features,
            previousRegime: null,
        };
        regimeStates.set(key, state);
        return state;
    }

    // Same regime as current → increment stable cycles
    if (winner.regime === prev.current) {
        prev.confidence = confidence;
        prev.stableCycles += 1;
        prev.timestamp = features.timestamp;
        prev.features = features;
        return prev;
    }

    // Different regime proposed — apply hysteresis
    // We track "pending" transitions via a separate counter
    if (!pendingTransitions.has(key) || pendingTransitions.get(key)!.regime !== winner.regime) {
        // New pending transition
        pendingTransitions.set(key, { regime: winner.regime, cycles: 1 });
        // Keep current regime, just update features
        prev.features = features;
        prev.timestamp = features.timestamp;
        return prev;
    }

    const pending = pendingTransitions.get(key)!;
    pending.cycles += 1;

    if (pending.cycles >= HYSTERESIS_CYCLES) {
        // Transition confirmed
        const previousRegime = prev.current;
        prev.previousRegime = previousRegime;
        prev.current = winner.regime;
        prev.confidence = confidence;
        prev.stableCycles = 1;
        prev.timestamp = features.timestamp;
        prev.features = features;
        pendingTransitions.delete(key);
        return prev;
    }

    // Not enough cycles yet — stay on current
    prev.features = features;
    prev.timestamp = features.timestamp;
    return prev;
}

/** Pending regime transitions, keyed by accountId:symbol */
const pendingTransitions = new Map<string, { regime: RegimeType; cycles: number }>();

/**
 * Get the current regime state without triggering detection.
 */
export function getRegimeState(accountId: string, symbol: string): RegimeState | null {
    return regimeStates.get(getKey(accountId, symbol)) ?? null;
}

/**
 * Reset regime state (for testing or account switch).
 */
export function resetRegimeState(accountId: string, symbol: string): void {
    const key = getKey(accountId, symbol);
    regimeStates.delete(key);
    pendingTransitions.delete(key);
}

/** Reset all state — for tests */
export function resetAllRegimeState(): void {
    regimeStates.clear();
    pendingTransitions.clear();
}
