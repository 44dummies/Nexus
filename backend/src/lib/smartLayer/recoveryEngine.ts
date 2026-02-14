/**
 * Recovery Engine — SMRT Loss Recovery State Machine
 *
 * Manages per-account recovery lifecycle:
 *   IDLE → RECOVERING → GRADUATED (or COOLDOWN on failure)
 *
 * Called after every trade settlement to:
 * 1. Detect losses and enter recovery mode
 * 2. Track deficit reduction during recovery
 * 3. Graduate when deficit is fully recovered
 * 4. Record completed episodes for neural network training
 * 5. Provide recovery parameter overrides for SmartLayer
 *
 * Anti-martingale approach:
 * - Start conservative after a loss
 * - Gradually increase stake after wins during recovery
 * - Decrease stake after further losses during recovery
 */

import type {
    RecoveryState,
    RecoveryMode,
    RecoveryEpisode,
    RecoveryParams,
    RecoveryFeatureVector,
    RecoveryConfig,
} from './recoveryTypes';
import { DEFAULT_RECOVERY_PARAMS, DEFAULT_RECOVERY_CONFIG } from './recoveryTypes';
import {
    predict as neuralPredict,
    train as neuralTrain,
    computeReward,
    getWeights,
} from './neuralRecoveryNet';

// ==================== STATE ====================

/** Per-account recovery state */
const recoveryStates = new Map<string, RecoveryState>();

/** Completed episodes for audit/persistence */
const completedEpisodes: RecoveryEpisode[] = [];
const MAX_EPISODE_HISTORY = 100;

let episodeCounter = 0;

// ==================== HELPERS ====================

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function createDefaultState(accountId: string): RecoveryState {
    return {
        mode: 'IDLE',
        accountId,
        deficit: 0,
        originalDeficit: 0,
        recovered: 0,
        tradesInRecovery: 0,
        winsInRecovery: 0,
        lossesInRecovery: 0,
        currentWinStreak: 0,
        currentLossStreak: 0,
        startedAt: 0,
        lastTradeAt: null,
        failedEpisodes: 0,
        successfulEpisodes: 0,
        cooldownUntil: null,
        lastGraduatedAt: null,
    };
}

function getOrCreateState(accountId: string): RecoveryState {
    let state = recoveryStates.get(accountId);
    if (!state) {
        state = createDefaultState(accountId);
        recoveryStates.set(accountId, state);
    }
    return state;
}

// ==================== FEATURE EXTRACTION ====================

/**
 * Build the neural network feature vector from current context.
 */
export function buildFeatureVector(
    accountId: string,
    context: {
        lossStreak: number;
        equity: number;
        deficit: number;
        recentWinRate: number;
        regimeConfidence: number;
        volatilityRatio: number | null;
        lastWinTimeMs: number | null;
        drawdownPct: number;
    },
): RecoveryFeatureVector {
    const state = getOrCreateState(accountId);
    const now = Date.now();

    return {
        lossStreakNorm: clamp(context.lossStreak / 20, 0, 1),
        deficitPctEquity: context.equity > 0
            ? clamp(context.deficit / context.equity, 0, 1)
            : 1,
        recentWinRate: clamp(context.recentWinRate, 0, 1),
        regimeConfidence: clamp(context.regimeConfidence, 0, 1),
        volatilityNorm: context.volatilityRatio !== null
            ? clamp(context.volatilityRatio / 5, 0, 1)
            : 0.5,
        timeSinceWinNorm: context.lastWinTimeMs !== null
            ? clamp((now - context.lastWinTimeMs) / (60 * 60 * 1000), 0, 1) // 0–60 min
            : 1,
        recoveryAttemptNorm: clamp(
            (state.failedEpisodes + state.successfulEpisodes) / 10,
            0,
            1,
        ),
        drawdownPct: clamp(context.drawdownPct, 0, 1),
    };
}

// ==================== CORE API ====================

/**
 * Called after every trade settlement.
 * Manages the recovery state machine transitions.
 *
 * Returns the mode transition that occurred (if any).
 */
