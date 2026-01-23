'use client';

import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useTradingStore } from '@/store/tradingStore';
import { apiFetch } from '@/lib/api';

interface DayData {
    date: string;
    pnl: number;
    trades: number;
    strategy?: string;
}

interface TradeRow {
    profit: number;
    created_at: string;
    bot_id?: string | null;
}

function getColorForPnL(pnl: number): string {
    if (pnl === 0) return 'hsl(210 20% 90% / 0.4)';

    if (pnl > 0) {
        const intensity = Math.min(pnl / 50, 1);
        return `hsl(150 60% 40% / ${0.2 + intensity * 0.8})`;
    } else {
        const intensity = Math.min(Math.abs(pnl) / 50, 1);
        return `hsl(0 70% 50% / ${0.2 + intensity * 0.8})`;
    }
}

function PerformanceHeatmap() {
    const { isAuthorized, activeAccountId } = useTradingStore();
    const [hoveredDay, setHoveredDay] = useState<DayData | null>(null);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
    const [data, setData] = useState<DayData[]>([]);
    const [loading, setLoading] = useState(true);
    const rafRef = useRef<number | null>(null);

    useEffect(() => {
        let mounted = true;
        if (!isAuthorized || !activeAccountId) {
            setData([]);
            setLoading(false);
            return () => {
                mounted = false;
            };
        }

        setLoading(true);
        const loadTrades = async () => {
            try {
                const res = await apiFetch('/api/trades?limit=1000', { cache: 'no-store' });
                if (!res.ok) {
                    throw new Error('Failed to load trades');
                }
                const payload = await res.json();
                const trades = Array.isArray(payload.trades) ? payload.trades as TradeRow[] : [];

                const byDay = new Map<string, DayData>();
                trades.forEach((trade) => {
                    const dateKey = trade.created_at.split('T')[0];
                    const entry = byDay.get(dateKey) || { date: dateKey, pnl: 0, trades: 0 };
                    entry.pnl += Number(trade.profit ?? 0);
                    entry.trades += 1;
                    entry.strategy = trade.bot_id || entry.strategy;
                    byDay.set(dateKey, entry);
                });

                const days: DayData[] = [];
                const today = new Date();
                for (let i = 90; i >= 0; i--) {
                    const date = new Date(today);
                    date.setDate(date.getDate() - i);
                    const key = date.toISOString().split('T')[0];
                    const entry = byDay.get(key) || { date: key, pnl: 0, trades: 0 };
                    entry.pnl = Math.round(entry.pnl * 100) / 100;
                    days.push(entry);
                }

                if (mounted) {
                    setData(days);
                }
            } catch {
                if (mounted) {
                    setData([]);
                }
            } finally {
                if (mounted) setLoading(false);
            }
        };

        loadTrades();
        return () => {
            mounted = false;
        };
    }, [isAuthorized, activeAccountId]);

    const scheduleTooltipUpdate = useCallback((x: number, y: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
        }
        rafRef.current = requestAnimationFrame(() => {
            setTooltipPos({ x, y });
            rafRef.current = null;
        });
    }, []);

    useEffect(() => {
        return () => {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
            }
        };
    }, []);

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
                    <p className="text-xs text-muted-foreground mt-1">Last 90 days</p>
                </div>
                <div className="text-right">
                    <div className={`text-2xl font-mono ${totalPnL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        {totalPnL >= 0 ? '+' : ''}{totalPnL.toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground">{totalTrades} trades</div>
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
                                        scheduleTooltipUpdate(e.clientX, e.clientY - 60);
                                    }
                                }}
                                onMouseMove={(e) => {
                                    if (day.date) {
                                        scheduleTooltipUpdate(e.clientX, e.clientY - 60);
                                    }
                                }}
                                onMouseLeave={() => setHoveredDay(null)}
                            />
                        ))}
                    </div>
                ))}
            </div>

            {loading && (
                <div className="text-xs text-muted-foreground mt-3">Loading trade data...</div>
            )}

            {/* Legend */}
            <div className="flex items-center justify-between mt-4 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                    <span>Less</span>
                    <div className="flex gap-0.5">
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'hsl(0 70% 50% / 1)' }} />
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'hsl(0 70% 50% / 0.5)' }} />
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'hsl(210 20% 90% / 0.4)' }} />
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'hsl(150 60% 40% / 0.5)' }} />
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'hsl(150 60% 40% / 1)' }} />
                    </div>
                    <span>More</span>
                </div>
                <div className="flex gap-4">
                    <span><span className="text-emerald-500">{winDays}</span> wins</span>
                    <span><span className="text-red-500">{lossDays}</span> losses</span>
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
                    <div className="font-mono text-foreground">{hoveredDay.date}</div>
                    <div className={`font-bold ${hoveredDay.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        {hoveredDay.pnl >= 0 ? '+' : ''}{hoveredDay.pnl.toFixed(2)}
                    </div>
                    {hoveredDay.strategy && (
                        <div className="text-xs text-muted-foreground">{hoveredDay.strategy}</div>
                    )}
                </motion.div>
            )}
        </div>
    );
}

const PerformanceHeatmapMemo = React.memo(PerformanceHeatmap);
export default PerformanceHeatmapMemo;
