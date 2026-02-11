/**
 * PnL Tracker — Centralized, Mathematically Correct PnL Computation
 *
 * Responsibilities:
 * 1. Track realized PnL from settled contracts (source: riskCache recordTradeSettled)
 * 2. Track unrealized PnL from open contracts via mark-to-market
 * 3. Maintain per-account PnL snapshots streamed to frontend
 * 4. Reconcile computed PnL against Deriv account balance periodically
 *
 * Architecture:
 * - Realized PnL: incremented on each settlement (single source of truth: Deriv profit field)
 * - Unrealized PnL: computed from open contracts using last known tick vs buy_price
 * - Net PnL = realized + unrealized
 * - Balance drift = abs(computed_balance - deriv_balance)
 */

import { tradeLogger } from './logger';
import { metrics } from './metrics';
import { auditSettlement } from './auditLogger';
import { recordTradeAndCheck } from './behaviorDetection';
import type { Response } from 'express';

// ==================== TYPES ====================

export interface OpenPositionMark {
    contractId: number;
    symbol: string;
    direction: 'CALL' | 'PUT';
    buyPrice: number;
    payout: number;
    stake: number;
    openedAt: number;
    botRunId?: string | null;
    /** Last mark price (spot at open or latest tick) */
    lastMarkPrice: number;
    /** Last computed unrealized PnL */
    unrealizedPnL: number;
}

export interface PnLState {
    accountId: string;
    /** Sum of all settled trade profits today (Deriv's profit field) */
    realizedPnL: number;
    /** Sum of unrealized PnL from open positions */
    unrealizedPnL: number;
    /** realized + unrealized */
    netPnL: number;
    /** Balance at start of tracking session */
    sessionStartBalance: number | null;
    /** Last known Deriv balance (from authorize/balance events) */
    lastKnownBalance: number | null;
    /** Drift between computed and actual balance */
    balanceDrift: number | null;
    /** Number of open positions */
    openPositionCount: number;
    /** Total exposure (sum of stakes in open positions) */
    openExposure: number;
    /** Win count today */
    winCount: number;
    /** Loss count today */
    lossCount: number;
    /** Average win amount */
    avgWin: number;
    /** Average loss amount */
    avgLoss: number;
    /** Last updated timestamp */
    lastUpdated: number;
    /** Open positions with mark prices */
    positions: OpenPositionMark[];
}

// ==================== STATE ====================

const pnlStates = new Map<string, PnLState>();

// SSE listeners for PnL stream
const pnlListeners = new Map<string, Set<Response>>();
const PNL_HEARTBEAT_MS = 25_000;
const MAX_SSE_CONNECTIONS = 50;
let activeSseCount = 0;

// ==================== CORE API ====================

function getOrCreatePnLState(accountId: string): PnLState {
    let state = pnlStates.get(accountId);
    if (!state) {
        state = {
            accountId,
            realizedPnL: 0,
            unrealizedPnL: 0,
            netPnL: 0,
            sessionStartBalance: null,
            lastKnownBalance: null,
            balanceDrift: null,
            openPositionCount: 0,
            openExposure: 0,
            winCount: 0,
            lossCount: 0,
            avgWin: 0,
            avgLoss: 0,
            lastUpdated: Date.now(),
            positions: [],
        };
        pnlStates.set(accountId, state);
    }
    return state;
}

/**
 * Initialize PnL state for an account with starting balance
 */
export function initPnLState(accountId: string, startBalance: number): void {
    const state = getOrCreatePnLState(accountId);
    state.sessionStartBalance = startBalance;
    state.lastKnownBalance = startBalance;
    state.lastUpdated = Date.now();
}

/**
 * Record a settled trade into realized PnL
 * Called from handleSettlement in trade.ts
 */
