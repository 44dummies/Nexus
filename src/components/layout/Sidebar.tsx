'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useState, useEffect } from 'react';
import {
    LayoutDashboard,
    Bot,
    History,
    Bell,
    Settings,
    Zap,
    Sun,
    Moon,
    Monitor,
    LogOut
} from 'lucide-react';
import { useTradingStore } from '@/store/tradingStore';

const navItems = [
    { href: '/dashboard', icon: LayoutDashboard, label: 'Overview' },
    { href: '/trade', icon: Zap, label: 'Trade' },
    { href: '/bots', icon: Bot, label: 'Bots' },
    { href: '/notifications', icon: Bell, label: 'Notifications' },
    { href: '/history', icon: History, label: 'History' },
    { href: '/settings', icon: Settings, label: 'Settings' },
];

const themes = [
    { id: 'cyberpunk', label: 'Signal', icon: Monitor },
    { id: 'institutional', label: 'GitHub Light', icon: Sun },
    { id: 'midnight', label: 'GitHub Dark', icon: Moon },
];

export default function Sidebar() {
    const pathname = usePathname();
    const { theme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const botRunning = useTradingStore((state) => state.botRunning);
    const logout = useTradingStore((state) => state.logout);

    // Prevent hydration mismatch
    useEffect(() => {
        setMounted(true); // eslint-disable-line react-hooks/set-state-in-effect
    }, []);

    const handleLogout = async () => {
        try {
            await fetch('/api/auth/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'logout' }),
            });
        } catch (err) {
            console.error('Logout failed', err);
        } finally {
            logout();
            window.location.href = '/';
        }
    };

    return (
        <aside className="w-16 lg:w-64 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col h-screen sticky top-0">
            {/* Logo */}
            <div className="p-4 flex items-center justify-center lg:justify-start gap-3 border-b border-sidebar-border">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-sky-500 flex items-center justify-center">
                    <Zap className="w-5 h-5 text-white" />
                </div>
                <span className="hidden lg:block text-lg font-bold text-foreground">
                    DerivNexus
                </span>
            </div>

            {/* Navigation */}
            <nav className="flex-1 p-3 space-y-2">
                {navItems.map((item) => {
                    const isActive = pathname === item.href;
                    const Icon = item.icon;

                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={`
                                flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200
                                ${isActive
                                    ? 'bg-accent/10 text-accent border border-accent/30'
                                    : 'text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent'
                                }
                            `}
                        >
                            <Icon className="w-5 h-5 flex-shrink-0" />
                            <span className="hidden lg:block text-sm font-medium">
                                {item.label}
                            </span>
                        </Link>
                    );
                })}
            </nav>

            {/* Bot Status */}
            <div className="px-3 py-4 border-t border-sidebar-border">
                <div className="flex items-center justify-center lg:justify-start gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${botRunning ? 'bg-emerald-400 animate-pulse shadow-lg shadow-emerald-500/50' : 'bg-gray-500'}`} />
                    <span className="hidden lg:block text-xs text-muted-foreground uppercase tracking-wider">
                        {botRunning ? 'Bot Active' : 'Bot Offline'}
                    </span>
                </div>
            </div>

            {/* Theme Switcher */}
            {mounted && (
                <div className="px-3 py-4 border-t border-sidebar-border">
                    <p className="hidden lg:block text-xs text-muted-foreground uppercase tracking-wider mb-2 px-3">
                        Theme
                    </p>
                    <div className="flex lg:flex-col gap-1">
                        {themes.map((t) => {
                            const Icon = t.icon;
                            const isActive = theme === t.id;

                            return (
                                <button
                                    key={t.id}
                                    onClick={() => setTheme(t.id)}
                                    className={`
                                        flex items-center justify-center lg:justify-start gap-2 px-3 py-2 rounded-lg transition-all
                                        ${isActive
                                            ? 'bg-accent/10 text-accent'
                                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                                        }
                                    `}
                                    title={t.label}
                                >
                                    <Icon className="w-4 h-4" />
                                    <span className="hidden lg:block text-xs">{t.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Logout */}
            <div className="p-3 border-t border-sidebar-border">
                <button
                    onClick={handleLogout}
                    className="w-full flex items-center justify-center lg:justify-start gap-2 px-3 py-2.5 rounded-xl text-muted-foreground hover:bg-red-500/10 hover:text-red-400 transition-all"
                >
                    <LogOut className="w-5 h-5" />
                    <span className="hidden lg:block text-sm">Logout</span>
                </button>
            </div>
        </aside>
    );
}
