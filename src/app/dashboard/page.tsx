'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTradingStore } from '@/store/tradingStore';
import { Activity, Wallet, TrendingUp, TrendingDown } from 'lucide-react';
import { BotEngine } from '@/lib/bot/engine';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import dynamic from 'next/dynamic';

// Dynamic imports for 3D components (SSR disabled)
const StrategySelector = dynamic(() => import('@/components/dashboard/StrategySelector'), { ssr: false });
const MarketVisualizer = dynamic(() => import('@/components/dashboard/MarketVisualizer'), { ssr: false });

const APP_ID = process.env.NEXT_PUBLIC_DERIV_APP_ID;
const DEFAULT_SYMBOL = 'R_100';

// Trade History Item Type
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
        userEmail,
        balance,
        currency,
        isAuthorized,
        setUser,
        setBalance,
        botRunning,
        baseStake,
        stopLoss,
        takeProfit,
        setBotRunning,
        setBotConfig,
    } = useTradingStore();
    const [isConnected, setIsConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const engineRef = useRef<BotEngine | null>(null);

    // Tick data for MarketVisualizer
    const [lastTick, setLastTick] = useState(0);
    const [prevTick, setPrevTick] = useState(0);

    // Mock trade history (in production, this would be from the store or WS)
    const [tradeHistory, setTradeHistory] = useState<TradeItem[]>([]);

    useEffect(() => {
        let isMounted = true;

        const initConnection = async () => {
            try {
                const res = await fetch('/api/auth/session');
                const data = await res.json();

                if (!data.authenticated || !data.token) {
                    console.log('Not authenticated, redirecting...');
                    router.push('/');
                    return;
                }

                const token = data.token;
                const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);
                wsRef.current = ws;

                ws.onopen = () => {
                    console.log('Connected to Deriv WS');
                    ws.send(JSON.stringify({ authorize: token }));
                };

                ws.onclose = () => {
                    if (isMounted) setIsConnected(false);
                };

                ws.onmessage = (msg) => {
                    const response = JSON.parse(msg.data);

                    if (response.error) {
                        console.error('WS Error:', response.error);
                        if (response.error.code === 'InvalidToken') router.push('/');
                        return;
                    }

                    if (response.msg_type === 'authorize') {
                        const { email, balance, currency } = response.authorize;
                        console.log('Authorized:', email);
                        setUser(email, Number(balance), currency, token);
                        if (isMounted) setIsConnected(true);

                        ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
                        ws.send(JSON.stringify({ ticks: DEFAULT_SYMBOL, subscribe: 1 }));

                        engineRef.current = new BotEngine({
                            ws,
                            symbol: DEFAULT_SYMBOL,
                        });
                    }

                    if (response.msg_type === 'balance') {
                        const { balance, currency } = response.balance;
                        setBalance(Number(balance));
                        useTradingStore.setState({ currency });
                    }

                    if (response.msg_type === 'tick') {
                        const quote = Number(response.tick?.quote);
                        setPrevTick(lastTick);
                        setLastTick(quote);
                        engineRef.current?.handleTick(quote);
                    }
                };

            } catch (err) {
                console.error('Failed to initialize:', err);
                router.push('/');
            }
        };

        initConnection();

        return () => {
            isMounted = false;
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            engineRef.current = null;
        };
    }, [router, setBalance, setUser, lastTick]);

    const tickDirection = lastTick > prevTick ? 'up' : lastTick < prevTick ? 'down' : 'neutral';

    return (
        <div className="min-h-screen bg-[#050508] text-white relative overflow-hidden">
            {/* Background Particle Visualizer */}
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
                        <div className="flex gap-8 items-center">
                            <div className="text-right">
                                <p className="text-xs text-gray-500 uppercase tracking-widest">Account</p>
                                <p className="font-mono font-medium text-sm">{userEmail || 'Loading...'}</p>
                            </div>
                            <div className="text-right">
                                <p className="text-xs text-gray-500 uppercase tracking-widest">Balance</p>
                                <div className="flex items-center justify-end gap-2 text-[#00f5ff] font-mono text-2xl">
                                    <Wallet className="w-5 h-5" />
                                    <span>{currency} {balance?.toFixed(2) || '0.00'}</span>
                                </div>
                            </div>
                            <div className={`flex items-center gap-2 px-4 py-2 rounded-full ${tickDirection === 'up' ? 'bg-emerald-500/20 text-emerald-400' : tickDirection === 'down' ? 'bg-red-500/20 text-red-400' : 'bg-gray-500/20 text-gray-400'}`}>
                                {tickDirection === 'up' ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                                <span className="font-mono text-sm">{lastTick.toFixed(2)}</span>
                            </div>
                        </div>
                    ) : (
                        <div className="text-amber-500 font-mono animate-pulse">Connecting...</div>
                    )}
                </header>

                {/* Strategy Selector */}
                <section className="mb-8">
                    <StrategySelector />
                </section>

                {/* Main Grid */}
                <main className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Chart Placeholder */}
                    <div className="lg:col-span-2 h-[400px] glass-panel rounded-2xl p-6 flex flex-col items-center justify-center text-gray-600">
                        <Activity className="w-16 h-16 mb-4 opacity-30" />
                        <span className="font-mono text-sm uppercase tracking-widest">Live Chart Coming Soon</span>
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
