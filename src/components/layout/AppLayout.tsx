'use client';

import { useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter } from 'next/navigation';
import { refreshSession } from '@/app/actions/auth';
import { useTradingStore } from '@/store/tradingStore';
import { BotEngine } from '@/lib/bot/engine';

const Sidebar = dynamic(() => import('@/components/layout/Sidebar'), { ssr: false });

interface AppLayoutProps {
    children: React.ReactNode;
}

const APP_ID = process.env.NEXT_PUBLIC_DERIV_APP_ID || '1089';
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

    // Sliding session: Refresh cookie every 5 minutes to keep session alive while app is open
    useEffect(() => {
        const interval = setInterval(() => {
            refreshSession().catch(console.error);
        }, 5 * 60 * 1000); // 5 minutes

        // Initial refresh on mount
        refreshSession().catch(console.error);

        return () => clearInterval(interval);
    }, []);

    const connectWebSocket = useCallback(() => {
        if (isConnectingRef.current) return;
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

            engineRef.current = new BotEngine({
                ws,
                symbol: DEFAULT_SYMBOL,
                maxStake,
                cooldownMs,
                entryMode,
                entryTimeoutMs,
                entryPollingMs,
                entrySlippagePct,
                entryAggressiveness,
                entryMinEdgePct,
            });
        };

        ws.onclose = () => {
            setConnectionStatus(false);
            isConnectingRef.current = false;
            if (engineRef.current) {
                engineRef.current.shutdown();
                engineRef.current = null;
            }
            if (pathname !== '/') {
                reconnectTimerRef.current = setTimeout(() => {
                    connectWebSocket();
                }, 3000);
            }
        };

        ws.onmessage = (msg) => {
            const response = JSON.parse(msg.data);
            if (response.error) {
                console.error('WS Error:', response.error);
                return;
            }

            engineRef.current?.handleMessage(response);

            if (response.msg_type === 'tick') {
                const quote = Number(response.tick?.quote);
                addTick(quote);
                engineRef.current?.handleTick(quote);
            }
        };
    }, [addTick, setConnectionStatus, entryMode, entryTimeoutMs, entryPollingMs, entrySlippagePct, entryAggressiveness, entryMinEdgePct, maxStake, cooldownMs, pathname]);

    useEffect(() => {
        if (pathname === '/') {
            return;
        }

        const initSession = async () => {
            try {
                const res = await fetch('/api/auth/session');
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
            engineRef.current?.shutdown();
            engineRef.current = null;
        };
    }, [pathname, setAccounts, setActiveAccount, setUser, connectWebSocket, router]);

    useEffect(() => {
        if (isAuthorized) return;
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        engineRef.current?.shutdown();
        engineRef.current = null;
        setConnectionStatus(false);
    }, [isAuthorized, setConnectionStatus]);

    useEffect(() => {
        if (!engineRef.current) return;
        engineRef.current.updateConfig({
            entryMode,
            entryTimeoutMs,
            entryPollingMs,
            entrySlippagePct,
            entryAggressiveness,
            entryMinEdgePct,
            maxStake,
            cooldownMs,
        });
    }, [entryMode, entryTimeoutMs, entryPollingMs, entrySlippagePct, entryAggressiveness, entryMinEdgePct, maxStake, cooldownMs]);

    const isLoginRoute = pathname === '/';

    return (
        <div className={`${isLoginRoute ? '' : 'flex'} min-h-screen bg-background`}>
            {!isLoginRoute && <Sidebar />}
            <main className={`${isLoginRoute ? '' : 'flex-1 overflow-auto'}`}>
                {children}
            </main>
        </div>
    );
}
