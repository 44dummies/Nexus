import { getSupabaseAdmin } from './supabaseAdmin';
import { decryptToken } from './sessionCrypto';
import { getOrCreateConnection, sendMessage } from './wsManager';
import { persistNotification, persistOrderStatus, persistTrade } from './tradePersistence';
import { recordTradeSettled, getRiskCache, initializeRiskCache } from './riskCache';
import logger from './logger';

type BuyRow = {
    account_id: string | null;
    contract_id: number | null;
    created_at: string | null;
};

interface BackfillOptions {
    lookbackMinutes?: number;
    batchSize?: number;
}

const DEFAULT_LOOKBACK_MINUTES = Number(process.env.BACKFILL_LOOKBACK_MINUTES) || 180;
const DEFAULT_BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE) || 200;

let isRunning = false;

const toNumber = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

const getDateKey = (isoString: string | null | undefined) => {
    if (!isoString) return null;
    return new Date(isoString).toISOString().slice(0, 10);
};

export async function runTradeBackfill(options: BackfillOptions = {}) {
    if (isRunning) return;
    isRunning = true;

    const { client: supabaseAdmin } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        isRunning = false;
        logger.warn('Backfill skipped: Supabase not configured');
        return;
    }

    const lookbackMinutes = options.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES;
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const cutoff = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();

    try {
        const { data: buys, error } = await supabaseAdmin
            .from('order_status')
            .select('account_id, contract_id, created_at')
            .eq('event', 'buy_confirmed')
            .gte('created_at', cutoff)
            .order('created_at', { ascending: false })
            .limit(batchSize);

        if (error) {
            logger.error({ error }, 'Backfill failed to load buy confirmations');
            return;
        }

        const buyRows = (buys || []) as BuyRow[];
        if (buyRows.length === 0) return;

        const contractIds = Array.from(new Set(
            buyRows.map((row) => row.contract_id).filter((id): id is number => Number.isFinite(id))
        ));
        if (contractIds.length === 0) return;

        const [existingTrades, settledStatuses] = await Promise.all([
            supabaseAdmin
                .from('trades')
                .select('contract_id')
                .in('contract_id', contractIds),
            supabaseAdmin
                .from('order_status')
                .select('contract_id')
                .eq('event', 'contract_settled')
                .in('contract_id', contractIds),
        ]);

        const existingSet = new Set((existingTrades.data || [])
            .map((row: { contract_id: number | null }) => row.contract_id)
            .filter((id: number | null): id is number => Number.isFinite(id)));

        const settledSet = new Set((settledStatuses.data || [])
            .map((row: { contract_id: number | null }) => row.contract_id)
            .filter((id: number | null): id is number => Number.isFinite(id)));

        const candidates = buyRows.filter((row) => {
            if (!row.account_id || !Number.isFinite(row.contract_id)) return false;
            if (existingSet.has(row.contract_id as number)) return false;
            if (settledSet.has(row.contract_id as number)) return false;
            return true;
        });

        if (candidates.length === 0) return;

        const accountIds = Array.from(new Set(candidates.map((row) => row.account_id).filter(Boolean)));
        const { data: sessions } = await supabaseAdmin
            .from('sessions')
            .select('account_id, account_type, token_encrypted, currency')
            .in('account_id', accountIds);

        const sessionMap = new Map<string, { token: string | null; accountType: 'real' | 'demo'; currency?: string | null }>();
        (sessions || []).forEach((session) => {
            const token = decryptToken(session.token_encrypted as { iv?: string; tag?: string; ciphertext?: string } | null);
            sessionMap.set(session.account_id, {
                token,
                accountType: session.account_type as 'real' | 'demo',
                currency: session.currency,
            });
        });

        for (const row of candidates) {
            const accountId = row.account_id as string;
            const contractId = row.contract_id as number;
            const session = sessionMap.get(accountId);
            if (!session?.token) continue;

            try {
                await getOrCreateConnection(session.token, accountId);
                const response = await sendMessage<{
                    proposal_open_contract?: {
                        contract_id: number;
                        is_sold: boolean;
                        profit: number;
                        status?: string;
                        payout?: number;
                        buy_price?: number;
                        symbol?: string;
                        duration?: number;
                        duration_unit?: string;
                    };
                    error?: { message: string };
                }>(accountId, {
                    proposal_open_contract: 1,
                    contract_id: contractId,
                    subscribe: 0,
                }, 10000);

                if (response.error || !response.proposal_open_contract) {
                    continue;
                }

                const contract = response.proposal_open_contract;
                if (!contract.is_sold) {
                    continue;
                }

                const profit = toNumber(contract.profit) ?? 0;
                const stake = toNumber(contract.buy_price);
                const symbol = typeof contract.symbol === 'string' ? contract.symbol : null;
                const duration = toNumber(contract.duration);
                const durationUnit = typeof contract.duration_unit === 'string' ? contract.duration_unit : null;
                const status = contract.status || 'settled';

                const tradeId = await persistTrade({
                    accountId,
                    accountType: session.accountType,
                    contractId,
                    symbol,
                    stake: stake ?? null,
                    duration: duration ?? null,
                    durationUnit,
                    profit,
                    status,
                    createdAt: row.created_at ?? undefined,
                });

                await persistNotification({
                    accountId,
                    title: profit >= 0 ? 'Trade Won' : 'Trade Lost',
                    body: `Contract #${contractId} settled with ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}`,
                    type: 'trade_result',
                    data: {
                        contractId,
                        profit,
                        status,
                        symbol,
                        backfilled: true,
                    },
                });

                await persistOrderStatus({
                    accountId,
                    tradeId,
                    contractId,
                    event: 'contract_settled',
                    status,
                    payload: {
                        profit,
                        payout: contract.payout,
                        backfilled: true,
                    },
                });

                const dateKey = getDateKey(row.created_at);
                const cache = getRiskCache(accountId);
                if (cache && dateKey && cache.dateKey === dateKey && stake !== null) {
                    recordTradeSettled(accountId, stake, profit);
                } else if (!cache && stake !== null) {
                    const { data: snapshot } = await supabaseAdmin
                        .from('settings')
                        .select('value')
                        .eq('account_id', accountId)
                        .eq('key', 'balance_snapshot')
                        .maybeSingle();
                    const balance = typeof snapshot?.value?.balance === 'number' ? snapshot.value.balance : 10000;
                    const entry = initializeRiskCache(accountId, { equity: balance });
                    if (dateKey && entry.dateKey === dateKey) {
                        recordTradeSettled(accountId, stake, profit);
                    }
                }

            } catch (error) {
                logger.error({ accountId, contractId, error }, 'Backfill settlement error');
            }
        }
    } finally {
        isRunning = false;
    }
}

export function startTradeBackfillJob() {
    const intervalMs = Number(process.env.BACKFILL_INTERVAL_MS) || 5 * 60 * 1000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    setTimeout(() => {
        runTradeBackfill().catch((error) => {
            logger.error({ error }, 'Backfill job failed');
        });
    }, 10_000);

    setInterval(() => {
        runTradeBackfill().catch((error) => {
            logger.error({ error }, 'Backfill job failed');
        });
    }, intervalMs);
}
