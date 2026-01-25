import WebSocket from 'ws';
import { getSupabaseAdmin } from './lib/supabaseAdmin';
import { ExecuteTradeParamsSchema, TradeSignalSchema, type ExecuteTradeParams } from './lib/validation';
import { getOrCreateConnection, sendMessage, cleanupConnection, registerStreamingListener, unregisterStreamingListener } from './lib/wsManager';
import {
    getRiskCache,
    initializeRiskCache,
    recordTradeOpened,
    recordTradeSettled,
    evaluateCachedRisk
} from './lib/riskCache';
import { tradeLogger } from './lib/logger';
import { registerPendingSettlement, clearPendingSettlement } from './lib/settlementSubscriptions';
import { persistNotification, persistOrderStatus, persistTrade } from './lib/tradePersistence';
import { metrics } from './lib/metrics';
import { LATENCY_METRICS, nowMs, recordLatency, type LatencyTrace } from './lib/latencyTracker';
import { executeProposalAndBuy, ExecutionError } from './lib/executionEngine';
import { isKillSwitchActive, preTradeCheck, recordReject, recordSlippageReject, recordStuckOrder } from './lib/riskManager';

const APP_ID = process.env.DERIV_APP_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || '1089';
const { client: supabaseAdmin } = getSupabaseAdmin();

interface DerivResponse {
    msg_type: string;
    error?: {
        message: string;
        code: string;
    };
    [key: string]: unknown;
}

interface RiskConfig {
    stopLoss: number;
    takeProfit: number;
    dailyLossLimitPct: number;
    drawdownLimitPct: number;
    maxConsecutiveLosses: number;
    lossCooldownMs: number;
}

const RISK_DEFAULTS: RiskConfig = {
    stopLoss: 0,
    takeProfit: 0,
    dailyLossLimitPct: 2,
    drawdownLimitPct: 6,
    maxConsecutiveLosses: 3,
    lossCooldownMs: 2 * 60 * 60 * 1000,
};

const SETTLED_CONTRACT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SETTLED_CONTRACTS = 10000;
const settledContracts = new Map<number, number>();

function pruneSettledContracts(now: number): void {
    for (const [contractId, timestamp] of settledContracts) {
        if (now - timestamp > SETTLED_CONTRACT_TTL_MS) {
            settledContracts.delete(contractId);
        }
    }

    if (settledContracts.size <= MAX_SETTLED_CONTRACTS) {
        return;
    }

    const overflow = settledContracts.size - MAX_SETTLED_CONTRACTS;
    let removed = 0;
    for (const contractId of settledContracts.keys()) {
        settledContracts.delete(contractId);
        removed += 1;
        if (removed >= overflow) break;
    }
}

function markContractSettled(contractId: number): boolean {
    const now = Date.now();
    const existing = settledContracts.get(contractId);
    if (existing && now - existing < SETTLED_CONTRACT_TTL_MS) {
        return false;
    }
    settledContracts.set(contractId, now);
    if (settledContracts.size > MAX_SETTLED_CONTRACTS) {
        pruneSettledContracts(now);
    }
    return true;
}

function recordTradeSettledOnce(accountId: string, contractId: number, stake: number, profit: number): boolean {
    if (!Number.isFinite(contractId)) {
        recordTradeSettled(accountId, stake, profit);
        return true;
    }
    if (!markContractSettled(contractId)) {
        return false;
    }
    recordTradeSettled(accountId, stake, profit);
    return true;
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

const toNumber = (value: unknown, fallback = 0) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
};

const getUtcDayRange = () => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return {
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        dateKey: start.toISOString().slice(0, 10),
        now,
    };
};

async function getSettingValue(accountId: string, key: string) {
    if (!supabaseAdmin) return null;
    const { data } = await supabaseAdmin
        .from('settings')
        .select('value')
        .eq('account_id', accountId)
        .eq('key', key)
        .maybeSingle();
    return data?.value ?? null;
}

