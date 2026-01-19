'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTradingStore } from '@/store/tradingStore';
import { Activity, Wallet, LogOut } from 'lucide-react';
import { BotEngine } from '@/lib/bot/engine';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import dynamic from 'next/dynamic';

// Dynamic imports for 3D & dashboard components
const StrategySelector = dynamic(() => import('@/components/dashboard/StrategySelector'), { ssr: false });
const MarketVisualizer = dynamic(() => import('@/components/dashboard/MarketVisualizer'), { ssr: false });
const AccountSwitcher = dynamic(() => import('@/components/dashboard/AccountSwitcher'), { ssr: false });
const LiveFeed = dynamic(() => import('@/components/dashboard/LiveFeed'), { ssr: false });
const VoiceButton = dynamic(() => import('@/components/dashboard/VoiceButton'), { ssr: false });
const PerformanceHeatmap = dynamic(() => import('@/components/analytics/PerformanceHeatmap'), { ssr: false });

const APP_ID = process.env.NEXT_PUBLIC_DERIV_APP_ID;
const DEFAULT_SYMBOL = 'R_100';

interface TradeItem {
    id: string;
    type: 'CALL' | 'PUT';
    stake: number;
    result: 'pending' | 'won' | 'lost';
    profit?: number;
    time: number;
}

