'use client';

import dynamic from 'next/dynamic';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorFallback } from '@/components/ui/ErrorFallback';
import { useTradingStore } from '@/store/tradingStore';

// Dynamic imports for heavy trading components
const SmartLayerPanel = dynamic(() => import('@/components/trade/SmartLayerPanel'), { ssr: false });
const PnLPanel = dynamic(() => import('@/components/trade/PnLPanel'), { ssr: false });
const AccountSwitcher = dynamic(() => import('@/components/dashboard/AccountSwitcher'), { ssr: false });
const BotRunToggle = dynamic(() => import('@/components/bots/BotRunToggle').then(mod => mod.BotRunToggle), { ssr: false });

function TradeContent() {
    const {
        isAuthorized,
        currency,
        balance,
        isConnected,
        activeAccountType,
    } = useTradingStore();

    return (
        <div className="relative min-h-screen bg-background">
            <div className="relative z-10 mx-auto w-full max-w-6xl px-4 sm:px-6 pt-16 lg:pt-6 pb-6">
                {/* Header row: live balance + mode badge + account switcher */}
                <div className="flex flex-wrap items-center justify-between gap-4 mb-4 rounded-2xl border border-border/60 bg-muted/30 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-4">
                        <div className="flex items-center gap-2 text-sm">
                            <div className={`w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
                            <span className="text-xs uppercase tracking-widest text-muted-foreground">
                                {isConnected ? 'Live' : 'Connecting'}
                            </span>
                        </div>
                        {isAuthorized && (
                            <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background/60 px-4 py-2 text-sm font-mono">
                                <span className="text-muted-foreground">{currency || 'USD'}</span>
                                <span className="font-semibold text-foreground">{(balance ?? 0).toFixed(2)}</span>
                            </div>
                        )}
                        {activeAccountType && (
                            <span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-widest ${activeAccountType === 'real'
                                    ? 'bg-emerald-500/15 text-emerald-500'
                                    : 'bg-amber-500/15 text-amber-500'
                                }`}>
                                {activeAccountType}
                            </span>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        <BotRunToggle size="sm" />
                        <AccountSwitcher />
                    </div>
                </div>

                {/* Smart Layer Panel */}
                <div className="mb-3">
                    <SmartLayerPanel />
                </div>

                {/* Real-time PnL */}
                <div className="mb-4">
                    <PnLPanel />
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
