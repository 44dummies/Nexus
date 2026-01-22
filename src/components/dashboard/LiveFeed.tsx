'use client';
import React from 'react';

import { useTradingStore } from '@/store/tradingStore';
import { TrendingUp, TrendingDown, Activity, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

function LiveFeed() {
    const {
        tickHistory,
        lastTick,
        prevTick,
        botLogs,
        totalProfitToday,
        totalLossToday,
        botRunning,
        clearLogs,
    } = useTradingStore();

    const direction = lastTick > prevTick ? 'up' : lastTick < prevTick ? 'down' : 'neutral';
    const change = lastTick - prevTick;
    const netPnL = totalProfitToday - totalLossToday;

    // Get last 20 ticks for mini chart
    const chartData = tickHistory.slice(-20);
    const minTick = Math.min(...chartData);
    const maxTick = Math.max(...chartData);
    const range = maxTick - minTick || 1;

    const getLogColor = (type: string) => {
        switch (type) {
            case 'signal': return 'text-accent';
            case 'trade': return 'text-emerald-500';
            case 'result': return 'text-amber-500';
            case 'error': return 'text-red-500';
            default: return 'text-muted-foreground';
        }
    };

    const getLogIcon = (type: string) => {
        switch (type) {
            case 'signal': return '⚡';
            case 'trade': return '📈';
            case 'result': return '💰';
            case 'error': return '❌';
            default: return '•';
        }
    };

    return (
        <div className="glass-panel rounded-2xl p-6 h-full flex flex-col">
            {/* Header Row */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <h3 className="text-sm font-mono text-muted-foreground uppercase tracking-widest">Live Feed</h3>
                    <span className={`px-2 py-0.5 rounded text-xs uppercase ${botRunning ? 'bg-emerald-500/20 text-emerald-500' : 'bg-muted text-muted-foreground'}`}>
                        {botRunning ? '● ACTIVE' : '○ IDLE'}
                    </span>
                </div>
                <div className="flex items-center gap-4">
                    <div className={`text-lg font-mono font-bold ${netPnL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        {netPnL >= 0 ? '+' : ''}{netPnL.toFixed(2)} USD
                    </div>
                    <button
                        onClick={clearLogs}
                        className="p-2 hover:bg-muted/40 rounded-lg transition-colors"
                        title="Clear logs"
                    >
                        <Trash2 className="w-4 h-4 text-muted-foreground" />
                    </button>
                </div>
            </div>

            {/* Price + Mini Chart Row */}
            <div className="flex items-center gap-6 mb-4 pb-4 border-b border-border">
                <motion.div
                    key={lastTick}
                    initial={{ scale: 1.05 }}
                    animate={{ scale: 1 }}
                    className={`text-3xl font-mono font-bold ${direction === 'up' ? 'text-emerald-400' :
                        direction === 'down' ? 'text-red-500' : 'text-foreground'
                        }`}
                >
                    {lastTick.toFixed(2)}
                </motion.div>
                <div className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${direction === 'up' ? 'bg-emerald-500/20 text-emerald-500' :
                    direction === 'down' ? 'bg-red-500/20 text-red-500' :
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
            <div className="grid grid-cols-4 gap-4 mb-4 pb-4 border-b border-border">
                <div>
                    <div className="text-xs text-muted-foreground mb-1">Today Profit</div>
                    <div className="font-mono text-emerald-500">+{totalProfitToday.toFixed(2)}</div>
                </div>
                <div>
                    <div className="text-xs text-muted-foreground mb-1">Today Loss</div>
                    <div className="font-mono text-red-500">-{totalLossToday.toFixed(2)}</div>
                </div>
                <div>
                    <div className="text-xs text-muted-foreground mb-1">Ticks</div>
                    <div className="font-mono text-muted-foreground">{tickHistory.length}</div>
                </div>
                <div>
                    <div className="text-xs text-muted-foreground mb-1">Symbol</div>
                    <div className="font-mono text-muted-foreground">R_100</div>
                </div>
            </div>

            {/* Bot Logs */}
            <div className="flex-1 overflow-hidden">
                <div className="text-xs text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-2">
                    <Activity className="w-3 h-3" />
                    Bot Activity Log
                </div>
                <div className="h-[200px] overflow-y-auto space-y-1 pr-2 scrollbar-thin scrollbar-thumb-border/60">
                    <AnimatePresence>
                        {botLogs.length === 0 ? (
                            <div className="text-muted-foreground text-center py-8 font-mono text-xs">
                                Start the bot to see activity...
                            </div>
                        ) : (
                            botLogs.map((log) => (
                                <motion.div
                                    key={log.id}
                                    initial={{ opacity: 0, x: 20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0 }}
                                    className="flex items-start gap-2 text-xs font-mono"
                                >
                                    <span className="text-muted-foreground shrink-0">
                                        {new Date(log.timestamp).toLocaleTimeString()}
                                    </span>
                                    <span>{getLogIcon(log.type)}</span>
                                    <span className={getLogColor(log.type)}>
                                        {log.message}
                                    </span>
                                </motion.div>
                            ))
                        )}
                    </AnimatePresence>
                </div>
            </div>
        </div>
    );
}

const LiveFeedMemo = React.memo(LiveFeed);
export default LiveFeedMemo;
