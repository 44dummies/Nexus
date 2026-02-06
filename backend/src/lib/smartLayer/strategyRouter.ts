/**
 * Strategy Router
 *
 * Selects the optimal AutoStrategyId based on the current RegimeState.
 * Implements safe switching with:
 *   - Hysteresis: won't switch unless regime is stable for N cycles
 *   - Order-in-flight guard: blocks switching when orders are pending
 *   - Cooldown: minimum time between strategy switches
 *   - Event emission: every switch is logged with full context
 *
 * Deterministic: given the same inputs, always produces the same output.
 */

import type {
    RegimeState,
    RegimeType,
    AutoStrategyId,
    StrategySwitchEvent,
    AutoModeState,
} from './types';
import { AUTO_STRATEGY_MAP } from './types';

// ==================== CONFIGURATION ====================

/** Minimum regime stable cycles before router will switch strategy */
const SWITCH_STABLE_CYCLES = 5;

/** Minimum ms between strategy switches */
const SWITCH_COOLDOWN_MS = 30_000;

/** Regime → strategy mapping (the core routing table) */
const REGIME_STRATEGY_MAP: Record<RegimeType, AutoStrategyId> = {
    REGIME_TREND: 'S1_TREND_FOLLOW',
    REGIME_RANGE: 'S2_MEAN_REVERSION',
    REGIME_HIGH_VOL: 'S3_BREAKOUT_GUARD',
    REGIME_LOW_LIQUIDITY: 'S0_SAFE_MODE',
    REGIME_UNCERTAIN: 'S0_SAFE_MODE',
};

// ==================== PER-ACCOUNT STATE ====================

/** Per (accountId:symbol) auto mode state */
const autoModeStates = new Map<string, AutoModeState>();

function getKey(accountId: string, symbol: string): string {
    return `${accountId}:${symbol}`;
}

// ==================== PUBLIC API ====================

/**
 * Initialize auto mode for a bot run.
 * Starts in S0_SAFE_MODE until regime stabilizes.
 */
export function initAutoMode(accountId: string, symbol: string): AutoModeState {
    const key = getKey(accountId, symbol);
    const state: AutoModeState = {
        enabled: true,
        currentStrategy: 'S0_SAFE_MODE',
        regime: null,
        lastSwitch: null,
        lastDecision: null,
        cycleCount: 0,
        orderInFlight: false,
    };
    autoModeStates.set(key, state);
    return state;
}

/**
 * Get auto mode state (read-only).
 */
export function getAutoModeState(accountId: string, symbol: string): AutoModeState | null {
    return autoModeStates.get(getKey(accountId, symbol)) ?? null;
}

/**
 * Set order-in-flight flag. MUST be called before/after trade execution.
 * When true, strategy switching is blocked.
 */
export function setOrderInFlight(accountId: string, symbol: string, inFlight: boolean): void {
    const state = autoModeStates.get(getKey(accountId, symbol));
    if (state) {
        state.orderInFlight = inFlight;
    }
}

/**
 * Disable auto mode, returning to manual strategy selection.
 */
export function disableAutoMode(accountId: string, symbol: string): void {
    autoModeStates.delete(getKey(accountId, symbol));
}

/**
 * Core routing function: select the best strategy for the current regime.
 *
 * Returns the selected AutoStrategyId and any switch event that occurred.
 * Safe: will NOT switch if:
 *   - Order is in-flight
 *   - Regime is not stable enough (< SWITCH_STABLE_CYCLES)
 *   - Switch cooldown has not elapsed
 */
export function selectStrategy(
    accountId: string,
    symbol: string,
    regime: RegimeState,
): { strategyId: AutoStrategyId; backendStrategyId: string; switchEvent: StrategySwitchEvent | null } {
    const key = getKey(accountId, symbol);
    let state = autoModeStates.get(key);

    if (!state) {
        state = initAutoMode(accountId, symbol);
    }

    state.cycleCount += 1;
    state.regime = regime;

    const proposedStrategy = REGIME_STRATEGY_MAP[regime.current];
    const currentStrategy = state.currentStrategy;

    // No change needed
    if (proposedStrategy === currentStrategy) {
        return {
            strategyId: currentStrategy,
            backendStrategyId: AUTO_STRATEGY_MAP[currentStrategy],
            switchEvent: null,
        };
    }

    // --- Switch guards ---

    // Guard 1: Order in flight → block switch
    if (state.orderInFlight) {
        return {
            strategyId: currentStrategy,
            backendStrategyId: AUTO_STRATEGY_MAP[currentStrategy],
            switchEvent: null,
        };
    }

    // Guard 2: Regime not stable enough
    if (regime.stableCycles < SWITCH_STABLE_CYCLES) {
        return {
            strategyId: currentStrategy,
            backendStrategyId: AUTO_STRATEGY_MAP[currentStrategy],
            switchEvent: null,
        };
    }

    // Guard 3: Switch cooldown
    const now = Date.now();
    if (state.lastSwitch && (now - state.lastSwitch.timestamp) < SWITCH_COOLDOWN_MS) {
        return {
            strategyId: currentStrategy,
            backendStrategyId: AUTO_STRATEGY_MAP[currentStrategy],
            switchEvent: null,
        };
    }

    // --- All guards passed: execute switch ---

    const switchEvent: StrategySwitchEvent = {
        correlationId: `SW-${now.toString(36)}-${state.cycleCount.toString(36)}`,
        timestamp: now,
        from: currentStrategy,
        to: proposedStrategy,
        reason: `Regime ${regime.current} stable for ${regime.stableCycles} cycles → ${proposedStrategy}`,
        regimeState: regime,
        metrics: {
            regimeConfidence: regime.confidence,
            stableCycles: regime.stableCycles,
            volatilityRatio: regime.features.volatilityRatio,
            trendStrength: regime.features.trendStrength,
        },
    };

    state.currentStrategy = proposedStrategy;
    state.lastSwitch = switchEvent;

    return {
        strategyId: proposedStrategy,
        backendStrategyId: AUTO_STRATEGY_MAP[proposedStrategy],
        switchEvent,
    };
}

/**
 * Get the backend strategy ID string for a given auto strategy.
 */
export function resolveBackendStrategy(autoId: AutoStrategyId): string {
    return AUTO_STRATEGY_MAP[autoId];
}

/**
 * Reset auto mode state (for testing).
 */
export function resetAutoMode(accountId: string, symbol: string): void {
    autoModeStates.delete(getKey(accountId, symbol));
}

/** Reset all state — for tests */
export function resetAllAutoMode(): void {
    autoModeStates.clear();
}
