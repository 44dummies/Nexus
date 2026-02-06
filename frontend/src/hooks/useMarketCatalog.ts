'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

export type MarketCategory =
    | 'synthetic'
    | 'crash_boom'
    | 'jump'
    | 'forex'
    | 'crypto'
    | 'commodities';

export interface MarketInfo {
    symbol: string;
    displayName: string;
    category: MarketCategory;
}

interface MarketCatalogResponse {
    markets?: MarketInfo[];
}

interface MarketCatalogState {
    markets: MarketInfo[];
    loading: boolean;
    error: string | null;
}

let cachedMarkets: MarketInfo[] | null = null;
let inflight: Promise<MarketInfo[]> | null = null;

async function loadMarketCatalog(): Promise<MarketInfo[]> {
    const res = await apiFetch('/api/markets', { cache: 'no-store' });
    const payload = await res.json().catch(() => ({} as MarketCatalogResponse));
    if (!res.ok) {
        const message = typeof payload?.error === 'string' ? payload.error : 'Failed to load markets';
        throw new Error(message);
    }
    return Array.isArray(payload?.markets) ? payload.markets : [];
}

export function useMarketCatalog(): MarketCatalogState {
    const [state, setState] = useState<MarketCatalogState>(() => ({
        markets: cachedMarkets ?? [],
        loading: cachedMarkets === null,
        error: null,
    }));

    useEffect(() => {
        let cancelled = false;

        if (cachedMarkets) {
            return () => {
                cancelled = true;
            };
        }

        if (!inflight) {
            inflight = loadMarketCatalog().finally(() => {
                inflight = null;
            });
        }

        inflight
            .then((markets) => {
                cachedMarkets = markets;
                if (!cancelled) {
                    setState({ markets, loading: false, error: null });
                }
            })
            .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : 'Failed to load markets';
                if (!cancelled) {
                    setState({ markets: [], loading: false, error: message });
                }
            });

        return () => {
            cancelled = true;
        };
    }, []);

    return state;
}
