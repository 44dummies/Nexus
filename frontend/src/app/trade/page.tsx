'use client';

import dynamic from 'next/dynamic';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorFallback } from '@/components/ui/ErrorFallback';
import { useTradingStore } from '@/store/tradingStore';

// Dynamic imports for heavy trading components
const MarketVisualizer = dynamic(() => import('@/components/dashboard/MarketVisualizer'), { ssr: false });
const LiveFeed = dynamic(() => import('@/components/dashboard/LiveFeed'), { ssr: false });
const DashboardHeader = dynamic(() => import('@/components/dashboard/DashboardHeader').then(mod => mod.DashboardHeader), { ssr: false });
const AdvancedChart = dynamic(() => import('@/components/trade/AdvancedChart'), { ssr: false });

function TradeContent() {
    const {
        lastTick,
        prevTick,
        isAuthorized,
        currency,
        balance,
        isConnected,
    } = useTradingStore();

    return (
        <div className="relative min-h-screen">
            <MarketVisualizer lastTick={lastTick} prevTick={prevTick} />

            <div className="relative z-10 mx-auto w-full max-w-6xl px-4 sm:px-6 py-8">
                <DashboardHeader
                    isAuthorized={isAuthorized}
                    isConnected={isConnected}
                    currency={currency}
                    balance={balance}
                />

                <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 mt-6">
                    <div className="lg:col-span-2">
                        <div className="glass-panel rounded-2xl p-6 min-h-[360px] sm:min-h-[420px]">
                            <AdvancedChart />
                        </div>
                    </div>
                    <div>
                        <LiveFeed />
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function TradePage() {
    return (
        <ErrorBoundary FallbackComponent={ErrorFallback}>
            <TradeContent />
        </ErrorBoundary>
    );
}
