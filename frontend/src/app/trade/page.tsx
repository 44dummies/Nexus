'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorFallback } from '@/components/ui/ErrorFallback';
import { useTradingStore } from '@/store/tradingStore';
import { usePnLStream } from '@/hooks/usePnLStream';

// Dynamic imports for heavy trading components
const MarketVisualizer = dynamic(() => import('@/components/dashboard/MarketVisualizer'), { ssr: false });
const LiveFeed = dynamic(() => import('@/components/dashboard/LiveFeed'), { ssr: false });
const DashboardHeader = dynamic(() => import('@/components/dashboard/DashboardHeader').then(mod => mod.DashboardHeader), { ssr: false });
const AdvancedChart = dynamic(() => import('@/components/trade/AdvancedChart'), { ssr: false });
const MarketSelector = dynamic(() => import('@/components/trade/MarketSelector'), { ssr: false });
const SmartLayerPanel = dynamic(() => import('@/components/trade/SmartLayerPanel'), { ssr: false });
const PnLPanel = dynamic(() => import('@/components/trade/PnLPanel'), { ssr: false });

function TradeContent() {
    const {
        lastTick,
        prevTick,
        isAuthorized,
        currency,
        balance,
        isConnected,
    } = useTradingStore();

    const [isChartMaximized, setIsChartMaximized] = useState(false);

    // Subscribe to real-time PnL stream
    usePnLStream();

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

                {/* Market Selector Bar */}
                <div className="flex items-center gap-4 mt-4 mb-2">
                    <MarketSelector />
                </div>

                {/* Smart Layer Panel */}
                <div className="mt-2 mb-2">
                    <SmartLayerPanel />
                </div>

                {/* Real-time PnL */}
                <div className="mb-2">
                    <PnLPanel />
                </div>

                <div className={`grid gap-6 mt-4 ${isChartMaximized ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-3'}`}>
                    <div className={isChartMaximized ? '' : 'lg:col-span-2'}>
                        <div className="glass-panel rounded-2xl p-6 min-h-[360px] sm:min-h-[420px]">
                            <AdvancedChart
                                isMaximized={isChartMaximized}
                                onToggleMaximize={() => setIsChartMaximized((prev) => !prev)}
                            />
                        </div>
                    </div>
                    {!isChartMaximized && (
                        <div>
                            <LiveFeed />
                        </div>
                    )}
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
