'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';

interface DayData {
    date: string;
    pnl: number;
    trades: number;
    strategy?: string;
}

// Mock data generator for demo
function generateMockData(): DayData[] {
    const data: DayData[] = [];
    const today = new Date();
    const strategies = ['RSI', 'Bollinger', 'MACD'];

    for (let i = 90; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);

        // Random trading activity (60% chance of trading day)
        if (Math.random() > 0.4) {
            const trades = Math.floor(Math.random() * 20) + 1;
            const winRate = Math.random();
            const pnl = (winRate > 0.5)
                ? Math.random() * 100 * winRate
                : -Math.random() * 50 * (1 - winRate);

            data.push({
                date: date.toISOString().split('T')[0],
                pnl: Math.round(pnl * 100) / 100,
                trades,
                strategy: strategies[Math.floor(Math.random() * strategies.length)],
            });
        } else {
            data.push({
                date: date.toISOString().split('T')[0],
                pnl: 0,
                trades: 0,
            });
        }
    }

    return data;
}

function getColorForPnL(pnl: number): string {
    if (pnl === 0) return 'rgba(255,255,255,0.05)';

    if (pnl > 0) {
        const intensity = Math.min(pnl / 50, 1);
        return `rgba(0, 255, 136, ${0.2 + intensity * 0.8})`;
    } else {
        const intensity = Math.min(Math.abs(pnl) / 50, 1);
        return `rgba(255, 68, 68, ${0.2 + intensity * 0.8})`;
    }
}

export default function PerformanceHeatmap() {
    const [hoveredDay, setHoveredDay] = useState<DayData | null>(null);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

    const data = useMemo(() => generateMockData(), []);

    // Group by weeks
    const weeks = useMemo(() => {
        const result: DayData[][] = [];
        let currentWeek: DayData[] = [];

        data.forEach((day, i) => {
            const date = new Date(day.date);
            const dayOfWeek = date.getDay();

            if (i === 0) {
                // Pad the first week
                for (let j = 0; j < dayOfWeek; j++) {
                    currentWeek.push({ date: '', pnl: 0, trades: 0 });
                }
            }

            currentWeek.push(day);

            if (dayOfWeek === 6 || i === data.length - 1) {
                result.push(currentWeek);
                currentWeek = [];
            }
        });

        return result;
    }, [data]);

    const totalPnL = data.reduce((sum, d) => sum + d.pnl, 0);
    const totalTrades = data.reduce((sum, d) => sum + d.trades, 0);
    const winDays = data.filter(d => d.pnl > 0).length;
    const lossDays = data.filter(d => d.pnl < 0).length;

    return (
        <div className="glass-panel rounded-2xl p-6">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h3 className="text-lg font-semibold">Performance Heatmap</h3>
                    <p className="text-xs text-gray-500 mt-1">Last 90 days</p>
                </div>
                <div className="text-right">
                    <div className={`text-2xl font-mono ${totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {totalPnL >= 0 ? '+' : ''}{totalPnL.toFixed(2)}
                    </div>
                    <div className="text-xs text-gray-500">{totalTrades} trades</div>
                </div>
            </div>

            {/* Heatmap Grid */}
            <div className="flex gap-1 overflow-x-auto pb-2">
                {weeks.map((week, wi) => (
                    <div key={wi} className="flex flex-col gap-1">
                        {week.map((day, di) => (
                            <motion.div
                                key={`${wi}-${di}`}
                                className="w-3 h-3 rounded-sm cursor-pointer"
                                style={{ backgroundColor: day.date ? getColorForPnL(day.pnl) : 'transparent' }}
                                whileHover={{ scale: 1.5 }}
                                onMouseEnter={(e) => {
                                    if (day.date) {
                                        setHoveredDay(day);
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        setTooltipPos({ x: rect.left, y: rect.top - 60 });
                                    }
                                }}
                                onMouseLeave={() => setHoveredDay(null)}
                            />
                        ))}
                    </div>
                ))}
            </div>

            {/* Legend */}
            <div className="flex items-center justify-between mt-4 text-xs text-gray-500">
                <div className="flex items-center gap-2">
                    <span>Less</span>
                    <div className="flex gap-0.5">
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(255,68,68,1)' }} />
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(255,68,68,0.5)' }} />
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }} />
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(0,255,136,0.5)' }} />
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(0,255,136,1)' }} />
                    </div>
                    <span>More</span>
                </div>
                <div className="flex gap-4">
                    <span><span className="text-emerald-400">{winDays}</span> wins</span>
                    <span><span className="text-red-400">{lossDays}</span> losses</span>
                </div>
            </div>

            {/* Tooltip */}
            {hoveredDay && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="fixed glass-panel px-3 py-2 rounded-lg text-sm pointer-events-none z-50"
                    style={{ left: tooltipPos.x, top: tooltipPos.y }}
                >
                    <div className="font-mono text-white">{hoveredDay.date}</div>
                    <div className={`font-bold ${hoveredDay.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {hoveredDay.pnl >= 0 ? '+' : ''}{hoveredDay.pnl.toFixed(2)}
                    </div>
                    {hoveredDay.strategy && (
                        <div className="text-xs text-gray-400">{hoveredDay.strategy}</div>
                    )}
                </motion.div>
            )}
        </div>
    );
}
