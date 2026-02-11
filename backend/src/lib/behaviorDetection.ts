/**
 * Behavior Detection — Overtrading & Revenge Trading Detection
 *
 * In-memory sliding window analysis for destructive trading patterns.
 * - Overtrading: Too many trades per day (configurable threshold)
 * - Revenge Trading: Post-loss spike (rapid trades after a significant loss)
 *
 * Wire into settlement hooks for real-time detection.
 */

import { logger } from './logger';
import { metrics } from './metrics';

// ==================== TYPES ====================

export interface BehaviorAlert {
    type: 'overtrading' | 'revenge_trading';
    severity: 'warning' | 'critical';
    reason: string;
    tradeCount: number;
    windowMinutes: number;
    timestamp: number;
}

export interface BehaviorCheckResult {
    overtrading: boolean;
    revengeTrade: boolean;
    alerts: BehaviorAlert[];
    shouldPause: boolean;
}

export interface BehaviorConfig {
    /** Max trades per day before flagging overtrading */
    maxTradesPerDay: number;
    /** Max trades in revenge window before flagging */
    maxTradesInRevengeWindow: number;
    /** Revenge window in minutes after a significant loss */
    revengeWindowMinutes: number;
    /** Loss threshold as fraction of balance to trigger revenge watch (0.02 = 2%) */
    revengeLossThreshold: number;
    /** Auto-pause trading on critical alerts */
    autoPauseOnCritical: boolean;
}

interface TradeRecord {
    timestamp: number;
    profit: number;
    stake: number;
}

interface BehaviorState {
    trades: TradeRecord[];
    lastSignificantLoss: { timestamp: number; profit: number } | null;
    alerts: BehaviorAlert[];
    pausedUntil: number | null;
}

// ==================== CONFIG ====================

const DEFAULT_CONFIG: BehaviorConfig = {
    maxTradesPerDay: 15,
    maxTradesInRevengeWindow: 3,
    revengeWindowMinutes: 30,
    revengeLossThreshold: 0.02,
    autoPauseOnCritical: false,
};

// ==================== STATE ====================

const behaviorStates = new Map<string, BehaviorState>();
let activeConfig: BehaviorConfig = { ...DEFAULT_CONFIG };

const behaviorLog = logger.child({ module: 'behavior' });

// ==================== CORE API ====================

/**
 * Record a settled trade and check for destructive patterns.
 */
export function recordTradeAndCheck(
    accountId: string,
    profit: number,
    stake: number,
    balance: number,
): BehaviorCheckResult {
    const state = getOrCreateState(accountId);
    const now = Date.now();

    // Record the trade
    state.trades.push({ timestamp: now, profit, stake });

    // Prune old trades (keep last 24 hours)
    const dayAgo = now - 24 * 60 * 60 * 1000;
    state.trades = state.trades.filter(t => t.timestamp > dayAgo);

    // Check if this was a significant loss
    if (profit < 0 && balance > 0) {
        const lossFraction = Math.abs(profit) / balance;
        if (lossFraction >= activeConfig.revengeLossThreshold) {
            state.lastSignificantLoss = { timestamp: now, profit };
            behaviorLog.warn({
                accountId,
                lossFraction: lossFraction.toFixed(4),
                profit,
            }, 'Significant loss detected — revenge watch active');
        }
    }

    // Run detection
    const result = checkPatterns(accountId, state, now);

    // Log alerts
    for (const alert of result.alerts) {
        if (!state.alerts.some(a => a.type === alert.type && now - a.timestamp < 60_000)) {
            state.alerts.push(alert);
            metrics.counter(`behavior.alert.${alert.type}`);
            behaviorLog.warn({
                accountId,
                alertType: alert.type,
                severity: alert.severity,
                reason: alert.reason,
            }, `Behavior alert: ${alert.type}`);
        }
    }

    // Prune old alerts
    state.alerts = state.alerts.filter(a => now - a.timestamp < 60 * 60 * 1000);

    if (result.shouldPause && activeConfig.autoPauseOnCritical) {
        state.pausedUntil = now + 15 * 60 * 1000; // 15 min cooldown
        behaviorLog.error({ accountId }, 'Auto-pausing trading due to critical behavior alert');
    }

    return result;
}

/**
 * Pre-trade behavior check (called from riskManager).
 * Returns true if trading should be blocked.
 */
