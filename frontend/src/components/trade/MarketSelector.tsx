'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { Search, ChevronDown, TrendingUp, BarChart2, Coins, Globe } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTradingStore } from '@/store/tradingStore';

export interface MarketInfo {
    symbol: string;
    displayName: string;
    category: 'synthetic' | 'forex' | 'crypto' | 'commodities';
}

const MARKETS: MarketInfo[] = [
    // Synthetic Indices
    { symbol: 'R_10', displayName: 'Volatility 10 Index', category: 'synthetic' },
    { symbol: 'R_25', displayName: 'Volatility 25 Index', category: 'synthetic' },
    { symbol: 'R_50', displayName: 'Volatility 50 Index', category: 'synthetic' },
    { symbol: 'R_75', displayName: 'Volatility 75 Index', category: 'synthetic' },
    { symbol: 'R_100', displayName: 'Volatility 100 Index', category: 'synthetic' },
    { symbol: '1HZ10V', displayName: 'Volatility 10 (1s) Index', category: 'synthetic' },
    { symbol: '1HZ25V', displayName: 'Volatility 25 (1s) Index', category: 'synthetic' },
    { symbol: '1HZ50V', displayName: 'Volatility 50 (1s) Index', category: 'synthetic' },
    { symbol: '1HZ75V', displayName: 'Volatility 75 (1s) Index', category: 'synthetic' },
    { symbol: '1HZ100V', displayName: 'Volatility 100 (1s) Index', category: 'synthetic' },
    // Forex
    { symbol: 'frxEURUSD', displayName: 'EUR/USD', category: 'forex' },
    { symbol: 'frxGBPUSD', displayName: 'GBP/USD', category: 'forex' },
    { symbol: 'frxUSDJPY', displayName: 'USD/JPY', category: 'forex' },
    { symbol: 'frxAUDUSD', displayName: 'AUD/USD', category: 'forex' },
    { symbol: 'frxUSDCAD', displayName: 'USD/CAD', category: 'forex' },
    // Crypto
    { symbol: 'cryBTCUSD', displayName: 'BTC/USD', category: 'crypto' },
    { symbol: 'cryETHUSD', displayName: 'ETH/USD', category: 'crypto' },
    // Commodities
    { symbol: 'frxXAUUSD', displayName: 'Gold/USD', category: 'commodities' },
    { symbol: 'frxXAGUSD', displayName: 'Silver/USD', category: 'commodities' },
];

const CATEGORY_META: Record<string, { label: string; icon: typeof TrendingUp }> = {
    synthetic: { label: 'Synthetic Indices', icon: BarChart2 },
    forex: { label: 'Forex', icon: Globe },
    crypto: { label: 'Crypto', icon: Coins },
    commodities: { label: 'Commodities', icon: TrendingUp },
};

export function getMarketDisplayName(symbol: string | null): string {
    if (!symbol) return 'Select Market';
    return MARKETS.find((m) => m.symbol === symbol)?.displayName ?? symbol;
}

export function getMarketCategory(symbol: string | null): string {
    if (!symbol) return '';
    return MARKETS.find((m) => m.symbol === symbol)?.category ?? 'synthetic';
}

export default function MarketSelector() {
    const { selectedSymbol, setSelectedSymbol } = useTradingStore();
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const containerRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (!containerRef.current?.contains(e.target as Node)) {
                setIsOpen(false);
                setSearch('');
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsOpen(false);
                setSearch('');
            }
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [isOpen]);

    useEffect(() => {
        if (isOpen) {
            // Small delay so AnimatePresence finishes mounting
            setTimeout(() => searchRef.current?.focus(), 50);
        }
    }, [isOpen]);

    const handleOpen = () => {
        if (isOpen) {
            setIsOpen(false);
            setSearch('');
        } else {
            setSearch('');
            setIsOpen(true);
        }
    };

    const filtered = useMemo(() => {
        if (!search.trim()) return MARKETS;
        const q = search.toLowerCase();
        return MARKETS.filter(
            (m) =>
                m.displayName.toLowerCase().includes(q) ||
                m.symbol.toLowerCase().includes(q) ||
                m.category.toLowerCase().includes(q)
        );
    }, [search]);

    const grouped = useMemo(() => {
        const groups: Record<string, MarketInfo[]> = {};
        for (const m of filtered) {
            if (!groups[m.category]) groups[m.category] = [];
            groups[m.category].push(m);
        }
        return groups;
    }, [filtered]);

    const displayName = getMarketDisplayName(selectedSymbol);

    return (
        <div ref={containerRef} className="relative z-[100]">
            <button
                type="button"
                onClick={handleOpen}
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 hover:bg-muted/50 border border-border/70 shadow-soft transition-colors min-w-[180px]"
            >
                <BarChart2 className="w-4 h-4 text-accent flex-shrink-0" />
                <span className="text-sm font-medium truncate">{displayName}</span>
                <ChevronDown className={`w-4 h-4 text-muted-foreground ml-auto transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: -8, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -8, scale: 0.98 }}
                        transition={{ duration: 0.15 }}
                        className="absolute top-full mt-2 left-0 w-80 glass-panel rounded-xl overflow-hidden shadow-soft-lg ring-1 ring-border/40"
                        role="listbox"
                        aria-label="Select market"
                    >
                        {/* Search */}
                        <div className="p-3 border-b border-border/50">
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                <input
                                    ref={searchRef}
                                    type="text"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    placeholder="Search markets..."
                                    className="w-full pl-9 pr-3 py-2 text-sm bg-muted/30 border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/40 text-foreground placeholder:text-muted-foreground"
                                />
                            </div>
                        </div>

                        {/* Market List */}
                        <div className="max-h-72 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-border/60">
                            {Object.keys(grouped).length === 0 ? (
                                <div className="text-center py-6 text-sm text-muted-foreground">No markets found</div>
                            ) : (
                                Object.entries(grouped).map(([category, markets]) => {
                                    const meta = CATEGORY_META[category];
                                    const Icon = meta?.icon ?? BarChart2;
                                    return (
                                        <div key={category} className="mb-2 last:mb-0">
                                            <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
                                                <Icon className="w-3 h-3" />
                                                {meta?.label ?? category}
                                            </div>
                                            {markets.map((m) => (
                                                <button
                                                    key={m.symbol}
                                                    role="option"
                                                    aria-selected={m.symbol === selectedSymbol}
                                                    onClick={() => {
                                                        setSelectedSymbol(m.symbol);
                                                        setIsOpen(false);
                                                    }}
                                                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                                                        m.symbol === selectedSymbol
                                                            ? 'bg-accent/10 text-accent'
                                                            : 'hover:bg-muted/40 text-foreground'
                                                    }`}
                                                >
                                                    <div>
                                                        <div className="font-medium">{m.displayName}</div>
                                                        <div className="text-[10px] font-mono text-muted-foreground">{m.symbol}</div>
                                                    </div>
                                                    {m.symbol === selectedSymbol && (
                                                        <div className="w-2 h-2 rounded-full bg-accent" />
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
