'use client';

import { useEffect, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getBotConfig } from '@/lib/bot/config';
import { useTradingStore } from '@/store/tradingStore';
import { toast } from 'sonner';
import { getBackendRunStatus, startBackendRun, stopBackendRun } from '@/lib/bot/engine';

interface BotRunToggleProps {
    size?: 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm' | 'icon-lg';
    className?: string;
}

export function BotRunToggle({ size = 'sm', className = '' }: BotRunToggleProps) {
    const [isBusy, setIsBusy] = useState(false);
    const {
        botRunning,
        isAuthorized,
        activeRunId,
        activeAccountId,
        selectedBotId,
        selectedSymbol,
        botConfigs,
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
        entryProfileId,
        entryMode,
        entryTimeoutMs,
        entryPollingMs,
        entrySlippagePct,
        entryAggressiveness,
        entryMinEdgePct,
        setBotRunning,
        setActiveRunId,
        setSelectedBotId,
        setSelectedSymbol,
    } = useTradingStore();

    const selectedStrategy = selectedBotId || 'rsi';
    const selectedBotConfig = getBotConfig(selectedStrategy, botConfigs);
    const handleStart = async () => {
        if (!isAuthorized) {
            toast.error('Not Connected', { description: 'Please connect to Deriv first' });
            return;
        }
        if (!selectedSymbol) {
            toast.error('Select market first');
            return;
        }
        if (baseStake <= 0) {
            toast.error('Invalid Stake', { description: 'Base stake must be greater than 0' });
            return;
        }

        const duration = selectedBotConfig.duration ?? 5;
        const durationUnit = selectedBotConfig.durationUnit ?? 't';
        const botCooldownMs = selectedBotConfig.cooldownMs ?? cooldownMs;

        setIsBusy(true);
        try {
            const { botRunId } = await startBackendRun({
                action: 'start-backend',
                botId: selectedStrategy,
                symbol: selectedSymbol,
                stake: baseStake,
                maxStake,
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
            const status = await getBackendRunStatus(botRunId);
            if (!status.active || !status.botRunId) {
                throw new Error('Backend did not start the bot');
            }
            setActiveRunId(status.botRunId);
            setBotRunning(true);
            if (status.strategyId) {
                setSelectedBotId(status.strategyId);
            }
            if (status.symbol) {
                setSelectedSymbol(status.symbol);
            }
            toast.success('Bot Started');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to start bot';
            toast.error(message);
        } finally {
            setIsBusy(false);
        }
    };

    const handleStop = async () => {
        setIsBusy(true);
        try {
            await stopBackendRun(activeRunId ?? undefined);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to stop bot';
            toast.error(message);
        }
        try {
            const status = await getBackendRunStatus();
            if (!status.active) {
                setActiveRunId(null);
                setBotRunning(false);
                toast.info('Bot Stopped');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to sync bot status';
            toast.error(message);
        } finally {
            setIsBusy(false);
        }
    };

    useEffect(() => {
        if (!isAuthorized || !activeAccountId) return;
        let isMounted = true;
        getBackendRunStatus()
            .then((status) => {
                if (!isMounted) return;
                if (status.active && status.botRunId) {
                    setActiveRunId(status.botRunId);
                    setBotRunning(true);
                    if (status.strategyId) {
                        setSelectedBotId(status.strategyId);
                    }
                    if (status.symbol) {
                        setSelectedSymbol(status.symbol);
                    }
                } else if (!status.active) {
                    setActiveRunId(null);
                    setBotRunning(false);
                }
            })
            .catch((error) => {
                if (!isMounted) return;
                const message = error instanceof Error ? error.message : 'Failed to sync bot status';
                toast.error(message);
            });
        return () => {
            isMounted = false;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store actions are stable references
    }, [isAuthorized, activeAccountId]);

    const canStart = Boolean(selectedSymbol && selectedBotConfig);
    const disableButton = !isAuthorized || isBusy || (!botRunning && !canStart);

    const buttonClass = botRunning
        ? 'bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 text-white'
        : 'bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white';

    return (
        <div className="flex items-center gap-2">
            <Button
                onClick={botRunning ? handleStop : handleStart}
                size={size}
                className={`${buttonClass} ${className}`}
                disabled={disableButton}
            >
                {botRunning ? (
                    <>
                        <Square className="w-4 h-4" />
                        Stop Bot
                    </>
                ) : (
                    <>
                        <Play className="w-4 h-4" />
                        Start Bot
                    </>
                )}
            </Button>
            {!botRunning && !canStart && (
                <span className="text-xs text-muted-foreground">Select market first</span>
            )}
        </div>
    );
}
