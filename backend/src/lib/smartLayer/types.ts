/**
 * Smart Layer — Type Definitions
 *
 * Defines the contracts for:
 * - Feature snapshots (market state)
 * - Regime detection outputs
 * - Parameter suggestions
 * - Risk gate states
 * - Strategy routing
 * - Audit/explainability events
 *
 * NON-NEGOTIABLE: Stake, SL, and TP are NEVER auto-filled.
 */

import type { TradeSignal, StrategyConfig, StrategyEvaluation } from '../strategyEngine';
import type { PriceSeries } from '../ringBuffer';

// ==================== FEATURE SNAPSHOT ====================

export interface FeatureSnapshot {
    /** Unix timestamp ms when snapshot was computed */
    timestamp: number;
    /** Symbol this snapshot pertains to */
    symbol: string;

    // Trend features
    emaSlopeShort: number | null;   // EMA(9) slope over last 5 bars
    emaSlopeLong: number | null;    // EMA(21) slope over last 5 bars
    trendStrength: number | null;   // abs(EMA9 - EMA21) / ATR — normalized

    // Volatility features
    atrCurrent: number | null;      // ATR(14) current
    atrSlow: number | null;         // ATR(50) — baseline volatility
    volatilityRatio: number | null; // atrCurrent / atrSlow
    stdDev: number | null;          // Rolling StdDev(20)

    // Range features
    meanReversionScore: number | null; // Distance from SMA(20) / ATR
    rsi: number | null;

    // Microstructure features
    spreadQuality: number | null;   // 0-1 score (lower spread = higher quality)
    tickDirectionPersistence: number | null; // % of last N ticks in same direction
    momentum: number | null;        // Short-horizon momentum value
    imbalance: number | null;       // Order book imbalance

    // Data quality
    tickCount: number;
    lastTickAge: number;            // ms since last tick
}

// ==================== REGIME DETECTION ====================

export type RegimeType =
    | 'REGIME_TREND'
    | 'REGIME_RANGE'
    | 'REGIME_HIGH_VOL'
    | 'REGIME_LOW_LIQUIDITY'
    | 'REGIME_UNCERTAIN';

export interface RegimeState {
    current: RegimeType;
    confidence: number;             // 0-1
    stableCycles: number;           // How many cycles the current regime has held
    timestamp: number;
    features: FeatureSnapshot;
    previousRegime: RegimeType | null;
}

// ==================== STRATEGY CATALOG ====================

export type AutoStrategyId =
    | 'S1_TREND_FOLLOW'
    | 'S2_MEAN_REVERSION'
    | 'S3_BREAKOUT_GUARD'
    | 'S0_SAFE_MODE'
    | 'S4_ADAPTER';

/** Maps auto strategy IDs to backend strategy engine IDs */
export const AUTO_STRATEGY_MAP: Record<AutoStrategyId, string> = {
    S1_TREND_FOLLOW: 'trend-rider',
    S2_MEAN_REVERSION: 'rsi',
    S3_BREAKOUT_GUARD: 'breakout-atr',
    S0_SAFE_MODE: 'capital-guard',
    S4_ADAPTER: 'adapter',
};

/** Reverse lookup */
export const STRATEGY_TO_AUTO: Record<string, AutoStrategyId> = {
    'trend-rider': 'S1_TREND_FOLLOW',
    'rsi': 'S2_MEAN_REVERSION',
    'breakout-atr': 'S3_BREAKOUT_GUARD',
    'capital-guard': 'S0_SAFE_MODE',
    'adapter': 'S4_ADAPTER',
};

// ==================== RISK GATE STATE ====================

export type RiskGateState =
    | 'ALLOW_TRADE'
    | 'REDUCED_RISK'
    | 'HALT';

// ==================== PARAMETER SUGGESTIONS ====================

/**
 * Parameters the Smart Layer MAY auto-fill.
 * EXCLUDED: stake, stopLoss, takeProfit — always user-defined.
 */
export interface SmartParamSuggestion {
    /** Max concurrent trades (dynamic, within upper bound) */
    maxConcurrentTrades: number;
    /** Cooldown between entries in ms (per-symbol) */
    cooldownMs: number;
    /** Signal confidence threshold (dynamic, within min/max) */
    signalConfidenceThreshold: number;
    /** Spread filter — max acceptable spread before gating */
    maxSpreadFilter: number;
    /** Volatility filter — max ATR ratio before gating */
    maxVolatilityRatio: number;
    /** Allow pyramiding (adding to position) */
    allowPyramiding: boolean;
    /** Preferred execution mode */
    preferredEntryMode: 'MARKET' | 'HYBRID_LIMIT_MARKET';
    /** Risk gate state derived from conditions */
    riskGate: RiskGateState;
}

