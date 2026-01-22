'use client';

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

        try {
            const res = await fetch('/api/bot-runs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'start',
                    botId: selectedStrategy,
                    config: {
                        entry: {
                            profileId: entryProfileId,
                            mode: entryMode,
                            timeoutMs: entryTimeoutMs,
                            pollingMs: entryPollingMs,
                            slippagePct: entrySlippagePct,
                            aggressiveness: entryAggressiveness,
                            minEdgePct: entryMinEdgePct,
                        },
                        risk: {
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
                        },
                        strategy: selectedBotConfig,
                    },
                }),
            });
            const data = await res.json();
            if (data?.runId) {
                setActiveRunId(data.runId);
            }
        } catch (err) {
            console.error('Failed to start bot run', err);
        }

        setBotRunning(true);
        toast.success('Bot Started', {
            description: `Trading with ${selectedBot.name}`,
        });
    };

    const handleStopBot = async () => {
        try {
            await fetch('/api/bot-runs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'stop',
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
        <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-8">
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

                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
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