export function onTradeSettled(
    accountId: string,
    profit: number,
    stake: number,
    context: {
        equity: number;
        lossStreak: number;
        recentWinRate: number;
        regimeConfidence: number;
        volatilityRatio: number | null;
        lastWinTimeMs: number | null;
        drawdownPct: number;
    },
    config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
): {
    previousMode: RecoveryMode;
    currentMode: RecoveryMode;
    transition: 'ENTERED_RECOVERY' | 'LOSS_IN_RECOVERY' | 'WIN_IN_RECOVERY' | 'GRADUATED' | 'FAILED' | 'NONE';
} {
    const state = getOrCreateState(accountId);
    const previousMode = state.mode;
    const now = Date.now();

    // Check if in cooldown
    if (state.mode === 'COOLDOWN') {
        if (state.cooldownUntil !== null && now >= state.cooldownUntil) {
            state.mode = 'IDLE';
            state.cooldownUntil = null;
        } else {
            return { previousMode, currentMode: 'COOLDOWN', transition: 'NONE' };
        }
    }

    // Check circuit breaker
    if (state.failedEpisodes >= config.maxFailedEpisodes && state.mode !== 'RECOVERING') {
        return { previousMode, currentMode: state.mode, transition: 'NONE' };
    }

    // Check minimum equity
    if (context.equity < config.minEquityForRecovery && state.mode !== 'RECOVERING') {
        return { previousMode, currentMode: state.mode, transition: 'NONE' };
    }

    state.lastTradeAt = now;

    // ── LOSS DETECTED ──

    if (profit < 0) {
        const lossAmount = Math.abs(profit);

        if (state.mode === 'IDLE' || state.mode === 'GRADUATED') {
            // Not in recovery — enter recovery mode
            state.mode = 'RECOVERING';
            state.deficit = lossAmount;
            state.originalDeficit = lossAmount;
            state.recovered = 0;
            state.tradesInRecovery = 1;
            state.winsInRecovery = 0;
            state.lossesInRecovery = 1;
            state.currentWinStreak = 0;
            state.currentLossStreak = 1;
            state.startedAt = now;

            return { previousMode, currentMode: 'RECOVERING', transition: 'ENTERED_RECOVERY' };
        }

        if (state.mode === 'RECOVERING') {
            // Already in recovery — compound the deficit
            state.deficit += lossAmount;
            state.tradesInRecovery += 1;
            state.lossesInRecovery += 1;
            state.currentWinStreak = 0;
            state.currentLossStreak += 1;

            // Check if deficit is too large (% of equity)
            const deficitPct = context.equity > 0
                ? (state.deficit / context.equity) * 100
                : 100;

            if (
                deficitPct > config.maxDeficitPct ||
                state.tradesInRecovery >= config.maxRecoveryTrades
            ) {
                // Recovery failed — record episode and enter cooldown
                return failRecovery(state, context, config);
            }

            return { previousMode: 'RECOVERING', currentMode: 'RECOVERING', transition: 'LOSS_IN_RECOVERY' };
        }
    }

    // ── WIN DETECTED ──

    if (profit >= 0) {
        if (state.mode === 'RECOVERING') {
            state.recovered += profit;
            state.deficit = Math.max(0, state.deficit - profit);
            state.tradesInRecovery += 1;
            state.winsInRecovery += 1;
            state.currentWinStreak += 1;
            state.currentLossStreak = 0;

            // Check if deficit is fully recovered
            if (state.deficit <= 0) {
                return graduateRecovery(state, context, config);
            }

            return { previousMode: 'RECOVERING', currentMode: 'RECOVERING', transition: 'WIN_IN_RECOVERY' };
        }

        // Not in recovery — nothing to do
        return { previousMode, currentMode: state.mode, transition: 'NONE' };
    }

    return { previousMode, currentMode: state.mode, transition: 'NONE' };
}

/**
 * Recovery succeeded — deficit fully recovered.
 */
