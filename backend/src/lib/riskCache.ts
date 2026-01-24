/**
 * In-memory cache for risk aggregates per account.
 * Replaces per-trade DB scans with cached values that update on settlement.
 */

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
    }

    // Check TTL
    if (Date.now() - entry.lastUpdated > CACHE_TTL_MS) {
        return null; // Expired, needs refresh from DB
    }

    return entry;
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

    return { allowed: true };
}

/**
 * Record a trade settlement (updates PnL and removes from open exposure)
 */
export function recordTradeSettled(
    accountId: string,
    stake: number,
    profit: number
): void {
    const entry = riskCache.get(accountId);

    if (!entry) {
        return;
    }

    // Update open exposure
    entry.openTradeCount = Math.max(0, entry.openTradeCount - 1);
    entry.openExposure = Math.max(0, entry.openExposure - stake);

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
        return { status: 'OK' }; // No cache, allow trade (will check DB)
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
}

/**
 * Clear all caches (used for testing)
 */
export function clearAllRiskCaches(): void {
    riskCache.clear();
}