export function recordSettledPnL(
    accountId: string,
    contractId: number,
    profit: number,
    details?: {
        symbol?: string;
        direction?: 'CALL' | 'PUT';
        buyPrice?: number;
        payout?: number;
        stake?: number;
    }
): void {
    const state = getOrCreatePnLState(accountId);

    // Remove from open positions
    const posIdx = state.positions.findIndex(p => p.contractId === contractId);
    if (posIdx !== -1) {
        const pos = state.positions[posIdx];
        state.openExposure = Math.max(0, state.openExposure - pos.stake);
        state.positions.splice(posIdx, 1);
        state.openPositionCount = state.positions.length;
    }

    // Update realized PnL
    state.realizedPnL += profit;

    if (profit > 0) {
        state.winCount += 1;
        // Running average: avgWin = ((old * (n-1)) + profit) / n
        state.avgWin = state.winCount === 1
            ? profit
            : ((state.avgWin * (state.winCount - 1)) + profit) / state.winCount;
    } else if (profit < 0) {
        state.lossCount += 1;
        const absLoss = Math.abs(profit);
        state.avgLoss = state.lossCount === 1
            ? absLoss
            : ((state.avgLoss * (state.lossCount - 1)) + absLoss) / state.lossCount;
    }

    // Recompute totals
    recomputeUnrealized(state);
    state.netPnL = state.realizedPnL + state.unrealizedPnL;

    // Update balance tracking
    if (state.lastKnownBalance !== null) {
        state.lastKnownBalance += profit;
    }

    state.lastUpdated = Date.now();

    metrics.counter('pnl.settlement_recorded');
    broadcastPnL(accountId, state);

    // Audit: record settlement event
    auditSettlement(accountId, {
        contractId,
        profit,
        symbol: details?.symbol,
        direction: details?.direction,
        stake: details?.stake,
    });

    // Behavior detection: check for overtrading/revenge patterns
    if (state.lastKnownBalance !== null && state.lastKnownBalance > 0) {
        recordTradeAndCheck(accountId, profit, details?.stake ?? 0, state.lastKnownBalance);
    }
}

/**
 * Track a newly opened position for unrealized PnL computation
 */
export function trackOpenPosition(
    accountId: string,
    position: {
        contractId: number;
        symbol: string;
        direction: 'CALL' | 'PUT';
        buyPrice: number;
        payout: number;
        stake: number;
        botRunId?: string | null;
    }
): void {
    const state = getOrCreatePnLState(accountId);

    // Avoid duplicates
    if (state.positions.some(p => p.contractId === position.contractId)) {
        return;
    }

    const mark: OpenPositionMark = {
        ...position,
        openedAt: Date.now(),
        lastMarkPrice: position.buyPrice,
        unrealizedPnL: 0, // At open, unrealized = 0
    };

    state.positions.push(mark);
    state.openPositionCount = state.positions.length;
    state.openExposure += position.stake;
    state.lastUpdated = Date.now();

    metrics.counter('pnl.position_opened');
    broadcastPnL(accountId, state);
}

/**
 * Update mark price for open positions (called on proposal_open_contract updates)
 * Deriv sends real-time profit for open contracts — use that directly
 */
export function markPosition(
    accountId: string,
    contractId: number,
    currentProfit: number,
    currentSpot?: number
): void {
    const state = pnlStates.get(accountId);
    if (!state) return;

    const pos = state.positions.find(p => p.contractId === contractId);
    if (!pos) return;

    pos.unrealizedPnL = currentProfit;
    if (currentSpot !== undefined) {
        pos.lastMarkPrice = currentSpot;
    }

    recomputeUnrealized(state);
    state.netPnL = state.realizedPnL + state.unrealizedPnL;
    state.lastUpdated = Date.now();

    broadcastPnL(accountId, state);
}

/**
 * Update the known Deriv balance (from authorize or balance stream)
 * Used for drift detection
 */
export function updateKnownBalance(accountId: string, balance: number): void {
    const state = getOrCreatePnLState(accountId);
    state.lastKnownBalance = balance;

    // Compute drift: expected balance = sessionStartBalance + realizedPnL
    if (state.sessionStartBalance !== null) {
        const expectedBalance = state.sessionStartBalance + state.realizedPnL;
        state.balanceDrift = Math.abs(balance - expectedBalance);

        if (state.balanceDrift > 0.01) {
            tradeLogger.warn({
                accountId,
                expectedBalance,
                actualBalance: balance,
                drift: state.balanceDrift,
                realizedPnL: state.realizedPnL,
            }, 'Balance drift detected');
            metrics.counter('pnl.balance_drift_detected');
        }
    }

    state.lastUpdated = Date.now();
}

/**
 * Get current PnL snapshot for an account
 */
export function getPnLSnapshot(accountId: string): PnLState | null {
    return pnlStates.get(accountId) ?? null;
}

/**
 * Reset PnL state for day rollover
 */