function graduateRecovery(
    state: RecoveryState,
    context: {
        equity: number;
        lossStreak: number;
        recentWinRate: number;
        regimeConfidence: number;
        volatilityRatio: number | null;
        lastWinTimeMs: number | null;
        drawdownPct: number;
    },
    config: RecoveryConfig,
): { previousMode: RecoveryMode; currentMode: RecoveryMode; transition: 'GRADUATED' } {
    const now = Date.now();

    // Build features for training
    const features = buildFeatureVector(state.accountId, {
        ...context,
        deficit: state.originalDeficit,
    });

    // Get the params that were used during this recovery
    const paramsUsed = neuralPredict(state.accountId, features, config);

    // Compute reward — pass win rate for accuracy bonus
    const winRate = state.tradesInRecovery > 0
        ? state.winsInRecovery / state.tradesInRecovery
        : 0;
    const reward = computeReward(
        state.recovered,
        state.originalDeficit,
        state.tradesInRecovery,
        true,
        winRate,
    );

    // Train neural network
    neuralTrain(state.accountId, features, paramsUsed, reward, config);

    // Record episode
    recordEpisode(state, features, paramsUsed, reward, true);

    // Update state
    state.successfulEpisodes += 1;
    state.mode = 'GRADUATED';
    state.lastGraduatedAt = now;
    state.deficit = 0;
    state.recovered = 0;

    return { previousMode: 'RECOVERING', currentMode: 'GRADUATED', transition: 'GRADUATED' };
}

/**
 * Recovery failed — deficit too large or too many trades.
 */
function failRecovery(
    state: RecoveryState,
    context: {
        equity: number;
        lossStreak: number;
        recentWinRate: number;
        regimeConfidence: number;
        volatilityRatio: number | null;
        lastWinTimeMs: number | null;
        drawdownPct: number;
    },
    config: RecoveryConfig,
): { previousMode: RecoveryMode; currentMode: RecoveryMode; transition: 'FAILED' } {
    const now = Date.now();

    // Build features for training (with negative reward signal)
    const features = buildFeatureVector(state.accountId, {
        ...context,
        deficit: state.originalDeficit,
    });

    const paramsUsed = neuralPredict(state.accountId, features, config);

    // Compute (low) reward — pass win rate for accuracy signal
    const winRate = state.tradesInRecovery > 0
        ? state.winsInRecovery / state.tradesInRecovery
        : 0;
    const reward = computeReward(
        state.recovered,
        state.originalDeficit,
        state.tradesInRecovery,
        false,
        winRate,
    );

    // Train neural network (will push toward conservative defaults)
    neuralTrain(state.accountId, features, paramsUsed, reward, config);

    // Record episode
    recordEpisode(state, features, paramsUsed, reward, false);

    // Update state
    state.failedEpisodes += 1;
    state.mode = 'COOLDOWN';
    state.cooldownUntil = now + config.failedRecoveryCooldownMs;
    state.deficit = 0;
    state.recovered = 0;

    return { previousMode: 'RECOVERING', currentMode: 'COOLDOWN', transition: 'FAILED' };
}

/**
 * Record a completed recovery episode.
 */
function recordEpisode(
    state: RecoveryState,
    features: RecoveryFeatureVector,
    params: RecoveryParams,
    reward: number,
    success: boolean,
): void {
    episodeCounter += 1;
    const episode: RecoveryEpisode = {
        id: `RE-${Date.now().toString(36)}-${episodeCounter.toString(36)}`,
        accountId: state.accountId,
        success,
        originalDeficit: state.originalDeficit,
        recoveredAmount: state.recovered,
        totalTrades: state.tradesInRecovery,
        wins: state.winsInRecovery,
        losses: state.lossesInRecovery,
        durationMs: Date.now() - state.startedAt,
        startFeatures: features,
        avgParams: params,
        reward,
        timestamp: Date.now(),
    };

    completedEpisodes.push(episode);
    // Keep bounded
    while (completedEpisodes.length > MAX_EPISODE_HISTORY) {
        completedEpisodes.shift();
    }
}

// ==================== RECOVERY OVERRIDES ====================

/**
 * Get current recovery parameter overrides for a given account.
 * These are applied by SmartLayer/botController during RECOVERING mode.
 *
 * When not in RECOVERING mode, returns null (no overrides).
 */
export function getRecoveryOverrides(
    accountId: string,
    context: {
        equity: number;
        lossStreak: number;
        recentWinRate: number;
        regimeConfidence: number;
        volatilityRatio: number | null;
        lastWinTimeMs: number | null;
        drawdownPct: number;
    },
    config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
): RecoveryParams | null {
    const state = getOrCreateState(accountId);

    if (state.mode !== 'RECOVERING') {
        return null;
    }

    // Build features from current context
    const features = buildFeatureVector(accountId, {
        ...context,
        deficit: state.deficit,
    });

    // Get neural network prediction
    let params = neuralPredict(accountId, features, config);

    // Apply anti-martingale adjustments based on win/loss streak
    params = applyAntiMartingale(params, state, config);

    return params;
}

