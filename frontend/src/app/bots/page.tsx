'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { useTradingStore } from '@/store/tradingStore';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorFallback } from '@/components/ui/ErrorFallback';
import { BotsHeader } from '@/components/bots/BotsHeader';
import { BotControlPanel } from '@/components/bots/BotControlPanel';
import { BotsPerformance } from '@/components/bots/BotsPerformance';
import { BotCard } from '@/components/bots/BotCard';
import { EntryControls } from '@/components/bots/EntryControls';
import { RiskParameters } from '@/components/bots/RiskParameters';
import { BotTuningPanel } from '@/components/bots/BotTuningPanel';
import { BOT_CATALOG } from '@/lib/bot/catalog';
import { getBotConfig } from '@/lib/bot/config';
import { getExecutionProfile } from '@/lib/bot/executionProfiles';
import { getBackendRunStatus, startBackendRun, stopBackendRun } from '@/lib/bot/engine';
import { Brain, Lock, ChevronRight, X, Zap, Shield, TrendingUp } from 'lucide-react';

// Available markets for bot trading
const MARKETS = [
    { id: 'R_100', name: 'Volatility 100 Index', category: 'Synthetics' },
    { id: 'R_75', name: 'Volatility 75 Index', category: 'Synthetics' },
    { id: 'R_50', name: 'Volatility 50 Index', category: 'Synthetics' },
    { id: 'R_25', name: 'Volatility 25 Index', category: 'Synthetics' },
    { id: 'R_10', name: 'Volatility 10 Index', category: 'Synthetics' },
    { id: '1HZ100V', name: 'Volatility 100 (1s) Index', category: 'Synthetics' },
    { id: '1HZ75V', name: 'Volatility 75 (1s) Index', category: 'Synthetics' },
    { id: '1HZ50V', name: 'Volatility 50 (1s) Index', category: 'Synthetics' },
    { id: 'BOOM1000', name: 'Boom 1000 Index', category: 'Crash/Boom' },
    { id: 'BOOM500', name: 'Boom 500 Index', category: 'Crash/Boom' },
    { id: 'CRASH1000', name: 'Crash 1000 Index', category: 'Crash/Boom' },
    { id: 'CRASH500', name: 'Crash 500 Index', category: 'Crash/Boom' },
    { id: 'JD100', name: 'Jump 100 Index', category: 'Jump' },
    { id: 'JD50', name: 'Jump 50 Index', category: 'Jump' },
];

// ==================== Bot Detail Drawer ====================