async function getRiskConfig(accountId: string, botRunId?: string | null) {
    if (!supabaseAdmin) return null;
    let runConfig: { risk?: Partial<RiskConfig> } | null = null;

    if (botRunId) {
        const { data } = await supabaseAdmin
            .from('bot_runs')
            .select('config')
            .eq('account_id', accountId)
            .eq('id', botRunId)
            .maybeSingle();
        runConfig = data?.config ?? null;
    }

    if (!runConfig) {
        const { data } = await supabaseAdmin
            .from('bot_runs')
            .select('config')
            .eq('account_id', accountId)
            .eq('run_status', 'running')
            .order('started_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        runConfig = data?.config ?? null;
    }

    const risk = runConfig && typeof runConfig === 'object' ? (runConfig as { risk?: Partial<RiskConfig> }).risk : null;
    return risk ?? null;
}

async function enforceServerRisk(accountId: string, botRunId?: string | null) {
    if (!supabaseAdmin) {
        throw new Error('Risk engine unavailable - database not configured');
    }

    const [riskConfig, riskStateValue, balanceSnapshot] = await Promise.all([
        getRiskConfig(accountId, botRunId),
        getSettingValue(accountId, 'risk_state'),
        getSettingValue(accountId, 'balance_snapshot'),
    ]);

    const risk: RiskConfig = {
        stopLoss: toNumber(riskConfig?.stopLoss, RISK_DEFAULTS.stopLoss),
        takeProfit: toNumber(riskConfig?.takeProfit, RISK_DEFAULTS.takeProfit),
        dailyLossLimitPct: toNumber(riskConfig?.dailyLossLimitPct, RISK_DEFAULTS.dailyLossLimitPct),
        drawdownLimitPct: toNumber(riskConfig?.drawdownLimitPct, RISK_DEFAULTS.drawdownLimitPct),
        maxConsecutiveLosses: Math.max(0, Math.floor(toNumber(riskConfig?.maxConsecutiveLosses, RISK_DEFAULTS.maxConsecutiveLosses))),
        lossCooldownMs: toNumber(riskConfig?.lossCooldownMs, RISK_DEFAULTS.lossCooldownMs),
    };

    const { startIso, endIso, dateKey, now } = getUtcDayRange();

    const { data: trades } = await supabaseAdmin
        .from('trades')
        .select('profit, created_at')
        .eq('account_id', accountId)
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .order('created_at', { ascending: false })
        .limit(2000);

    let totalLossToday = 0;
    let totalProfitToday = 0;
    let lossStreak = 0;
    let streakComputed = false;

    // Trades are ordered newest-first; compute streak from most recent until first win
    (trades || []).forEach((trade) => {
        const profit = Number(trade.profit ?? 0);
        if (profit < 0) {
            totalLossToday += Math.abs(profit);
            if (!streakComputed) {
                lossStreak += 1;
            }
        } else {
            totalProfitToday += profit;
            streakComputed = true; // Stop counting streak after first win
        }
    });

    const riskState = riskStateValue && typeof riskStateValue === 'object' ? riskStateValue as {
        date?: string;
        dailyStartEquity?: number;
        equityPeak?: number;
    } : null;

    const snapshot = balanceSnapshot && typeof balanceSnapshot === 'object' ? balanceSnapshot as {
        balance?: number;
        asOf?: string;
    } : null;

    const balance = typeof snapshot?.balance === 'number' ? snapshot?.balance : null;
    const dailyStartEquity = riskState?.date === dateKey ? riskState?.dailyStartEquity ?? balance : balance;
    const equityPeak = riskState?.date === dateKey ? riskState?.equityPeak ?? balance : balance;

    if (typeof risk.dailyLossLimitPct === 'number' && risk.dailyLossLimitPct > 0 && typeof dailyStartEquity === 'number') {
        const dailyLossLimit = (risk.dailyLossLimitPct / 100) * dailyStartEquity;
        if (totalLossToday >= dailyLossLimit) {
            throw new Error('Daily loss limit reached');
        }
    }

    if (typeof risk.drawdownLimitPct === 'number' && risk.drawdownLimitPct > 0 && typeof equityPeak === 'number' && typeof balance === 'number') {
        const drawdown = ((equityPeak - balance) / equityPeak) * 100;
        if (drawdown >= risk.drawdownLimitPct) {
            throw new Error('Drawdown limit reached');
        }
    }

    if (risk.maxConsecutiveLosses > 0 && lossStreak >= risk.maxConsecutiveLosses) {
        const lastLossTime = trades?.[0]?.created_at ? new Date(trades[0].created_at).getTime() : null;
        if (lastLossTime && now.getTime() - lastLossTime < risk.lossCooldownMs) {
            throw new Error('Loss cooldown active');
        }
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

export async function executeTradeServer(
    signal: 'CALL' | 'PUT',
    params: ExecuteTradeParams,
    auth: { token: string; accountId: string; accountType: 'real' | 'demo'; accountCurrency?: string | null },
    latencyTrace?: LatencyTrace
): Promise<TradeResult> {
    const signalValidation = TradeSignalSchema.safeParse(signal);
    if (!signalValidation.success) {
        throw new Error('Invalid trade signal');
    }

    const paramsValidation = ExecuteTradeParamsSchema.safeParse(params);
    if (!paramsValidation.success) {
        throw new Error(`Invalid trade parameters: ${paramsValidation.error.issues.map(e => e.message).join(', ')}`);
    }

    const { token, accountId, accountType, accountCurrency } = auth;

    if (isKillSwitchActive(accountId)) {
        throw new Error('Kill switch active');
    }

    await enforceServerRisk(accountId, params.botRunId ?? null);

    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);
        let reqId = 1;
        const getReqId = () => reqId++;
        const timestamps = {
            proposalRequestedAt: 0,
            proposalReceivedAt: 0,
            buySentAt: 0,
            buyConfirmedAt: 0,
        };
        let proposalSentPerfTs: number | null = null;
        let buySentPerfTs: number | null = null;
        let contractId: number | null = null;

        const cleanup = () => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        };

        // Calculate timeout based on duration + buffer
        const parseDurationToMs = (duration: number, unit: string): number => {
            switch (unit) {
                case 't': return duration * 2000; // ~2s per tick
                case 's': return duration * 1000;
                case 'm': return duration * 60 * 1000;
                case 'h': return duration * 60 * 60 * 1000;
                case 'd': return duration * 24 * 60 * 60 * 1000;
                default: return duration * 1000;
            }
        };
        const baseDurationMs = parseDurationToMs(params.duration || 5, params.durationUnit || 't');
        const timeoutMs = Math.max(30000, baseDurationMs + 15000); // Min 30s, or duration + 15s buffer

        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Trade execution timed out'));
        }, timeoutMs);

        ws.on('open', () => {
            ws.send(JSON.stringify({ authorize: token, req_id: getReqId() }));
        });

        ws.on('message', (data) => {
            let response: DerivResponse | null = null;
            try {
                response = JSON.parse(data.toString()) as DerivResponse;
            } catch {
                return;
            }
            if (!response) return;

            if (response.error) {
                metrics.counter('trade.error');
                if (timestamps.proposalRequestedAt && !timestamps.proposalReceivedAt) {
                    metrics.counter('trade.proposal_reject');
                } else if (timestamps.buySentAt && !timestamps.buyConfirmedAt) {
                    metrics.counter('trade.buy_reject');
                }
                recordReject(accountId);
                persistOrderStatus({
                    accountId,
                    contractId,
                    event: 'error',
                    status: response.error.code || 'error',
                    payload: { message: response.error.message, code: response.error.code },
                }).catch((err) => tradeLogger.error({ err }, 'Order status error persist failed'));
                cleanup();
                clearTimeout(timeout);
                reject(new Error(response.error.message));
                return;
            }

            if (response.msg_type === 'authorize') {
                timestamps.proposalRequestedAt = Date.now();
                const proposalReq = {
                    proposal: 1,
                    amount: params.stake,
                    basis: 'stake',
                    contract_type: signal,
                    currency: accountCurrency || 'USD',
                    duration: params.duration || 5,
                    duration_unit: params.durationUnit || 't',
                    symbol: params.symbol,
                    req_id: getReqId(),
                };
                proposalSentPerfTs = nowMs();
                if (latencyTrace) {
                    latencyTrace.orderSentTs = proposalSentPerfTs;
                }
                recordLatency(LATENCY_METRICS.decisionToSend, latencyTrace?.decisionTs, proposalSentPerfTs);
                ws.send(JSON.stringify(proposalReq));
                metrics.counter('trade.proposal_sent');
                persistOrderStatus({
                    accountId,
                    event: 'proposal_requested',
                    payload: proposalReq,
                }).catch((err) => tradeLogger.error({ err }, 'Order status persist failed'));
            }

            if (response.msg_type === 'proposal') {
                const proposal = response.proposal as { id?: string; ask_price?: number; payout?: number; spot?: number };
                const entryMode = params.entryMode;
                const entryTargetPrice = params.entryTargetPrice;
                const entrySlippagePct = params.entrySlippagePct;
                const proposalAckPerfTs = nowMs();
                if (latencyTrace) {
                    latencyTrace.proposalAckTs = proposalAckPerfTs;
                }
                recordLatency(
                    LATENCY_METRICS.sendToProposalAck,
                    proposalSentPerfTs ?? latencyTrace?.orderSentTs,
                    proposalAckPerfTs
                );
                metrics.counter('trade.proposal_ack');
                timestamps.proposalReceivedAt = Date.now();
                const proposalLatency = timestamps.proposalRequestedAt
                    ? timestamps.proposalReceivedAt - timestamps.proposalRequestedAt
                    : null;
                persistOrderStatus({
                    accountId,
                    event: 'proposal_received',
                    latencyMs: proposalLatency,
                    price: proposal.ask_price ?? null,
                    payload: {
                        spot: proposal.spot,
                        ask_price: proposal.ask_price,
                        payout: proposal.payout,
                    },
                }).catch((err) => tradeLogger.error({ err }, 'Order status persist failed'));

                if (
                    entryMode === 'HYBRID_LIMIT_MARKET'
                    && typeof entryTargetPrice === 'number'
                    && Number.isFinite(entryTargetPrice)
                    && typeof entrySlippagePct === 'number'
                    && Number.isFinite(entrySlippagePct)
                    && entryTargetPrice > 0
                ) {
                    const spot = Number(proposal.spot);
                    if (Number.isFinite(spot)) {
                        const slippagePct = Math.abs((spot - entryTargetPrice) / entryTargetPrice) * 100;
                        if (slippagePct > entrySlippagePct) {
                            metrics.counter('trade.slippage_reject');
                            recordSlippageReject(accountId);
                            persistOrderStatus({
                                accountId,
                                event: 'slippage_reject',
                                status: 'slippage_exceeded',
                                price: proposal.ask_price ?? null,
                                payload: {
                                    spot,
                                    entryTargetPrice,
                                    slippagePct,
                                    tolerancePct: entrySlippagePct,
                                },
                            }).catch((err) => tradeLogger.error({ err }, 'Order status persist failed'));
                            cleanup();
                            clearTimeout(timeout);
                            reject(new Error('Slippage exceeded tolerance'));
                            return;
                        }
                    }
                }
                const buyReq = {
                    buy: proposal.id,
                    price: proposal.ask_price,
                    req_id: getReqId(),
                };
                buySentPerfTs = nowMs();
                if (latencyTrace) {
                    latencyTrace.buySentTs = buySentPerfTs;
                }
                timestamps.buySentAt = Date.now();
                ws.send(JSON.stringify(buyReq));
                metrics.counter('trade.buy_sent');
                persistOrderStatus({
                    accountId,
                    event: 'buy_sent',
                    price: proposal.ask_price ?? null,
                    payload: buyReq,
                }).catch((err) => tradeLogger.error({ err }, 'Order status persist failed'));
            }

            if (response.msg_type === 'buy') {
                const buy = response.buy as { contract_id: number; buy_price?: number; payout?: number };
                contractId = buy.contract_id;
                const buyAckPerfTs = nowMs();
                if (latencyTrace) {
                    latencyTrace.buyAckTs = buyAckPerfTs;
                }
                recordLatency(LATENCY_METRICS.sendToBuyAck, buySentPerfTs ?? latencyTrace?.buySentTs, buyAckPerfTs);
                metrics.counter('trade.buy_ack');
                timestamps.buyConfirmedAt = Date.now();
                const buyLatency = timestamps.buySentAt
                    ? timestamps.buyConfirmedAt - timestamps.buySentAt
                    : null;
                persistOrderStatus({
                    accountId,
                    contractId,
                    event: 'buy_confirmed',
                    latencyMs: buyLatency,
                    price: buy.buy_price ?? null,
                    payload: buy,
                }).catch((err) => tradeLogger.error({ err }, 'Order status persist failed'));
                persistNotification({
                    accountId,
                    title: 'Order Executed',
                    body: `Contract #${buy.contract_id} opened on ${params.symbol}`,
                    type: 'order_status',
                    data: {
                        contractId: buy.contract_id,
                        symbol: params.symbol,
                        status: 'open',
                    },
                }).catch((err) => tradeLogger.error({ err }, 'Notification persistence failed'));
                ws.send(JSON.stringify({
                    proposal_open_contract: 1,
                    contract_id: contractId,
                    subscribe: 1,
                    req_id: getReqId()
                }));
            }

            if (response.msg_type === 'proposal_open_contract') {
                const contract = response.proposal_open_contract as { contract_id: number; is_sold: boolean; profit: number; payout?: number; status?: string };
                if (contract.is_sold) {
                    const fillPerfTs = nowMs();
                    if (latencyTrace) {
                        latencyTrace.fillTs = fillPerfTs;
                    }
                    recordLatency(LATENCY_METRICS.sendToFill, latencyTrace?.orderSentTs ?? proposalSentPerfTs ?? undefined, fillPerfTs);
                    metrics.counter('trade.fill');
                    cleanup();
                    clearTimeout(timeout);
                    resolve({
                        contractId: contract.contract_id,
                        profit: contract.profit,
                        status: contract.status,
                    });

                    persistTrade({
                        accountId,
                        accountType,
                        botId: params.botId ?? null,
                        botRunId: params.botRunId ?? null,
                        contractId: contract.contract_id,
                        symbol: params.symbol,
                        stake: params.stake,
                        duration: params.duration || 5,
                        durationUnit: params.durationUnit || 't',
                        profit: contract.profit,
                        status: contract.status || 'settled',
                        entryProfileId: params.entryProfileId ?? null,
                    }).then((tradeId) => {
                        const totalLatency = timestamps.buyConfirmedAt
                            ? Date.now() - timestamps.buyConfirmedAt
                            : null;
                        persistOrderStatus({
                            accountId,
                            tradeId,
                            contractId: contract.contract_id,
                            event: 'contract_settled',
                            status: contract.status || 'settled',
                            latencyMs: totalLatency,
                            payload: {
                                profit: contract.profit,
                                payout: contract.payout,
                            },
                        }).catch((err) => tradeLogger.error({ err }, 'Order status persist failed'));
                    }).catch((err) => tradeLogger.error({ err }, 'Trade persistence failed'));

                    persistNotification({
                        accountId,
                        title: contract.profit >= 0 ? 'Trade Won' : 'Trade Lost',
                        body: `Contract #${contract.contract_id} settled with ${contract.profit >= 0 ? '+' : ''}${Number(contract.profit).toFixed(2)}`,
                        type: 'trade_result',
                        data: {
                            contractId: contract.contract_id,
                            profit: contract.profit,
                            status: contract.status,
                            symbol: params.symbol,
                        },
                    }).catch((err) => tradeLogger.error({ err }, 'Notification persistence failed'));
                }
            }
        });

        ws.on('error', (err) => {
            persistOrderStatus({
                accountId,
                contractId,
                event: 'error',
                status: 'socket_error',
                payload: { message: err.message },
            }).catch((error) => tradeLogger.error({ error }, 'Order status error persist failed'));
            cleanup();
            clearTimeout(timeout);
            reject(err);
        });
    });
}