/**
 * Precision-first anti-martingale:
 * - After consecutive wins: aggressively increase stake (capitalize on accuracy)
 * - After consecutive losses: tighten precision threshold (only take best signals)
 * - No cooldown manipulation — trade at full speed, but with surgical precision
 */
function applyAntiMartingale(
    params: RecoveryParams,
    state: RecoveryState,
    config: RecoveryConfig,
): RecoveryParams {
    let stakeMultiplier = params.stakeMultiplier;
    let precisionThreshold = params.precisionThreshold;
    let confidenceBoost = params.confidenceBoost;

    if (state.currentWinStreak >= 2) {
        // Winning streak — aggressively scale stake (proven accuracy)
        const winBoost = 1 + (state.currentWinStreak - 1) * 0.2;
        stakeMultiplier *= Math.min(winBoost, 2.0);
        // Slightly relax precision on proven streak (earning trust)
        precisionThreshold *= 0.95;
    }

    if (state.currentLossStreak >= 2) {
        // Losing streak — tighten precision, only take surgical entries
        const precisionTightening = 1 + (state.currentLossStreak - 1) * 0.05;
        precisionThreshold *= Math.min(precisionTightening, 1.3);
        // Also boost confidence requirement
        confidenceBoost += (state.currentLossStreak - 1) * 0.03;
        // Reduce stake on bad streak
        const lossReduction = 1 - (state.currentLossStreak - 1) * 0.15;
        stakeMultiplier *= Math.max(lossReduction, 0.4);
    }

    return {
        stakeMultiplier: clamp(
            stakeMultiplier,
            config.stakeMultiplierBounds.min,
            config.stakeMultiplierBounds.max,
        ),
        precisionThreshold: clamp(
            precisionThreshold,
            config.precisionThresholdBounds.min,
            config.precisionThresholdBounds.max,
        ),
        confidenceBoost: clamp(
            confidenceBoost,
            config.confidenceBoostBounds.min,
            config.confidenceBoostBounds.max,
        ),
        aggressiveness: params.aggressiveness,
    };
}

// ==================== READ-ONLY ACCESSORS ====================

/**
 * Get current recovery state for an account (read-only).
 */
export function getRecoveryState(accountId: string): RecoveryState | null {
    return recoveryStates.get(accountId) ?? null;
}

/**
 * Get completed recovery episodes.
 */
export function getCompletedEpisodes(accountId?: string): RecoveryEpisode[] {
    if (accountId) {
        return completedEpisodes.filter((e) => e.accountId === accountId);
    }
    return [...completedEpisodes];
}

/**
 * Check if recovery is active for an account.
 */
export function isRecoveryActive(accountId: string): boolean {
    const state = recoveryStates.get(accountId);
    return state?.mode === 'RECOVERING';
}

/**
 * Get a serializable snapshot for persistence/telemetry.
 */
export function getRecoverySnapshot(accountId: string): {
    mode: RecoveryMode;
    deficit: number;
    originalDeficit: number;
    recovered: number;
    tradesInRecovery: number;
    winRate: number;
    failedEpisodes: number;
    successfulEpisodes: number;
    neuralWeights: ReturnType<typeof getWeights>;
} | null {
    const state = recoveryStates.get(accountId);
    if (!state) return null;

    return {
        mode: state.mode,
        deficit: state.deficit,
        originalDeficit: state.originalDeficit,
        recovered: state.recovered,
        tradesInRecovery: state.tradesInRecovery,
        winRate: state.tradesInRecovery > 0
            ? state.winsInRecovery / state.tradesInRecovery
            : 0,
        failedEpisodes: state.failedEpisodes,
        successfulEpisodes: state.successfulEpisodes,
        neuralWeights: getWeights(accountId),
    };
}

// ==================== LIFECYCLE ====================

/**
 * Reset recovery state for an account.
 */
export function resetRecoveryState(accountId: string): void {
    recoveryStates.delete(accountId);
}

/**
 * Reset all recovery states (for testing).
 */
export function resetAllRecoveryStates(): void {
    recoveryStates.clear();
    completedEpisodes.length = 0;
    episodeCounter = 0;
}

// ==================== TEST EXPORTS ====================

export const __test = {
    recoveryStates,
    completedEpisodes,
    createDefaultState,
    applyAntiMartingale,
};
