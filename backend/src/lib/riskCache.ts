/**
 * In-memory cache for risk aggregates per account.
 * Replaces per-trade DB scans with cached values that update on settlement.
 */

import { classifySupabaseError, getSupabaseAdmin, withSupabaseRetry } from './supabaseAdmin';
import { riskLogger } from './logger';
import { metrics } from './metrics';
import { record as recordObstacle } from './obstacleLog';

export interface RiskCacheEntry {
    accountId: string;
    dailyPnL: number;
    totalLossToday: number;
    totalProfitToday: number;
    lossStreak: number;
    consecutiveWins: number;
    equity: number;
    equityPeak: number;
    dailyStartEquity: number;
    openExposure: number; // Total stake of open positions
    openTradeCount: number; // Number of concurrent trades
    lastLossTime: number | null;
    lastTradeTime: number | null;
    lastUpdated: number;
    dateKey: string; // YYYY-MM-DD to detect day rollover
}

// Default max concurrent trades - can be overridden per-run via risk config
const DEFAULT_MAX_CONCURRENT_TRADES = Number(process.env.DEFAULT_MAX_CONCURRENT_TRADES) || 5;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const riskCache = new Map<string, RiskCacheEntry>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RISK_STATE_KEY = 'risk_state';
const PERSIST_DEBOUNCE_MS = 1000;

interface PersistedRiskState {
    date?: string;
    dailyStartEquity?: number;
    equityPeak?: number;
    equity?: number;
    dailyPnL?: number;
    totalLossToday?: number;
    totalProfitToday?: number;
    lossStreak?: number;
    consecutiveWins?: number;
    openExposure?: number;
    openTradeCount?: number;
    lastLossTime?: number;
    lastTradeTime?: number;
}

const toNumber = (value: unknown, fallback = 0): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
};

async function persistRiskState(accountId: string, entry: RiskCacheEntry): Promise<void> {
    const { client: supabaseAdmin, error } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        recordObstacle('risk', 'Risk state persistence', error || 'Supabase not configured', 'medium', ['backend/src/lib/riskCache.ts']);
        return;
    }

    const payload: PersistedRiskState = {
        date: entry.dateKey,
        dailyStartEquity: entry.dailyStartEquity,
        equityPeak: entry.equityPeak,
        equity: entry.equity,
        dailyPnL: entry.dailyPnL,
        totalLossToday: entry.totalLossToday,
        totalProfitToday: entry.totalProfitToday,
        lossStreak: entry.lossStreak,
        consecutiveWins: entry.consecutiveWins,
        openExposure: entry.openExposure,
        openTradeCount: entry.openTradeCount,
        lastLossTime: entry.lastLossTime ?? undefined,
        lastTradeTime: entry.lastTradeTime ?? undefined,
    };

    try {
        await withSupabaseRetry('settings.upsert.risk_state', async (client) => await client.from('settings').upsert({
            account_id: accountId,
            key: RISK_STATE_KEY,
            value: payload,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'account_id,key' }));
        metrics.counter('risk.cache_persisted');
    } catch (error) {
        const info = classifySupabaseError(error);
        metrics.counter('risk.cache_persist_error');
        riskLogger.error({ error: info.message, code: info.code, category: info.category }, 'Risk state persist failed');
    }
}

function schedulePersist(accountId: string, entry: RiskCacheEntry): void {
    if (persistTimers.has(accountId)) return;
    const timer = setTimeout(() => {
        persistTimers.delete(accountId);
        persistRiskState(accountId, entry).catch((error) => {
            riskLogger.error({ error, accountId }, 'Risk state persist failed');
        });
    }, PERSIST_DEBOUNCE_MS);
    persistTimers.set(accountId, timer);
}

/**
 * Get date key for today (used for daily reset detection)
 */
function getTodayKey(): string {
    return new Date().toISOString().split('T')[0];
}

/**
 * Get or initialize risk cache for an account
 */
