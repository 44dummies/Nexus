/**
 * Smart Layer — Barrel Export & Orchestrator
 *
 * This is the single entry point for the Smart Layer system.
 * The SmartLayer class orchestrates: features → regime → params → strategy
 * in a single `executeCycle()` call per tick.
 *
 * Usage:
 *   import { SmartLayer } from './smartLayer';
 *   const sl = SmartLayer.getInstance();
 *   const result = sl.executeCycle(input);
 */

import type { PriceSeries } from '../ringBuffer';
import type {
    FeatureSnapshot,
    RegimeState,
    AutoStrategyId,
    SmartLayerDecision,
    SmartParamSuggestion,
    SmartParamBounds,
    StrategySwitchEvent,
    AutoModeState,
    ExecutionCycleInput,
    ExecutionCycleOutput,
    BotTelemetry,
    RiskGateState,
} from './types';
import { DEFAULT_PARAM_BOUNDS, AUTO_STRATEGY_MAP } from './types';
import { extractFeatures, hashFeatures } from './featureExtractor';
import { detectRegime, getRegimeState, resetRegimeState, resetAllRegimeState } from './regimeDetector';
import { suggestParams } from './smartLayerEngine';
import {
    selectStrategy,
    initAutoMode,
    getAutoModeState,
    setOrderInFlight,
    disableAutoMode,
    resetAutoMode,
    resetAllAutoMode,
} from './strategyRouter';
import {
    evaluateAdapter,
    extractAdapterFeatures,
    getAdapterRequiredTicks,
    resetAdapterState,
    resetAllAdapterState,
    type AdapterDecision,
    type AdapterFeatures,
    type AdapterRegime,
    type AdapterSubStrategy,
    type AdapterConfig,
    DEFAULT_ADAPTER_CONFIG,
} from './adapterStrategy';

// Re-export everything for convenience
export type {
    FeatureSnapshot,
    RegimeState,
    AutoStrategyId,
    SmartLayerDecision,
    SmartParamSuggestion,
    SmartParamBounds,
    StrategySwitchEvent,
    AutoModeState,
    ExecutionCycleInput,
    ExecutionCycleOutput,
    BotTelemetry,
    RiskGateState,
    // Adapter types
    AdapterDecision,
    AdapterFeatures,
    AdapterRegime,
    AdapterSubStrategy,
    AdapterConfig,
};

export {
    extractFeatures,
    hashFeatures,
    detectRegime,
    getRegimeState,
    suggestParams,
    selectStrategy,
    initAutoMode,
    getAutoModeState,
    setOrderInFlight,
    disableAutoMode,
    DEFAULT_PARAM_BOUNDS,
    AUTO_STRATEGY_MAP,
    // Adapter strategy exports
    evaluateAdapter,
    extractAdapterFeatures,
    getAdapterRequiredTicks,
    resetAdapterState,
    resetAllAdapterState,
    DEFAULT_ADAPTER_CONFIG,
};

// ==================== TELEMETRY STORE ====================

/** Per-account telemetry, updated externally by botController */
const telemetryStore = new Map<string, BotTelemetry>();

// ==================== ORCHESTRATOR ====================

export class SmartLayer {
    private static instance: SmartLayer | null = null;
    private bounds: SmartParamBounds;

    private constructor(bounds?: SmartParamBounds) {
        this.bounds = bounds ?? DEFAULT_PARAM_BOUNDS;
    }

    static getInstance(bounds?: SmartParamBounds): SmartLayer {
        if (!SmartLayer.instance) {
            SmartLayer.instance = new SmartLayer(bounds);
        }
        return SmartLayer.instance;
    }

    /** Override bounds (useful for testing or per-account tuning) */
    setBounds(bounds: SmartParamBounds): void {
        this.bounds = bounds;
    }

    /**
     * Execute one full Smart Layer cycle.
     *
     * Pipeline: features → regime → params → strategy → output
     *
     * This is called once per tick in the bot controller when Auto Mode is enabled.
     * Returns everything the bot controller needs to make a trade decision.
     */
    executeCycle(input: ExecutionCycleInput): {
        features: FeatureSnapshot;
        regime: RegimeState;
        decision: SmartLayerDecision;
        strategyId: AutoStrategyId;
        backendStrategyId: string;
        switchEvent: StrategySwitchEvent | null;
        gated: boolean;
        gateReason?: string;
    } {
        const { accountId, symbol, prices, tick, microContext } = input;

        // 1. Extract features
        const features = extractFeatures(accountId, symbol, prices, tick.receivedPerfMs);

        // 2. Detect regime
        const regime = detectRegime(accountId, symbol, features);

        // 3. Get telemetry for this account
        const telemetry = telemetryStore.get(accountId) ?? null;

        // 4. Suggest parameters
        const decision = suggestParams(features, regime, telemetry, this.bounds);

        // 5. Select strategy
        const { strategyId, backendStrategyId, switchEvent } = selectStrategy(
            accountId,
            symbol,
            regime
        );

        // 6. Determine gating
        const gated = decision.params.riskGate === 'HALT';
        const gateReason = gated
            ? decision.reasonCodes.find(r => r.param === 'riskGate')?.reason
            : undefined;

        return {
            features,
            regime,
            decision,
            strategyId,
            backendStrategyId,
            switchEvent,
            gated,
            gateReason,
        };
    }

    // ==================== TELEMETRY ====================

    /**
     * Update telemetry for an account.
     * Called by botController after each trade result.
     */
    static updateTelemetry(accountId: string, update: Partial<BotTelemetry>): void {
        const existing = telemetryStore.get(accountId);
        if (existing) {
            Object.assign(existing, update);
        } else {
            telemetryStore.set(accountId, {
                accountId,
                totalTradesSession: 0,
                totalProfitSession: 0,
                winRate: 0,
                avgLatencyMs: 0,
                errorRate: 0,
                lastTradeTimeMs: null,
                consecutiveLosses: 0,
                consecutiveWins: 0,
                ...update,
            });
        }
    }

    static getTelemetry(accountId: string): BotTelemetry | null {
        return telemetryStore.get(accountId) ?? null;
    }

    // ==================== LIFECYCLE ====================

    /**
     * Mark order as in-flight (blocks strategy switching).
     */
    markOrderInFlight(accountId: string, symbol: string): void {
        setOrderInFlight(accountId, symbol, true);
    }

    /**
     * Clear order-in-flight flag (unblocks strategy switching).
     */
    clearOrderInFlight(accountId: string, symbol: string): void {
        setOrderInFlight(accountId, symbol, false);
    }

    /**
     * Enable auto mode for a (account, symbol) pair.
     */
    enableAutoMode(accountId: string, symbol: string): AutoModeState {
        return initAutoMode(accountId, symbol);
    }

    /**
     * Disable auto mode.
     */
    disableAutoMode(accountId: string, symbol: string): void {
        disableAutoMode(accountId, symbol);
    }

    /**
     * Get auto mode state.
     */
    getAutoModeState(accountId: string, symbol: string): AutoModeState | null {
        return getAutoModeState(accountId, symbol);
    }

    /**
     * Get regime state without triggering detection.
     */
    getRegimeState(accountId: string, symbol: string): RegimeState | null {
        return getRegimeState(accountId, symbol);
    }

    // ==================== TEST SUPPORT ====================

    /** Full reset for tests */
    static reset(): void {
        SmartLayer.instance = null;
        telemetryStore.clear();
        resetAllRegimeState();
        resetAllAutoMode();
        resetAllAdapterState();
    }
}
