'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorFallback } from '@/components/ui/ErrorFallback';
import { useTradingStore } from '@/store/tradingStore';
import { usePnLStream } from '@/hooks/usePnLStream';

// Dynamic imports for heavy trading components
const DashboardHeader = dynamic(() => import('@/components/dashboard/DashboardHeader').then(mod => mod.DashboardHeader), { ssr: false });
const MarketSelector = dynamic(() => import('@/components/trade/MarketSelector'), { ssr: false });
const SmartLayerPanel = dynamic(() => import('@/components/trade/SmartLayerPanel'), { ssr: false });
const PnLPanel = dynamic(() => import('@/components/trade/PnLPanel'), { ssr: false });
const AdvancedChart = dynamic(() => import('@/components/trade/AdvancedChart'), { ssr: false });
const AccountSwitcher = dynamic(() => import('@/components/dashboard/AccountSwitcher'), { ssr: false });

function TradeContent() {
    const {
        isAuthorized,
        currency,
        balance,
        isConnected,
    } = useTradingStore();

    const [isChartMaximized, setIsChartMaximized] = useState(false);

    // Subscribe to real-time PnL stream
    usePnLStream();

    return (
        <div className="relative min-h-screen bg-background">
            <div className="relative z-10 mx-auto w-full max-w-6xl px-4 sm:px-6 pt-16 lg:pt-6 pb-6">
                {/* Header row: title + account switcher + balance */}
                <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                    <DashboardHeader
                        isAuthorized={isAuthorized}
                        isConnected={isConnected}
                        currency={currency}
                        balance={balance}
                    />
                    <div className="flex items-center gap-3">
                        {/* Live Balance Pill */}
                        {isAuthorized && (
                            <div className="flex items-center gap-2 rounded-full border border-border/70 bg-muted/40 px-4 py-2 text-sm font-mono">
                                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                                <span className="text-muted-foreground">{currency || 'USD'}</span>
                                <span className="font-semibold text-foreground">{(balance ?? 0).toFixed(2)}</span>
                            </div>
                        )}
                        <AccountSwitcher />
                    </div>
                </div>

                {/* Market Selector Bar */}
                <div className="flex items-center gap-4 mb-3">
                    <MarketSelector />
                </div>

                {/* Smart Layer Panel */}
                <div className="mb-3">
                    <SmartLayerPanel />
                </div>

                {/* Real-time PnL */}
                <div className="mb-4">
                    <PnLPanel />
                </div>

                {/* Advanced Chart */}
                <div className="glass-panel rounded-2xl p-4 sm:p-6">
                    <AdvancedChart
                        isMaximized={isChartMaximized}
                        onToggleMaximize={() => setIsChartMaximized(prev => !prev)}
                    />
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