export function getRiskCache(accountId: string): RiskCacheEntry | null {
    const entry = riskCache.get(accountId);

    if (!entry) {
        return null;
    }

    // Check for day rollover
    const today = getTodayKey();
    if (entry.dateKey !== today) {
        // Reset daily values
        entry.dailyPnL = 0;
        entry.totalLossToday = 0;
        entry.totalProfitToday = 0;
        entry.lossStreak = 0;
        entry.consecutiveWins = 0;
        entry.dailyStartEquity = entry.equity;
        entry.dateKey = today;
        entry.lastUpdated = Date.now();
        schedulePersist(accountId, entry);
    }

    // Check TTL
    if (Date.now() - entry.lastUpdated > CACHE_TTL_MS) {
        riskCache.delete(accountId);
        return null; // Expired, needs refresh from DB
    }

    return entry;
}

export async function hydrateRiskCache(accountId: string): Promise<RiskCacheEntry | null> {
    const { client: supabaseAdmin } = getSupabaseAdmin();
    if (!supabaseAdmin) return null;

    const [{ data: riskState }, { data: balanceSnapshot }] = await Promise.all([
        supabaseAdmin
            .from('settings')
            .select('value, updated_at')
            .eq('account_id', accountId)
            .eq('key', RISK_STATE_KEY)
            .maybeSingle(),
        supabaseAdmin
            .from('settings')
            .select('value')
            .eq('account_id', accountId)
            .eq('key', 'balance_snapshot')
            .maybeSingle(),
    ]);

    const persisted = riskState?.value && typeof riskState.value === 'object'
        ? riskState.value as PersistedRiskState
        : null;
    const snapshot = balanceSnapshot?.value && typeof balanceSnapshot.value === 'object'
        ? balanceSnapshot.value as { balance?: number }
        : null;

    const balance = typeof snapshot?.balance === 'number' ? snapshot.balance : null;
    const today = getTodayKey();
    const persistedDate = typeof persisted?.date === 'string' ? persisted.date : null;
    const isToday = persistedDate === today;

    const equity = typeof persisted?.equity === 'number'
        ? persisted.equity
        : typeof balance === 'number'
            ? balance
            : typeof persisted?.dailyStartEquity === 'number'
                ? persisted.dailyStartEquity + toNumber(persisted.dailyPnL, 0)
                : null;

    if (equity === null || !Number.isFinite(equity)) {
        return null;
    }

    const dailyPnL = isToday ? toNumber(persisted?.dailyPnL, 0) : 0;
    const totalLossToday = isToday ? toNumber(persisted?.totalLossToday, 0) : 0;
    const totalProfitToday = isToday ? toNumber(persisted?.totalProfitToday, 0) : 0;
    const lossStreak = isToday ? toNumber(persisted?.lossStreak, 0) : 0;
    const consecutiveWins = isToday ? toNumber(persisted?.consecutiveWins, 0) : 0;

    const entry: RiskCacheEntry = {
        accountId,
        equity,
        equityPeak: isToday
            ? toNumber(persisted?.equityPeak, equity)
            : equity,
        dailyStartEquity: isToday
            ? toNumber(persisted?.dailyStartEquity, equity)
            : equity,
        dailyPnL,
        totalLossToday,
        totalProfitToday,
        lossStreak,
        consecutiveWins,
        openExposure: toNumber(persisted?.openExposure, 0),
        openTradeCount: Math.max(0, Math.floor(toNumber(persisted?.openTradeCount, 0))),
        lastLossTime: persisted?.lastLossTime ?? null,
        lastTradeTime: persisted?.lastTradeTime ?? null,
        lastUpdated: Date.now(),
        dateKey: today,
    };

    riskCache.set(accountId, entry);
    schedulePersist(accountId, entry);
    return entry;
}

export async function getOrHydrateRiskCache(accountId: string): Promise<RiskCacheEntry | null> {
    const existing = getRiskCache(accountId);
    if (existing) return existing;
    return hydrateRiskCache(accountId);
}

export async function warmRiskCache(accountId: string, balanceHint?: number): Promise<RiskCacheEntry | null> {
    const existing = getRiskCache(accountId);
    if (existing) return existing;

    const hydrated = await hydrateRiskCache(accountId);
    if (hydrated) return hydrated;

    if (typeof balanceHint === 'number' && Number.isFinite(balanceHint)) {
        return initializeRiskCache(accountId, { equity: balanceHint });
    }

    return null;
}

