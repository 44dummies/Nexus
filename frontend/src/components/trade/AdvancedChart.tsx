'use client';

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useTradingStore } from '@/store/tradingStore';
import { getMarketDisplayName } from '@/components/trade/MarketSelector';
import { useCandleStream, type OHLCCandle, type CandleTimeframe } from '@/hooks/useCandleStream';
import {
    createChart,
    type IChartApi,
    type ISeriesApi,
    type CandlestickData,
    type Time,
    ColorType,
    CrosshairMode,
    CandlestickSeries,
    type CandlestickSeriesPartialOptions,
} from 'lightweight-charts';
import { ChartCandlestick, Maximize2, Minimize2 } from 'lucide-react';

// ==================== FALLBACK CANDLE AGGREGATION ====================
// Used only when server-side candle stream hasn't delivered data yet.

const TIMEFRAME_SECONDS: Record<string, number> = {
    '1s': 1,
    '5s': 5,
    '15s': 15,
    '1m': 60,
    '5m': 300,
};

function aggregateTicksFallback(ticks: number[], timeframeSec: number): OHLCCandle[] {
    if (ticks.length === 0) return [];

    const now = Math.floor(Date.now() / 1000);
    const candles: OHLCCandle[] = [];
    const bucketSize = Math.max(1, Math.floor(ticks.length / 60));
    const startTime = now - Math.ceil(ticks.length / bucketSize) * timeframeSec;

    for (let i = 0; i < ticks.length; i += bucketSize) {
        const slice = ticks.slice(i, i + bucketSize);
        if (slice.length === 0) continue;
        const candleTime = Math.floor(startTime + (i / bucketSize) * timeframeSec);
        candles.push({
            time: candleTime,
            open: slice[0],
            high: Math.max(...slice),
            low: Math.min(...slice),
            close: slice[slice.length - 1],
            tickCount: slice.length,
            isLive: false,
        });
    }

    const seen = new Set<number>();
    return candles.filter(c => {
        if (seen.has(c.time)) return false;
        seen.add(c.time);
        return true;
    });
}

// ==================== CHART SIZE ====================

export type ChartSize = 'compact' | 'default' | 'expanded';

const CHART_HEIGHTS: Record<ChartSize, number> = {
    compact: 320,
    default: 420,
    expanded: 600,
};

// ==================== TIMEFRAMES ====================

const TIMEFRAMES: { id: CandleTimeframe; label: string }[] = [
    { id: '1s', label: '1s' },
    { id: '5s', label: '5s' },
    { id: '15s', label: '15s' },
    { id: '1m', label: '1m' },
    { id: '5m', label: '5m' },
];

// ==================== COMPONENT ====================

interface AdvancedChartProps {
    isMaximized?: boolean;
    onToggleMaximize?: () => void;
}

