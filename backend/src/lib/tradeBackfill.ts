import { getSupabaseAdmin } from './supabaseAdmin';
import { decryptToken } from './sessionCrypto';
import { getOrCreateConnection, sendMessage, sendMessageAsync } from './wsManager';
import { persistNotification, persistOrderStatus, persistTrade } from './tradePersistence';
import { recordTradeSettled, getRiskCache, initializeRiskCache } from './riskCache';
import logger from './logger';
import { loadAllOpenContractsFromSettings, seedOpenContracts, finalizeOpenContract, trackOpenContract } from './openContracts';
import { registerPendingSettlement } from './settlementSubscriptions';

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

// Distributed lock using Supabase settings table (SEC: TRADE-08)
const LOCK_KEY = 'backfill_lock';
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function acquireDistributedLock(supabase: any): Promise<boolean> {
    const now = Date.now();
    const lockValue = { holder: process.pid, acquiredAt: now, expiresAt: now + LOCK_TTL_MS };
    
    // Try to get existing lock
    const { data: existing } = await supabase
        .from('settings')
        .select('value')
        .eq('account_id', '__system__')
        .eq('key', LOCK_KEY)
        .maybeSingle();
    
    const existingLock = existing?.value as { expiresAt?: number } | null;
    
    // If lock exists and not expired, can't acquire
    if (existingLock?.expiresAt && existingLock.expiresAt > now) {
        logger.debug({ existingLock }, 'Backfill lock held by another process');
        return false;
    }
    
    // Try to upsert the lock
    const { error } = await supabase
        .from('settings')
        .upsert({
            account_id: '__system__',
            key: LOCK_KEY,
            value: lockValue,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'account_id,key' });
    
    if (error) {
        logger.warn({ error }, 'Failed to acquire backfill lock');
        return false;
    }
    
    return true;
}

async function releaseDistributedLock(supabase: any): Promise<void> {
    await supabase
        .from('settings')
        .delete()
        .eq('account_id', '__system__')
        .eq('key', LOCK_KEY);
}

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

// Track contracts that permanently fail to avoid re-checking every cycle
const permanentlyFailedContracts = new Set<string>();
const PERMANENT_FAIL_LIMIT = 5000; // cap the set size

function markPermanentFailure(accountId: string, contractId: number): void {
    const key = `${accountId}:${contractId}`;
    if (permanentlyFailedContracts.size >= PERMANENT_FAIL_LIMIT) {
        // Evict oldest entries (clear half the set)
        const entries = Array.from(permanentlyFailedContracts);
        for (let i = 0; i < entries.length / 2; i++) {
            permanentlyFailedContracts.delete(entries[i]);
        }
    }
    permanentlyFailedContracts.add(key);
}

