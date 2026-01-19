'use client';

import { useTradingStore } from '@/store/tradingStore';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { motion } from 'framer-motion';

export default function LiveFeed() {
    const { tickHistory, lastTick, prevTick } = useTradingStore();

    const direction = lastTick > prevTick ? 'up' : lastTick < prevTick ? 'down' : 'neutral';
    const change = lastTick - prevTick;
    const changePercent = prevTick > 0 ? ((change / prevTick) * 100).toFixed(3) : '0.000';

    // Get last 20 ticks for mini chart
    const chartData = tickHistory.slice(-20);
    const minTick = Math.min(...chartData);
    const maxTick = Math.max(...chartData);
    const range = maxTick - minTick || 1;

    return (
        <div className="glass-panel rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-mono text-gray-400 uppercase tracking-widest">Live Feed</h3>
                <span className="text-xs text-gray-500">R_100</span>
            </div>

            {/* Current Price Display */}
            <div className="flex items-center gap-4 mb-6">
                <motion.div
                    key={lastTick}
                    initial={{ scale: 1.05 }}
                    animate={{ scale: 1 }}
                    className={`text-4xl font-mono font-bold ${direction === 'up' ? 'text-emerald-400' :
                            direction === 'down' ? 'text-red-400' : 'text-white'
                        }`}
                >
                    {lastTick.toFixed(2)}
                </motion.div>
                <div className={`flex items-center gap-1 px-3 py-1 rounded-full text-sm ${direction === 'up' ? 'bg-emerald-500/20 text-emerald-400' :
                        direction === 'down' ? 'bg-red-500/20 text-red-400' :
                            'bg-gray-500/20 text-gray-400'
                    }`}>
                    {direction === 'up' ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                    <span>{change >= 0 ? '+' : ''}{change.toFixed(2)}</span>
                    <span className="text-xs opacity-70">({changePercent}%)</span>
                </div>
            </div>

            {/* Mini Chart */}
            <div className="h-16 flex items-end gap-0.5">
                {chartData.map((tick, i) => {
                    const height = ((tick - minTick) / range) * 100;
                    const isUp = i > 0 && tick > chartData[i - 1];
                    const isDown = i > 0 && tick < chartData[i - 1];
                    return (
                        <motion.div
                            key={i}
                            initial={{ height: 0 }}
                            animate={{ height: `${Math.max(height, 5)}%` }}
                            className={`flex-1 rounded-t ${isUp ? 'bg-emerald-500/60' :
                                    isDown ? 'bg-red-500/60' :
                                        'bg-gray-500/40'
                                }`}
                        />
                    );
                })}
            </div>

            {/* Stats Row */}
            <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-white/5">
                <div>
                    <div className="text-xs text-gray-500 mb-1">High</div>
                    <div className="font-mono text-emerald-400">{maxTick.toFixed(2)}</div>
                </div>
                <div>
                    <div className="text-xs text-gray-500 mb-1">Low</div>
                    <div className="font-mono text-red-400">{minTick.toFixed(2)}</div>
                </div>
                <div>
                    <div className="text-xs text-gray-500 mb-1">Ticks</div>
                    <div className="font-mono text-gray-400">{tickHistory.length}</div>
                </div>
            </div>
        </div>
    );
}
