'use client';

import { History, Search, Filter, TrendingUp, TrendingDown, Clock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';

interface TradeRow {
    id: string;
    contract_id: number;
    symbol: string;
    stake: number;
    duration: number;
    duration_unit: string;
    profit: number;
    status: string;
    bot_id?: string;
    entry_profile_id?: string;
    created_at: string;
}

export default function HistoryPage() {
    const [trades, setTrades] = useState<TradeRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');

    useEffect(() => {
        let mounted = true;
        const loadTrades = async () => {
            try {
                const res = await fetch('/api/trades?limit=200');
                const data = await res.json();
                if (!mounted) return;
                setTrades(Array.isArray(data.trades) ? data.trades : []);
            } catch (err) {
                if (!mounted) return;
                setTrades([]);
            } finally {
                if (mounted) setLoading(false);
            }
        };

        loadTrades();
        return () => {
            mounted = false;
        };
    }, []);

    const filteredTrades = useMemo(() => {
        if (!query) return trades;
        const q = query.toLowerCase();
        return trades.filter((trade) =>
            String(trade.contract_id).includes(q)
            || trade.symbol.toLowerCase().includes(q)
            || (trade.status || '').toLowerCase().includes(q)
        );
    }, [trades, query]);

    const formatTime = (timestamp: number) => {
        return new Date(timestamp).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    };

    const formatDate = (timestamp: number) => {
        return new Date(timestamp).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
        });
    };

    return (
        <div className="p-6 lg:p-8 max-w-6xl mx-auto">
            {/* Header */}
            <div className="mb-8">
                <h1 className="text-3xl font-bold flex items-center gap-3">
                    <History className="w-8 h-8 text-accent" />
                    Trade History
                </h1>
                <p className="text-muted-foreground mt-2">
                    View your complete trading activity and results
                </p>
            </div>

                {/* Filters */}
                <div className="flex gap-4 mb-6">
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                            placeholder="Search trades..."
                            className="pl-10 bg-muted/50"
                            value={query}
                            onChange={(e) => setQuery(e.currentTarget.value)}
                        />
                    </div>
                    <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-muted/50 border border-border hover:border-accent/50 transition-all">
                        <Filter className="w-4 h-4" />
                        <span>Filter</span>
                    </button>
                </div>

                {/* Trade Table */}
                <div className="glass-panel rounded-2xl overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-muted/50">
                                <tr>
                                    <th className="text-left px-6 py-4 text-xs uppercase tracking-wider text-muted-foreground font-medium">Time</th>
                                    <th className="text-left px-6 py-4 text-xs uppercase tracking-wider text-muted-foreground font-medium">Type</th>
                                    <th className="text-left px-6 py-4 text-xs uppercase tracking-wider text-muted-foreground font-medium">Details</th>
                                    <th className="text-right px-6 py-4 text-xs uppercase tracking-wider text-muted-foreground font-medium">Result</th>
                                    <th className="text-right px-6 py-4 text-xs uppercase tracking-wider text-muted-foreground font-medium">Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {loading ? (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                                            Loading trade history...
                                        </td>
                                    </tr>
                                ) : filteredTrades.length === 0 ? (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                                            <Clock className="w-12 h-12 mx-auto mb-4 opacity-50" />
                                            <p className="text-lg">No trades yet</p>
                                            <p className="text-sm mt-1">Start the bot to see your trading history</p>
                                        </td>
                                    </tr>
                                ) : (
                                    filteredTrades.map((trade) => (
                                        <tr key={trade.id} className="hover:bg-muted/30 transition-colors">
                                            <td className="px-6 py-4">
                                                <div className="font-mono text-sm">{formatTime(new Date(trade.created_at).getTime())}</div>
                                                <div className="text-xs text-muted-foreground">{formatDate(new Date(trade.created_at).getTime())}</div>
                                            </td>
                                            <td className="px-6 py-4">
                                                {trade.profit >= 0 ? (
                                                    <span className="flex items-center gap-1.5 text-emerald-400">
                                                        <TrendingUp className="w-4 h-4" />
                                                        WIN
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-1.5 text-red-400">
                                                        <TrendingDown className="w-4 h-4" />
                                                        LOSS
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-sm">
                                                #{trade.contract_id} / {trade.symbol} / {trade.duration}{trade.duration_unit.toUpperCase()}
                                                {trade.bot_id ? ` / ${trade.bot_id}` : ''}
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono">
                                                <span className={trade.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                                    {trade.profit >= 0 ? '+' : ''}{Number(trade.profit).toFixed(2)}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-right text-xs text-muted-foreground">
                                                {trade.status || '-'}
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Summary Footer */}
                {filteredTrades.length > 0 && !loading && (
                    <div className="mt-4 text-sm text-muted-foreground text-center">
                        Showing {filteredTrades.length} trade{filteredTrades.length !== 1 ? 's' : ''}
                    </div>
                )}
        </div>
    );
}
