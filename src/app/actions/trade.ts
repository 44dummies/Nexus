'use server';

import { cookies } from 'next/headers';
import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';
import { refreshSession } from '@/app/actions/auth';
import { ExecuteTradeParamsSchema, TradeSignalSchema, ExecuteTradeParams } from '@/lib/validation';


interface DerivResponse {
    msg_type: string;
    error?: {
        message: string;
        code: string;
    };
    [key: string]: unknown;
}

const APP_ID = process.env.NEXT_PUBLIC_DERIV_APP_ID || '1089';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
    })
    : null;


interface TradeResult {
    contractId: number;
    profit: number;
    status: string;
}

async function persistTrade(payload: {
    accountId: string | null;
    accountType: 'real' | 'demo' | null;
    botId?: string | null;
    botRunId?: string | null;
    contractId: number;
    symbol: string;
    stake: number;
    duration: number;
    durationUnit: string;
    profit: number;
    status: string;
    entryProfileId?: string | null;
}) {
    if (!supabaseAdmin) return;

    const { data, error } = await supabaseAdmin.from('trades').insert({
        account_id: payload.accountId,
        account_type: payload.accountType,
        bot_id: payload.botId ?? null,
        bot_run_id: payload.botRunId ?? null,
        contract_id: payload.contractId,
        symbol: payload.symbol,
        stake: payload.stake,
        duration: payload.duration,
        duration_unit: payload.durationUnit,
        profit: payload.profit,
        status: payload.status,
        entry_profile_id: payload.entryProfileId ?? null,
    }).select('id').single();
    if (error) {
        throw error;
    }
    return data?.id ?? null;
}

async function persistNotification(payload: {
    accountId: string | null;
    title: string;
    body: string;
    type: string;
    data?: Record<string, unknown>;
}) {
    if (!supabaseAdmin) return;

    const { error } = await supabaseAdmin.from('notifications').insert({
        account_id: payload.accountId,
        title: payload.title,
        body: payload.body,
        type: payload.type,
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

export async function executeTradeServer(signal: 'CALL' | 'PUT', params: ExecuteTradeParams): Promise<TradeResult> {
    // Input Validation
    const signalValidation = TradeSignalSchema.safeParse(signal);
    if (!signalValidation.success) {
        throw new Error('Invalid trade signal');
    }

    const paramsValidation = ExecuteTradeParamsSchema.safeParse(params);
    if (!paramsValidation.success) {
        throw new Error(`Invalid trade parameters: ${paramsValidation.error.issues.map(e => e.message).join(', ')}`);
    }

    const cookieStore = await cookies();
    const realToken = cookieStore.get('deriv_token')?.value;
    const demoToken = cookieStore.get('deriv_demo_token')?.value;
    const activeTypeCookie = cookieStore.get('deriv_active_type')?.value as 'real' | 'demo' | undefined;
    const activeType = activeTypeCookie || (demoToken ? 'demo' : 'real');
    const token = activeType === 'demo' ? demoToken : realToken;
    const accountId = activeType === 'demo'
        ? cookieStore.get('deriv_demo_account')?.value || null
        : cookieStore.get('deriv_account')?.value || null;
    const accountCurrency = activeType === 'demo'
        ? cookieStore.get('deriv_demo_currency')?.value
        : cookieStore.get('deriv_currency')?.value;

    if (!token) {
        throw new Error('User not authenticated');
    }

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
            // 1. Authorize
            ws.send(JSON.stringify({ authorize: token, req_id: getReqId() }));
        });

        ws.on('message', (data) => {
            const response = JSON.parse(data.toString()) as DerivResponse;

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
                // 2. Proposal
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
                // 3. Buy
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const proposal = response.proposal as any;
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
                // 4. Subscribe to open contract to wait for result
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const buy = response.buy as any;
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
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const contract = response.proposal_open_contract as any;
                if (contract.is_sold) {
                    cleanup();
                    clearTimeout(timeout);
                    resolve({
                        contractId: contract.contract_id,
                        profit: contract.profit,
                        status: contract.status,
                    });

                    // Refresh session on successful trade activity to keep cookie alive
                    refreshSession().catch(e => console.error('Session refresh failed', e));

                    // Persist trade + notification (if DB configured)
                    persistTrade({
                        accountId,
                        accountType: activeType,
                        botId: params.botId ?? null,
                        botRunId: params.botRunId ?? null,
                        contractId: contract.contract_id,
                        symbol: params.symbol,
                        stake: params.stake,
                        duration: params.duration || 5,
                        durationUnit: params.durationUnit || 't',
                        profit: contract.profit,
                        status: contract.status,
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
                            status: contract.status,
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
