import WebSocket from 'ws';
import { ExecuteTradeParamsSchema, TradeSignalSchema, type ExecuteTradeParams } from './lib/validation';
import { getOrCreateConnection, sendMessage, cleanupConnection, registerStreamingListener, unregisterStreamingListener } from './lib/wsManager';
import { recordTradeSettled, recordTradeFailedAttempt } from './lib/riskCache';
import { tradeLogger } from './lib/logger';
import { registerPendingSettlement, clearPendingSettlement } from './lib/settlementSubscriptions';
import { persistNotification, persistOrderStatus, persistTrade } from './lib/tradePersistence';
import { metrics } from './lib/metrics';
import { LATENCY_METRICS, nowMs, recordLatency, type LatencyTrace } from './lib/latencyTracker';
import { executeProposalAndBuy, ExecutionError } from './lib/executionEngine';
import { recordReject, recordSlippageReject, recordStuckOrder } from './lib/riskManager';
import { preTradeGate } from './lib/preTradeGate';
import type { TradeRiskConfig } from './lib/riskConfig';
import { finalizeOpenContract, trackOpenContract } from './lib/openContracts';

const APP_ID = process.env.DERIV_APP_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || '1089';
interface DerivResponse {
    msg_type: string;
    error?: {
        message: string;
        code: string;
    };
    [key: string]: unknown;
}

const SETTLED_CONTRACT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SETTLED_CONTRACTS = 10000;
type ContractFinalizationState = {
    timestamp: number;
    exposureClosed: boolean;
    pnlApplied: boolean;
};

const contractFinalizations = new Map<string, ContractFinalizationState>();

// Mutex locks for settlement to prevent race conditions (SEC: TRADE-01)
const settlementLocks = new Map<string, Promise<void>>();

async function withSettlementLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    // Wait for any existing lock
    while (settlementLocks.has(key)) {
        await settlementLocks.get(key);
    }
    
    // Create our lock
    let releaseLock: () => void;
    const lock = new Promise<void>(resolve => {
        releaseLock = resolve;
    });
    settlementLocks.set(key, lock);
    
    try {
        return await fn();
    } finally {
        settlementLocks.delete(key);
        releaseLock!();
    }
}

function pruneContractFinalizations(now: number): void {
    for (const [contractKey, state] of contractFinalizations) {
        if (now - state.timestamp > SETTLED_CONTRACT_TTL_MS) {
            contractFinalizations.delete(contractKey);
        }
    }

    if (contractFinalizations.size <= MAX_SETTLED_CONTRACTS) {
        return;
    }

    const overflow = contractFinalizations.size - MAX_SETTLED_CONTRACTS;
    let removed = 0;
    for (const contractKey of contractFinalizations.keys()) {
        contractFinalizations.delete(contractKey);
        removed += 1;
        if (removed >= overflow) break;
    }
}

function getFinalizationState(accountId: string, contractId: number): ContractFinalizationState {
    const key = `${accountId}:${contractId}`;
    const existing = contractFinalizations.get(key);
    if (existing) {
        return existing;
    }
    const state: ContractFinalizationState = {
        timestamp: Date.now(),
        exposureClosed: false,
        pnlApplied: false,
    };
    contractFinalizations.set(key, state);
    return state;
}

function recordTradeSettledOnce(accountId: string, contractId: number, stake: number, profit: number): boolean {
    if (!Number.isFinite(contractId)) {
        recordTradeSettled(accountId, stake, profit);
        return true;
    }
    const state = getFinalizationState(accountId, contractId);
    if (state.pnlApplied) {
        return false;
    }
    state.pnlApplied = true;
    state.timestamp = Date.now();

    const skipExposure = state.exposureClosed;
    state.exposureClosed = true;

    recordTradeSettled(accountId, stake, profit, { skipExposure });

    if (contractFinalizations.size > MAX_SETTLED_CONTRACTS) {
        pruneContractFinalizations(state.timestamp);
    }

    return true;
}

function recordTradeFailedAttemptOnce(accountId: string, contractId: number | null, stake: number): void {
    if (!Number.isFinite(contractId)) {
        recordTradeFailedAttempt(accountId, stake);
        return;
    }
    const id = contractId as number;
    const state = getFinalizationState(accountId, id);
    if (state.exposureClosed) {
        return;
    }
    state.exposureClosed = true;
    state.timestamp = Date.now();
    recordTradeFailedAttempt(accountId, stake);
    if (contractFinalizations.size > MAX_SETTLED_CONTRACTS) {
        pruneContractFinalizations(state.timestamp);
    }
}

/**
 * Calculate duration in milliseconds from duration value and unit
 */
