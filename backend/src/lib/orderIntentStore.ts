/**
 * Order Intent Store — Idempotency Guard
 *
 * Prevents duplicate orders on retry/reconnect by tracking order intents
 * keyed by accountId:correlationId.
 *
 * Uses LRU+TTL eviction to bound memory usage.
 *
 * CONTRACT: Before sending a proposal/buy, check `getOrCreate()`.
 * If the intent already has a result, return it (do NOT re-send).
 */

import { tradeLogger } from './logger';
import { metrics } from './metrics';

export type IntentStatus = 'PENDING' | 'FULFILLED' | 'FAILED';

export interface OrderIntent {
    correlationId: string;
    accountId: string;
    symbol: string;
    status: IntentStatus;
    createdAt: number;
    /** Contract ID if fulfilled */
    contractId?: number;
    /** Error message if failed */
    error?: string;
    /** Buy price if fulfilled */
    buyPrice?: number;
}

interface IntentEntry {
    intent: OrderIntent;
    accessedAt: number;
}

const DEFAULT_TTL_MS = Math.max(30_000, Number(process.env.ORDER_INTENT_TTL_MS) || 5 * 60 * 1000); // 5 min
const DEFAULT_MAX_SIZE = Math.max(100, Number(process.env.ORDER_INTENT_MAX_SIZE) || 5000);

class OrderIntentStore {
    private store = new Map<string, IntentEntry>();
    private ttlMs: number;
    private maxSize: number;
    private pruneTimer: ReturnType<typeof setInterval> | null = null;

    constructor(ttlMs: number = DEFAULT_TTL_MS, maxSize: number = DEFAULT_MAX_SIZE) {
        this.ttlMs = ttlMs;
        this.maxSize = maxSize;
        // Prune expired entries every 60s
        this.pruneTimer = setInterval(() => this.pruneExpired(), 60_000);
        if (this.pruneTimer && typeof this.pruneTimer === 'object' && 'unref' in this.pruneTimer) {
            this.pruneTimer.unref();
        }
    }

    private makeKey(accountId: string, _symbol: string, correlationId: string): string {
        // Strict idempotency is scoped per account + correlationId.
        return `${accountId}:${correlationId}`;
    }

    /**
     * Check if an intent already exists for this correlation ID.
     * Returns the existing intent if found (caller should NOT re-send),
     * or null if this is a new intent (caller should proceed).
     */
    check(accountId: string, symbol: string, correlationId: string): OrderIntent | null {
        const key = this.makeKey(accountId, symbol, correlationId);
        const entry = this.store.get(key);
        if (!entry) return null;

        // Check TTL
        const now = Date.now();
        if (now - entry.intent.createdAt > this.ttlMs) {
            this.store.delete(key);
            return null;
        }

        entry.accessedAt = now;
        metrics.counter('order_intent.cache_hit');
        return entry.intent;
    }

    /**
     * Register a new order intent as PENDING.
     * Returns false if a duplicate already exists (idempotency violation prevented).
     */
    register(accountId: string, symbol: string, correlationId: string): boolean {
        const existing = this.check(accountId, symbol, correlationId);
        if (existing) {
            tradeLogger.warn({
                correlationId,
                accountId,
                symbol,
                existingStatus: existing.status,
            }, 'Duplicate order intent prevented');
            metrics.counter('order_intent.duplicate_prevented');
            return false;
        }

        const key = this.makeKey(accountId, symbol, correlationId);
        const now = Date.now();
        this.store.set(key, {
            intent: {
                correlationId,
                accountId,
                symbol,
                status: 'PENDING',
                createdAt: now,
            },
            accessedAt: now,
        });

        // Enforce max size (LRU eviction)
        if (this.store.size > this.maxSize) {
            this.evictLRU();
        }

        metrics.counter('order_intent.registered');
        return true;
    }

    /**
     * Mark an intent as fulfilled with a contract ID.
     */
    fulfill(accountId: string, symbol: string, correlationId: string, contractId: number, buyPrice?: number): void {
        const key = this.makeKey(accountId, symbol, correlationId);
        const entry = this.store.get(key);
        if (entry) {
            entry.intent.status = 'FULFILLED';
            entry.intent.contractId = contractId;
            entry.intent.buyPrice = buyPrice;
            entry.accessedAt = Date.now();
            metrics.counter('order_intent.fulfilled');
        }
    }

    /**
     * Mark an intent as failed.
     */
    fail(accountId: string, symbol: string, correlationId: string, error: string): void {
        const key = this.makeKey(accountId, symbol, correlationId);
        const entry = this.store.get(key);
        if (entry) {
            entry.intent.status = 'FAILED';
            entry.intent.error = error;
            entry.accessedAt = Date.now();
            metrics.counter('order_intent.failed');
        }
    }

    private evictLRU(): void {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, entry] of this.store) {
            if (entry.accessedAt < oldestTime) {
                oldestTime = entry.accessedAt;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            this.store.delete(oldestKey);
            metrics.counter('order_intent.lru_evict');
        }
    }

    private pruneExpired(): void {
        const now = Date.now();
        let pruned = 0;
        for (const [key, entry] of this.store) {
            if (now - entry.intent.createdAt > this.ttlMs) {
                this.store.delete(key);
                pruned++;
            }
        }
        if (pruned > 0) {
            metrics.counter('order_intent.ttl_prune', pruned);
        }
    }

    /** Get store size (for metrics/testing) */
    get size(): number {
        return this.store.size;
    }

    /** Clear all entries (testing) */
    clear(): void {
        this.store.clear();
    }

    /** Destroy (cleanup timers) */
    destroy(): void {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
        this.store.clear();
    }
}

// Singleton
export const orderIntentStore = new OrderIntentStore();
