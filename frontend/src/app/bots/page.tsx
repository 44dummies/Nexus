'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
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
        setSelectedBotId,
        selectedBotId,
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
    } = useTradingStore();

    // Local state for market selection
    const [selectedMarket, setSelectedMarket] = useState('R_100');

    const selectedStrategy = selectedBotId || 'rsi';
    const selectedBot = BOT_CATALOG.find((bot) => bot.id === selectedStrategy) || BOT_CATALOG[0];
    const selectedBotConfig = getBotConfig(selectedStrategy, botConfigs);
    const selectedExecution = getExecutionProfile(selectedBot.executionProfileId);
    const handleSelectStrategy = (id: string) => {
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
    };

    const handleStartBot = async () => {
        if (!isAuthorized) {
            toast.error('Not Connected', {
                description: 'Please connect to Deriv first',
            });
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
            const res = await apiFetch('/api/bot-runs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'start-backend',
                    botId: selectedStrategy,
                    symbol: selectedMarket,
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
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const message = typeof data?.error === 'string' ? data.error : 'Failed to start bot';
                throw new Error(message);
            }
            if (data?.runId) {
                setActiveRunId(data.runId);
            }
            setBotRunning(true);
            toast.success('Bot Started', {
                description: `Trading with ${selectedBot.name}`,
            });
        } catch (err) {
            console.error('Failed to start bot run', err);
            const message = err instanceof Error ? err.message : 'Failed to start bot';
            toast.error(message);
            return;
        }
    };

    const handleStopBot = async () => {
        if (!activeRunId) {
            console.warn('No active run ID to stop');
            setBotRunning(false);
            return;
        }

        try {
            await apiFetch('/api/bot-runs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'stop-backend',
                    runId: activeRunId,
                }),
            });
        } catch (err) {
            console.error('Failed to stop bot run', err);
        } finally {
            setActiveRunId(null);
        }
        setBotRunning(false);
        toast.info('Bot Stopped', {
            description: 'Trading has been paused',
        });
    };

    const netPnL = totalProfitToday - totalLossToday;

    return (
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-8 space-y-8">
            <BotsHeader />

            <div className="grid grid-cols-1 lg:grid-cols-[2fr,1fr] gap-6">
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-lg font-semibold">Bot Hub</h2>
                            <p className="text-sm text-muted-foreground">Choose a bot profile. Only one runs at a time.</p>
                        </div>
                        <div className="text-xs text-muted-foreground uppercase tracking-widest">
                            {BOT_CATALOG.length} profiles
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                        {BOT_CATALOG.map((bot) => (
                            <BotCard
                                key={bot.id}
                                profile={bot}
                                selected={bot.id === selectedStrategy}
                                onSelect={handleSelectStrategy}
                            />
                        ))}
                    </div>
                </div>

                <div className="space-y-6">
                    <div className="glass-panel rounded-2xl p-6">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-lg font-semibold">Selected Bot</h3>
                            <span className="text-xs text-muted-foreground uppercase tracking-widest">Active</span>
                        </div>
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
                    </div>

                    {/* Market Selector */}
                    <div className="glass-panel rounded-2xl p-6">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-lg font-semibold">Market</h3>
                            <span className="text-xs text-muted-foreground uppercase tracking-widest">Symbol</span>
                        </div>
                        <select
                            value={selectedMarket}
                            onChange={(e) => setSelectedMarket(e.target.value)}
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
                            Selected: <span className="font-mono text-foreground">{selectedMarket}</span>
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

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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

            <BotTuningPanel
                botId={selectedStrategy}
                config={selectedBotConfig}
                onUpdate={(patch) => setBotConfigFor(selectedStrategy, patch)}
            />

            <BotsPerformance
                totalProfitToday={totalProfitToday}
                totalLossToday={totalLossToday}
                netPnL={netPnL}
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
