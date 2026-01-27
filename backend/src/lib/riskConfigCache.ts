import type { TradeRiskConfig } from './riskConfig';

type CacheEntry = {
    accountId: string;
    config: Partial<TradeRiskConfig> | null;
    updatedAt: number;
};

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = Math.max(60_000, Number(process.env.RISK_CONFIG_CACHE_TTL_MS) || 5 * 60 * 1000);

function isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.updatedAt > CACHE_TTL_MS;
}

export function primeRiskConfig(
    botRunId: string,
    accountId: string,
    config: Partial<TradeRiskConfig> | null
): void {
    if (!botRunId) return;
    cache.set(botRunId, {
        accountId,
        config: config ?? null,
        updatedAt: Date.now(),
    });
}

export function getRiskConfigCached(botRunId?: string | null): Partial<TradeRiskConfig> | null {
    if (!botRunId) return null;
    const entry = cache.get(botRunId);
    if (!entry) return null;
    if (isExpired(entry)) {
        cache.delete(botRunId);
        return null;
    }
    return entry.config ?? null;
}

export function dropRiskConfig(botRunId: string): void {
    if (!botRunId) return;
    cache.delete(botRunId);
}