function isPermanentlyFailed(accountId: string, contractId: number): boolean {
    return permanentlyFailedContracts.has(`${accountId}:${contractId}`);
}

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

        const openContractsByAccount = await loadAllOpenContractsFromSettings();
        for (const [accountId, contracts] of openContractsByAccount.entries()) {
            seedOpenContracts(accountId, contracts);
        }

        const candidates = new Map<string, {
            accountId: string;
            contractId: number;
            createdAt?: string | null;
            stake?: number | null;
            symbol?: string | null;
        }>();

        for (const row of buyRows) {
            if (!row.account_id || !Number.isFinite(row.contract_id)) continue;
            const accountId = row.account_id as string;
            const contractId = row.contract_id as number;
            candidates.set(`${accountId}:${contractId}`, {
                accountId,
                contractId,
                createdAt: row.created_at ?? null,
            });
        }

        for (const [accountId, contracts] of openContractsByAccount.entries()) {
            for (const entry of contracts) {
                if (!Number.isFinite(entry.contractId)) continue;
                candidates.set(`${accountId}:${entry.contractId}`, {
                    accountId,
                    contractId: entry.contractId,
                    createdAt: typeof entry.openedAt === 'number'
                        ? new Date(entry.openedAt).toISOString()
                        : null,
                    stake: entry.stake ?? null,
                    symbol: entry.symbol ?? null,
                });
            }
        }

        if (candidates.size === 0) return;

        const contractIds = Array.from(new Set(
            Array.from(candidates.values()).map((row) => row.contractId).filter((id): id is number => Number.isFinite(id))
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

        for (const row of candidates.values()) {
            if (existingSet.has(row.contractId) || settledSet.has(row.contractId)) {
                finalizeOpenContract(row.accountId, row.contractId);
            }
        }

        const candidateRows = Array.from(candidates.values()).filter((row) => {
            if (!row.accountId || !Number.isFinite(row.contractId)) return false;
            if (existingSet.has(row.contractId)) return false;
            if (settledSet.has(row.contractId)) return false;
            return true;
        });

        if (candidateRows.length === 0) return;

        const accountIds = Array.from(new Set(candidateRows.map((row) => row.accountId).filter(Boolean)));
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

        for (const row of candidateRows) {
            const accountId = row.accountId as string;
            const contractId = row.contractId as number;
            const session = sessionMap.get(accountId);
            if (!session?.token) continue;

            // Skip contracts that have permanently failed in previous cycles
            if (isPermanentlyFailed(accountId, contractId)) continue;

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
                }, 10000);

                if (response.error || !response.proposal_open_contract) {
                    continue;
                }

                const contract = response.proposal_open_contract;
                if (!contract.is_sold) {
                    registerPendingSettlement(accountId, contractId);
                    sendMessageAsync(accountId, {
                        proposal_open_contract: 1,
                        contract_id: contractId,
                        subscribe: 1,
                    });
                    const stake = toNumber(contract.buy_price) ?? row.stake ?? null;
                    if (stake !== null) {
                        trackOpenContract(accountId, {
                            contractId,
                            stake,
                            symbol: typeof contract.symbol === 'string' ? contract.symbol : row.symbol ?? null,
                            openedAt: Date.now(),
                        });
                    }
                    continue;
                }

                const profit = toNumber(contract.profit) ?? 0;
                const stake = toNumber(contract.buy_price) ?? row.stake ?? null;
                const symbol = typeof contract.symbol === 'string' ? contract.symbol : (row.symbol ?? null);
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
                    createdAt: row.createdAt ?? undefined,
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

                finalizeOpenContract(accountId, contractId);

                const dateKey = getDateKey(row.createdAt ?? null);
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
                const errMsg = error instanceof Error ? error.message : String(error);
                const isConnectionError = errMsg.includes('No connection') || errMsg.includes('Connection closed') || errMsg.includes('timeout') || errMsg.includes('WebSocket');
                const isContractGone = errMsg.includes('ContractNotFound') || errMsg.includes('InvalidContractId') || errMsg.includes('not found') || errMsg.includes('InputValidation');

                if (isContractGone) {
                    // Contract no longer exists on Deriv — permanent, don't retry
                    markPermanentFailure(accountId, contractId);
                    logger.debug({ accountId, contractId }, 'Backfill: contract not found, skipping permanently');
                } else if (isConnectionError) {
                    // Transient WS issue — warn once, will retry next cycle
                    logger.warn({ accountId, contractId }, 'Backfill: connection unavailable, will retry');
                } else {
                    // Unexpected error — log at error level
                    logger.error({ accountId, contractId, error: errMsg }, 'Backfill settlement error');
                }
            }
        }
    } finally {
        isRunning = false;
    }
}

export function startTradeBackfillJob() {
    const intervalMs = Number(process.env.BACKFILL_INTERVAL_MS) || 5 * 60 * 1000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    const initialTimer = setTimeout(() => {
        runTradeBackfill().catch((error) => {
            logger.error({ error }, 'Backfill job failed');
        });
    }, 10_000);
    initialTimer.unref();

    const backfillTimer = setInterval(() => {
        runTradeBackfill().catch((error) => {
            logger.error({ error }, 'Backfill job failed');
        });
    }, intervalMs);
    backfillTimer.unref();
}
