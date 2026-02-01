'use client';

import dynamic from 'next/dynamic';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorFallback } from '@/components/ui/ErrorFallback';
import NotificationsPanel from '@/components/dashboard/NotificationsPanel';
import { useEffect, useMemo, useState } from 'react';
import { useTradingStore } from '@/store/tradingStore';
import { BotRunToggle } from '@/components/bots/BotRunToggle';
import { apiFetch, apiUrl } from '@/lib/api';

const PerformanceHeatmap = dynamic(() => import('@/components/analytics/PerformanceHeatmap'), { ssr: false });
const DashboardStats = dynamic(() => import('@/components/dashboard/DashboardStats').then(mod => mod.DashboardStats), { ssr: false });
const AccountSwitcher = dynamic(() => import('@/components/dashboard/AccountSwitcher'), { ssr: false });

type TradeRow = {
    id?: string;
    profit?: number | string | null;
    created_at?: string | null;
    contractId?: number | null;
};

const getUtcDayRange = () => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { startMs: start.getTime(), endMs: end.getTime() };
};

function DashboardContent() {
    const {
        lastTick,
        prevTick,
        botRunning,
        isAuthorized,
        activeAccountId,
    } = useTradingStore();

    const [todayTrades, setTodayTrades] = useState<TradeRow[]>([]);
    const totalTrades = todayTrades.length;

    const { netPnL, wins, losses } = useMemo(() => {
        let nextNet = 0;
        let nextWins = 0;
        let nextLosses = 0;

        todayTrades.forEach((trade) => {
            const profit = typeof trade.profit === 'number'
                ? trade.profit
                : typeof trade.profit === 'string'
                    ? Number(trade.profit)
                    : 0;
            if (!Number.isFinite(profit)) return;
            nextNet += profit;
            if (profit >= 0) {
                nextWins += 1;
            } else {
                nextLosses += 1;
            }
        });

        return { netPnL: nextNet, wins: nextWins, losses: nextLosses };
    }, [todayTrades]);

    const winRate = useMemo(() => {
        return totalTrades ? (wins / totalTrades) * 100 : 0;
    }, [wins, totalTrades]);

    useEffect(() => {
        if (!isAuthorized) {
            setTodayTrades([]);
            return;
        }

        let isMounted = true;

        const fetchTodayTrades = async () => {
            try {
                const res = await apiFetch('/api/trades?limit=1000');
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to fetch trades');
                }

                const trades = Array.isArray(data?.trades) ? data.trades as TradeRow[] : [];
                const { startMs, endMs } = getUtcDayRange();
                const filtered = trades.filter((trade) => {
                    if (!trade.created_at) return false;
                    const time = new Date(trade.created_at).getTime();
                    return Number.isFinite(time) && time >= startMs && time < endMs;
                });

                if (isMounted) {
                    setTodayTrades(filtered);
                }
            } catch {
                if (isMounted) {
                    setTodayTrades([]);
                }
            }
        };

        fetchTodayTrades();
        const interval = setInterval(fetchTodayTrades, 30000);

        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, [isAuthorized, activeAccountId]);

    useEffect(() => {
        if (!isAuthorized) return;

        const streamUrl = apiUrl('/api/trades/stream');
        const source = new EventSource(streamUrl, { withCredentials: true });

        const handleTradeEvent = (event: MessageEvent) => {
            try {
                const payload = JSON.parse(event.data) as {
                    id?: string | null;
                    contractId?: number | null;
                    profit?: number | string | null;
                    createdAt?: string | null;
                    created_at?: string | null;
                    symbol?: string | null;
                };

                const createdAt = payload.createdAt || payload.created_at || null;
                if (!createdAt) return;

                const createdMs = new Date(createdAt).getTime();
                if (!Number.isFinite(createdMs)) return;

                const { startMs, endMs } = getUtcDayRange();
                if (createdMs < startMs || createdMs >= endMs) return;

                const tradeId = payload.id ?? null;
                const contractId = payload.contractId ?? null;

                setTodayTrades((prev) => {
                    const exists = prev.some((trade) =>
                        (trade.id && tradeId && trade.id === tradeId)
                        || (trade.contractId && contractId && trade.contractId === contractId)
                    );
                    if (exists) return prev;
                    return [{
                        id: tradeId ?? undefined,
                        contractId: contractId ?? undefined,
                        profit: payload.profit ?? 0,
                        created_at: createdAt,
                    }, ...prev];
                });
            } catch {
                // ignore malformed events
            }
        };

        source.addEventListener('trade', handleTradeEvent);

        return () => {
            source.removeEventListener('trade', handleTradeEvent);
            source.close();
        };
    }, [isAuthorized, activeAccountId]);

    return (
        <div className="relative min-h-screen">
            <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-8">
                <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <p className="text-xs text-muted-foreground uppercase tracking-[0.45em]">Overview</p>
                        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Performance Command Center</h1>
                        <p className="text-sm text-muted-foreground mt-2 max-w-xl">
                            Real-time pulse on strategy health, account performance, and execution flow.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <BotRunToggle size="sm" />
                        <div className="rounded-full border border-border/60 bg-muted/30 px-4 py-2 text-xs uppercase tracking-widest text-muted-foreground">
                            Win Rate <span className="text-foreground ml-2 font-mono">{winRate.toFixed(1)}%</span>
                        </div>
                        <AccountSwitcher />
                    </div>
                </div>

                <DashboardStats
                    lastTick={lastTick}
                    prevTick={prevTick}
                    botRunning={botRunning}
                    netPnL={netPnL}
                    totalTrades={totalTrades}
                />

                <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr,1fr]">
                    <div className="space-y-6">
                        <section className="glass-panel rounded-2xl p-6">
                            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <h3 className="text-lg font-semibold">Performance Overview</h3>
                                    <p className="text-xs text-muted-foreground uppercase tracking-widest mt-1">
                                        Last 30 days
                                    </p>
                                </div>
                                <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-muted-foreground">
                                    <span className="rounded-full border border-border/60 bg-muted/30 px-3 py-1">
                                        {totalTrades} trades
                                    </span>
                                    <span className={`rounded-full border px-3 py-1 ${netPnL >= 0 ? 'border-emerald-400/40 text-emerald-600 dark:text-emerald-300' : 'border-red-400/40 text-red-600 dark:text-red-300'}`}>
                                        {netPnL >= 0 ? '+' : ''}{netPnL.toFixed(2)} P&amp;L
                                    </span>
                                </div>
                            </div>
                            <PerformanceHeatmap />
                        </section>

                    </div>

                    <div className="space-y-6">
                        <NotificationsPanel />
                        <section className="glass-panel rounded-2xl p-6 space-y-4">
                            <div className="flex items-center justify-between">
                                <h3 className="text-lg font-semibold">Quick Insights</h3>
                                <span className="text-xs uppercase tracking-widest text-muted-foreground">Today</span>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                                    <p className="text-xs text-muted-foreground uppercase tracking-widest">Wins</p>
                                    <p className="mt-2 text-xl font-mono text-emerald-600 dark:text-emerald-400">{wins}</p>
                                </div>
                                <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                                    <p className="text-xs text-muted-foreground uppercase tracking-widest">Losses</p>
                                    <p className="mt-2 text-xl font-mono text-red-600 dark:text-red-400">{losses}</p>
                                </div>
                                <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                                    <p className="text-xs text-muted-foreground uppercase tracking-widest">Net P&amp;L</p>
                                    <p className={`mt-2 text-xl font-mono ${netPnL >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                        {netPnL >= 0 ? '+' : ''}{netPnL.toFixed(2)}
                                    </p>
                                </div>
                                <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                                    <p className="text-xs text-muted-foreground uppercase tracking-widest">Bot Status</p>
                                    <p className={`mt-2 text-lg font-mono ${botRunning ? 'text-emerald-600 dark:text-emerald-300' : 'text-muted-foreground'}`}>
                                        {botRunning ? 'RUNNING' : 'IDLE'}
                                    </p>
                                </div>
                            </div>
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function DashboardPage() {
    return (
        <ErrorBoundary FallbackComponent={ErrorFallback}>
            <DashboardContent />
        </ErrorBoundary>
    );
}
