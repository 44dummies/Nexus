'use client';

import { useState } from 'react';
import { Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { getBotConfig } from '@/lib/bot/config';
import { useTradingStore } from '@/store/tradingStore';
import { toast } from 'sonner';

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
        selectedBotId,
        botConfigs,
        entryProfileId,
        entryMode,
        entryTimeoutMs,
        entryPollingMs,
        entrySlippagePct,
        entryAggressiveness,
        entryMinEdgePct,
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
        setBotRunning,
        setActiveRunId,
    } = useTradingStore();

    const handleStart = async () => {
        if (!isAuthorized) {
            toast.error('Not Connected', { description: 'Please connect to Deriv first' });
            return;
        }
        if (baseStake <= 0) {
            toast.error('Invalid Stake', { description: 'Base stake must be greater than 0' });
            return;
        }

        const selectedStrategy = selectedBotId || 'rsi';
        const selectedBotConfig = getBotConfig(selectedStrategy, botConfigs);

        setIsBusy(true);
        try {
            const res = await apiFetch('/api/bot-runs', {
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
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to start bot');
            }

            if (data?.runId) {
                setActiveRunId(data.runId);
            }
            setBotRunning(true);
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
            const res = await apiFetch('/api/bot-runs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'stop',
                    runId: activeRunId,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to stop bot');
            }
            setActiveRunId(null);
            setBotRunning(false);
            toast.info('Bot Stopped');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to stop bot';
            toast.error(message);
        } finally {
            setIsBusy(false);
        }
    };

    const buttonClass = botRunning
        ? 'bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 text-white'
        : 'bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white';

    return (
        <Button
            onClick={botRunning ? handleStop : handleStart}
            size={size}
            className={`${buttonClass} ${className}`}
            disabled={!isAuthorized || isBusy}
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
    );
}
