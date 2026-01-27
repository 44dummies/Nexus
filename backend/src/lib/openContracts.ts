import { getSupabaseAdmin } from './supabaseAdmin';
import { persistenceQueue } from './persistenceQueue';
import { tradeLogger } from './logger';

export interface OpenContractEntry {
    contractId: number;
    stake: number;
    symbol?: string | null;
    openedAt: number;
    botRunId?: string | null;
    botId?: string | null;
}

const OPEN_CONTRACTS_KEY = 'open_contracts';
const PERSIST_DEBOUNCE_MS = Math.max(100, Number(process.env.OPEN_CONTRACTS_PERSIST_DEBOUNCE_MS) || 500);

const openContractsByAccount = new Map<string, Map<number, OpenContractEntry>>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePersist(accountId: string): void {
    if (persistTimers.has(accountId)) return;
    const timer = setTimeout(() => {
        persistTimers.delete(accountId);
        persistOpenContracts(accountId).catch((error) => {
            tradeLogger.warn({ accountId, error }, 'Open contracts persist failed');
        });
    }, PERSIST_DEBOUNCE_MS);
    persistTimers.set(accountId, timer);
}

async function persistOpenContracts(accountId: string): Promise<void> {
    const { client: supabaseAdmin } = getSupabaseAdmin();
    if (!supabaseAdmin) return;

    const bucket = openContractsByAccount.get(accountId);
    const contracts = bucket ? Array.from(bucket.values()) : [];

    try {
        await persistenceQueue.enqueue(async () => {
            await supabaseAdmin.from('settings').upsert({
                account_id: accountId,
                key: OPEN_CONTRACTS_KEY,
                value: { contracts },
                updated_at: new Date().toISOString(),
            }, { onConflict: 'account_id,key' });
        });
    } catch (error) {
        tradeLogger.warn({ accountId, error }, 'Open contracts persist enqueue failed; retrying');
        setTimeout(() => schedulePersist(accountId), Math.min(1000, PERSIST_DEBOUNCE_MS));
    }
}

export function trackOpenContract(accountId: string, entry: OpenContractEntry): void {
    let bucket = openContractsByAccount.get(accountId);
    if (!bucket) {
        bucket = new Map();
        openContractsByAccount.set(accountId, bucket);
    }
    bucket.set(entry.contractId, entry);
    schedulePersist(accountId);
}

export function finalizeOpenContract(accountId: string, contractId: number): void {
    const bucket = openContractsByAccount.get(accountId);
    if (bucket) {
        bucket.delete(contractId);
        if (bucket.size === 0) {
            openContractsByAccount.delete(accountId);
        }
        schedulePersist(accountId);
    }
}

export function seedOpenContracts(accountId: string, entries: OpenContractEntry[]): void {
    if (!entries || entries.length === 0) return;
    let bucket = openContractsByAccount.get(accountId);
    if (!bucket) {
        bucket = new Map();
        openContractsByAccount.set(accountId, bucket);
    }
    for (const entry of entries) {
        if (!Number.isFinite(entry.contractId)) continue;
        bucket.set(entry.contractId, entry);
    }
}

export async function loadAllOpenContractsFromSettings(): Promise<Map<string, OpenContractEntry[]>> {
    const results = new Map<string, OpenContractEntry[]>();
    const { client: supabaseAdmin } = getSupabaseAdmin();
    if (!supabaseAdmin) return results;

    const { data, error } = await supabaseAdmin
        .from('settings')
        .select('account_id, value')
        .eq('key', OPEN_CONTRACTS_KEY);

    if (error) {
        tradeLogger.warn({ error }, 'Open contracts load failed');
        return results;
    }

    for (const row of data || []) {
        const accountId = row.account_id as string | null;
        if (!accountId) continue;
        const value = row.value as { contracts?: OpenContractEntry[] } | OpenContractEntry[] | null;
        const contracts = Array.isArray(value)
            ? value
            : Array.isArray(value?.contracts)
                ? value.contracts
                : [];
        if (contracts.length > 0) {
            results.set(accountId, contracts);
        }
    }

    return results;
}
