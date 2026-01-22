'use client';

import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';

interface NotificationRow {
    id: string;
    title: string;
    body: string;
    type: string;
    created_at: string;
}

export default function NotificationsPanel() {
    const [items, setItems] = useState<NotificationRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let mounted = true;
        const loadNotifications = async () => {
            try {
                const res = await fetch('/api/notifications?limit=6');
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

    return (
        <div className="glass-panel rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Bell className="w-5 h-5 text-accent" />
                    Notifications
                </h3>
                <span className="text-xs text-muted-foreground uppercase tracking-widest">Recent</span>
            </div>

            {loading ? (
                <div className="text-sm text-muted-foreground">Loading notifications...</div>
            ) : items.length === 0 ? (
                <div className="text-sm text-muted-foreground">No notifications yet.</div>
            ) : (
                <div className="space-y-3">
                    {items.map((item) => (
                        <div key={item.id} className="p-3 bg-muted/40 rounded-lg border border-border/50">
                            <div className="flex justify-between items-center mb-1">
                                <span className="font-medium text-sm">{item.title}</span>
                                <span className="text-xs text-muted-foreground">
                                    {new Date(item.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                                </span>
                            </div>
                            <p className="text-xs text-muted-foreground">{item.body}</p>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