/**
 * Initialize risk cache from database values
 */
export function initializeRiskCache(
    accountId: string,
    initialData: {
        equity: number;
        equityPeak?: number;
        dailyPnL?: number;
        totalLossToday?: number;
        totalProfitToday?: number;
        lossStreak?: number;
    }
): RiskCacheEntry {
    const today = getTodayKey();

    const entry: RiskCacheEntry = {
        accountId,
        equity: initialData.equity,
        equityPeak: initialData.equityPeak ?? initialData.equity,
        dailyStartEquity: initialData.equity - (initialData.dailyPnL ?? 0),
        dailyPnL: initialData.dailyPnL ?? 0,
        totalLossToday: initialData.totalLossToday ?? 0,
        totalProfitToday: initialData.totalProfitToday ?? 0,
        lossStreak: initialData.lossStreak ?? 0,
        consecutiveWins: 0,
        openExposure: 0,
        openTradeCount: 0,
        lastLossTime: null,
        lastTradeTime: null,
        lastUpdated: Date.now(),
        dateKey: today,
    };

    riskCache.set(accountId, entry);
    schedulePersist(accountId, entry);
    return entry;
}

/**
 * Record a new trade being placed (increases open exposure)
 */
export function recordTradeOpened(
    accountId: string,
    stake: number,
    maxConcurrentTrades?: number
): { allowed: boolean; reason?: string } {
    const entry = riskCache.get(accountId);

    if (!entry) {
        return { allowed: false, reason: 'Risk cache not initialized' };
    }

    const limit = maxConcurrentTrades ?? DEFAULT_MAX_CONCURRENT_TRADES;
    if (entry.openTradeCount >= limit) {
        return {
            allowed: false,
            reason: `Max concurrent trades (${limit}) reached`
        };
    }

    entry.openTradeCount += 1;
    entry.openExposure += stake;
    entry.lastTradeTime = Date.now();
    entry.lastUpdated = Date.now();
    schedulePersist(accountId, entry);

    return { allowed: true };
}

/**
 * Record a trade settlement (updates PnL and removes from open exposure)
 */
export function recordTradeSettled(
    accountId: string,
    stake: number,
    profit: number,
    options?: { skipExposure?: boolean }
): void {
    const entry = riskCache.get(accountId);

    if (!entry) {
        return;
    }

    if (!options?.skipExposure) {
        // Update open exposure
        entry.openTradeCount = Math.max(0, entry.openTradeCount - 1);
        entry.openExposure = Math.max(0, entry.openExposure - stake);
    }

    // Update PnL
    entry.dailyPnL += profit;
    entry.equity += profit;

    if (profit < 0) {
        entry.totalLossToday += Math.abs(profit);
        entry.lossStreak += 1;
        entry.consecutiveWins = 0;
        entry.lastLossTime = Date.now();
    } else {
        entry.totalProfitToday += profit;
        entry.consecutiveWins += 1;
        entry.lossStreak = 0;
    }

    // Update equity peak
    if (entry.equity > entry.equityPeak) {
        entry.equityPeak = entry.equity;
    }

    entry.lastUpdated = Date.now();
    schedulePersist(accountId, entry);
}

/**
 * Record a failed trade attempt (rollback open exposure)
 * Does NOT affect PnL or streaks.
 */
export function recordTradeFailedAttempt(
    accountId: string,
    stake: number
): void {
    const entry = riskCache.get(accountId);
    if (!entry) return;

    entry.openTradeCount = Math.max(0, entry.openTradeCount - 1);
    entry.openExposure = Math.max(0, entry.openExposure - stake);
    entry.lastUpdated = Date.now();
    schedulePersist(accountId, entry);
}

/**
 * Reconcile open trade state from external source (e.g., open contracts API)
 */
export function setOpenTradeState(accountId: string, openTradeCount: number, openExposure: number): void {
    const entry = riskCache.get(accountId);

    if (!entry) {
        return;
    }

    entry.openTradeCount = Math.max(0, Math.floor(openTradeCount));
    entry.openExposure = Math.max(0, openExposure);
    entry.lastUpdated = Date.now();
    schedulePersist(accountId, entry);
}

