import WebSocket from 'ws';
import { getSupabaseAdmin } from './lib/supabaseAdmin';
import { ExecuteTradeParamsSchema, TradeSignalSchema, type ExecuteTradeParams } from './lib/validation';

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
    let consecutiveWins = 0;

    (trades || []).forEach((trade) => {
        const profit = Number(trade.profit ?? 0);
        if (profit < 0) {
            totalLossToday += Math.abs(profit);
            lossStreak += 1;
            consecutiveWins = 0;
        } else {
            totalProfitToday += profit;
            consecutiveWins += 1;
            lossStreak = 0;
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

async function persistTrade(payload: {
    accountId: string;
    accountType?: string | null;
    botId?: string | null;
    botRunId?: string | null;
    entryProfileId?: string | null;
    contractId: number;
    symbol: string;
    stake: number;
    duration: number;
    durationUnit: string;
    profit: number;
    status: string;
}) {
    if (!supabaseAdmin) return null;

    const { data, error } = await supabaseAdmin.from('trades').insert({
        account_id: payload.accountId,
        account_type: payload.accountType ?? null,
        bot_id: payload.botId ?? null,
        bot_run_id: payload.botRunId ?? null,
        entry_profile_id: payload.entryProfileId ?? null,
        contract_id: payload.contractId,
        symbol: payload.symbol,
        stake: payload.stake,
        duration: payload.duration,
        duration_unit: payload.durationUnit,
        profit: payload.profit,
        status: payload.status,
    }).select('id').maybeSingle();

    if (error) {
        throw error;
    }

    return data?.id ?? null;
}

async function persistNotification(payload: {
    accountId: string;
    title: string;
    body: string;
    type?: string | null;
    data?: Record<string, unknown> | null;
}) {
    if (!supabaseAdmin) return;

    const { error } = await supabaseAdmin.from('notifications').insert({
        account_id: payload.accountId,
        title: payload.title,
        body: payload.body,
        type: payload.type ?? null,
        data: payload.data ?? null,
    });

    if (error) {
        throw error;
    }
}

async function persistOrderStatus(payload: {
    accountId: string | null;
    tradeId?: string | null;
    contractId?: number | null;
    event: string;
    status?: string | null;
    price?: number | null;
    latencyMs?: number | null;
    payload?: Record<string, unknown> | null;
}) {
    if (!supabaseAdmin) return;

    const { error } = await supabaseAdmin.from('order_status').insert({
        account_id: payload.accountId,
        trade_id: payload.tradeId ?? null,
        contract_id: payload.contractId ?? null,
        event: payload.event,
        status: payload.status ?? null,
        price: payload.price ?? null,
        latency_ms: payload.latencyMs ?? null,
        payload: payload.payload ?? null,
    });
    if (error) {
        throw error;
    }
}

export interface TradeResult {
    contractId: number;
    profit: number;
    status?: string;
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

        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Trade execution timed out'));
        }, 30000);

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
                }).catch((err) => console.error('Order status error persist failed', err));
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
                }).catch((err) => console.error('Order status persist failed', err));
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
                }).catch((err) => console.error('Order status persist failed', err));

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
                            }).catch((err) => console.error('Order status persist failed', err));
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
                }).catch((err) => console.error('Order status persist failed', err));
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
                }).catch((err) => console.error('Order status persist failed', err));
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
                }).catch((err) => console.error('Notification persistence failed', err));
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
                        }).catch((err) => console.error('Order status persist failed', err));
                    }).catch((err) => console.error('Trade persistence failed', err));

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
                    }).catch((err) => console.error('Notification persistence failed', err));
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
            }).catch((error) => console.error('Order status error persist failed', error));
            cleanup();
            clearTimeout(timeout);
            reject(err);
        });
    });
}