function calculateDurationMs(duration: number, durationUnit: string): number {
    switch (durationUnit) {
        case 't': // ticks - estimate ~1 second per tick
            return duration * 1000;
        case 's': // seconds
            return duration * 1000;
        case 'm': // minutes
            return duration * 60 * 1000;
        case 'h': // hours
            return duration * 60 * 60 * 1000;
        case 'd': // days
            return duration * 24 * 60 * 60 * 1000;
        default:
            return duration * 1000; // Default to seconds
    }
}

export interface TradeResult {
    contractId: number;
    profit: number;
    status?: string;
}

/**
 * Fast trade result - returned immediately on buy confirmation
 * Profit is 0 until settlement (handled async)
 */
export interface TradeResultFast {
    contractId: number;
    buyPrice: number;
    payout: number;
    status: 'open';
    executionTimeMs: number;
}

// executeTradeServer removed (Moved to archive/legacyTrade.ts)

/**
 * Fast trade execution using persistent WebSocket
 * Returns immediately on buy confirmation (fire-and-forget)
 * Settlement handled asynchronously
 */
export async function executeTradeServerFast(
    signal: 'CALL' | 'PUT',
    params: ExecuteTradeParams,
    auth: { token: string; accountId: string; accountType: 'real' | 'demo'; accountCurrency?: string | null },
    riskOverrides?: Partial<TradeRiskConfig>,
    latencyTrace?: LatencyTrace,
    preGate?: { stake: number; risk: TradeRiskConfig }
): Promise<TradeResultFast> {
    const startTime = Date.now();

    const signalValidation = TradeSignalSchema.safeParse(signal);
    if (!signalValidation.success) {
        throw new Error('Invalid trade signal');
    }

    const paramsValidation = ExecuteTradeParamsSchema.safeParse(params);
    if (!paramsValidation.success) {
        throw new Error(`Invalid trade parameters: ${paramsValidation.error.issues.map(e => e.message).join(', ')}`);
    }

    const { token, accountId, accountType, accountCurrency } = auth;
    let stake = params.stake;

    const gate = preGate ?? preTradeGate({
        accountId,
        stake,
        botRunId: params.botRunId ?? null,
        riskOverrides,
    }, latencyTrace);
    stake = gate.stake;

    try {
        const execResult = await executeProposalAndBuy({
            accountId,
            token,
            signal,
            stake,
            symbol: params.symbol,
            duration: params.duration || 5,
            durationUnit: params.durationUnit || 't',
            currency: accountCurrency || 'USD',
            entryMode: params.entryMode || 'MARKET',
            entryTargetPrice: params.entryTargetPrice,
            entrySlippagePct: params.entrySlippagePct ?? 1.5,
        });

        if (latencyTrace) {
            latencyTrace.proposalSentTs = execResult.proposalSentTs;
            latencyTrace.orderSentTs = execResult.proposalSentTs;
            latencyTrace.proposalAckTs = execResult.proposalAckTs;
            latencyTrace.buySentTs = execResult.buySentTs;
            latencyTrace.buyAckTs = execResult.buyAckTs;
        }
        recordLatency(LATENCY_METRICS.decisionToSend, latencyTrace?.decisionTs, execResult.proposalSentTs);
        recordLatency(LATENCY_METRICS.sendToProposalAck, execResult.proposalSentTs, execResult.proposalAckTs);
        recordLatency(LATENCY_METRICS.sendToBuyAck, execResult.buySentTs, execResult.buyAckTs);
        recordLatency(LATENCY_METRICS.gateToProposal, latencyTrace?.gateEndTs, execResult.proposalSentTs);
        recordLatency(LATENCY_METRICS.proposalRtt, execResult.proposalSentTs, execResult.proposalAckTs);
        recordLatency(LATENCY_METRICS.buyRtt, execResult.buySentTs, execResult.buyAckTs);
        recordLatency(LATENCY_METRICS.tickToBuyAck, latencyTrace?.tickReceivedTs, execResult.buyAckTs);
        metrics.counter('trade.proposal_sent');
        metrics.counter('trade.proposal_ack');
        metrics.counter('trade.buy_sent');
        metrics.counter('trade.buy_ack');

        const buy = execResult.buy;

        trackOpenContract(accountId, {
            contractId: buy.contract_id,
            stake,
            symbol: params.symbol,
            openedAt: Date.now(),
            botRunId: params.botRunId ?? null,
            botId: params.botId ?? null,
        });

        const executionTimeMs = Date.now() - startTime;
        metrics.histogram('trade.execution_ms', executionTimeMs);

        // Persist order status asynchronously
        persistOrderStatus({
            accountId,
            contractId: buy.contract_id,
            event: 'buy_confirmed',
            status: 'open',
            latencyMs: executionTimeMs,
            price: buy.buy_price,
            payload: buy,
        }).catch(err => tradeLogger.error({ err }, 'Order status persist failed'));

        // Fire async settlement tracking (don't await)
        trackSettlementAsync(accountId, accountType, buy.contract_id, stake, params, latencyTrace)
            .catch(err => tradeLogger.error({ err }, 'Settlement tracking failed'));

        return {
            contractId: buy.contract_id,
            buyPrice: buy.buy_price,
            payout: buy.payout ?? 0,
            status: 'open',
            executionTimeMs,
        };

    } catch (error) {
        metrics.counter('trade.error');
        if (error instanceof ExecutionError) {
            if (error.code === 'SLIPPAGE_EXCEEDED') {
                metrics.counter('trade.slippage_reject');
                recordSlippageReject(accountId);
                persistOrderStatus({
                    accountId,
                    event: 'slippage_reject',
                    status: 'slippage_exceeded',
                    price: typeof error.meta?.askPrice === 'number' ? error.meta.askPrice : null,
                    payload: error.meta ?? null,
                }).catch(err => tradeLogger.error({ err }, 'Order status persist failed'));
            }
            if (error.code === 'THROTTLE') {
                metrics.counter('trade.throttle_reject');
            }
            if (error.code === 'PROPOSAL_REJECT') {
                metrics.counter('trade.proposal_reject');
                recordReject(accountId);
            }
            if (error.code === 'BUY_REJECT') {
                metrics.counter('trade.buy_reject');
                recordReject(accountId);
            }
        } else if (error instanceof Error) {
            if (error.message.toLowerCase().includes('slippage')) {
                metrics.counter('trade.slippage_reject');
            }
        }
        // Rollback concurrent trade count on failure (do not touch streaks)
        recordTradeFailedAttemptOnce(accountId, null, stake);
        throw error;
    }
}