export default function AdvancedChart({ isMaximized = false, onToggleMaximize }: AdvancedChartProps) {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

    const { tickHistory, lastTick, prevTick, selectedSymbol } = useTradingStore();
    const [timeframe, setTimeframe] = useState<CandleTimeframe>('5s');
    const [chartSize, setChartSize] = useState<ChartSize>('default');

    // Server-side candle stream — proper time-aligned OHLC
    const { candles: serverCandles, isConnected: candlesConnected } = useCandleStream(
        selectedSymbol,
        timeframe,
    );

    const marketName = getMarketDisplayName(selectedSymbol);
    const trendUp = lastTick >= prevTick;

    const chartHeight = isMaximized
        ? (typeof window !== 'undefined' ? window.innerHeight - 200 : 600)
        : CHART_HEIGHTS[chartSize];

    // Use server-side candles when available, fall back to client-side aggregation
    const candles = useMemo(() => {
        if (serverCandles.length > 0) return serverCandles;
        // Fallback: client-side tick aggregation (inaccurate but functional)
        const timeframeSec = TIMEFRAME_SECONDS[timeframe] ?? 5;
        return aggregateTicksFallback(tickHistory, timeframeSec);
    }, [serverCandles, tickHistory, timeframe]);

    // Initialize chart
    useEffect(() => {
        if (!chartContainerRef.current) return;

        const chart = createChart(chartContainerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: 'rgba(148, 163, 184, 0.7)',
                fontSize: 11,
                fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
            },
            grid: {
                vertLines: { color: 'rgba(148, 163, 184, 0.06)' },
                horzLines: { color: 'rgba(148, 163, 184, 0.06)' },
            },
            crosshair: {
                mode: CrosshairMode.Normal,
                vertLine: {
                    color: 'rgba(148, 163, 184, 0.3)',
                    width: 1,
                    style: 3,
                    labelBackgroundColor: 'rgba(30, 41, 59, 0.9)',
                },
                horzLine: {
                    color: 'rgba(148, 163, 184, 0.3)',
                    width: 1,
                    style: 3,
                    labelBackgroundColor: 'rgba(30, 41, 59, 0.9)',
                },
            },
            rightPriceScale: {
                borderColor: 'rgba(148, 163, 184, 0.1)',
                scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            timeScale: {
                borderColor: 'rgba(148, 163, 184, 0.1)',
                timeVisible: true,
                secondsVisible: true,
            },
            width: chartContainerRef.current.clientWidth,
            height: chartHeight,
        });

        const candlestickOptions: CandlestickSeriesPartialOptions = {
            upColor: 'rgba(34, 197, 94, 0.9)',
            downColor: 'rgba(239, 68, 68, 0.9)',
            borderUpColor: 'rgba(34, 197, 94, 1)',
            borderDownColor: 'rgba(239, 68, 68, 1)',
            wickUpColor: 'rgba(34, 197, 94, 0.7)',
            wickDownColor: 'rgba(239, 68, 68, 0.7)',
        };

        const series = chart.addSeries(CandlestickSeries, candlestickOptions);

        chartRef.current = chart;
        candleSeriesRef.current = series;

        // Resize observer
        const observer = new ResizeObserver((entries) => {
            if (entries[0] && chartRef.current) {
                const { width } = entries[0].contentRect;
                chartRef.current.applyOptions({ width });
            }
        });
        observer.observe(chartContainerRef.current);

        return () => {
            observer.disconnect();
            chart.remove();
            chartRef.current = null;
            candleSeriesRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Resize chart when height changes
    useEffect(() => {
        if (chartRef.current) {
            chartRef.current.applyOptions({ height: chartHeight });
        }
    }, [chartHeight]);

    // Update candle data
    useEffect(() => {
        if (!candleSeriesRef.current || candles.length === 0) return;

        const data: CandlestickData<Time>[] = candles.map((c) => ({
            time: c.time as Time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
        }));

        candleSeriesRef.current.setData(data);

        // Auto-scroll to latest
        if (chartRef.current) {
            chartRef.current.timeScale().scrollToRealTime();
        }
    }, [candles]);

    const cycleSize = useCallback(() => {
        setChartSize((prev) => {
            const order: ChartSize[] = ['compact', 'default', 'expanded'];
            return order[(order.indexOf(prev) + 1) % order.length];
        });
    }, []);

    // Stats from candles
    const stats = useMemo(() => {
        if (candles.length === 0) return { range: 0, volatility: 0, count: 0 };
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const maxP = Math.max(...highs);
        const minP = Math.min(...lows);
        const closes = candles.map(c => c.close);
        const changes = closes.slice(1).map((v, i) => Math.abs(v - closes[i]));
        const avgChange = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
        const vol = avgChange && minP > 0 ? (avgChange / minP) * 100 : 0;
        return { range: maxP - minP, volatility: vol, count: candles.length };
    }, [candles]);

    return (
        <div className="relative h-full w-full">
            <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.12),_transparent_55%),radial-gradient(circle_at_bottom,_rgba(34,197,94,0.1),_transparent_60%)] opacity-70" />

            {/* Header */}
            <div className="relative z-10 flex flex-wrap items-center justify-between gap-4 mb-4">
                <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-[0.35em]">Advanced Charting</p>
                    <h2 className="text-2xl font-semibold flex items-center gap-2">
                        <ChartCandlestick className="w-5 h-5 text-accent" />
                        {marketName}
                    </h2>
                </div>
                <div className="flex items-center gap-2">
                    {/* Chart Size Controls */}
                    <div className="flex items-center gap-1 mr-2 border-r border-border/50 pr-2">
                        <button
                            onClick={cycleSize}
                            title={`Chart size: ${chartSize}`}
                            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-[10px] uppercase tracking-widest border border-border/60 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                        >
                            {chartSize === 'compact' ? 'S' : chartSize === 'default' ? 'M' : 'L'}
                        </button>
                        {onToggleMaximize && (
                            <button
                                onClick={onToggleMaximize}
                                title={isMaximized ? 'Exit fullscreen' : 'Maximize chart'}
                                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-[10px] border border-border/60 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                            >
                                {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                            </button>
                        )}
                    </div>
                    {/* Timeframe buttons — horizontal scroll on mobile */}
                    <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                        {TIMEFRAMES.map((frame) => (
                            <button
                                key={frame.id}
                                onClick={() => setTimeframe(frame.id)}
                                className={`min-h-[44px] px-3 py-2 rounded-full text-xs font-mono uppercase tracking-widest border whitespace-nowrap transition-colors ${
                                    timeframe === frame.id
                                        ? 'bg-accent text-accent-foreground border-accent'
                                        : 'border-border/70 text-muted-foreground hover:text-foreground hover:border-border'
                                }`}
                            >
                                {frame.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Chart Container */}
            <div className="relative z-10 rounded-2xl border border-border/70 bg-muted/20 overflow-hidden p-2">
                {/* Last price overlay */}
                <div className="absolute top-3 right-4 z-20 glass-panel rounded-xl px-3 py-2 text-xs font-mono text-accent flex items-center gap-2">
                    {candlesConnected && (
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" title="Server candles connected" />
                    )}
                    Last: {lastTick.toFixed(2)}
                </div>

                <div ref={chartContainerRef} className="w-full" style={{ minHeight: chartHeight }} />
            </div>

            {/* Stats */}
            <div className="relative z-10 mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs uppercase tracking-widest text-muted-foreground">
                <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                    <div className="text-[10px]">Range</div>
                    <div className="text-sm font-mono text-foreground">{stats.range.toFixed(2)}</div>
                </div>
                <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                    <div className="text-[10px]">Volatility</div>
                    <div className="text-sm font-mono text-foreground">{stats.volatility.toFixed(2)}%</div>
                </div>
                <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                    <div className="text-[10px]">Momentum</div>
                    <div className={`text-sm font-mono ${trendUp ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                        {trendUp ? 'UPTREND' : 'DOWNTREND'}
                    </div>
                </div>
                <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                    <div className="text-[10px]">Candles</div>
                    <div className="text-sm font-mono text-foreground">{stats.count}</div>
                </div>
            </div>
        </div>
    );
}