function BotDetailDrawer({
    bot,
    onClose,
}: {
    bot: (typeof BOT_CATALOG)[number];
    onClose: () => void;
}) {
    const profile = getExecutionProfile(bot.executionProfileId);

    return (
        <div className="fixed inset-0 z-50 flex justify-end">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            {/* Drawer */}
            <div className="relative w-full max-w-md bg-background border-l border-border overflow-y-auto animate-in slide-in-from-right">
                <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-border bg-background/90 backdrop-blur">
                    <h3 className="text-lg font-semibold">{bot.name}</h3>
                    <button
                        onClick={onClose}
                        className="flex items-center justify-center w-11 h-11 rounded-xl hover:bg-muted transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-4 sm:p-6 space-y-6">
                    {/* Summary */}
                    <div>
                        <p className="text-sm text-muted-foreground leading-relaxed">{bot.summary}</p>
                    </div>

                    {/* Strategy Attributes */}
                    <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                            <div className="flex items-center gap-1.5 mb-1">
                                <TrendingUp className="w-3.5 h-3.5 text-accent" />
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Market Fit</span>
                            </div>
                            <p className="text-sm font-medium">{bot.marketFit}</p>
                        </div>
                        <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                            <div className="flex items-center gap-1.5 mb-1">
                                <Zap className="w-3.5 h-3.5 text-amber-400" />
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Edge</span>
                            </div>
                            <p className="text-sm font-medium">{bot.edge}</p>
                        </div>
                        <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                            <div className="flex items-center gap-1.5 mb-1">
                                <Shield className="w-3.5 h-3.5 text-blue-400" />
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Risk Profile</span>
                            </div>
                            <p className="text-sm font-medium">{profile.name}</p>
                        </div>
                        <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                            <div className="flex items-center gap-1.5 mb-1">
                                <Brain className="w-3.5 h-3.5 text-purple-400" />
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Strategy ID</span>
                            </div>
                            <p className="text-sm font-mono">{bot.id}</p>
                        </div>
                    </div>

                    {/* Execution Profile Details */}
                    <div>
                        <h4 className="text-sm font-semibold mb-3 uppercase tracking-wider text-muted-foreground">Execution Profile</h4>
                        <div className="space-y-2 text-sm">
                            <div className="flex justify-between py-1.5 border-b border-border/30">
                                <span className="text-muted-foreground">Entry Timeout</span>
                                <span className="font-mono">{profile.defaults.entryTimeoutMs}ms</span>
                            </div>
                            <div className="flex justify-between py-1.5 border-b border-border/30">
                                <span className="text-muted-foreground">Polling Interval</span>
                                <span className="font-mono">{profile.defaults.entryPollingMs}ms</span>
                            </div>
                            <div className="flex justify-between py-1.5 border-b border-border/30">
                                <span className="text-muted-foreground">Slippage Tolerance</span>
                                <span className="font-mono">{profile.defaults.entrySlippagePct}%</span>
                            </div>
                            <div className="flex justify-between py-1.5 border-b border-border/30">
                                <span className="text-muted-foreground">Aggressiveness</span>
                                <span className="font-mono">{profile.defaults.entryAggressiveness}</span>
                            </div>
                            <div className="flex justify-between py-1.5">
                                <span className="text-muted-foreground">Min Edge</span>
                                <span className="font-mono">{profile.defaults.entryMinEdgePct}%</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ==================== SmartLayer Toggle ====================

function SmartLayerToggle() {
    const autoModeEnabled = useTradingStore((s) => s.autoModeEnabled);
    const setAutoModeEnabled = useTradingStore((s) => s.setAutoModeEnabled);
    const currentRegime = useTradingStore((s) => s.currentRegime);
    const activeAutoStrategy = useTradingStore((s) => s.activeAutoStrategy);
    const botRunning = useTradingStore((s) => s.botRunning);

    return (
        <div className={`relative rounded-2xl border p-4 sm:p-5 transition-all ${
            autoModeEnabled
                ? 'border-purple-500/50 bg-purple-500/5 shadow-[0_0_30px_-10px_rgba(168,85,247,0.3)]'
                : 'border-border/60 bg-muted/20'
        }`}>
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <div className={`p-2.5 rounded-xl transition-colors ${
                        autoModeEnabled ? 'bg-purple-500/20' : 'bg-muted/50'
                    }`}>
                        <Brain className={`w-5 h-5 transition-colors ${
                            autoModeEnabled ? 'text-purple-400' : 'text-muted-foreground'
                        }`} />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold flex items-center gap-2">
                            SmartLayer Auto Mode
                            {autoModeEnabled && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/20 text-purple-400 uppercase tracking-wider">
                                    Active
                                </span>
                            )}
                        </h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {autoModeEnabled
                                ? 'AI selects strategy based on market regime detection'
                                : 'Enable AI-driven strategy selection and risk management'}
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    {autoModeEnabled && currentRegime && (
                        <span className="text-xs font-mono text-purple-300 bg-purple-500/10 px-2 py-1 rounded-lg">
                            {currentRegime}
                        </span>
                    )}
                    {autoModeEnabled && activeAutoStrategy && (
                        <span className="text-xs font-mono text-blue-300 bg-blue-500/10 px-2 py-1 rounded-lg">
                            {activeAutoStrategy}
                        </span>
                    )}
                    <button
                        onClick={() => setAutoModeEnabled(!autoModeEnabled)}
                        disabled={botRunning}
                        className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] ${
                            autoModeEnabled ? 'bg-purple-500' : 'bg-slate-600'
                        }`}
                    >
                        <span className={`inline-block h-6 w-6 rounded-full bg-white shadow-sm transition-transform ${
                            autoModeEnabled ? 'translate-x-7' : 'translate-x-1'
                        }`} />
                    </button>
                </div>
            </div>

            {autoModeEnabled && (
                <div className="mt-3 pt-3 border-t border-purple-500/20">
                    <div className="flex items-center gap-2 text-xs text-purple-300/80">
                        <Lock className="w-3.5 h-3.5" />
                        <span>Strategy selection and tuning parameters are managed by SmartLayer when auto mode is active.</span>
                    </div>
                </div>
            )}
        </div>
    );
}

// ==================== Main Content ====================

function BotsContent() {
    const {
        botRunning,
        setBotRunning,
        baseStake,
        maxStake,
        stopLoss,
        takeProfit,
        cooldownMs,
        baseRiskPct,
        dailyLossLimitPct,
        drawdownLimitPct,
        maxConsecutiveLosses,
        lossCooldownMs,
        setBotConfig,
        isAuthorized,
        totalProfitToday,
        totalLossToday,
        activeAccountId,
        setSelectedBotId,
        selectedBotId,
        selectedSymbol,
        setSelectedSymbol,
        entryProfileId,
        entryMode,
        entryTimeoutMs,
        entryPollingMs,
        entrySlippagePct,
        entryAggressiveness,
        entryMinEdgePct,
        setEntryConfig,
        botConfigs,
        setBotConfigFor,
        activeRunId,
        setActiveRunId,
        autoModeEnabled,
    } = useTradingStore();

    const [drawerBot, setDrawerBot] = useState<(typeof BOT_CATALOG)[number] | null>(null);

    const selectedStrategy = selectedBotId || 'rsi';
    const selectedBot = BOT_CATALOG.find((bot) => bot.id === selectedStrategy) || BOT_CATALOG[0];
    const selectedBotConfig = getBotConfig(selectedStrategy, botConfigs);
    const selectedExecution = getExecutionProfile(selectedBot.executionProfileId);

    const handleSelectStrategy = useCallback((id: string) => {
        if (autoModeEnabled) return; // Locked in auto mode
        setSelectedBotId(id);
        const botProfile = BOT_CATALOG.find((bot) => bot.id === id);
        if (botProfile?.executionProfileId) {
            const profile = getExecutionProfile(botProfile.executionProfileId);
            setEntryConfig({
                entryProfileId: profile.id,
                entryTimeoutMs: profile.defaults.entryTimeoutMs,
                entryPollingMs: profile.defaults.entryPollingMs,
                entrySlippagePct: profile.defaults.entrySlippagePct,
                entryAggressiveness: profile.defaults.entryAggressiveness,
                entryMinEdgePct: profile.defaults.entryMinEdgePct,
            });
            setBotConfig({
                baseRiskPct: profile.baseRiskPct,
                lossCooldownMs: profile.lossCooldownMs,
            });
        }
    }, [autoModeEnabled, setSelectedBotId, setEntryConfig, setBotConfig]);

    const syncBackendStatus = async (runId?: string) => {
        const status = await getBackendRunStatus(runId);
        if (status.active) {
            if (!status.botRunId) {
                throw new Error('Backend did not return bot run ID');
            }
            setActiveRunId(status.botRunId);
            setBotRunning(true);
            const strategyId = status.strategyId;
            if (strategyId) {
                setSelectedBotId(strategyId);
            }
            if (status.symbol) {
                setSelectedSymbol(status.symbol);
            }
        } else {
            setActiveRunId(null);
            setBotRunning(false);
        }
        return status;
    };

    useEffect(() => {
        if (!isAuthorized || !activeAccountId) return;
        let isMounted = true;
        syncBackendStatus().catch((err) => {
            if (!isMounted) return;
            const message = err instanceof Error ? err.message : 'Failed to sync bot status';
            toast.error(message);
        });
        return () => {
            isMounted = false;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthorized, activeAccountId]);

    const handleStartBot = async () => {
        if (!isAuthorized) {
            toast.error('Not Connected', {
                description: 'Please connect to Deriv first',
            });
            return;
        }

        if (!selectedSymbol) {
            toast.error('Select market first');
            return;
        }

        if (baseStake <= 0) {
            toast.error('Invalid Stake', {
                description: 'Base stake must be greater than 0',
            });
            return;
        }

        const duration = selectedBotConfig.duration ?? 5;
        const durationUnit = selectedBotConfig.durationUnit ?? 't';
        const botCooldownMs = selectedBotConfig.cooldownMs ?? cooldownMs;

        try {
            const { botRunId } = await startBackendRun({
                action: 'start-backend',
                botId: autoModeEnabled ? 'adapter' : selectedStrategy,
                symbol: selectedSymbol,
                stake: baseStake,
                maxStake: maxStake,
                duration,
                durationUnit,
                cooldownMs: botCooldownMs,
                strategyConfig: selectedBotConfig,
                risk: {
                    baseStake,
                    maxStake,
                    stopLoss,
                    takeProfit,
                    cooldownMs: botCooldownMs,
                    baseRiskPct,
                    dailyLossLimitPct,
                    drawdownLimitPct,
                    maxConsecutiveLosses,
                    lossCooldownMs,
                },
                entry: {
                    profileId: entryProfileId,
                    mode: entryMode,
                    timeoutMs: entryTimeoutMs,
                    pollingMs: entryPollingMs,
                    slippagePct: entrySlippagePct,
                    aggressiveness: entryAggressiveness,
                    minEdgePct: entryMinEdgePct,
                },
            });
            const status = await syncBackendStatus(botRunId);
            if (!status.active) {
                throw new Error('Backend did not start the bot');
            }
            toast.success('Bot Started', {
                description: autoModeEnabled
                    ? 'SmartLayer Adapter is managing strategy selection'
                    : `Trading with ${selectedBot.name}`,
            });
        } catch (err) {
            console.error('Failed to start bot run', err);
            const message = err instanceof Error ? err.message : 'Failed to start bot';
            toast.error(message);
            return;
        }
    };

    const handleStopBot = async () => {
        let status = null;
        try {
            await stopBackendRun(activeRunId ?? undefined);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to stop bot';
            toast.error(message);
        }
        try {
            status = await syncBackendStatus();
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to sync bot status';
            toast.error(message);
            return;
        }
        if (status && !status.active) {
            toast.info('Bot Stopped', {
                description: 'Trading has been paused',
            });
        }
    };

    const netPnL = totalProfitToday - totalLossToday;
    const isLocked = autoModeEnabled;

    return (
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 pt-16 lg:pt-6 pb-6 space-y-6">
            <BotsHeader />

            {/* SmartLayer Auto Mode Toggle — Prominent top-level toggle */}
            <SmartLayerToggle />

            <div className="grid grid-cols-1 lg:grid-cols-[2fr,1fr] gap-6">
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-semibold">Bot Hub</h2>
                            {isLocked && (
                                <span className="flex items-center gap-1 text-xs text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded-full">
                                    <Lock className="w-3 h-3" />
                                    Auto
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground uppercase tracking-widest">
                            {BOT_CATALOG.length} profiles
                        </p>
                    </div>

                    <div className={`grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 transition-opacity ${
                        isLocked ? 'opacity-50 pointer-events-none' : ''
                    }`}>
                        {BOT_CATALOG.map((bot) => (
                            <div key={bot.id} className="relative group">
                                <BotCard
                                    profile={bot}
                                    selected={bot.id === selectedStrategy}
                                    onSelect={handleSelectStrategy}
                                />
                                {/* Detail drawer trigger */}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setDrawerBot(bot);
                                    }}
                                    className="absolute top-2 right-2 flex items-center justify-center w-9 h-9 sm:w-8 sm:h-8 rounded-lg bg-background/80 border border-border/50 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity hover:bg-muted"
                                    title="View details"
                                >
                                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="space-y-6">
                    <div className="glass-panel rounded-2xl p-6">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-lg font-semibold">
                                {isLocked ? 'SmartLayer Adapter' : 'Selected Bot'}
                            </h3>
                            <span className={`text-xs uppercase tracking-widest ${
                                botRunning ? 'text-emerald-400' : 'text-muted-foreground'
                            }`}>
                                {botRunning ? '● Running' : '○ Idle'}
                            </span>
                        </div>
                        {isLocked ? (
                            <>
                                <p className="text-xl font-semibold mb-1">Adapter Strategy</p>
                                <p className="text-sm text-muted-foreground mb-4">
                                    SmartLayer dynamically selects the optimal sub-strategy based on real-time regime detection.
                                </p>
                                <div className="space-y-2 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Mode</span>
                                        <span className="text-purple-400">Autonomous</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Sub-strategies</span>
                                        <span>Trend, Mean-Rev, Breakout, Safe</span>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <>
                                <p className="text-xl font-semibold mb-1">{selectedBot.name}</p>
                                <p className="text-sm text-muted-foreground mb-4">{selectedBot.summary}</p>
                                <div className="space-y-2 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Market Fit</span>
                                        <span>{selectedBot.marketFit}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Edge</span>
                                        <span>{selectedBot.edge}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Execution</span>
                                        <span>{selectedExecution.name}</span>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Market Selector */}
                    <div className="glass-panel rounded-2xl p-6">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-lg font-semibold">Market</h3>
                            <span className="text-xs text-muted-foreground uppercase tracking-widest">Symbol</span>
                        </div>
                        <select
                            value={selectedSymbol ?? ''}
                            onChange={(e) => setSelectedSymbol(e.target.value)}
                            disabled={botRunning}
                            className="w-full p-3 rounded-xl bg-background/50 border border-border/50 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {Object.entries(
                                MARKETS.reduce((acc, market) => {
                                    if (!acc[market.category]) acc[market.category] = [];
                                    acc[market.category].push(market);
                                    return acc;
                                }, {} as Record<string, typeof MARKETS>)
                            ).map(([category, markets]) => (
                                <optgroup key={category} label={category}>
                                    {markets.map((market) => (
                                        <option key={market.id} value={market.id}>
                                            {market.name}
                                        </option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                        <p className="text-xs text-muted-foreground mt-2">
                            Selected: <span className="font-mono text-foreground">{selectedSymbol ?? '—'}</span>
                        </p>
                    </div>

                    <BotControlPanel
                        botRunning={botRunning}
                        isAuthorized={isAuthorized}
                        onStartBot={handleStartBot}
                        onStopBot={handleStopBot}
                    />
                </div>
            </div>

            {/* Risk & Entry Controls — locked in auto mode */}
            <div className={`grid grid-cols-1 lg:grid-cols-2 gap-6 transition-opacity ${
                isLocked ? 'opacity-50 pointer-events-none' : ''
            }`}>
                {isLocked && (
                    <div className="lg:col-span-2 flex items-center justify-center gap-2 text-xs text-purple-400 bg-purple-500/5 border border-purple-500/20 rounded-xl py-2">
                        <Lock className="w-3.5 h-3.5" />
                        <span>Risk and entry controls are managed by SmartLayer in auto mode</span>
                    </div>
                )}
                <RiskParameters
                    baseStake={baseStake}
                    maxStake={maxStake}
                    stopLoss={stopLoss}
                    takeProfit={takeProfit}
                    cooldownMs={cooldownMs}
                    baseRiskPct={baseRiskPct}
                    dailyLossLimitPct={dailyLossLimitPct}
                    drawdownLimitPct={drawdownLimitPct}
                    maxConsecutiveLosses={maxConsecutiveLosses}
                    lossCooldownMs={lossCooldownMs}
                    setBotConfig={setBotConfig}
                />

                <EntryControls
                    entryProfileId={entryProfileId}
                    entryMode={entryMode}
                    entryTimeoutMs={entryTimeoutMs}
                    entryPollingMs={entryPollingMs}
                    entrySlippagePct={entrySlippagePct}
                    entryAggressiveness={entryAggressiveness}
                    entryMinEdgePct={entryMinEdgePct}
                    setEntryConfig={setEntryConfig}
                />
            </div>

            {!isLocked && (
                <BotTuningPanel
                    botId={selectedStrategy}
                    config={selectedBotConfig}
                    onUpdate={(patch) => setBotConfigFor(selectedStrategy, patch)}
                />
            )}

            <BotsPerformance
                totalProfitToday={totalProfitToday}
                totalLossToday={totalLossToday}
                netPnL={netPnL}
            />

            {/* Bot Detail Drawer */}
            {drawerBot && (
                <BotDetailDrawer bot={drawerBot} onClose={() => setDrawerBot(null)} />
            )}
        </div>
    );
}

export default function BotsPage() {
    return (
        <ErrorBoundary FallbackComponent={ErrorFallback}>
            <BotsContent />
        </ErrorBoundary>
    );
}
