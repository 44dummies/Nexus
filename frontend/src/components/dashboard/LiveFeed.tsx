'use client';
import React from 'react';

import { useTradingStore } from '@/store/tradingStore';
import { getMarketDisplayName } from '@/components/trade/MarketSelector';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';

function LiveFeed() {
    const shouldReduceMotion = useReducedMotion();
    const {
        tickHistory,
        lastTick,
        prevTick,
        totalProfitToday,
        totalLossToday,
        botRunning,
        tradeResults,
        selectedSymbol,
    } = useTradingStore();

    const symbolName = getMarketDisplayName(selectedSymbol);

    const direction = lastTick > prevTick ? 'up' : lastTick < prevTick ? 'down' : 'neutral';
    const change = lastTick - prevTick;
    const netPnL = totalProfitToday - totalLossToday;

    // Get last 20 ticks for mini chart
    const chartData = tickHistory.slice(-20);
    const minTick = Math.min(...chartData);
    const maxTick = Math.max(...chartData);
    const range = maxTick - minTick || 1;

    return (
        <div className="glass-panel rounded-2xl p-6 h-full flex flex-col">
            {/* Header Row */}
            <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                <div className="flex items-center gap-3">
                    <h3 className="text-sm font-mono text-muted-foreground uppercase tracking-widest">Live Feed</h3>
                    <span className={`px-2 py-0.5 rounded text-xs uppercase ${botRunning ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                        {botRunning ? '● ACTIVE' : '○ IDLE'}
                    </span>
                </div>
                <div className={`text-base sm:text-lg font-mono font-bold ${netPnL >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                    {netPnL >= 0 ? '+' : ''}{netPnL.toFixed(2)} USD
                </div>
            </div>

            {/* Price + Mini Chart Row */}
            <div className="flex items-center gap-6 mb-4 pb-4 border-b border-border">
                <motion.div
                    key={lastTick}
                    initial={shouldReduceMotion ? false : { scale: 1.05 }}
                    animate={{ scale: 1 }}
                    transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.15 }}
                    className={`text-3xl font-mono font-bold ${direction === 'up' ? 'text-emerald-600 dark:text-emerald-400' :
                        direction === 'down' ? 'text-red-600 dark:text-red-400' : 'text-foreground'
                        }`}
                >
                    {lastTick.toFixed(2)}
                </motion.div>
                <div className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${direction === 'up' ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' :
                    direction === 'down' ? 'bg-red-500/20 text-red-600 dark:text-red-400' :
                        'bg-muted text-muted-foreground'
                    }`}>
                    {direction === 'up' ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                    <span>{change >= 0 ? '+' : ''}{change.toFixed(2)}</span>
                </div>

                {/* Mini Chart */}
                <div className="flex-1 h-8 flex items-end gap-0.5">
                    {chartData.map((tick, i) => {
                        const height = ((tick - minTick) / range) * 100;
                        const isUp = i > 0 && tick > chartData[i - 1];
                        return (
                            <div
                                key={i}
                                className={`flex-1 rounded-t transition-all ${isUp ? 'bg-emerald-500/60' : 'bg-red-500/60'
                                    }`}
                                style={{ height: `${Math.max(height, 10)}%` }}
                            />
                        );
                    })}
                </div>
            </div>

            {/* Stats Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 pb-4 border-b border-border">
                <div>
                    <div className="text-xs text-muted-foreground mb-1">Today Profit</div>
                    <div className="font-mono text-emerald-600 dark:text-emerald-400">+{totalProfitToday.toFixed(2)}</div>
                </div>
                <div>
                    <div className="text-xs text-muted-foreground mb-1">Today Loss</div>
                    <div className="font-mono text-red-600 dark:text-red-400">-{totalLossToday.toFixed(2)}</div>
                </div>
                <div>
                    <div className="text-xs text-muted-foreground mb-1">Ticks</div>
                    <div className="font-mono text-muted-foreground">{tickHistory.length}</div>
                </div>
                <div>
                    <div className="text-xs text-muted-foreground mb-1">Symbol</div>
                    <div className="font-mono text-muted-foreground truncate" title={symbolName}>{selectedSymbol || 'R_100'}</div>
                </div>
            </div>

            {/* Trade Results */}
            <div className="flex-1 overflow-hidden">
                <div className="flex items-center justify-between text-xs uppercase tracking-widest text-muted-foreground">
                    <span>Trade P&amp;L Stream</span>
                    <span>{tradeResults.length} entries</span>
                </div>
                <div className="mt-3 h-[280px] overflow-y-auto space-y-2 pr-2 scrollbar-thin scrollbar-thumb-border/60">
                    {tradeResults.length === 0 ? (
                        <div className="text-muted-foreground text-center py-6 font-mono text-xs">
                            Trades will appear here as they settle.
                        </div>
                    ) : (
                        tradeResults.map((trade) => (
                            <div
                                key={trade.id}
                                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs font-mono"
                            >
                                <div className="flex items-center gap-3">
                                    <span className="text-muted-foreground">
                                        {new Date(trade.timestamp).toLocaleTimeString()}
                                    </span>
                                    <span className="text-muted-foreground">
                                        #{trade.contractId ?? '—'}
                                    </span>
                                </div>
                                <span className={`${trade.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'} text-sm`}>
                                    {trade.profit >= 0 ? '+' : ''}{trade.profit.toFixed(2)}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

const LiveFeedMemo = React.memo(LiveFeed);
export default LiveFeedMemo;
