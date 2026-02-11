/**
 * Recovery Types — Shared type definitions for the SMRT Recovery Layer.
 *
 * Defines contracts for:
 * - Recovery state machine modes
 * - Per-account recovery state
 * - Completed recovery episodes (for neural training)
 * - Recovery parameter overrides
 * - Neural network weight serialization
 */

// ==================== RECOVERY MODE ====================

export type RecoveryMode = 'IDLE' | 'RECOVERING' | 'COOLDOWN' | 'GRADUATED';

// ==================== RECOVERY STATE ====================

export interface RecoveryState {
    /** Current recovery mode */
    mode: RecoveryMode;
    /** Account this state belongs to */
    accountId: string;
    /** Total deficit to recover (positive number) */
    deficit: number;
    /** Original deficit when recovery started */
    originalDeficit: number;
    /** Amount recovered so far */
    recovered: number;
    /** Trades executed during this recovery episode */
    tradesInRecovery: number;
    /** Wins during this recovery episode */
    winsInRecovery: number;
    /** Losses during this recovery episode */
    lossesInRecovery: number;
    /** Consecutive wins in current recovery streak */
    currentWinStreak: number;
    /** Consecutive losses in current recovery streak */
    currentLossStreak: number;
    /** Timestamp when recovery started */
    startedAt: number;
    /** Timestamp of last trade in recovery */
    lastTradeAt: number | null;
    /** Number of failed recovery episodes for this account (lifetime) */
    failedEpisodes: number;
    /** Number of successful recovery episodes (lifetime) */
    successfulEpisodes: number;
    /** Cooldown expiry timestamp (only when mode=COOLDOWN) */
    cooldownUntil: number | null;
    /** Last graduated timestamp */
    lastGraduatedAt: number | null;
}

// ==================== RECOVERY EPISODE ====================

/** A completed recovery attempt — used for neural network training */
export interface RecoveryEpisode {
    /** Unique episode ID */
    id: string;
    /** Account ID */
    accountId: string;
    /** Whether recovery was successful (deficit fully recovered) */
    success: boolean;
    /** Original deficit amount */
    originalDeficit: number;
    /** Amount actually recovered (may be partial if failed) */
    recoveredAmount: number;
    /** Total trades taken during episode */
    totalTrades: number;
    /** Wins during episode */
    wins: number;
    /** Losses during episode */
    losses: number;
    /** Episode duration in ms */
    durationMs: number;
    /** Input features at episode start (for neural training) */
    startFeatures: RecoveryFeatureVector;
    /** Average params used during the episode */
    avgParams: RecoveryParams;
    /** Reward score: higher = better recovery (used as training signal) */
    reward: number;
    /** Timestamp */
    timestamp: number;
}

// ==================== RECOVERY PARAMS ====================

/** Output of recovery engine — applied as overrides to SmartLayer params */
export interface RecoveryParams {
    /** Stake multiplier (0.5–3.0). <1 = conservative, >1 = aggressive on high-confidence */
    stakeMultiplier: number;
    /** Minimum signal precision threshold (0.6–0.95). Only trade signals above this quality */
    precisionThreshold: number;
    /** Extra confidence threshold to add (0.0–0.35). Higher = pickier signals only */
    confidenceBoost: number;
    /** Recovery aggressiveness (0.0–1.0). Controls rate of scaling on wins */
    aggressiveness: number;
}

/** Safe default params — precision-first, no cooldown */
export const DEFAULT_RECOVERY_PARAMS: RecoveryParams = {
    stakeMultiplier: 1.0,
    precisionThreshold: 0.7,
    confidenceBoost: 0.15,
    aggressiveness: 0.5,
};

// ==================== NEURAL FEATURE VECTOR ====================

/** 8-dimensional input features for the neural network */
export interface RecoveryFeatureVector {
    /** Normalized loss streak length (0–1, mapped from 0–20+) */
    lossStreakNorm: number;
    /** Deficit as % of equity (0–1) */
    deficitPctEquity: number;
    /** Win rate over recent trades (0–1) */
    recentWinRate: number;
    /** Current regime confidence (0–1) */
    regimeConfidence: number;
    /** Volatility ratio (normalized 0–1 from raw 0–5) */
    volatilityNorm: number;
    /** Normalized time since last win (0–1, mapped from 0–60min) */
    timeSinceWinNorm: number;
    /** Recovery attempt count (normalized 0–1, mapped from 0–10+) */
    recoveryAttemptNorm: number;
    /** Account drawdown % (0–1) */
    drawdownPct: number;
}

// ==================== NEURAL WEIGHTS ====================

/** Serializable neural network weights for persistence */
export interface NeuralWeights {
    /** Input → Hidden1 weights (8 x 16 = 128 values) */
    w1: number[];
    /** Hidden1 biases (16 values) */
    b1: number[];
    /** Hidden1 → Hidden2 weights (16 x 8 = 128 values) */
    w2: number[];
    /** Hidden2 biases (8 values) */
    b2: number[];
    /** Hidden2 → Output weights (8 x 4 = 32 values) */
    w3: number[];
    /** Output biases (4 values) */
    b3: number[];
    /** Training iteration count (for learning rate schedule) */
    iterations: number;
    /** Last training timestamp */
    lastTrainedAt: number | null;
}

// ==================== CONFIGURATION ====================

export interface RecoveryConfig {
    /** Max deficit as % of equity before giving up recovery */
    maxDeficitPct: number;
    /** Max trades in a single recovery episode before abandoning */
    maxRecoveryTrades: number;
    /** Max failed episodes before circuit breaker halts recovery */
    maxFailedEpisodes: number;
    /** Cooldown after failed recovery episode (ms) */
    failedRecoveryCooldownMs: number;
    /** Minimum equity to allow recovery (absolute floor) */
    minEquityForRecovery: number;
    /** Stake multiplier bounds — wider upper bound for aggressive profit capture */
    stakeMultiplierBounds: { min: number; max: number };
    /** Precision threshold bounds — minimum signal quality during recovery */
    precisionThresholdBounds: { min: number; max: number };
    /** Confidence boost bounds */
    confidenceBoostBounds: { min: number; max: number };
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
    maxDeficitPct: 15,           // Give up if deficit > 15% of equity
    maxRecoveryTrades: 50,       // Abandon after 50 trades in one episode
    maxFailedEpisodes: 5,        // Circuit breaker after 5 failed episodes
    failedRecoveryCooldownMs: 60_000, // 1 minute cooldown after failed episode
    minEquityForRecovery: 5,     // Don't try to recover if equity < $5
    stakeMultiplierBounds: { min: 0.5, max: 3.0 },
    precisionThresholdBounds: { min: 0.6, max: 0.95 },
    confidenceBoostBounds: { min: 0.0, max: 0.35 },
};
