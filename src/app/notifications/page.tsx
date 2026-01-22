'use client';

import { Bell, Search, Filter, Inbox, Check } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface NotificationRow {
    id: string;
    title: string;
    body: string;
    type: string | null;
    data?: {
        profit?: number;
        status?: string;
        symbol?: string;
    } | null;
    created_at: string;
    read_at?: string | null;
}

const typeLabels: Record<string, string> = {
    order_status: 'Order',
    trade_result: 'Result',
};

const typeClasses: Record<string, string> = {
    order_status: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
    trade_result: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
};

export default function NotificationsPage() {
    const [items, setItems] = useState<NotificationRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [filterType, setFilterType] = useState<'all' | 'order_status' | 'trade_result'>('all');
    const [markingAll, setMarkingAll] = useState(false);
    const [markingIds, setMarkingIds] = useState<Record<string, boolean>>({});

    useEffect(() => {
        let mounted = true;
        const loadNotifications = async () => {
            try {
                const res = await fetch('/api/notifications?limit=100');
                const data = await res.json();
                if (!mounted) return;
                setItems(Array.isArray(data.notifications) ? data.notifications : []);
            } catch {
                if (!mounted) return;
                setItems([]);
            } finally {
                if (mounted) setLoading(false);
            }
        };

        loadNotifications();
        return () => {
            mounted = false;
        };
    }, []);

    const filteredItems = useMemo(() => {
        let list = items;
        if (filterType !== 'all') {
            list = list.filter((item) => item.type === filterType);
        }
        if (!query) return list;
        const q = query.toLowerCase();
        return list.filter((item) =>
            item.title.toLowerCase().includes(q)
            || item.body.toLowerCase().includes(q)
            || (item.type || '').toLowerCase().includes(q)
        );
    }, [items, filterType, query]);

    const formatTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
    });

    const formatDate = (timestamp: number) => new Date(timestamp).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
    });

    const markRead = async (ids: string[] | 'all') => {
        if (ids === 'all') {
            setMarkingAll(true);
        } else {
            setMarkingIds((prev) => ids.reduce((acc, id) => ({ ...acc, [id]: true }), { ...prev }));
        }
        try {
            await fetch('/api/notifications', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'mark-read',
                    all: ids === 'all',
                    ids: ids === 'all' ? undefined : ids,
                }),
            });
            const now = new Date().toISOString();
            setItems((prev) => prev.map((item) => {
                if (ids === 'all') {
                    return item.read_at ? item : { ...item, read_at: now };
                }
                if (ids.includes(item.id)) {
                    return { ...item, read_at: now };
                }
                return item;
            }));
        } catch {
            // no-op
        } finally {
            if (ids === 'all') {
                setMarkingAll(false);
            } else {
                setMarkingIds((prev) => ids.reduce((acc, id) => {
                    const next = { ...acc };
                    delete next[id];
                    return next;
                }, { ...prev }));
            }
        }
    };

    return (
        <div className="p-6 lg:p-8 max-w-6xl mx-auto">
            <div className="mb-8">
                <h1 className="text-3xl font-bold flex items-center gap-3">
                    <Bell className="w-8 h-8 text-accent" />
                    Notifications
                </h1>
                <p className="text-muted-foreground mt-2">
                    Order status updates, trade results, and system alerts
                </p>
            </div>

            <div className="flex flex-col md:flex-row gap-4 md:items-center mb-6">
                <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                        placeholder="Search notifications..."
                        className="pl-10 bg-muted/50"
                        value={query}
                        onChange={(e) => setQuery(e.currentTarget.value)}
                    />
                </div>
                <div className="flex items-center gap-2">
                    {['all', 'order_status', 'trade_result'].map((type) => (
                        <button
                            key={type}
                            onClick={() => setFilterType(type as typeof filterType)}
                            className={cn(
                                'px-3 py-1.5 rounded-full text-xs uppercase tracking-wider border transition-all',
                                filterType === type
                                    ? 'border-accent text-accent bg-accent/10'
                                    : 'border-border/60 text-muted-foreground hover:border-accent/40'
                            )}
                        >
                            {type === 'all' ? 'All' : typeLabels[type]}
                        </button>
                    ))}
                    <button className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-border/60 text-muted-foreground hover:border-accent/40 transition-all text-xs uppercase tracking-wider">
                        <Filter className="w-3.5 h-3.5" />
                        Filter
                    </button>
                    <button
                        onClick={() => markRead('all')}
                        disabled={markingAll || items.every((item) => item.read_at)}
                        className={cn(
                            'flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs uppercase tracking-wider transition-all',
                            markingAll || items.every((item) => item.read_at)
                                ? 'border-border/50 text-muted-foreground/70 cursor-not-allowed'
                                : 'border-accent/50 text-accent hover:border-accent'
                        )}
                    >
                        <Check className="w-3.5 h-3.5" />
                        Mark all read
                    </button>
                </div>
            </div>

            <div className="glass-panel rounded-2xl overflow-hidden">
                <div className="divide-y divide-border">
                    {loading ? (
                        <div className="px-6 py-12 text-center text-muted-foreground">
                            Loading notifications...
                        </div>
                    ) : filteredItems.length === 0 ? (
                        <div className="px-6 py-12 text-center text-muted-foreground">
                            <Inbox className="w-12 h-12 mx-auto mb-4 opacity-50" />
                            <p className="text-lg">No notifications yet</p>
                            <p className="text-sm mt-1">Trade activity will show up here</p>
                        </div>
                    ) : (
                        filteredItems.map((item) => {
                            const createdAt = new Date(item.created_at).getTime();
                            const badge = item.type ? (typeLabels[item.type] || 'Update') : 'Update';
                            const badgeClass = item.type ? typeClasses[item.type] : 'bg-muted/40 text-muted-foreground border-border/60';
                            const profit = typeof item.data?.profit === 'number' ? item.data.profit : null;
                            return (
                                <div key={item.id} className="flex flex-col md:flex-row md:items-center gap-4 px-6 py-4 hover:bg-muted/30 transition-colors">
                                    <div className="flex-1">
                                        <div className="flex items-center gap-3 mb-1">
                                            <span className={cn('text-[10px] uppercase tracking-wider border px-2 py-0.5 rounded-full', badgeClass)}>
                                                {badge}
                                            </span>
                                            {item.read_at ? null : (
                                                <span className="text-[10px] uppercase tracking-wider text-accent">New</span>
                                            )}
                                        </div>
                                        <p className="font-medium">{item.title}</p>
                                        <p className="text-sm text-muted-foreground">{item.body}</p>
                                    </div>
                                    <div className="flex items-center justify-between md:flex-col md:items-end md:gap-2 text-xs text-muted-foreground min-w-[160px]">
                                        <span>{formatTime(createdAt)}</span>
                                        <span>{formatDate(createdAt)}</span>
                                        {profit !== null && (
                                            <span className={profit >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                                {profit >= 0 ? '+' : ''}{profit.toFixed(2)}
                                            </span>
                                        )}
                                        {!item.read_at && (
                                            <button
                                                onClick={() => markRead([item.id])}
                                                disabled={markingIds[item.id]}
                                                className={cn(
                                                    'mt-1 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider border px-2 py-1 rounded-full transition-all',
                                                    markingIds[item.id]
                                                        ? 'border-border/50 text-muted-foreground/70 cursor-not-allowed'
                                                        : 'border-accent/50 text-accent hover:border-accent'
                                                )}
                                            >
                                                <Check className="w-3 h-3" />
                                                Mark read
                                            </button>
                                        )}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            {filteredItems.length > 0 && !loading && (
                <div className="mt-4 text-sm text-muted-foreground text-center">
                    Showing {filteredItems.length} notification{filteredItems.length !== 1 ? 's' : ''}
                </div>
            )}
        </div>
    );
}
