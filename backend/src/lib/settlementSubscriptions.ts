import { registerConnectionReadyListener, sendMessageAsync } from './wsManager';
import { tradeLogger } from './logger';
import { metrics } from './metrics';

interface PendingSettlement {
    contractId: number;
    lastUpdateAt: number;
    resubscribeAttempts: number;
}

const pendingSettlements = new Map<string, Map<number, PendingSettlement>>();
const registeredAccounts = new Set<string>();
const lastDisconnectTimes = new Map<string, number>();

import { registerDisconnectListener, unregisterDisconnectListener } from './wsManager';

const RESUBSCRIBE_STALE_MS = Math.max(10_000, Number(process.env.SETTLEMENT_STALE_MS) || 60_000);
const RESUBSCRIBE_INTERVAL_MS = Math.max(5_000, Number(process.env.SETTLEMENT_RESUBSCRIBE_INTERVAL_MS) || 30_000);
const RESUBSCRIBE_MAX_ATTEMPTS = Math.max(1, Number(process.env.SETTLEMENT_RESUBSCRIBE_MAX_ATTEMPTS) || 5);

function getBucket(accountId: string): Map<number, PendingSettlement> {
    let bucket = pendingSettlements.get(accountId);
    if (!bucket) {
        bucket = new Map();
        pendingSettlements.set(accountId, bucket);
    }
    return bucket;
}

export function registerPendingSettlement(accountId: string, contractId: number): void {
    const bucket = getBucket(accountId);
    const existing = bucket.get(contractId);
    if (!existing) {
        bucket.set(contractId, {
            contractId,
            lastUpdateAt: Date.now(),
            resubscribeAttempts: 0,
        });
    }

    metrics.gauge('settlement.pending_count', bucket.size);

    if (!registeredAccounts.has(accountId)) {
        registerConnectionReadyListener(accountId, (accId, isReconnect) => {
            if (!isReconnect) return;
            const disconnectTime = lastDisconnectTimes.get(accId);
            if (disconnectTime) {
                const gapMs = Date.now() - disconnectTime;
                tradeLogger.warn({ accountId: accId, gapMs }, 'Settlement gap detected - resubscribing pending');
                lastDisconnectTimes.delete(accId);
            }
            resubscribePendingSettlements(accId);
        });
        registerDisconnectListener(accountId, (accId) => {
            lastDisconnectTimes.set(accId, Date.now());
        });
        registeredAccounts.add(accountId);
    }
}

export function recordSettlementUpdate(accountId: string, contractId: number): void {
    const bucket = pendingSettlements.get(accountId);
    if (!bucket) return;
    const entry = bucket.get(contractId);
    if (!entry) return;
    entry.lastUpdateAt = Date.now();
    entry.resubscribeAttempts = 0;
}

export function clearPendingSettlement(accountId: string, contractId: number): void {
    const bucket = pendingSettlements.get(accountId);
    if (!bucket) return;
    bucket.delete(contractId);
    if (bucket.size === 0) {
        pendingSettlements.delete(accountId);
    }
    metrics.gauge('settlement.pending_count', bucket.size);
}

export function resubscribePendingSettlements(accountId: string): void {
    const bucket = pendingSettlements.get(accountId);
    if (!bucket || bucket.size === 0) return;

    for (const entry of bucket.values()) {
        try {
            sendMessageAsync(accountId, {
                proposal_open_contract: 1,
                contract_id: entry.contractId,
                subscribe: 1,
            });
            metrics.counter('settlement.resubscribe_sent');
        } catch (error) {
            tradeLogger.error({ accountId, contractId: entry.contractId, error }, 'Settlement resubscribe failed');
            metrics.counter('settlement.resubscribe_error');
        }
    }
}

function sweepStaleSettlements(): void {
    const now = Date.now();
    for (const [accountId, bucket] of pendingSettlements.entries()) {
        const toRemove: number[] = [];
        for (const entry of bucket.values()) {
            if (now - entry.lastUpdateAt < RESUBSCRIBE_STALE_MS) continue;
            if (entry.resubscribeAttempts >= RESUBSCRIBE_MAX_ATTEMPTS) {
                tradeLogger.warn({ accountId, contractId: entry.contractId }, 'Settlement resubscribe attempts exhausted - removing stale entry');
                metrics.counter('settlement.resubscribe_exhausted');
                toRemove.push(entry.contractId);
                continue;
            }
            entry.resubscribeAttempts += 1;
            entry.lastUpdateAt = now;
            try {
                sendMessageAsync(accountId, {
                    proposal_open_contract: 1,
                    contract_id: entry.contractId,
                    subscribe: 1,
                });
                metrics.counter('settlement.resubscribe_sent');
            } catch (error) {
                tradeLogger.error({ accountId, contractId: entry.contractId, error }, 'Settlement resubscribe failed');
                metrics.counter('settlement.resubscribe_error');
            }
        }
        for (const contractId of toRemove) {
            bucket.delete(contractId);
        }
        if (bucket.size === 0) {
            pendingSettlements.delete(accountId);
        }
        metrics.gauge('settlement.pending_count', bucket.size);
    }
}

const settlementSweepTimer = setInterval(() => {
    sweepStaleSettlements();
}, RESUBSCRIBE_INTERVAL_MS);
settlementSweepTimer.unref();

export function getPendingSettlementCount(): number {
    let total = 0;
    for (const bucket of pendingSettlements.values()) {
        total += bucket.size;
    }
    return total;
}
