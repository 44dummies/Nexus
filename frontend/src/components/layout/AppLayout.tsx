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

    // Sliding session: Refresh cookie every 5 minutes to keep session alive while app is open
    useEffect(() => {
        const interval = setInterval(() => {
            apiFetch('/api/auth/session').catch(console.error);
        }, 5 * 60 * 1000); // 5 minutes

        // Initial refresh on mount
        apiFetch('/api/auth/session').catch(console.error);

        return () => clearInterval(interval);
    }, []);

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
        const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);
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
                const delay = Math.min(3000 * Math.pow(2, attempt), 30000);
                reconnectAttemptsRef.current = Math.min(attempt + 1, 10);
                reconnectTimerRef.current = setTimeout(() => {
                    connectWebSocket();
                }, delay);
            }
        };

        ws.onerror = () => {
            setConnectionStatus(false);
            isConnectingRef.current = false;
        };

        ws.onmessage = (msg) => {
            const response = JSON.parse(msg.data);
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

        const initSession = async () => {
            try {
                const res = await apiFetch('/api/auth/session');
                const data = await res.json();

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
            }
        };

        initSession();

        return () => {
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
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
                            onClick={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
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