export function isBehaviorBlocked(accountId: string): { blocked: boolean; reason?: string } {
    const state = behaviorStates.get(accountId);
    if (!state) return { blocked: false };

    const now = Date.now();

    if (state.pausedUntil && now < state.pausedUntil) {
        const remainingSec = Math.ceil((state.pausedUntil - now) / 1000);
        return {
            blocked: true,
            reason: `Trading paused for ${remainingSec}s due to behavior detection`,
        };
    }

    return { blocked: false };
}

/**
 * Get behavior state for an account (for telemetry/SSE)
 */
export function getBehaviorSnapshot(accountId: string): {
    tradesToday: number;
    recentAlerts: BehaviorAlert[];
    isPaused: boolean;
    pauseRemainingSec: number;
} {
    const state = behaviorStates.get(accountId);
    if (!state) {
        return { tradesToday: 0, recentAlerts: [], isPaused: false, pauseRemainingSec: 0 };
    }

    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const tradesToday = state.trades.filter(t => t.timestamp >= todayStart).length;
    const isPaused = state.pausedUntil !== null && now < state.pausedUntil;
    const pauseRemainingSec = isPaused ? Math.ceil((state.pausedUntil! - now) / 1000) : 0;

    return {
        tradesToday,
        recentAlerts: state.alerts.slice(-5),
        isPaused,
        pauseRemainingSec,
    };
}

/**
 * Update behavior config
 */
export function updateBehaviorConfig(partial: Partial<BehaviorConfig>): void {
    activeConfig = { ...activeConfig, ...partial };
    behaviorLog.info({ config: activeConfig }, 'Behavior detection config updated');
}

/**
 * Clear behavior state for an account
 */
export function clearBehaviorState(accountId: string): void {
    behaviorStates.delete(accountId);
}

// ==================== INTERNAL ====================

function getOrCreateState(accountId: string): BehaviorState {
    let state = behaviorStates.get(accountId);
    if (!state) {
        state = {
            trades: [],
            lastSignificantLoss: null,
            alerts: [],
            pausedUntil: null,
        };
        behaviorStates.set(accountId, state);
    }
    return state;
}

function checkPatterns(
    accountId: string,
    state: BehaviorState,
    now: number,
): BehaviorCheckResult {
    const alerts: BehaviorAlert[] = [];
    let overtrading = false;
    let revengeTrade = false;

    // --- Overtrading Detection ---
    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    const tradesToday = state.trades.filter(t => t.timestamp >= todayStart).length;

    if (tradesToday > activeConfig.maxTradesPerDay) {
        overtrading = true;
        const severity = tradesToday > activeConfig.maxTradesPerDay * 1.5 ? 'critical' : 'warning';
        alerts.push({
            type: 'overtrading',
            severity,
            reason: `${tradesToday} trades today (limit: ${activeConfig.maxTradesPerDay})`,
            tradeCount: tradesToday,
            windowMinutes: 1440,
            timestamp: now,
        });
    }

    // --- Revenge Trading Detection ---
    if (state.lastSignificantLoss) {
        const windowMs = activeConfig.revengeWindowMinutes * 60 * 1000;
        const windowStart = state.lastSignificantLoss.timestamp;
        const windowEnd = windowStart + windowMs;

        if (now <= windowEnd) {
            const tradesInWindow = state.trades.filter(
                t => t.timestamp > windowStart && t.timestamp <= windowEnd,
            ).length;

            if (tradesInWindow >= activeConfig.maxTradesInRevengeWindow) {
                revengeTrade = true;
                alerts.push({
                    type: 'revenge_trading',
                    severity: tradesInWindow >= activeConfig.maxTradesInRevengeWindow * 2 ? 'critical' : 'warning',
                    reason: `${tradesInWindow} trades within ${activeConfig.revengeWindowMinutes}min after loss of ${state.lastSignificantLoss.profit.toFixed(2)}`,
                    tradeCount: tradesInWindow,
                    windowMinutes: activeConfig.revengeWindowMinutes,
                    timestamp: now,
                });
            }
        } else {
            // Window expired — clear
            state.lastSignificantLoss = null;
        }
    }

    const shouldPause = alerts.some(a => a.severity === 'critical');

    return { overtrading, revengeTrade, alerts, shouldPause };
}

// ==================== EXPORTS FOR TESTING ====================

export const __test = {
    behaviorStates,
    getOrCreateState,
    checkPatterns,
    DEFAULT_CONFIG,
    getActiveConfig: () => activeConfig,
    resetConfig: () => { activeConfig = { ...DEFAULT_CONFIG }; },
};
