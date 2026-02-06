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
import BotDetailsDialog from '@/components/bots/BotDetailsDialog';
import { BOT_CATALOG } from '@/lib/bot/catalog';
import { getBotConfig } from '@/lib/bot/config';
import { getExecutionProfile } from '@/lib/bot/executionProfiles';
import { getBackendRunStatus, startBackendRun, stopBackendRun } from '@/lib/bot/engine';
import { useMarketCatalog } from '@/hooks/useMarketCatalog';
import { Brain, Lock } from 'lucide-react';

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

    const [detailBot, setDetailBot] = useState<(typeof BOT_CATALOG)[number] | null>(null);
    const { markets, loading: marketsLoading, error: marketsError } = useMarketCatalog();

    const marketGroups = markets.reduce((acc, market) => {
        if (!acc[market.category]) acc[market.category] = [];
        acc[market.category].push(market);
        return acc;
    }, {} as Record<string, typeof markets>);

    const marketCategoryLabels: Record<string, string> = {
        synthetic: 'Synthetics',
        crash_boom: 'Crash/Boom',
        jump: 'Jump',
        forex: 'Forex',
        crypto: 'Crypto',
        commodities: 'Commodities',
    };

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
                        isLocked ? 'opacity-70' : ''
                    }`}>
                        {BOT_CATALOG.map((bot) => (
                            <div key={bot.id} className="relative group">
                                <BotCard
                                    profile={bot}
                                    selected={bot.id === selectedStrategy}
                                    onSelect={() => {
                                        handleSelectStrategy(bot.id);
                                        setDetailBot(bot);
                                    }}
                                />
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
                            disabled={botRunning || marketsLoading}
                            className="w-full p-3 rounded-xl bg-background/50 border border-border/50 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {marketsLoading && <option>Loading markets…</option>}
                            {!marketsLoading && marketsError && <option>Markets unavailable</option>}
                            {!marketsLoading && !marketsError && Object.entries(marketGroups).map(([category, group]) => (
                                <optgroup key={category} label={marketCategoryLabels[category] ?? category}>
                                    {group.map((market) => (
                                        <option key={market.symbol} value={market.symbol}>
                                            {market.displayName}
                                        </option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                        <p className="text-xs text-muted-foreground mt-2">
                            {marketsError ? marketsError : (
                                <>
                                    Selected: <span className="font-mono text-foreground">{selectedSymbol ?? '—'}</span>
                                </>
                            )}
                        </p>
                    </div>

                    <BotControlPanel
                        botRunning={botRunning}
                        isAuthorized={isAuthorized}
                        autoModeEnabled={autoModeEnabled}
                        onStartBot={handleStartBot}
                        onStopBot={handleStopBot}
                    />
                </div>
            </div>

            {/* Risk & Entry Controls — locked in auto mode */}
            <div className={`grid grid-cols-1 lg:grid-cols-2 gap-6 transition-opacity ${
                isLocked ? 'opacity-90' : ''
            }`}>
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
                    isLocked={isLocked}
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
                    isLocked={isLocked}
                    setEntryConfig={setEntryConfig}
                />
            </div>

            <BotTuningPanel
                botId={selectedStrategy}
                config={selectedBotConfig}
                isLocked={isLocked}
                onUpdate={(patch) => setBotConfigFor(selectedStrategy, patch)}
            />

            <BotsPerformance
                totalProfitToday={totalProfitToday}
                totalLossToday={totalLossToday}
                netPnL={netPnL}
            />

            <BotDetailsDialog
                open={!!detailBot}
                bot={detailBot}
                isLocked={isLocked}
                isSelected={detailBot?.id === selectedStrategy}
                onClose={() => setDetailBot(null)}
                onSelect={(id) => {
                    handleSelectStrategy(id);
                    setDetailBot(null);
                }}
            />
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
