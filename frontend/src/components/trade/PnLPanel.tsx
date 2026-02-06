'use client';

import { useTradingStore } from '@/store/tradingStore';
import { TrendingUp, TrendingDown, Activity, AlertTriangle, BarChart3 } from 'lucide-react';
import { useMemo } from 'react';

/**
 * PnLPanel — Real-time Profit & Loss display
 * Shows realized/unrealized/net PnL, win rate, open positions, and balance drift warning
 */
export default function PnLPanel() {
    const realizedPnL = useTradingStore((s) => s.pnlRealizedPnL);
    const unrealizedPnL = useTradingStore((s) => s.pnlUnrealizedPnL);
    const netPnL = useTradingStore((s) => s.pnlNetPnL);
    const winCount = useTradingStore((s) => s.pnlWinCount);
    const lossCount = useTradingStore((s) => s.pnlLossCount);
    const avgWin = useTradingStore((s) => s.pnlAvgWin);
    const avgLoss = useTradingStore((s) => s.pnlAvgLoss);
    const openPositionCount = useTradingStore((s) => s.pnlOpenPositionCount);
    const openExposure = useTradingStore((s) => s.pnlOpenExposure);
    const balanceDrift = useTradingStore((s) => s.pnlBalanceDrift);
    const positions = useTradingStore((s) => s.pnlPositions);

    const totalTrades = winCount + lossCount;
    const winRate = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(1) : '—';
    const expectancy = useMemo(() => {
        if (totalTrades === 0) return 0;
        const pWin = winCount / totalTrades;
        const pLoss = lossCount / totalTrades;
        return pWin * avgWin - pLoss * avgLoss;
    }, [totalTrades, winCount, lossCount, avgWin, avgLoss]);

    const pnlColor = (v: number) =>
        v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-400';

    const pnlBg = (v: number) =>
        v > 0 ? 'bg-emerald-500/10' : v < 0 ? 'bg-red-500/10' : 'bg-slate-500/10';

    const formatCurrency = (v: number) => {
        const sign = v >= 0 ? '+' : '';
        return `${sign}$${v.toFixed(2)}`;
    };

    return (
        <div className="rounded-xl border border-slate-700/50 bg-slate-900/60 backdrop-blur-sm">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-700/40">
                <div className="flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-indigo-400" />
                    <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">P&L</span>
                </div>
                {balanceDrift !== null && balanceDrift > 0.01 && (
                    <div className="flex items-center gap-1 text-amber-400" title={`Balance drift: $${balanceDrift.toFixed(2)}`}>
                        <AlertTriangle className="h-3.5 w-3.5" />
                        <span className="text-[10px] font-medium">Drift: ${balanceDrift.toFixed(2)}</span>
                    </div>
                )}
            </div>

            {/* Main PnL Numbers */}
            <div className="grid grid-cols-3 gap-px bg-slate-700/20">
                {/* Net PnL */}
                <div className={`px-3 py-2.5 ${pnlBg(netPnL)}`}>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">Net P&L</div>
                    <div className={`text-lg font-bold tabular-nums ${pnlColor(netPnL)}`}>
                        {formatCurrency(netPnL)}
                    </div>
                </div>

                {/* Realized */}
                <div className="px-3 py-2.5 bg-slate-800/40">
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">Realized</div>
                    <div className={`text-sm font-semibold tabular-nums ${pnlColor(realizedPnL)}`}>
                        {formatCurrency(realizedPnL)}
                    </div>
                </div>

                {/* Unrealized */}
                <div className="px-3 py-2.5 bg-slate-800/40">
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">Unrealized</div>
                    <div className={`text-sm font-semibold tabular-nums ${pnlColor(unrealizedPnL)}`}>
                        {formatCurrency(unrealizedPnL)}
                    </div>
                </div>
            </div>

            {/* Stats Row */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t border-slate-700/30">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    {/* Win Rate */}
                    <div className="flex items-center gap-1.5">
                        <div className="flex items-center gap-0.5">
                            <TrendingUp className="h-3 w-3 text-emerald-400" />
                            <span className="text-[11px] font-medium text-emerald-400">{winCount}</span>
                        </div>
                        <span className="text-slate-600">/</span>
                        <div className="flex items-center gap-0.5">
                            <TrendingDown className="h-3 w-3 text-red-400" />
                            <span className="text-[11px] font-medium text-red-400">{lossCount}</span>
                        </div>
                        <span className="text-[10px] text-slate-500 ml-0.5">({winRate}%)</span>
                    </div>

                    {/* Expectancy */}
                    <div className="flex items-center gap-1">
                        <span className="text-[10px] text-slate-500">EV:</span>
                        <span className={`text-[11px] font-medium tabular-nums ${pnlColor(expectancy)}`}>
                            {formatCurrency(expectancy)}
                        </span>
                    </div>

                    {/* Average Win/Loss */}
                    <div className="flex items-center gap-1">
                        <span className="text-[10px] text-slate-500">Avg W/L:</span>
                        <span className="text-[11px] text-emerald-400 tabular-nums">${avgWin.toFixed(2)}</span>
                        <span className="text-slate-600">/</span>
                        <span className="text-[11px] text-red-400 tabular-nums">${avgLoss.toFixed(2)}</span>
                    </div>
                </div>

                {/* Open Positions */}
                {openPositionCount > 0 && (
                    <div className="flex items-center gap-1.5">
                        <Activity className="h-3 w-3 text-sky-400 animate-pulse" />
                        <span className="text-[11px] text-sky-400 font-medium">
                            {openPositionCount} open (${openExposure.toFixed(2)})
                        </span>
                    </div>
                )}
            </div>

            {/* Open Positions Detail (collapsed when empty) */}
            {positions.length > 0 && (
                <div className="border-t border-slate-700/30 px-3 py-2 space-y-1">
                    {positions.map((pos) => (
                        <div
                            key={pos.contractId}
                            className="flex items-center justify-between text-[11px] py-0.5"
                        >
                            <div className="flex items-center gap-2">
                                <span className={`font-medium px-1.5 py-0.5 rounded text-[10px] ${
                                    pos.direction === 'CALL'
                                        ? 'bg-emerald-500/15 text-emerald-400'
                                        : 'bg-red-500/15 text-red-400'
                                }`}>
                                    {pos.direction}
                                </span>
                                <span className="text-slate-400">{pos.symbol}</span>
                                <span className="text-slate-600">${pos.stake.toFixed(2)}</span>
                            </div>
                            <span className={`font-medium tabular-nums ${pnlColor(pos.unrealizedPnL)}`}>
                                {formatCurrency(pos.unrealizedPnL)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