/**
 * Track settlement asynchronously after buy confirmation
 * Uses streaming listener to properly wait for is_sold=true
 */
async function trackSettlementAsync(
    accountId: string,
    accountType: 'real' | 'demo',
    contractId: number,
    stake: number,
    params: ExecuteTradeParams,
    latencyTrace?: LatencyTrace
): Promise<void> {
    // Calculate timeout based on trade duration + buffer
    const durationMs = calculateDurationMs(params.duration ?? 5, params.durationUnit ?? 't');
    const BUFFER_MS = 30 * 1000; // 30 second buffer for settlement processing
    const MIN_TIMEOUT_MS = 30 * 1000; // Minimum 30 seconds
    const MAX_TIMEOUT_MS = 10 * 60 * 1000; // Maximum 10 minutes
    const SETTLEMENT_TIMEOUT_MS = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(MIN_TIMEOUT_MS, durationMs + BUFFER_MS)
    );

    let subscriptionId: string | undefined;

    try {
        registerPendingSettlement(accountId, contractId);
        // First, subscribe to contract updates
        const subscribeResponse = await sendMessage<{
            proposal_open_contract?: {
                contract_id: number;
                is_sold: boolean;
                profit: number;
                status?: string;
                payout?: number;
            };
            subscription?: { id: string };
            error?: { message: string };
        }>(accountId, {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
        }, 30000);

        if (subscribeResponse.error) {
            tradeLogger.error({ error: subscribeResponse.error.message, contractId }, 'Settlement subscription failed');
            recordTradeFailedAttemptOnce(accountId, contractId, stake); // Decrement concurrent count only
            clearPendingSettlement(accountId, contractId);
            return;
        }

        subscriptionId = subscribeResponse.subscription?.id;

        // Check if already settled in the initial response
        const initialContract = subscribeResponse.proposal_open_contract;
        if (initialContract?.is_sold) {
            const fillPerfTs = nowMs();
            if (latencyTrace) {
                latencyTrace.fillTs = fillPerfTs;
                latencyTrace.settleTs = fillPerfTs;
            }
            recordLatency(LATENCY_METRICS.sendToFill, latencyTrace?.orderSentTs, fillPerfTs);
            recordLatency(LATENCY_METRICS.buyToSettle, latencyTrace?.buyAckTs, fillPerfTs);
            recordLatency(LATENCY_METRICS.tickToSettle, latencyTrace?.tickReceivedTs, fillPerfTs);
            metrics.counter('trade.fill');
            await handleSettlement(accountId, accountType, stake, params, initialContract);
            clearPendingSettlement(accountId, contractId);
            return;
        }

        // Wait for settlement via streaming listener
        const settledContract = await new Promise<{
            contract_id: number;
            is_sold: boolean;
            profit: number;
            status?: string;
            payout?: number;
        } | null>((resolve) => {
            let settled = false;
            let timeout: ReturnType<typeof setTimeout> | null = null;

            const listener = (_accId: string, message: Record<string, unknown>) => {
                if (settled) return;

                if (message.msg_type === 'proposal_open_contract') {
                    const contract = message.proposal_open_contract as {
                        contract_id: number;
                        is_sold: boolean;
                        profit: number;
                        status?: string;
                        payout?: number;
                    };

                    if (contract.contract_id === contractId && contract.is_sold) {
                        settled = true;
                        if (timeout) {
                            clearTimeout(timeout);
                            timeout = null;
                        }
                        const fillPerfTs = nowMs();
                        if (latencyTrace) {
                            latencyTrace.fillTs = fillPerfTs;
                            latencyTrace.settleTs = fillPerfTs;
                        }
                        recordLatency(LATENCY_METRICS.sendToFill, latencyTrace?.orderSentTs, fillPerfTs);
                        recordLatency(LATENCY_METRICS.buyToSettle, latencyTrace?.buyAckTs, fillPerfTs);
                        recordLatency(LATENCY_METRICS.tickToSettle, latencyTrace?.tickReceivedTs, fillPerfTs);
                        metrics.counter('trade.fill');
                        unregisterStreamingListener(accountId, listener);
                        clearPendingSettlement(accountId, contractId);
                        resolve(contract);
                    }
                }
            };

            // Register listener
            registerStreamingListener(accountId, listener);

            // Timeout fallback
            timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    timeout = null;
                    unregisterStreamingListener(accountId, listener);
                    tradeLogger.warn({ contractId }, 'Settlement timeout - contract not sold within timeout');
                    recordStuckOrder(accountId, contractId);
                    clearPendingSettlement(accountId, contractId);
                    resolve(null);
                }
            }, SETTLEMENT_TIMEOUT_MS);
        });

        if (settledContract) {
            await handleSettlement(accountId, accountType, stake, params, settledContract);
        } else {
            // Timeout case - still decrement concurrent count
            recordTradeFailedAttemptOnce(accountId, contractId, stake);
        }

    } catch (error) {
        tradeLogger.error({ error, contractId }, 'Settlement tracking error');
        recordTradeFailedAttemptOnce(accountId, contractId, stake);
        clearPendingSettlement(accountId, contractId);
    } finally {
        // Always attempt to forget the subscription to stop updates
        if (subscriptionId) {
            sendMessage(accountId, { forget: subscriptionId }).catch((err) => {
                // Ignore forget errors (e.g. if connection closed)
                tradeLogger.debug({ error: err, contractId }, 'Failed to forget settlement subscription');
            });
        }
    }
}