export default function DashboardPage() {
    const router = useRouter();
    const {
        accounts,
        activeAccountId,
        userEmail,
        balance,
        currency,
        isAuthorized,
        lastTick,
        prevTick,
        setAccounts,
        setUser,
        setBalance,
        addTick,
        botRunning,
        baseStake,
        stopLoss,
        takeProfit,
        setBotRunning,
        setBotConfig,
        logout,
    } = useTradingStore();

    const [isConnected, setIsConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const engineRef = useRef<BotEngine | null>(null);
    const [tradeHistory, setTradeHistory] = useState<TradeItem[]>([]);

    // Connect WebSocket with given token
    const connectWebSocket = useCallback((token: string) => {
        // Close existing connection
        if (wsRef.current) {
            wsRef.current.close();
        }

        const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log('Connected to Deriv WS');
            ws.send(JSON.stringify({ authorize: token }));
        };

        ws.onclose = () => {
            setIsConnected(false);
        };

        ws.onmessage = (msg) => {
            const response = JSON.parse(msg.data);

            if (response.error) {
                console.error('WS Error:', response.error);
                if (response.error.code === 'InvalidToken') {
                    logout();
                    router.push('/');
                }
                return;
            }

            if (response.msg_type === 'authorize') {
                const { email, balance, currency } = response.authorize;
                console.log('Authorized:', email);
                setUser(email, Number(balance), currency, token);
                setIsConnected(true);

                // Subscribe to updates
                ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
                ws.send(JSON.stringify({ ticks: DEFAULT_SYMBOL, subscribe: 1 }));

                engineRef.current = new BotEngine({
                    ws,
                    symbol: DEFAULT_SYMBOL,
                });
            }

            if (response.msg_type === 'balance') {
                setBalance(Number(response.balance.balance));
                useTradingStore.setState({ currency: response.balance.currency });
            }

            if (response.msg_type === 'tick') {
                const quote = Number(response.tick?.quote);
                addTick(quote);
                engineRef.current?.handleTick(quote);
            }
        };
    }, [router, setUser, setBalance, addTick, logout]);

    // Initial connection from session
    useEffect(() => {
        const initSession = async () => {
            try {
                const res = await fetch('/api/auth/session');
                const data = await res.json();

                if (!data.authenticated) {
                    router.push('/');
                    return;
                }

                // Build accounts array from session
                const accountsFromSession = [];
                if (data.token && data.account) {
                    accountsFromSession.push({
                        id: data.account,
                        token: data.token,
                        currency: data.currency || 'USD',
                        type: data.account.startsWith('CR') ? 'real' : 'demo' as 'real' | 'demo',
                    });
                }
                if (data.demoToken && data.demoAccount) {
                    accountsFromSession.push({
                        id: data.demoAccount,
                        token: data.demoToken,
                        currency: data.demoCurrency || 'USD',
                        type: 'demo' as const,
                    });
                }

                if (accountsFromSession.length > 0) {
                    setAccounts(accountsFromSession, data.email || '');
                    connectWebSocket(accountsFromSession[0].token);
                } else if (data.token) {
                    // Fallback: single token
                    connectWebSocket(data.token);
                } else {
                    router.push('/');
                }

            } catch (err) {
                console.error('Session init failed:', err);
                router.push('/');
            }
        };

        initSession();

        return () => {
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            engineRef.current = null;
        };
    }, [router, setAccounts, connectWebSocket]);

    // Re-connect when account switches
    useEffect(() => {
        const activeAccount = accounts.find(a => a.id === activeAccountId);
        if (activeAccount && wsRef.current) {
            connectWebSocket(activeAccount.token);
        }
    }, [activeAccountId, accounts, connectWebSocket]);

    const handleLogout = () => {
        logout();
        router.push('/');
    };

    const tickDirection = lastTick > prevTick ? 'up' : lastTick < prevTick ? 'down' : 'neutral';

    return (
        <div className="min-h-screen bg-[#050508] text-white relative overflow-hidden">
            <MarketVisualizer lastTick={lastTick} prevTick={prevTick} />

            <div className="relative z-10 p-8">
                {/* Header */}
                <header className="flex justify-between items-center mb-8 glass-panel rounded-2xl p-6">
                    <div>
                        <h1 className="text-3xl font-bold flex items-center gap-3">
                            <Activity className="text-[#00f5ff]" />
                            <span>DerivNexus</span>
                        </h1>
                        <p className="text-gray-400 text-sm mt-1 font-mono">ALGORITHMIC TRADING TERMINAL</p>
                    </div>

                    {isAuthorized ? (
                        <div className="flex gap-6 items-center">
                            <VoiceButton />
                            <AccountSwitcher />
                            <div className="text-right">
                                <p className="text-xs text-gray-500 uppercase tracking-widest">Balance</p>
                                <div className="flex items-center justify-end gap-2 text-[#00f5ff] font-mono text-2xl">
                                    <Wallet className="w-5 h-5" />
                                    <span>{currency} {balance?.toFixed(2) || '0.00'}</span>
                                </div>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={handleLogout}
                                className="text-gray-400 hover:text-red-400"
                            >
                                <LogOut className="w-5 h-5" />
                            </Button>
                        </div>
                    ) : (
                        <div className="text-amber-500 font-mono animate-pulse">Connecting...</div>
                    )}
                </header>

                {/* Strategy Selector */}
                <section className="mb-8">
                    <StrategySelector />
                </section>

                {/* Performance Analytics */}
                <section className="mb-8">
                    <PerformanceHeatmap />
                </section>

                {/* Main Grid */}
                <main className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Live Feed - replaces chart placeholder */}
                    <div className="lg:col-span-2">
                        <LiveFeed />
                    </div>

                    {/* Right Column */}
                    <div className="flex flex-col gap-6">
                        {/* Bot Controls */}
                        <div className="glass-panel rounded-2xl p-6">
                            <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-3">
                                <h2 className="text-lg font-semibold">Bot Controls</h2>
                                <span className={`text-xs uppercase tracking-widest ${botRunning ? 'text-emerald-400' : 'text-gray-500'}`}>
                                    {botRunning ? '● RUNNING' : '○ STOPPED'}
                                </span>
                            </div>
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <Label htmlFor="base-stake" className="text-gray-400 text-xs uppercase">Base Stake ($)</Label>
                                    <Input
                                        id="base-stake"
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={baseStake}
                                        onChange={(e) => setBotConfig({ baseStake: Number.isFinite(e.currentTarget.valueAsNumber) ? Math.max(0, e.currentTarget.valueAsNumber) : 0 })}
                                        className="bg-black/30 border-white/10 font-mono"
                                    />
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <Label htmlFor="stop-loss" className="text-gray-400 text-xs uppercase">Stop Loss</Label>
                                        <Input
                                            id="stop-loss"
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={stopLoss}
                                            onChange={(e) => setBotConfig({ stopLoss: Number.isFinite(e.currentTarget.valueAsNumber) ? Math.max(0, e.currentTarget.valueAsNumber) : 0 })}
                                            className="bg-black/30 border-white/10 font-mono"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="take-profit" className="text-gray-400 text-xs uppercase">Take Profit</Label>
                                        <Input
                                            id="take-profit"
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={takeProfit}
                                            onChange={(e) => setBotConfig({ takeProfit: Number.isFinite(e.currentTarget.valueAsNumber) ? Math.max(0, e.currentTarget.valueAsNumber) : 0 })}
                                            className="bg-black/30 border-white/10 font-mono"
                                        />
                                    </div>
                                </div>
                                <Button
                                    className={`w-full font-semibold uppercase tracking-wider transition-all duration-300 ${botRunning ? 'bg-red-500/80 hover:bg-red-500 text-white' : 'bg-[#00f5ff] hover:bg-[#00d4dd] text-black'}`}
                                    onClick={() => setBotRunning(!botRunning)}
                                    disabled={!isConnected}
                                >
                                    {botRunning ? '■ Stop Bot' : '▶ Start Bot'}
                                </Button>
                            </div>
                        </div>

                        {/* Trade History */}
                        <div className="glass-panel rounded-2xl p-6 flex-1">
                            <h2 className="text-lg font-semibold mb-4 border-b border-white/5 pb-2">Trade History</h2>
                            <LayoutGroup>
                                <AnimatePresence>
                                    {tradeHistory.length === 0 ? (
                                        <motion.div
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            className="text-gray-600 text-center py-8 font-mono text-sm"
                                        >
                                            No trades yet
                                        </motion.div>
                                    ) : (
                                        tradeHistory.map((trade) => (
                                            <motion.div
                                                key={trade.id}
                                                layout
                                                initial={{ opacity: 0, x: 50 }}
                                                animate={{
                                                    opacity: 1,
                                                    x: 0,
                                                    borderColor: trade.result === 'won' ? '#00ff88' : trade.result === 'lost' ? '#ff4444' : 'rgba(255,255,255,0.1)'
                                                }}
                                                exit={{ opacity: 0, x: -50 }}
                                                className={`p-3 rounded-lg mb-2 border ${trade.result === 'won' ? 'bg-emerald-500/10' : trade.result === 'lost' ? 'bg-red-500/10' : 'bg-white/5'}`}
                                            >
                                                <div className="flex justify-between items-center">
                                                    <span className={`font-mono text-sm ${trade.type === 'CALL' ? 'text-emerald-400' : 'text-red-400'}`}>
                                                        {trade.type}
                                                    </span>
                                                    <span className="font-mono text-xs text-gray-500">
                                                        ${trade.stake.toFixed(2)}
                                                    </span>
                                                </div>
                                            </motion.div>
                                        ))
                                    )}
                                </AnimatePresence>
                            </LayoutGroup>
                        </div>
                    </div>
                </main>
            </div>
        </div>
    );
}
