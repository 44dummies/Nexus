import crypto from 'crypto';
import { classifySupabaseError, getSupabaseAdmin } from './supabaseAdmin';
import { metrics } from './metrics';
import { tradeLogger } from './logger';

export type ExecutionLedgerState = 'PENDING' | 'SETTLED' | 'FAILED';

export interface PersistableTradePayload {
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
    buyPrice?: number | null;
    payout?: number | null;
    direction?: 'CALL' | 'PUT' | null;
    status: string;
    createdAt?: string | null;
}

export interface ExecutionLedgerEntry {
    id: string;
    correlationId: string;
    accountId: string;
    symbol: string;
    state: ExecutionLedgerState;
    pnl: number;
    fees: number;
    timestamp: number;
    contractId: number;
    tradePayload?: PersistableTradePayload;
    lastError?: string | null;
}

const inMemoryLedger = new Map<string, ExecutionLedgerEntry>();

function normalizeRow(row: Record<string, unknown>): ExecutionLedgerEntry | null {
    const id = typeof row.id === 'string' ? row.id : null;
    const correlationId = typeof row.correlation_id === 'string' ? row.correlation_id : null;
    const accountId = typeof row.account_id === 'string' ? row.account_id : null;
    const symbol = typeof row.symbol === 'string' ? row.symbol : null;
    const stateRaw = typeof row.state === 'string' ? row.state : null;
    const pnl = typeof row.pnl === 'number' ? row.pnl : Number(row.pnl);
    const fees = typeof row.fees === 'number' ? row.fees : Number(row.fees);
    const timestamp = typeof row.timestamp_ms === 'number' ? row.timestamp_ms : Number(row.timestamp_ms);
    const contractId = typeof row.contract_id === 'number' ? row.contract_id : Number(row.contract_id);

    if (!id || !correlationId || !accountId || !symbol) return null;
    if (stateRaw !== 'PENDING' && stateRaw !== 'SETTLED' && stateRaw !== 'FAILED') return null;
    if (!Number.isFinite(pnl) || !Number.isFinite(fees) || !Number.isFinite(timestamp) || !Number.isFinite(contractId)) {
        return null;
    }

    const metadata = row.metadata && typeof row.metadata === 'object'
        ? row.metadata as { tradePayload?: PersistableTradePayload }
        : null;

    return {
        id,
        correlationId,
        accountId,
        symbol,
        state: stateRaw,
        pnl,
        fees,
        timestamp,
        contractId,
        tradePayload: metadata?.tradePayload,
        lastError: typeof row.last_error === 'string' ? row.last_error : null,
    };
}

async function upsertSupabase(entry: ExecutionLedgerEntry): Promise<void> {
    const { client: supabaseAdmin } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        throw new Error('Supabase not configured');
    }

    const { error } = await supabaseAdmin
        .from('execution_ledger')
        .upsert({
            id: entry.id,
            correlation_id: entry.correlationId,
            account_id: entry.accountId,
            symbol: entry.symbol,
            state: entry.state,
            pnl: entry.pnl,
            fees: entry.fees,
            timestamp_ms: entry.timestamp,
            contract_id: entry.contractId,
            metadata: entry.tradePayload ? { tradePayload: entry.tradePayload } : null,
            last_error: entry.lastError ?? null,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });

    if (error) {
        throw error;
    }
}

async function writeWithFallback(entry: ExecutionLedgerEntry): Promise<void> {
    inMemoryLedger.set(entry.id, entry);
    try {
        await upsertSupabase(entry);
    } catch (error) {
        const info = classifySupabaseError(error);
        metrics.counter('execution_ledger.persist_error');
        if (!info.message.toLowerCase().includes('not configured')) {
            tradeLogger.error({ entryId: entry.id, error: info.message, code: info.code }, 'Execution ledger persist failed');
        }
    }
}

export async function writeExecutionLedgerPending(input: {
    correlationId: string;
    accountId: string;
    symbol: string;
    pnl: number;
    fees: number;
    contractId: number;
    tradePayload?: PersistableTradePayload;
    timestamp?: number;
}): Promise<string> {
    const id = crypto.randomUUID();
    const entry: ExecutionLedgerEntry = {
        id,
        correlationId: input.correlationId,
        accountId: input.accountId,
        symbol: input.symbol,
        state: 'PENDING',
        pnl: input.pnl,
        fees: input.fees,
        timestamp: input.timestamp ?? Date.now(),
        contractId: input.contractId,
        tradePayload: input.tradePayload,
        lastError: null,
    };
    await writeWithFallback(entry);
    metrics.counter('execution_ledger.pending_written');
    return id;
}

export async function markExecutionLedgerSettled(id: string): Promise<void> {
    const existing = inMemoryLedger.get(id);
    if (!existing) return;
    existing.state = 'SETTLED';
    existing.lastError = null;
    await writeWithFallback(existing);
    metrics.counter('execution_ledger.settled_written');
}

export async function markExecutionLedgerFailed(id: string, err: string): Promise<void> {
    const existing = inMemoryLedger.get(id);
    if (!existing) return;
    existing.state = 'FAILED';
    existing.lastError = err;
    await writeWithFallback(existing);
    metrics.counter('execution_ledger.failed_written');
}

async function loadNonSettledEntries(): Promise<ExecutionLedgerEntry[]> {
    const { client: supabaseAdmin } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return Array.from(inMemoryLedger.values()).filter((entry) => entry.state !== 'SETTLED');
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('execution_ledger')
            .select('id, correlation_id, account_id, symbol, state, pnl, fees, timestamp_ms, contract_id, metadata, last_error')
            .neq('state', 'SETTLED')
            .order('timestamp_ms', { ascending: true })
            .limit(1000);

        if (error) {
            throw error;
        }

        const normalized = (data || [])
            .map((row) => normalizeRow(row as Record<string, unknown>))
            .filter((row): row is ExecutionLedgerEntry => row !== null);

        for (const row of normalized) {
            inMemoryLedger.set(row.id, row);
        }

        return normalized;
    } catch (error) {
        const info = classifySupabaseError(error);
        metrics.counter('execution_ledger.replay_load_error');
        tradeLogger.error({ error: info.message, code: info.code }, 'Execution ledger replay load failed');
        return Array.from(inMemoryLedger.values()).filter((entry) => entry.state !== 'SETTLED');
    }
}

export async function replayNonSettledExecutionLedger(
    processor: (entry: ExecutionLedgerEntry) => Promise<void>
): Promise<number> {
    const nonSettled = await loadNonSettledEntries();
    let replayed = 0;

    for (const entry of nonSettled) {
        try {
            await processor(entry);
            await markExecutionLedgerSettled(entry.id);
            replayed += 1;
            metrics.counter('execution_ledger.replay_ok');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown replay error';
            await markExecutionLedgerFailed(entry.id, message);
            metrics.counter('execution_ledger.replay_error');
            tradeLogger.error({ entryId: entry.id, error }, 'Execution ledger replay failed');
        }
    }

    return replayed;
}

export function clearExecutionLedgerForTest(): void {
    inMemoryLedger.clear();
}

export function getExecutionLedgerForTest(): ExecutionLedgerEntry[] {
    return Array.from(inMemoryLedger.values());
}
