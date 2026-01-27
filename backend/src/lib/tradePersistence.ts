import { getSupabaseAdmin } from './supabaseAdmin';
import { broadcastTrade } from './tradeStream';
import { persistenceQueue } from './persistenceQueue';

const { client: supabaseAdmin } = getSupabaseAdmin();

export async function persistTrade(payload: {
    accountId: string;
    accountType?: string | null;
    botId?: string | null;
    botRunId?: string | null;
    entryProfileId?: string | null;
    contractId: number;
    symbol?: string | null;
    stake?: number | null;
    duration?: number | null;
    durationUnit?: string | null;
    profit: number;
    status: string;
    createdAt?: string | null;
}) {
    if (!supabaseAdmin) return null;

    return persistenceQueue.enqueue(async () => {
        const { data, error } = await supabaseAdmin.from('trades').insert({
            account_id: payload.accountId,
            account_type: payload.accountType ?? null,
            bot_id: payload.botId ?? null,
            bot_run_id: payload.botRunId ?? null,
            entry_profile_id: payload.entryProfileId ?? null,
            contract_id: payload.contractId,
            symbol: payload.symbol ?? null,
            stake: payload.stake ?? null,
            duration: payload.duration ?? null,
            duration_unit: payload.durationUnit ?? null,
            profit: payload.profit,
            status: payload.status,
            created_at: payload.createdAt ?? undefined,
        }).select('id, created_at').maybeSingle();

        if (error) {
            throw error;
        }

        broadcastTrade(payload.accountId, {
            id: data?.id ?? null,
            contractId: payload.contractId,
            profit: payload.profit,
            symbol: payload.symbol ?? null,
            createdAt: (data as { created_at?: string | null } | null)?.created_at ?? new Date().toISOString(),
        });

        return data?.id ?? null;
    });
}

export async function persistNotification(payload: {
    accountId: string;
    title: string;
    body: string;
    type?: string | null;
    data?: Record<string, unknown> | null;
}) {
    if (!supabaseAdmin) return;

    return persistenceQueue.enqueue(async () => {
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
    });
}

export async function persistOrderStatus(payload: {
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

    return persistenceQueue.enqueue(async () => {
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
    });
}