export interface SmartParamBounds {
    maxConcurrentTrades: { min: number; max: number };
    cooldownMs: { min: number; max: number };
    signalConfidenceThreshold: { min: number; max: number };
    maxSpreadFilter: { min: number; max: number };
    maxVolatilityRatio: { min: number; max: number };
}

export const DEFAULT_PARAM_BOUNDS: SmartParamBounds = {
    maxConcurrentTrades: { min: 1, max: 10 },
    cooldownMs: { min: 500, max: 30_000 },
    signalConfidenceThreshold: { min: 0.2, max: 0.9 },
    maxSpreadFilter: { min: 0, max: 0.05 },
    maxVolatilityRatio: { min: 0.5, max: 5.0 },
};

// ==================== SMART LAYER OUTPUT ====================

export interface SmartLayerDecision {
    /** Unique correlation ID for this decision cycle */
    correlationId: string;
    /** Timestamp of decision */
    timestamp: number;
    /** Feature snapshot hash for reproducibility */
    featureHash: string;
    /** Computed parameter suggestions */
    params: SmartParamSuggestion;
    /** Reason codes explaining each parameter choice */
    reasonCodes: SmartReasonCode[];
    /** Regime state at time of decision */
    regime: RegimeState;
}

export interface SmartReasonCode {
    param: keyof SmartParamSuggestion;
    reason: string;
    oldValue?: number | string | boolean;
    newValue: number | string | boolean;
    trigger: string;          // metric that triggered the change
    boundsApplied: boolean;   // was the value clamped to bounds?
}

// ==================== STRATEGY SWITCH EVENT ====================

export interface StrategySwitchEvent {
    correlationId: string;
    timestamp: number;
    from: AutoStrategyId;
    to: AutoStrategyId;
    reason: string;
    regimeState: RegimeState;
    metrics: {
        regimeConfidence: number;
        stableCycles: number;
        volatilityRatio: number | null;
        trendStrength: number | null;
    };
}

// ==================== AUTO MODE STATE ====================

export interface AutoModeState {
    enabled: boolean;
    currentStrategy: AutoStrategyId;
    regime: RegimeState | null;
    lastSwitch: StrategySwitchEvent | null;
    lastDecision: SmartLayerDecision | null;
    cycleCount: number;
    /** Whether an order is currently in-flight (blocks switching) */
    orderInFlight: boolean;
}

// ==================== EXECUTION CYCLE ====================

export interface ExecutionCycleInput {
    accountId: string;
    symbol: string;
    prices: PriceSeries;
    lastPrice: number;
    lossStreak: number;
    tick: { quote: number; epoch: number; receivedPerfMs: number };
    microContext?: {
        imbalance: number | null;
        spread: number | null;
        momentum: number | null;
        mode: 'order_book' | 'synthetic' | null;
    };
}

export interface ExecutionCycleOutput {
    signal: TradeSignal | null;
    strategyId: string;
    autoStrategyId: AutoStrategyId;
    evaluation: StrategyEvaluation;
    smartParams: SmartParamSuggestion;
    regime: RegimeState;
    gated: boolean;
    gateReason?: string;
    correlationId: string;
}

// ==================== TELEMETRY ====================

export interface BotTelemetry {
    accountId: string;
    totalTradesSession: number;
    totalProfitSession: number;
    winRate: number;
    avgLatencyMs: number;
    errorRate: number;
    lastTradeTimeMs: number | null;
    consecutiveLosses: number;
    consecutiveWins: number;
}

// ==================== PNL ====================

export interface PnLSnapshot {
    accountId: string;
    timestamp: number;
    realizedPnL: number;
    unrealizedPnL: number;
    fees: number;
    netPnL: number;
    /** Per-position breakdown */
    positions: PositionPnL[];
}

export interface PositionPnL {
    contractId: number;
    symbol: string;
    direction: TradeSignal;
    entryPrice: number;
    markPrice: number;
    size: number;
    unrealizedPnL: number;
    realizedPnL: number;
    fees: number;
    openedAt: number;
}