/**
 * Handle contract settlement - persist trade and notifications
 */
async function handleSettlement(
    accountId: string,
    accountType: 'real' | 'demo',
    stake: number,
    params: ExecuteTradeParams,
    contract: { contract_id: number; is_sold: boolean; profit: number; status?: string; payout?: number }
): Promise<void> {
    const state = getFinalizationState(accountId, contract.contract_id);
    if (state.pnlApplied) {
        return;
    }

    if (!recordTradeSettledOnce(accountId, contract.contract_id, stake, contract.profit)) {
        return;
    }

    finalizeOpenContract(accountId, contract.contract_id);

    // Persist trade to database (queued)
    persistTrade({
        accountId,
        accountType,
        botId: params.botId ?? null,
        botRunId: params.botRunId ?? null,
        contractId: contract.contract_id,
        symbol: params.symbol,
        stake,
        duration: params.duration || 5,
        durationUnit: params.durationUnit || 't',
        profit: contract.profit,
        status: contract.status || 'settled',
        entryProfileId: params.entryProfileId ?? null,
    }).then((tradeId) => {
        persistOrderStatus({
            accountId,
            tradeId: tradeId ?? null,
            contractId: contract.contract_id,
            event: 'contract_settled',
            status: contract.status || 'settled',
            payload: {
                profit: contract.profit,
                payout: contract.payout,
            },
        }).catch(err => tradeLogger.error({ err }, 'Order status persist failed'));
    }).catch((err) => tradeLogger.error({ err }, 'Trade persistence failed'));

    // Send notification (queued)
    persistNotification({
        accountId,
        title: contract.profit >= 0 ? 'Trade Won' : 'Trade Lost',
        body: `Contract #${contract.contract_id} settled with ${contract.profit >= 0 ? '+' : ''}${contract.profit.toFixed(2)}`,
        type: 'trade_result',
        data: {
            contractId: contract.contract_id,
            profit: contract.profit,
            status: contract.status,
            symbol: params.symbol,
        },
    }).catch((err) => tradeLogger.error({ err }, 'Notification persistence failed'));
}
