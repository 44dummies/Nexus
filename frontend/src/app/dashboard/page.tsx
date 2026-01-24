'use client';

import dynamic from 'next/dynamic';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorFallback } from '@/components/ui/ErrorFallback';
import NotificationsPanel from '@/components/dashboard/NotificationsPanel';
import { useMemo } from 'react';
import { useTradingStore } from '@/store/tradingStore';

const PerformanceHeatmap = dynamic(() => import('@/components/analytics/PerformanceHeatmap'), { ssr: false });
const DashboardStats = dynamic(() => import('@/components/dashboard/DashboardStats').then(mod => mod.DashboardStats), { ssr: false });
const StrategySelector = dynamic(() => import('@/components/dashboard/StrategySelector'), { ssr: false });
const AccountSwitcher = dynamic(() => import('@/components/dashboard/AccountSwitcher'), { ssr: false });

function DashboardContent() {
    const {
        lastTick,
        prevTick,
        botRunning,
        totalProfitToday,
        totalLossToday,
        tradeResults,
    } = useTradingStore();

    const netPnL = totalProfitToday - totalLossToday;
    const totalTrades = tradeResults.length;
    const { wins, losses, winRate } = useMemo(() => {
        const wins = tradeResults.filter((t) => t.profit >= 0).length;
        const losses = tradeResults.length - wins;
        const winRate = tradeResults.length ? (wins / tradeResults.length) * 100 : 0;
        return { wins, losses, winRate };
    }, [tradeResults]);

    return (
        <div className="relative min-h-screen">
            <div className="mx-auto w-full max-w-6xl px-6 py-8">
                <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <p className="text-xs text-muted-foreground uppercase tracking-[0.45em]">Overview</p>
                        <h1 className="text-3xl font-semibold tracking-tight">Performance Command Center</h1>
                        <p className="text-sm text-muted-foreground mt-2 max-w-xl">
                            Real-time pulse on strategy health, account performance, and execution flow.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
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
                                    <span className={`rounded-full border px-3 py-1 ${netPnL >= 0 ? 'border-emerald-400/40 text-emerald-300' : 'border-red-400/40 text-red-300'}`}>
                                        {netPnL >= 0 ? '+' : ''}{netPnL.toFixed(2)} P&amp;L
                                    </span>
                                </div>
                            </div>
                            <PerformanceHeatmap />
                        </section>

                        <section className="glass-panel rounded-2xl p-6">
                            <div className="mb-4 flex items-center justify-between">
                                <div>
                                    <h3 className="text-lg font-semibold">Strategy Matrix</h3>
                                    <p className="text-xs text-muted-foreground uppercase tracking-widest mt-1">
                                        Signal alignment and edge density
                                    </p>
                                </div>
                                <span className="text-xs uppercase tracking-widest text-muted-foreground">Live</span>
                            </div>
                            <StrategySelector />
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
                                    <p className="mt-2 text-xl font-mono text-emerald-400">{wins}</p>
                                </div>
                                <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                                    <p className="text-xs text-muted-foreground uppercase tracking-widest">Losses</p>
                                    <p className="mt-2 text-xl font-mono text-red-400">{losses}</p>
                                </div>
                                <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                                    <p className="text-xs text-muted-foreground uppercase tracking-widest">Net P&amp;L</p>
                                    <p className={`mt-2 text-xl font-mono ${netPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {netPnL >= 0 ? '+' : ''}{netPnL.toFixed(2)}
                                    </p>
                                </div>
                                <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                                    <p className="text-xs text-muted-foreground uppercase tracking-widest">Bot Status</p>
                                    <p className={`mt-2 text-lg font-mono ${botRunning ? 'text-emerald-300' : 'text-muted-foreground'}`}>
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
