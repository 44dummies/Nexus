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
    LogOut,
    Wifi,
    WifiOff,
} from 'lucide-react';
import { useTradingStore } from '@/store/tradingStore';
import { apiFetch } from '@/lib/api';
import { LogoMark } from '@/components/brand/LogoMark';
import dynamic from 'next/dynamic';

const AccountSwitcher = dynamic(() => import('@/components/dashboard/AccountSwitcher'), { ssr: false });

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

interface SidebarProps {
    isMobileOpen?: boolean;
    onMobileClose?: () => void;
}

export default function Sidebar({ isMobileOpen = false, onMobileClose }: SidebarProps) {
    const pathname = usePathname();
    const { theme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const [isCollapsed, setIsCollapsed] = useState(false);
    const botRunning = useTradingStore((state) => state.botRunning);
    const isConnected = useTradingStore((state) => state.isConnected);
    const activeAccountType = useTradingStore((state) => state.activeAccountType);
    const logout = useTradingStore((state) => state.logout);

    // Prevent hydration mismatch
    useEffect(() => {
        setMounted(true);
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

    const handleLinkClick = () => {
        if (window.innerWidth < 1024 && onMobileClose) {
            onMobileClose();
        }
    };

    const sidebarClasses = `
        flex flex-col h-screen bg-sidebar border-r border-sidebar-border
        fixed inset-y-0 left-0 z-50 w-[85vw] max-w-72 shadow-xl
        transition-all duration-300 ease-in-out
        ${isMobileOpen ? 'translate-x-0' : '-translate-x-full'}
        lg:translate-x-0 lg:static lg:sticky lg:top-0 lg:z-auto lg:shadow-none
        ${isCollapsed ? 'lg:w-16' : 'lg:w-64'}
    `;

    return (
        <aside id="app-sidebar" className={sidebarClasses} aria-label="Primary">
            {/* Logo — click toggles collapse on desktop */}
            <div className="p-4 flex items-center justify-between border-b border-sidebar-border">
                <button
                    type="button"
                    onClick={toggleCollapse}
                    className="hidden lg:flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity"
                    aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                    title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                    <LogoMark size={40} className="shadow-soft-lg" />
                    <span className={`${isCollapsed ? 'hidden' : 'block'} text-lg font-bold text-foreground`}>
                        DerivNexus
                    </span>
                </button>
                {/* Mobile: non-interactive logo + close button */}
                <div className="lg:hidden flex items-center gap-3">
                    <LogoMark size={40} className="shadow-soft-lg" />
                    <span className="text-lg font-bold text-foreground">DerivNexus</span>
                </div>
                <button
                    type="button"
                    onClick={onMobileClose}
                    className="lg:hidden h-11 w-11 flex items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    aria-label="Close navigation menu"
                >
                    <ChevronLeft className="w-6 h-6" />
                </button>
            </div>

            {/* Navigation */}
            <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto min-h-0" aria-label="Primary">
                {navItems.map((item) => {
                    const isActive = pathname === item.href;
                    const Icon = item.icon;

                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            onClick={handleLinkClick}
                            title={item.label}
                            aria-label={isCollapsed ? item.label : undefined}
                            aria-current={isActive ? 'page' : undefined}
                            className={`
                                flex items-center gap-3 px-3 py-3 rounded-xl transition-all duration-200
                                ${isCollapsed ? 'lg:justify-center lg:px-2' : 'lg:justify-start lg:px-3'}
                                ${isActive
                                    ? 'bg-accent/10 text-accent border border-accent/30'
                                    : 'text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent'
                                }
                            `}
                        >
                            <Icon className="w-5 h-5 flex-shrink-0" />
                            <span className={`${isCollapsed ? 'hidden lg:hidden' : 'block'} text-sm font-medium`}>
                                {item.label}
                            </span>
                        </Link>
                    );
                })}
            </nav>

            {/* Status Indicators */}
            <div className="px-3 py-3 border-t border-sidebar-border space-y-2">
                <div className={`flex items-center gap-2 ${isCollapsed ? 'lg:justify-center' : 'lg:justify-start'} justify-center`}>
                    {isConnected ? (
                        <Wifi className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                        <WifiOff className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
                    )}
                    <span className={`${isCollapsed ? 'hidden lg:hidden' : 'block'} text-xs text-muted-foreground`}>
                        {isConnected ? 'Connected' : 'Reconnecting...'}
                    </span>
                </div>

                <div className={`flex items-center gap-2 ${isCollapsed ? 'lg:justify-center' : 'lg:justify-start'} justify-center`}>
                    <div className={`w-2.5 h-2.5 rounded-full ${botRunning ? 'bg-emerald-400 animate-pulse shadow-lg shadow-emerald-500/50' : 'bg-gray-500'}`} />
                    <span className={`${isCollapsed ? 'hidden lg:hidden' : 'block'} text-xs text-muted-foreground uppercase tracking-wider`}>
                        {botRunning ? 'Bot Active' : 'Bot Offline'}
                    </span>
                </div>
            </div>

            {/* Theme Switcher */}
            {mounted && (
                <div className="px-3 py-3 border-t border-sidebar-border">
                    <div className={`flex flex-col sm:flex-row lg:flex-col gap-1 ${isCollapsed ? 'lg:items-center' : ''}`}>
                        {themes.map((t) => {
                            const Icon = t.icon;
                            const isActive = theme === t.id;

                            return (
                                <button
                                    key={t.id}
                                    onClick={() => setTheme(t.id)}
                                    aria-label={t.label}
                                    aria-pressed={isActive}
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
                                    <span className={`${isCollapsed ? 'hidden lg:hidden' : 'block'} text-xs`}>{t.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Footer: Account Switcher + Logout */}
            <div className="p-3 border-t border-sidebar-border space-y-2">
                {/* Account Switcher — integrated into sidebar footer */}
                <div className={`mb-1 ${isCollapsed ? 'flex justify-center' : ''}`}>
                    <AccountSwitcher compact={isCollapsed} />
                </div>
                {isCollapsed && activeAccountType && (
                    <div className="flex justify-center text-[10px] text-muted-foreground">
                        {activeAccountType === 'real' ? 'REAL' : 'DEMO'}
                    </div>
                )}

                <button
                    onClick={handleLogout}
                    aria-label="Log out"
                    className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-muted-foreground hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 transition-all ${isCollapsed ? 'lg:justify-center' : 'lg:justify-start'}`}
                >
                    <LogOut className="w-5 h-5" />
                    <span className={`${isCollapsed ? 'hidden lg:hidden' : 'block'} text-sm`}>Logout</span>
                </button>
            </div>
        </aside>
    );
}
