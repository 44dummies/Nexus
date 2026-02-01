'use client';

import { TrendingUp, TrendingDown, Zap } from 'lucide-react';

interface BotsPerformanceProps {
    totalProfitToday: number;
    totalLossToday: number;
    netPnL: number;
}

export function BotsPerformance({ totalProfitToday, totalLossToday, netPnL }: BotsPerformanceProps) {
    return (
        <div className="glass-panel rounded-2xl p-6">
            <h2 className="text-lg font-semibold mb-4">Today&apos;s Performance</h2>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-center">
                    <TrendingUp className="w-5 h-5 text-emerald-600 dark:text-emerald-400 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground uppercase">Profit</p>
                    <p className="text-xl font-mono font-bold text-emerald-600 dark:text-emerald-400">+${totalProfitToday.toFixed(2)}</p>
                </div>
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
                    <TrendingDown className="w-5 h-5 text-red-600 dark:text-red-400 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground uppercase">Loss</p>
                    <p className="text-xl font-mono font-bold text-red-600 dark:text-red-400">-${totalLossToday.toFixed(2)}</p>
                </div>
                <div className={`border rounded-xl p-4 text-center ${netPnL >= 0 ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
                    <Zap className={`w-5 h-5 mx-auto mb-2 ${netPnL >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`} />
                    <p className="text-xs text-muted-foreground uppercase">Net</p>
                    <p className={`text-xl font-mono font-bold ${netPnL >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                        {netPnL >= 0 ? '+' : ''}{netPnL.toFixed(2)}
                    </p>
                </div>
            </div>
        </div>
    );
}
