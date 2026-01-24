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
    auth: { token: string; accountId: string; accountType: 'real' | 'demo'; accountCurrency?: string | null }
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
                ws.send(JSON.stringify(proposalReq));
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
                timestamps.buySentAt = Date.now();
                ws.send(JSON.stringify(buyReq));
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
    }
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

    // Record trade opening (updates concurrent count)
    const openResult = recordTradeOpened(accountId, stake);
    if (!openResult.allowed) {
        throw new Error(openResult.reason ?? 'Risk check failed');
    }

    try {
        // Get or create persistent connection
        const connection = await getOrCreateConnection(token, accountId, APP_ID);

        // Request proposal
        const proposalResponse = await sendMessage<{
            proposal?: {
                id: string;
                ask_price: number;
                spot?: number;
                payout?: number;
            };
            error?: { message: string };
        }>(accountId, {
            proposal: 1,
            amount: stake,
            basis: 'stake',
            contract_type: signal,
            currency: accountCurrency || 'USD',
            duration: params.duration || 5,
            duration_unit: params.durationUnit || 't',
            symbol: params.symbol,
        }, 5000);

        if (proposalResponse.error) {
            throw new Error(proposalResponse.error.message);
        }

        const proposal = proposalResponse.proposal;
        if (!proposal?.id) {
            throw new Error('No proposal received');
        }

        // Slippage enforcement with ask_price (fail-fast)
        const entryMode = params.entryMode || 'MARKET';
        const entryTargetPrice = params.entryTargetPrice;
        const entrySlippagePct = params.entrySlippagePct ?? 1.5;

        if (
            entryMode === 'HYBRID_LIMIT_MARKET' &&
            typeof entryTargetPrice === 'number' &&
            Number.isFinite(entryTargetPrice) &&
            entryTargetPrice > 0
        ) {
            // Use ask_price for slippage check (more accurate than spot)
            const checkPrice = proposal.ask_price;
            if (!Number.isFinite(checkPrice)) {
                throw new Error('No ask_price available - cannot verify slippage');
            }

            // Calculate max acceptable price
            const maxPrice = entryTargetPrice * (1 + entrySlippagePct / 100);
            if (checkPrice > maxPrice) {
                persistOrderStatus({
                    accountId,
                    event: 'slippage_reject',
                    status: 'slippage_exceeded',
                    price: checkPrice,
                    payload: {
                        askPrice: checkPrice,
                        entryTargetPrice,
                        maxPrice,
                        slippagePct: ((checkPrice - entryTargetPrice) / entryTargetPrice) * 100,
                        tolerancePct: entrySlippagePct,
                    },
                }).catch(err => tradeLogger.error({ err }, 'Order status persist failed'));
                throw new Error('Slippage exceeded tolerance');
            }
        }

        // Send buy request with price cap
        const buyResponse = await sendMessage<{
            buy?: {
                contract_id: number;
                buy_price: number;
                payout?: number;
            };
            error?: { message: string; code?: string };
        }>(accountId, {
            buy: proposal.id,
            price: proposal.ask_price, // Use quoted price as max
        }, 10000);

        if (buyResponse.error) {
            throw new Error(buyResponse.error.message);
        }

        const buy = buyResponse.buy;
        if (!buy?.contract_id) {
            throw new Error('Buy confirmation not received');
        }

        const executionTimeMs = Date.now() - startTime;

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
        trackSettlementAsync(accountId, accountType, buy.contract_id, stake, params)
            .catch(err => tradeLogger.error({ err }, 'Settlement tracking failed'));

        return {
            contractId: buy.contract_id,
            buyPrice: buy.buy_price,
            payout: buy.payout ?? 0,
            status: 'open',
            executionTimeMs,
        };

    } catch (error) {
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
    params: ExecuteTradeParams
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
            recordTradeSettled(accountId, stake, 0); // Decrement concurrent count
            clearPendingSettlement(accountId, contractId);
            return;
        }

        // Check if already settled in the initial response
        const initialContract = subscribeResponse.proposal_open_contract;
        if (initialContract?.is_sold) {
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
                    clearPendingSettlement(accountId, contractId);
                    resolve(null);
                }
            }, SETTLEMENT_TIMEOUT_MS);
        });

        if (settledContract) {
            await handleSettlement(accountId, accountType, stake, params, settledContract);
        } else {
            // Timeout case - still decrement concurrent count
            recordTradeSettled(accountId, stake, 0);
        }

    } catch (error) {
        tradeLogger.error({ error, contractId }, 'Settlement tracking error');
        recordTradeSettled(accountId, stake, 0);
        clearPendingSettlement(accountId, contractId);
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
    // Update risk cache with profit/loss
    recordTradeSettled(accountId, stake, contract.profit);

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
