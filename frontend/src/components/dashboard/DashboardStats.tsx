'use client';

import { Activity, TrendingUp, TrendingDown, BarChart2 } from 'lucide-react';
import { useTradingStore } from '@/store/tradingStore';

interface DashboardStatsProps {
    lastTick: number;
    prevTick: number;
    botRunning: boolean;
    netPnL: number;
    totalTrades: number;
}

export function DashboardStats({ lastTick, prevTick, botRunning, netPnL, totalTrades }: DashboardStatsProps) {
    const selectedSymbol = useTradingStore((state) => state.selectedSymbol);
    const tickDirection = lastTick > prevTick ? 'up' : lastTick < prevTick ? 'down' : 'neutral';

    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {/* Live Price */}
            <div className="glass-panel rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-mono">{selectedSymbol || 'R_100'}</span>
                    {tickDirection === 'up' ? (
                        <TrendingUp className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    ) : tickDirection === 'down' ? (
                        <TrendingDown className="w-4 h-4 text-red-600 dark:text-red-400" />
                    ) : (
                        <Activity className="w-4 h-4 text-muted-foreground" />
                    )}
                </div>
                <div className={`text-2xl font-mono font-bold ${tickDirection === 'up' ? 'text-emerald-600 dark:text-emerald-400' :
                    tickDirection === 'down' ? 'text-red-600 dark:text-red-400' : 'text-foreground'
                    }`}>
                    {lastTick?.toFixed(2) || '-.--'}
                </div>
            </div>

            {/* Bot Status */}
            <div className="glass-panel rounded-xl p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Bot Status</p>
                <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${botRunning ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'}`} />
                    <span className={`text-lg font-semibold ${botRunning ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                        {botRunning ? 'Running' : 'Stopped'}
                    </span>
                </div>
            </div>

            {/* Daily P&L */}
            <div className="glass-panel rounded-xl p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Today&apos;s P&amp;L</p>
                <div className={`text-2xl font-mono font-bold ${netPnL >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                    {netPnL >= 0 ? '+' : ''}{netPnL.toFixed(2)}
                </div>
            </div>

            {/* Win Rate Placeholder */}
            <div className="glass-panel rounded-xl p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Trades Today</p>
                <div className="flex items-center gap-2">
                    <BarChart2 className="w-5 h-5 text-accent" />
                    <span className="text-lg font-mono">
                        {totalTrades}
                    </span>
                </div>
            </div>
        </div>
    );
}
