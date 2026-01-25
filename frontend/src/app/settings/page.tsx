'use client';

import { Settings, Palette, Key, Bell, Shield, RefreshCw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTradingStore } from '@/store/tradingStore';

const themes = [
    {
        id: 'cyberpunk',
        name: 'Signal',
        description: 'Teal accents, deep canvas, low glare',
        preview: 'bg-gradient-to-br from-slate-950 to-slate-900 border-cyan-500/30'
    },
    {
        id: 'institutional',
        name: 'GitHub Light',
        description: 'Neutral canvas, crisp typography, blue accents',
        preview: 'bg-gradient-to-br from-white to-slate-100 border-slate-300'
    },
    {
        id: 'midnight',
        name: 'GitHub Dark',
        description: 'Deep graphite, balanced contrast, blue focus',
        preview: 'bg-gradient-to-br from-slate-950 to-slate-900 border-blue-500/30'
    },
];

export default function SettingsPage() {
    const { theme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const { resetDailyStats, clearLogs } = useTradingStore();

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMounted(true);
    }, []);

    const handleResetStats = () => {
        resetDailyStats();
        toast.success('Stats Reset', {
            description: 'Daily statistics have been cleared',
        });
    };

    const handleClearLogs = () => {
        clearLogs();
        toast.success('Logs Cleared', {
            description: 'All bot logs have been cleared',
        });
    };

    return (
        <div className="mx-auto w-full max-w-4xl px-4 sm:px-6 py-8">
            {/* Header */}
            <div className="mb-8">
                <h1 className="text-3xl font-bold flex items-center gap-3">
                    <Settings className="w-8 h-8 text-accent" />
                    Settings
                </h1>
                <p className="text-muted-foreground mt-2">
                    Customize your trading terminal experience
                </p>
            </div>

            <div className="space-y-6">
                {/* Theme Settings */}
                <section className="glass-panel rounded-2xl p-6">
                    <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <Palette className="w-5 h-5 text-accent" />
                        Appearance
                    </h2>

                    {mounted && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {themes.map((t) => (
                                <button
                                    key={t.id}
                                    onClick={() => {
                                        setTheme(t.id);
                                        toast.success('Theme Changed', {
                                            description: `Switched to ${t.name} theme`,
                                        });
                                    }}
                                    className={`p-4 rounded-xl border-2 transition-all text-left ${theme === t.id
                                        ? 'border-accent ring-2 ring-accent/20'
                                        : 'border-border hover:border-accent/50'
                                        }`}
                                >
                                    <div className={`h-16 rounded-lg mb-3 border ${t.preview}`} />
                                    <p className="font-medium">{t.name}</p>
                                    <p className="text-xs text-muted-foreground mt-1">{t.description}</p>
                                </button>
                            ))}
                        </div>
                    )}
                </section>

                {/* API Settings */}
                <section className="glass-panel rounded-2xl p-6">
                    <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <Key className="w-5 h-5 text-accent" />
                        API Configuration
                    </h2>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">
                                Deriv App ID
                            </Label>
                            <Input
                                value="••••••"
                                type="password"
                                disabled
                                className="bg-muted/50 font-mono text-sm sm:text-base tracking-widest"
                            />
                            <p className="text-xs text-muted-foreground">
                                App ID is configured via environment variables
                            </p>
                        </div>
                    </div>
                </section>

                {/* Notifications */}
                <section className="glass-panel rounded-2xl p-6">
                    <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <Bell className="w-5 h-5 text-accent" />
                        Notifications
                    </h2>

                    <div className="space-y-3">
                        <label className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 rounded-lg bg-muted/30 cursor-pointer hover:bg-muted/50 transition-colors">
                            <div>
                                <p className="font-medium">Trade Alerts</p>
                                <p className="text-sm text-muted-foreground">Get notified when trades execute</p>
                            </div>
                            <input type="checkbox" defaultChecked className="w-5 h-5 rounded" />
                        </label>
                        <label className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 rounded-lg bg-muted/30 cursor-pointer hover:bg-muted/50 transition-colors">
                            <div>
                                <p className="font-medium">Error Alerts</p>
                                <p className="text-sm text-muted-foreground">Get notified when errors occur</p>
                            </div>
                            <input type="checkbox" defaultChecked className="w-5 h-5 rounded" />
                        </label>
                    </div>
                </section>

                {/* Data Management */}
                <section className="glass-panel rounded-2xl p-6">
                    <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <Shield className="w-5 h-5 text-accent" />
                        Data Management
                    </h2>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Button
                            variant="outline"
                            onClick={handleResetStats}
                            className="h-auto py-4 flex flex-col items-center gap-2"
                        >
                            <RefreshCw className="w-5 h-5" />
                            <span>Reset Daily Stats</span>
                            <span className="text-xs text-muted-foreground">Clear profit/loss counters</span>
                        </Button>
                        <Button
                            variant="outline"
                            onClick={handleClearLogs}
                            className="h-auto py-4 flex flex-col items-center gap-2"
                        >
                            <RefreshCw className="w-5 h-5" />
                            <span>Clear Bot Logs</span>
                            <span className="text-xs text-muted-foreground">Remove all activity logs</span>
                        </Button>
                    </div>
                </section>
            </div>
        </div>
    );
}
