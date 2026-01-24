'use client';

import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTradingStore } from '@/store/tradingStore';
import { BarChart2, ChartCandlestick, Minus, Plus } from 'lucide-react';

type Candle = {
    open: number;
    high: number;
    low: number;
    close: number;
};

const TIMEFRAMES = [
    { id: '1s', label: '1s', targetCandles: 60 },
    { id: '5s', label: '5s', targetCandles: 48 },
    { id: '15s', label: '15s', targetCandles: 36 },
    { id: '1m', label: '1m', targetCandles: 28 },
    { id: '5m', label: '5m', targetCandles: 20 },
];

function buildCandles(ticks: number[], targetCandles: number): Candle[] {
    if (ticks.length === 0) {
        return [{ open: 0, high: 0, low: 0, close: 0 }];
    }
    const bucketSize = Math.max(2, Math.floor(ticks.length / Math.max(targetCandles, 1)));
    const candles: Candle[] = [];
    for (let i = 0; i < ticks.length; i += bucketSize) {
        const slice = ticks.slice(i, i + bucketSize);
        if (slice.length === 0) continue;
        const open = slice[0];
        const close = slice[slice.length - 1];
        const high = Math.max(...slice);
        const low = Math.min(...slice);
        candles.push({ open, high, low, close });
    }
    return candles.length ? candles : [{ open: ticks[0], high: ticks[0], low: ticks[0], close: ticks[0] }];
}

function movingAverage(values: number[], window: number) {
    if (values.length === 0) return [];
    const result = new Array(values.length).fill(0);
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
        sum += values[i];
        if (i >= window) {
            sum -= values[i - window];
        }
        const divisor = i < window ? i + 1 : window;
        result[i] = sum / divisor;
    }
    return result;
}

