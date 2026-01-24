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
    ChevronLeft,
    ChevronRight,
    LogOut
} from 'lucide-react';
import { useTradingStore } from '@/store/tradingStore';
import { apiFetch } from '@/lib/api';
import { LogoMark } from '@/components/brand/LogoMark';

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
    const [isCollapsed, setIsCollapsed] = useState(false);
    const botRunning = useTradingStore((state) => state.botRunning);
    const logout = useTradingStore((state) => state.logout);

    // Prevent hydration mismatch
    useEffect(() => {
        setMounted(true); // eslint-disable-line react-hooks/set-state-in-effect
        const saved = window.localStorage.getItem('sidebar-collapsed');
        if (saved !== null) {
            setIsCollapsed(saved === 'true');
        }
    }, []);

    const handleLogout = async () => {
        try {
            await apiFetch('/api/auth/session', {
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

    const toggleCollapse = () => {
        setIsCollapsed((prev) => {
            const next = !prev;
            window.localStorage.setItem('sidebar-collapsed', String(next));
            return next;
        });
    };

    const labelClassName = isCollapsed ? 'hidden' : 'hidden lg:block';

    return (
        <aside
            className={`w-16 ${isCollapsed ? 'lg:w-16' : 'lg:w-64'} flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col h-screen sticky top-0 transition-[width] duration-300`}
        >
            {/* Logo */}
            <div className={`flex items-center border-b border-sidebar-border p-2 ${isCollapsed ? 'lg:p-2' : 'lg:p-4'}`}>
                <div className={`flex items-center gap-3 ${isCollapsed ? 'lg:justify-center w-full' : ''}`}>
                    <div className="p-1 rounded-3xl bg-gradient-to-br from-sky-400/30 via-cyan-300/20 to-blue-600/30 shadow-soft-lg">
                        <LogoMark size={40} className="drop-shadow-md lg:hidden" />
                        <LogoMark size={isCollapsed ? 40 : 56} className="drop-shadow-md hidden lg:block" />
                    </div>
                    <span className={`${labelClassName} text-2xl font-semibold text-foreground font-dancing tracking-wide`}>
                        Nexus
                    </span>
                </div>
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
                            title={item.label}
                            className={`
                                flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200
                                ${isCollapsed ? 'lg:justify-center lg:px-2' : 'lg:justify-start lg:px-3'}
                                ${isActive
                                    ? 'bg-accent/10 text-accent border border-accent/30'
                                    : 'text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent'
                                }
                            `}
                        >
                            <Icon className="w-5 h-5 flex-shrink-0" />
                            <span className={`${labelClassName} text-sm font-medium`}>
                                {item.label}
                            </span>
                        </Link>
                    );
                })}
            </nav>

            {/* Bot Status */}
            <div className="px-3 py-4 border-t border-sidebar-border">
                <div className={`flex items-center gap-2 ${isCollapsed ? 'lg:justify-center' : 'lg:justify-start'} justify-center`}>
                    <div className={`w-2.5 h-2.5 rounded-full ${botRunning ? 'bg-emerald-400 animate-pulse shadow-lg shadow-emerald-500/50' : 'bg-gray-500'}`} />
                    <span className={`${labelClassName} text-xs text-muted-foreground uppercase tracking-wider`}>
                        {botRunning ? 'Bot Active' : 'Bot Offline'}
                    </span>
                </div>
            </div>

            {/* Theme Switcher */}
            {mounted && (
                <div className="px-3 py-4 border-t border-sidebar-border">
                    <p className={`${labelClassName} text-xs text-muted-foreground uppercase tracking-wider mb-2 px-3`}>
                        Theme
                    </p>
                    <div className={`flex lg:flex-col gap-1 ${isCollapsed ? 'lg:items-center' : ''}`}>
                        {themes.map((t) => {
                            const Icon = t.icon;
                            const isActive = theme === t.id;

                            return (
                                <button
                                    key={t.id}
                                    onClick={() => setTheme(t.id)}
                                    className={`
                                        flex items-center justify-center lg:justify-start gap-2 px-3 py-2 rounded-lg transition-all
                                        ${isCollapsed ? 'lg:justify-center lg:px-2' : 'lg:justify-start lg:px-3'}
                                        ${isActive
                                            ? 'bg-accent/10 text-accent'
                                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                                        }
                                    `}
                                    title={t.label}
                                >
                                    <Icon className="w-4 h-4" />
                                    <span className={`${labelClassName} text-xs`}>{t.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Collapse Toggle */}
            <div className="px-3 py-3 border-t border-sidebar-border">
                <button
                    type="button"
                    onClick={toggleCollapse}
                    className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground transition-colors ${isCollapsed ? 'lg:justify-center' : 'lg:justify-start'}`}
                    aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                    title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                    {isCollapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
                    <span className={`${labelClassName} text-sm`}>{isCollapsed ? 'Expand' : 'Collapse'}</span>
                </button>
            </div>

            {/* Logout */}
            <div className="p-3 border-t border-sidebar-border">
                <button
                    onClick={handleLogout}
                    className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-muted-foreground hover:bg-red-500/10 hover:text-red-400 transition-all ${isCollapsed ? 'lg:justify-center' : 'lg:justify-start'}`}
                >
                    <LogOut className="w-5 h-5" />
                    <span className={`${labelClassName} text-sm`}>Logout</span>
                </button>
            </div>
        </aside>
    );
}
