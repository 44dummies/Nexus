'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter } from 'next/navigation';
import { useTradingStore } from '@/store/tradingStore';
import { BotEngine } from '@/lib/bot/engine';
import { apiFetch } from '@/lib/api';

const Sidebar = dynamic(() => import('@/components/layout/Sidebar'), { ssr: false });

interface AppLayoutProps {
    children: React.ReactNode;
}

const RAW_APP_ID = (process.env.NEXT_PUBLIC_DERIV_APP_ID || '').trim();
const APP_ID = Number.isFinite(Number(RAW_APP_ID)) && RAW_APP_ID ? RAW_APP_ID : '1089';
const DEFAULT_SYMBOL = 'R_100';
const RAW_WS_URL = (process.env.NEXT_PUBLIC_DERIV_WS_URL || 'wss://ws.derivws.com/websockets/v3').trim();
const WS_URL = RAW_WS_URL.replace(/\/$/, '');
const WS_RECONNECT_BASE_MS = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_BASE_MS || 1500);
const WS_RECONNECT_MAX_MS = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_MAX_MS || 30000);
const WS_RECONNECT_JITTER_MS = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_JITTER_MS || 500);

export default function AppLayout({ children }: AppLayoutProps) {
    const pathname = usePathname();
    const router = useRouter();
    const {
        addTick,
        setAccounts,
        setUser,
        setConnectionStatus,
        setActiveAccount,
        entryMode,
        entryTimeoutMs,
        entryPollingMs,
        entrySlippagePct,
        entryAggressiveness,
        entryMinEdgePct,
        maxStake,
        cooldownMs,
        isAuthorized,
    } = useTradingStore();

    const wsRef = useRef<WebSocket | null>(null);
    const engineRef = useRef<BotEngine | null>(null);
    const isConnectingRef = useRef(false);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reconnectAttemptsRef = useRef(0);
    const sessionRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const sessionRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Sliding session: Refresh cookie every 5 minutes to keep session alive while app is open
    // Only run on authenticated routes (not on login page)
    useEffect(() => {
        // Don't run session refresh on login page
        if (pathname === '/') {
            return;
        }

        const refreshSession = async () => {
            try {
                const res = await apiFetch('/api/auth/session');
                // Only log errors for non-401 responses
                if (!res.ok && res.status !== 401) {
                    console.error('Session refresh failed with status:', res.status);
                }
            } catch (err) {
                // Silently ignore network errors for session refresh
            }
        };

        // Initial refresh on mount
        refreshSession();

        sessionRefreshRef.current = setInterval(refreshSession, 5 * 60 * 1000); // 5 minutes

        return () => {
            if (sessionRefreshRef.current) {
                clearInterval(sessionRefreshRef.current);
                sessionRefreshRef.current = null;
            }
        };
    }, [pathname]);

    const connectWebSocket = useCallback(() => {
        if (isConnectingRef.current) return;
        if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
        }
        if (engineRef.current) {
            engineRef.current.shutdown();
            engineRef.current = null;
        }
        if (wsRef.current) wsRef.current.close();

        isConnectingRef.current = true;
        const ws = new WebSocket(`${WS_URL}?app_id=${APP_ID}`);
        wsRef.current = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ ticks: DEFAULT_SYMBOL, subscribe: 1 }));
            setConnectionStatus(true);
            isConnectingRef.current = false;
            reconnectAttemptsRef.current = 0;

            const snapshot = useTradingStore.getState();
            engineRef.current = new BotEngine({
                ws,
                symbol: DEFAULT_SYMBOL,
                maxStake: snapshot.maxStake,
                cooldownMs: snapshot.cooldownMs,
            });
        };

        ws.onclose = () => {
            setConnectionStatus(false);
            isConnectingRef.current = false;
            // Bot keeps running on backend, just clear local ref
            engineRef.current = null;

            if (pathname !== '/') {
                const attempt = reconnectAttemptsRef.current;
                const baseDelay = Math.min(WS_RECONNECT_BASE_MS * Math.pow(2, attempt), WS_RECONNECT_MAX_MS);
                const jitter = Math.floor(Math.random() * WS_RECONNECT_JITTER_MS);
                const delay = Math.min(baseDelay + jitter, WS_RECONNECT_MAX_MS);
                reconnectAttemptsRef.current = Math.min(attempt + 1, 10);
                reconnectTimerRef.current = setTimeout(() => {
                    connectWebSocket();
                }, delay);
            }
        };

        ws.onerror = (event) => {
            setConnectionStatus(false);
            isConnectingRef.current = false;
            console.error('WebSocket error', event);
        };

        ws.onmessage = (msg) => {
            let response: any;
            try {
                response = JSON.parse(msg.data);
            } catch (error) {
                console.error('WebSocket message parse error', error);
                return;
            }
            if (response.error) {
                console.error('WS Error:', response.error);
                return;
            }

            if (response.msg_type === 'tick') {
                const quote = Number(response.tick?.quote);
                addTick(quote);
                const epoch = Number(response.tick?.epoch);
                engineRef.current?.onTick(quote, epoch);
            }
        };
    }, [addTick, setConnectionStatus, pathname]);

    useEffect(() => {
        if (pathname === '/') {
            return;
        }

        let isMounted = true;

        const initSession = async () => {
            try {
                const res = await apiFetch('/api/auth/session');
                
                // Handle 401/403 without triggering re-renders
                if (res.status === 401 || res.status === 403) {
                    if (isMounted) {
                        router.push('/');
                    }
                    return;
                }

                if (res.status >= 500) {
                    console.error('Session init transient error with status:', res.status);
                    if (isMounted && !sessionRetryRef.current) {
                        sessionRetryRef.current = setTimeout(() => {
                            sessionRetryRef.current = null;
                            initSession();
                        }, 5000);
                    }
                    return;
                }

                const data = await res.json();

                if (!isMounted) return;

                if (data?.transient) {
                    if (!sessionRetryRef.current) {
                        sessionRetryRef.current = setTimeout(() => {
                            sessionRetryRef.current = null;
                            initSession();
                        }, 5000);
                    }
                    return;
                }

                if (!data.authenticated) {
                    router.push('/');
                    return;
                }

                if (Array.isArray(data.accounts)) {
                    setAccounts(
                        data.accounts,
                        data.email || '',
                        data.activeAccountId || null,
                        data.activeAccountType || null,
                        data.activeCurrency || null
                    );
                }

                if (data.activeAccountId && data.activeAccountType && data.activeCurrency) {
                    setActiveAccount(data.activeAccountId, data.activeAccountType, data.activeCurrency);
                }

                setUser(data.email || '', Number(data.balance ?? 0), data.activeCurrency || data.currency || 'USD');
                connectWebSocket();
            } catch (err) {
                console.error('Session init failed:', err);
                if (isMounted && !sessionRetryRef.current) {
                    sessionRetryRef.current = setTimeout(() => {
                        sessionRetryRef.current = null;
                        initSession();
                    }, 5000);
                }
            }
        };

        initSession();

        return () => {
            isMounted = false;
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            if (sessionRetryRef.current) {
                clearTimeout(sessionRetryRef.current);
                sessionRetryRef.current = null;
            }
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            engineRef.current = null;
        };
    }, [pathname, setAccounts, setActiveAccount, setUser, connectWebSocket, router]);

    useEffect(() => {
        if (isAuthorized) return;
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        engineRef.current = null;
        setConnectionStatus(false);
    }, [isAuthorized, setConnectionStatus]);

    useEffect(() => {
        if (!engineRef.current) return;
        engineRef.current.updateConfig({
            maxStake,
            cooldownMs,
        });
    }, [maxStake, cooldownMs]);

    const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

    const isLoginRoute = pathname === '/';

    return (
        <div className={`${isLoginRoute ? '' : 'flex'} min-h-screen bg-background relative`}>
            {!isLoginRoute && (
                <>
                    {/* Mobile Menu Trigger */}
                    <div className="lg:hidden fixed top-4 left-4 z-40">
                        <button
                            type="button"
                            onClick={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
                            aria-label={isMobileSidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
                            aria-controls="app-sidebar"
                            aria-expanded={isMobileSidebarOpen}
                            className="p-2 rounded-lg bg-background/80 backdrop-blur border border-border/50 shadow-sm hover:bg-accent/10 transition-colors"
                        >
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="24"
                                height="24"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <line x1="3" x2="21" y1="6" y2="6" />
                                <line x1="3" x2="21" y1="12" y2="12" />
                                <line x1="3" x2="21" y1="18" y2="18" />
                            </svg>
                        </button>
                    </div>

                    <Sidebar
                        isMobileOpen={isMobileSidebarOpen}
                        onMobileClose={() => setIsMobileSidebarOpen(false)}
                    />

                    {/* Mobile Backdrop */}
                    {isMobileSidebarOpen && (
                        <div
                            className="lg:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
                            onClick={() => setIsMobileSidebarOpen(false)}
                        />
                    )}
                </>
            )}
            <main className={`${isLoginRoute ? '' : 'flex-1 overflow-auto'} relative w-full`}>
                {children}
            </main>
        </div>
    );
}