export default function AdvancedChart() {
    const { tickHistory, lastTick, prevTick } = useTradingStore();
    const [timeframe, setTimeframe] = useState(TIMEFRAMES[1].id);
    const [showFastMa, setShowFastMa] = useState(true);
    const [showSlowMa, setShowSlowMa] = useState(true);
    const [showArea, setShowArea] = useState(true);
    const [hoverIndex, setHoverIndex] = useState<number | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);

    const {
        candles,
        closes,
        fastMa,
        slowMa,
        minPrice,
        maxPrice,
        volatility,
        trendUp,
    } = useMemo(() => {
        const baseTicks = tickHistory.length > 2 ? tickHistory : [prevTick, lastTick].filter(Number.isFinite);
        const safeTicks = baseTicks.length ? baseTicks : [0, 0];
        const targetCandles = TIMEFRAMES.find((frame) => frame.id === timeframe)?.targetCandles ?? 48;
        const candleSeries = buildCandles(safeTicks, targetCandles);
        const closeSeries = candleSeries.map((c) => c.close);
        const fast = movingAverage(closeSeries, 6);
        const slow = movingAverage(closeSeries, 12);
        const lows = candleSeries.map((c) => c.low);
        const highs = candleSeries.map((c) => c.high);
        const minPrice = Math.min(...lows);
        const maxPrice = Math.max(...highs);
        const changes = closeSeries.slice(1).map((value, idx) => Math.abs(value - closeSeries[idx]));
        const avgChange = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
        const volatility = avgChange ? (avgChange / Math.max(minPrice, 1)) * 100 : 0;
        const trendUp = lastTick >= prevTick;

        return {
            candles: candleSeries,
            closes: closeSeries,
            fastMa: fast,
            slowMa: slow,
            minPrice,
            maxPrice,
            volatility,
            trendUp,
        };
    }, [tickHistory, lastTick, prevTick, timeframe]);

    const width = 1000;
    const height = 420;
    const padding = { top: 28, right: 70, bottom: 36, left: 18 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const priceRange = Math.max(maxPrice - minPrice, 0.0001);
    const xStep = chartWidth / Math.max(candles.length - 1, 1);
    const barWidth = Math.max(4, Math.min(14, xStep * 0.6));

    const xForIndex = (index: number) => padding.left + index * xStep;
    const yForPrice = (price: number) =>
        padding.top + (1 - (price - minPrice) / priceRange) * chartHeight;

    const linePath = closes
        .map((value, index) => `${index === 0 ? 'M' : 'L'} ${xForIndex(index)} ${yForPrice(value)}`)
        .join(' ');

    const fastPath = fastMa
        .map((value, index) => `${index === 0 ? 'M' : 'L'} ${xForIndex(index)} ${yForPrice(value)}`)
        .join(' ');

    const slowPath = slowMa
        .map((value, index) => `${index === 0 ? 'M' : 'L'} ${xForIndex(index)} ${yForPrice(value)}`)
        .join(' ');

    const handleMouseMove = (event: MouseEvent<SVGSVGElement>) => {
        if (!svgRef.current || candles.length === 0) return;
        const rect = svgRef.current.getBoundingClientRect();
        const relativeX = event.clientX - rect.left;
        const index = Math.round((relativeX / rect.width) * (candles.length - 1));
        const clamped = Math.max(0, Math.min(candles.length - 1, index));
        setHoverIndex(clamped);
    };

    const hovered = hoverIndex !== null ? candles[hoverIndex] : null;
    const hoveredX = hoverIndex !== null ? xForIndex(hoverIndex) : 0;
    const hoveredClose = hovered ? hovered.close : null;

    return (
        <div className="relative h-full w-full">
            <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.12),_transparent_55%),radial-gradient(circle_at_bottom,_rgba(34,197,94,0.1),_transparent_60%)] opacity-70" />
            <div className="relative z-10 flex flex-wrap items-center justify-between gap-4 mb-4">
                <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-[0.35em]">Advanced Charting</p>
                    <h2 className="text-2xl font-semibold flex items-center gap-2">
                        <ChartCandlestick className="w-5 h-5 text-accent" />
                        R_100 Momentum
                    </h2>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {TIMEFRAMES.map((frame) => (
                        <button
                            key={frame.id}
                            onClick={() => setTimeframe(frame.id)}
                            className={`px-3 py-1 rounded-full text-xs font-mono uppercase tracking-widest border transition-colors ${timeframe === frame.id
                                ? 'bg-accent text-accent-foreground border-accent'
                                : 'border-border/70 text-muted-foreground hover:text-foreground hover:border-border'
                                }`}
                        >
                            {frame.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="relative z-10 rounded-2xl border border-border/70 bg-muted/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-muted-foreground">
                        <BarChart2 className="w-4 h-4 text-accent" />
                        <span>Live Candles</span>
                        <span className={`px-2 py-0.5 rounded-full ${trendUp ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                            {trendUp ? 'Bullish' : 'Bearish'}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setShowFastMa((prev) => !prev)}
                            className={`px-2 py-1 rounded-full text-[10px] uppercase tracking-widest border ${showFastMa ? 'border-emerald-400/60 text-emerald-300' : 'border-border/60 text-muted-foreground'}`}
                        >
                            MA 6
                        </button>
                        <button
                            onClick={() => setShowSlowMa((prev) => !prev)}
                            className={`px-2 py-1 rounded-full text-[10px] uppercase tracking-widest border ${showSlowMa ? 'border-sky-400/60 text-sky-300' : 'border-border/60 text-muted-foreground'}`}
                        >
                            MA 12
                        </button>
                        <button
                            onClick={() => setShowArea((prev) => !prev)}
                            className={`px-2 py-1 rounded-full text-[10px] uppercase tracking-widest border ${showArea ? 'border-accent/60 text-accent' : 'border-border/60 text-muted-foreground'}`}
                        >
                            AREA
                        </button>
                    </div>
                </div>

                <div className="relative">
                    <svg
                        ref={svgRef}
                        viewBox={`0 0 ${width} ${height}`}
                        className="w-full h-[360px] sm:h-[420px]"
                        onMouseMove={handleMouseMove}
                        onMouseLeave={() => setHoverIndex(null)}
                    >
                        <defs>
                            <linearGradient id="priceGlow" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="rgba(59,130,246,0.35)" />
                                <stop offset="100%" stopColor="rgba(59,130,246,0)" />
                            </linearGradient>
                        </defs>

                        {[0, 1, 2, 3, 4].map((tick) => {
                            const y = padding.top + (chartHeight / 4) * tick;
                            return (
                                <line
                                    key={`grid-${tick}`}
                                    x1={padding.left}
                                    y1={y}
                                    x2={width - padding.right}
                                    y2={y}
                                    stroke="rgba(148,163,184,0.15)"
                                    strokeWidth="1"
                                />
                            );
                        })}

                        {[0, 1, 2, 3, 4, 5].map((tick) => {
                            const x = padding.left + (chartWidth / 5) * tick;
                            return (
                                <line
                                    key={`vgrid-${tick}`}
                                    x1={x}
                                    y1={padding.top}
                                    x2={x}
                                    y2={height - padding.bottom}
                                    stroke="rgba(148,163,184,0.12)"
                                    strokeWidth="1"
                                />
                            );
                        })}

                        {showArea && (
                            <path
                                d={`${linePath} L ${padding.left + chartWidth} ${height - padding.bottom} L ${padding.left} ${height - padding.bottom} Z`}
                                fill="url(#priceGlow)"
                                stroke="none"
                            />
                        )}

                        <path d={linePath} fill="none" stroke="rgba(59,130,246,0.9)" strokeWidth="2" />

                        {showFastMa && <path d={fastPath} fill="none" stroke="rgba(16,185,129,0.9)" strokeWidth="1.5" />}
                        {showSlowMa && <path d={slowPath} fill="none" stroke="rgba(56,189,248,0.8)" strokeWidth="1.2" strokeDasharray="6 6" />}

                        {candles.map((candle, index) => {
                            const x = xForIndex(index);
                            const openY = yForPrice(candle.open);
                            const closeY = yForPrice(candle.close);
                            const highY = yForPrice(candle.high);
                            const lowY = yForPrice(candle.low);
                            const bodyTop = Math.min(openY, closeY);
                            const bodyHeight = Math.max(2, Math.abs(openY - closeY));
                            const isUp = candle.close >= candle.open;
                            return (
                                <g key={`candle-${index}`}>
                                    <line
                                        x1={x}
                                        y1={highY}
                                        x2={x}
                                        y2={lowY}
                                        stroke={isUp ? 'rgba(34,197,94,0.8)' : 'rgba(239,68,68,0.85)'}
                                        strokeWidth="2"
                                    />
                                    <rect
                                        x={x - barWidth / 2}
                                        y={bodyTop}
                                        width={barWidth}
                                        height={bodyHeight}
                                        rx={2}
                                        fill={isUp ? 'rgba(34,197,94,0.75)' : 'rgba(239,68,68,0.8)'}
                                    />
                                </g>
                            );
                        })}

                        {[0, 1, 2, 3].map((tick) => {
                            const price = minPrice + (priceRange / 3) * (3 - tick);
                            const y = yForPrice(price);
                            return (
                                <text
                                    key={`label-${tick}`}
                                    x={width - 10}
                                    y={y + 4}
                                    fontSize="10"
                                    fill="rgba(148,163,184,0.7)"
                                    textAnchor="end"
                                >
                                    {price.toFixed(2)}
                                </text>
                            );
                        })}

                        {hovered && (
                            <>
                                <line
                                    x1={hoveredX}
                                    y1={padding.top}
                                    x2={hoveredX}
                                    y2={height - padding.bottom}
                                    stroke="rgba(148,163,184,0.4)"
                                    strokeDasharray="4 6"
                                />
                                {hoveredClose !== null && (
                                    <line
                                        x1={padding.left}
                                        y1={yForPrice(hoveredClose)}
                                        x2={width - padding.right}
                                        y2={yForPrice(hoveredClose)}
                                        stroke="rgba(148,163,184,0.35)"
                                        strokeDasharray="4 6"
                                    />
                                )}
                            </>
                        )}
                    </svg>

                    <div className="absolute top-3 right-4 glass-panel rounded-xl px-3 py-2 text-xs font-mono text-accent">
                        Last: {lastTick.toFixed(2)}
                    </div>

                    {hovered && (
                        <div className="absolute left-4 top-4 glass-panel rounded-xl px-3 py-2 text-xs font-mono text-muted-foreground space-y-1">
                            <div className="flex items-center gap-2">
                                <Minus className="w-3 h-3 text-emerald-400" />
                                <span>O {hovered.open.toFixed(2)}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Plus className="w-3 h-3 text-emerald-400" />
                                <span>H {hovered.high.toFixed(2)}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Minus className="w-3 h-3 text-red-400" />
                                <span>L {hovered.low.toFixed(2)}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Plus className="w-3 h-3 text-accent" />
                                <span>C {hovered.close.toFixed(2)}</span>
                            </div>
                        </div>
                    )}
                </div>

                <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs uppercase tracking-widest text-muted-foreground">
                    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                        <div className="text-[10px]">Range</div>
                        <div className="text-sm font-mono text-foreground">{(maxPrice - minPrice).toFixed(2)}</div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                        <div className="text-[10px]">Volatility</div>
                        <div className="text-sm font-mono text-foreground">{volatility.toFixed(2)}%</div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                        <div className="text-[10px]">Momentum</div>
                        <div className={`text-sm font-mono ${trendUp ? 'text-emerald-400' : 'text-red-400'}`}>
                            {trendUp ? 'UPTREND' : 'DOWNTREND'}
                        </div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                        <div className="text-[10px]">Candles</div>
                        <div className="text-sm font-mono text-foreground">{candles.length}</div>
                    </div>
                </div>
            </div>
        </div>
    );
}