/**
 * Update equity from external source (e.g., balance refresh)
 */
export function updateEquity(accountId: string, newEquity: number): void {
    const entry = riskCache.get(accountId);

    if (entry) {
        entry.equity = newEquity;
        if (newEquity > entry.equityPeak) {
            entry.equityPeak = newEquity;
        }
        entry.lastUpdated = Date.now();
        schedulePersist(accountId, entry);
    }
}

/**
 * Evaluate risk status based on cached values
 */
export function evaluateCachedRisk(
    accountId: string,
    params: {
        proposedStake: number;
        maxStake: number;
        dailyLossLimitPct?: number;
        drawdownLimitPct?: number;
        maxConsecutiveLosses?: number;
        cooldownMs?: number;
        lossCooldownMs?: number;
        maxConcurrentTrades?: number;
    }
): {
    status: 'OK' | 'COOLDOWN' | 'HALT' | 'REDUCE_STAKE' | 'MAX_CONCURRENT';
    reason?: string;
    cooldownMs?: number;
} {
    const entry = riskCache.get(accountId);

    if (!entry) {
        // SECURITY: Fail closed if risk state is unknown. 
        // Previously returned 'OK' which allowed bypass.
        return {
            status: 'HALT',
            reason: 'Risk state not initialized (Fail Closed)'
        };
    }

    const now = Date.now();


    // Check concurrent trade limit
    const maxConcurrent = params.maxConcurrentTrades ?? DEFAULT_MAX_CONCURRENT_TRADES;
    if (entry.openTradeCount >= maxConcurrent) {
        return {
            status: 'MAX_CONCURRENT',
            reason: `Max ${maxConcurrent} concurrent trades`
        };
    }

    // Check loss streak cooldown
    if (
        params.maxConsecutiveLosses &&
        entry.lossStreak >= params.maxConsecutiveLosses &&
        params.lossCooldownMs &&
        entry.lastLossTime &&
        now - entry.lastLossTime < params.lossCooldownMs
    ) {
        return {
            status: 'COOLDOWN',
            reason: 'LOSS_STREAK',
            cooldownMs: params.lossCooldownMs - (now - entry.lastLossTime),
        };
    }

    // Check trade cooldown
    if (
        params.cooldownMs &&
        entry.lastTradeTime &&
        now - entry.lastTradeTime < params.cooldownMs
    ) {
        return {
            status: 'COOLDOWN',
            reason: 'TRADE_COOLDOWN',
            cooldownMs: params.cooldownMs - (now - entry.lastTradeTime),
        };
    }

    // Check daily loss limit
    if (params.dailyLossLimitPct && entry.dailyStartEquity > 0) {
        const dailyLossPct = (entry.totalLossToday / entry.dailyStartEquity) * 100;
        if (dailyLossPct >= params.dailyLossLimitPct) {
            return { status: 'HALT', reason: 'DAILY_LOSS' };
        }
    }

    // Check drawdown limit
    if (params.drawdownLimitPct && entry.equityPeak > 0) {
        const drawdownPct = ((entry.equityPeak - entry.equity) / entry.equityPeak) * 100;
        if (drawdownPct >= params.drawdownLimitPct) {
            return { status: 'HALT', reason: 'DRAWDOWN' };
        }
    }

    // Check stake limit
    if (params.proposedStake > params.maxStake) {
        return { status: 'REDUCE_STAKE', reason: 'STAKE_LIMIT' };
    }

    return { status: 'OK' };
}

/**
 * Get cache statistics for debugging
 */
export function getCacheStats(accountId: string): RiskCacheEntry | null {
    return riskCache.get(accountId) ?? null;
}

/**
 * Clear cache for an account
 */
export function clearRiskCache(accountId: string): void {
    riskCache.delete(accountId);
    const timer = persistTimers.get(accountId);
    if (timer) {
        clearTimeout(timer);
        persistTimers.delete(accountId);
    }
}

/**
 * Clear all caches (used for testing)
 */
export function clearAllRiskCaches(): void {
    riskCache.clear();
    for (const timer of persistTimers.values()) {
        clearTimeout(timer);
    }
    persistTimers.clear();
}