/**
 * Fast trade execution using persistent WebSocket
 * Returns immediately on buy confirmation (fire-and-forget)
 * Settlement handled asynchronously
 */
export async function executeTradeServerFast(
    signal: 'CALL' | 'PUT',
    params: ExecuteTradeParams,
    auth: { token: string; accountId: string; accountType: 'real' | 'demo'; accountCurrency?: string | null },
    riskOverrides?: {
        dailyLossLimitPct?: number;
        drawdownLimitPct?: number;
        maxConsecutiveLosses?: number;
        cooldownMs?: number;
        lossCooldownMs?: number;
        maxStake?: number;
        maxConcurrentTrades?: number;
        maxOrderSize?: number;
        maxNotional?: number;
        maxExposure?: number;
        maxOrdersPerSecond?: number;
        maxOrdersPerMinute?: number;
        maxCancelsPerSecond?: number;
    },
    latencyTrace?: LatencyTrace
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
    if (isKillSwitchActive(accountId)) {
        throw new Error('Kill switch active');
    }
    let stake = params.stake;

    // Check cached risk - fast path
    let riskEntry = getRiskCache(accountId);
    if (!riskEntry) {
        // Initialize cache from balance
        const balanceSnapshot = await getSettingValue(accountId, 'balance_snapshot');
        const snapshot = balanceSnapshot && typeof balanceSnapshot === 'object'
            ? balanceSnapshot as { balance?: number }
            : null;
        const balance = typeof snapshot?.balance === 'number' ? snapshot.balance : 10000;
        riskEntry = initializeRiskCache(accountId, { equity: balance });
    }

    // Fast risk evaluation from cache
    const riskStatus = evaluateCachedRisk(accountId, {
        proposedStake: stake,
        maxStake: riskOverrides?.maxStake ?? params.stake * 10, // Allow reasonable stakes
        dailyLossLimitPct: riskOverrides?.dailyLossLimitPct ?? 2,
        drawdownLimitPct: riskOverrides?.drawdownLimitPct ?? 6,
        maxConsecutiveLosses: riskOverrides?.maxConsecutiveLosses ?? 3,
        cooldownMs: riskOverrides?.cooldownMs ?? 3000, // 3s cooldown between trades
        lossCooldownMs: riskOverrides?.lossCooldownMs ?? 60000, // 1 min after max loss streak
        maxConcurrentTrades: riskOverrides?.maxConcurrentTrades,
    });

    if (riskStatus.status === 'HALT') {
        throw new Error(riskStatus.reason === 'DAILY_LOSS'
            ? 'Daily loss limit reached'
            : 'Drawdown limit reached');
    }

    if (riskStatus.status === 'MAX_CONCURRENT') {
        throw new Error('Maximum concurrent trades reached (5)');
    }

    if (riskStatus.status === 'COOLDOWN') {
        const waitMs = riskStatus.cooldownMs ?? 1000;
        throw new Error(`Cooldown active - wait ${Math.ceil(waitMs / 1000)}s`);
    }

    if (riskStatus.status === 'REDUCE_STAKE') {
        const maxStake = riskOverrides?.maxStake ?? params.stake * 10;
        stake = Math.min(stake, maxStake);
    }

    const preTrade = preTradeCheck(accountId, stake, {
        maxOrderSize: riskOverrides?.maxOrderSize,
        maxNotional: riskOverrides?.maxNotional,
        maxExposure: riskOverrides?.maxExposure,
        maxOrdersPerSecond: riskOverrides?.maxOrdersPerSecond,
        maxOrdersPerMinute: riskOverrides?.maxOrdersPerMinute,
        maxCancelsPerSecond: riskOverrides?.maxCancelsPerSecond,
    });
    if (!preTrade.allowed) {
        throw new Error(`Risk limit: ${preTrade.reason}`);
    }

    // Record trade opening (updates concurrent count)
    const openResult = recordTradeOpened(accountId, stake);
    if (!openResult.allowed) {
        throw new Error(openResult.reason ?? 'Risk check failed');
    }

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
            latencyTrace.orderSentTs = execResult.proposalSentTs;
            latencyTrace.proposalAckTs = execResult.proposalAckTs;
            latencyTrace.buySentTs = execResult.buySentTs;
            latencyTrace.buyAckTs = execResult.buyAckTs;
        }
        recordLatency(LATENCY_METRICS.decisionToSend, latencyTrace?.decisionTs, execResult.proposalSentTs);
        recordLatency(LATENCY_METRICS.sendToProposalAck, execResult.proposalSentTs, execResult.proposalAckTs);
        recordLatency(LATENCY_METRICS.sendToBuyAck, execResult.buySentTs, execResult.buyAckTs);
        metrics.counter('trade.proposal_sent');
        metrics.counter('trade.proposal_ack');
        metrics.counter('trade.buy_sent');
        metrics.counter('trade.buy_ack');

        const proposal = execResult.proposal;
        const buy = execResult.buy;

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
        // Rollback concurrent trade count on failure
        recordTradeSettled(accountId, stake, 0);
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
            recordTradeSettledOnce(accountId, contractId, stake, 0); // Decrement concurrent count
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
            }
            recordLatency(LATENCY_METRICS.sendToFill, latencyTrace?.orderSentTs, fillPerfTs);
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
                        const fillPerfTs = nowMs();
                        if (latencyTrace) {
                            latencyTrace.fillTs = fillPerfTs;
                        }
                        recordLatency(LATENCY_METRICS.sendToFill, latencyTrace?.orderSentTs, fillPerfTs);
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
            setTimeout(() => {
                if (!settled) {
                    settled = true;
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
            recordTradeSettledOnce(accountId, contractId, stake, 0);
        }

    } catch (error) {
        tradeLogger.error({ error, contractId }, 'Settlement tracking error');
        recordTradeSettledOnce(accountId, contractId, stake, 0);
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
    if (!recordTradeSettledOnce(accountId, contract.contract_id, stake, contract.profit)) {
        return;
    }

    // Persist trade to database
    await persistTrade({
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
    });

    // Send notification
    await persistNotification({
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
    });

    persistOrderStatus({
        accountId,
        contractId: contract.contract_id,
        event: 'contract_settled',
        status: contract.status || 'settled',
        payload: {
            profit: contract.profit,
            payout: contract.payout,
        },
    }).catch(err => tradeLogger.error({ err }, 'Order status persist failed'));
}