export function resetDailyPnL(accountId: string): void {
    const state = pnlStates.get(accountId);
    if (!state) return;

    state.realizedPnL = 0;
    state.winCount = 0;
    state.lossCount = 0;
    state.avgWin = 0;
    state.avgLoss = 0;

    // Keep open positions — they carry over
    recomputeUnrealized(state);
    state.netPnL = state.unrealizedPnL;

    if (state.lastKnownBalance !== null) {
        state.sessionStartBalance = state.lastKnownBalance;
    }
    state.balanceDrift = null;
    state.lastUpdated = Date.now();

    broadcastPnL(accountId, state);
}

/**
 * Clean up PnL state for an account (e.g., on logout)
 */
export function clearPnLState(accountId: string): void {
    pnlStates.delete(accountId);
}

// ==================== INTERNAL ====================

function recomputeUnrealized(state: PnLState): void {
    state.unrealizedPnL = 0;
    for (const pos of state.positions) {
        state.unrealizedPnL += pos.unrealizedPnL;
    }
}

// ==================== SSE STREAMING ====================

export function subscribePnLStream(accountId: string, res: Response): () => void {
    let bucket = pnlListeners.get(accountId);
    if (!bucket) {
        bucket = new Set<Response>();
        pnlListeners.set(accountId, bucket);
    }

    if (activeSseCount >= MAX_SSE_CONNECTIONS) {
        res.status(503).end('Too many active streams');
        return () => { };
    }

    bucket.add(res);
    activeSseCount++;

    const heartbeat = setInterval(() => {
        try {
            res.write(`event: ping\ndata: ${Date.now()}\n\n`);
        } catch {
            // ignore stale connections
        }
    }, PNL_HEARTBEAT_MS);
    heartbeat.unref();

    // Send current snapshot immediately on connect
    const state = pnlStates.get(accountId);
    if (state) {
        try {
            res.write(`event: pnl\ndata: ${JSON.stringify(serializePnL(state))}\n\n`);
        } catch {
            // ignore
        }
    }

    return () => {
        clearInterval(heartbeat);
        activeSseCount = Math.max(0, activeSseCount - 1);
        const set = pnlListeners.get(accountId);
        if (set) {
            set.delete(res);
            if (set.size === 0) {
                pnlListeners.delete(accountId);
            }
        }
    };
}

function broadcastPnL(accountId: string, state: PnLState): void {
    const bucket = pnlListeners.get(accountId);
    if (!bucket || bucket.size === 0) return;

    const data = JSON.stringify(serializePnL(state));
    const message = `event: pnl\ndata: ${data}\n\n`;

    for (const res of bucket) {
        try {
            res.write(message);
        } catch {
            // ignore write errors on stale connections
        }
    }
}

function serializePnL(state: PnLState): Record<string, unknown> {
    // Compute total profit/loss for frontend unification
    const totalProfit = state.winCount > 0 ? round(state.avgWin * state.winCount) : 0;
    const totalLoss = state.lossCount > 0 ? round(state.avgLoss * state.lossCount) : 0;

    return {
        realizedPnL: round(state.realizedPnL),
        unrealizedPnL: round(state.unrealizedPnL),
        netPnL: round(state.netPnL),
        openPositionCount: state.openPositionCount,
        openExposure: round(state.openExposure),
        winCount: state.winCount,
        lossCount: state.lossCount,
        avgWin: round(state.avgWin),
        avgLoss: round(state.avgLoss),
        totalProfit,
        totalLoss,
        balanceDrift: state.balanceDrift !== null ? round(state.balanceDrift) : null,
        lastKnownBalance: state.lastKnownBalance !== null ? round(state.lastKnownBalance) : null,
        lastUpdated: state.lastUpdated,
        positions: state.positions.map(p => ({
            contractId: p.contractId,
            symbol: p.symbol,
            direction: p.direction,
            buyPrice: round(p.buyPrice),
            stake: round(p.stake),
            payout: round(p.payout),
            lastMarkPrice: round(p.lastMarkPrice),
            unrealizedPnL: round(p.unrealizedPnL),
            openedAt: p.openedAt,
            botRunId: p.botRunId ?? null,
        })),
    };
}

function round(n: number): number {
    return Math.round(n * 100) / 100;
}

// ==================== EXPORTS FOR TESTING ====================

export const __test = {
    pnlStates,
    pnlListeners,
    recomputeUnrealized,
    getOrCreatePnLState,
};
