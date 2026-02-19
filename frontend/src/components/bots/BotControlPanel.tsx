'use client';

import { useState, useEffect } from 'react';
import { Square, Play, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTradingStore } from '@/store/tradingStore';

interface BotControlPanelProps {
    botRunning: boolean;
    isAuthorized: boolean;
    autoModeEnabled: boolean;
    onStartBot: () => void;
    onStopBot: () => void;
}

export function BotControlPanel({ botRunning, isAuthorized, autoModeEnabled, onStartBot, onStopBot }: BotControlPanelProps) {
    const cooldownUntil = useTradingStore((s) => s.cooldownUntil);
    const cooldownMs = useTradingStore((s) => s.cooldownMs);
    const [remainingSec, setRemainingSec] = useState<number>(0);

    useEffect(() => {
        if (!cooldownUntil || !botRunning) {
            setRemainingSec(0);
            return;
        }

        const tick = () => {
            const ms = cooldownUntil - Date.now();
            setRemainingSec(ms > 0 ? Math.ceil(ms / 1000) : 0);
        };
        tick();
        const id = setInterval(tick, 250);
        return () => clearInterval(id);
    }, [cooldownUntil, botRunning]);

    const isCooling = botRunning && remainingSec > 0;

    return (
        <div className="glass-panel rounded-2xl p-6">
            <h2 className="text-lg font-semibold mb-4">Bot Control</h2>

            <div className="flex items-center justify-between gap-4 mb-6">
                <div className="flex items-center gap-4">
                    <div className={`w-4 h-4 rounded-full ${isCooling
                        ? 'bg-amber-500 animate-pulse shadow-lg shadow-amber-500/50'
                        : botRunning
                            ? 'bg-emerald-500 animate-pulse shadow-lg shadow-emerald-500/50'
                            : 'bg-gray-500'
                        }`} />
                    <span className="text-lg font-medium">
                        {isCooling ? 'Cooldown' : botRunning ? 'Bot is Running' : 'Bot is Stopped'}
                    </span>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs uppercase tracking-widest ${autoModeEnabled ? 'bg-purple-500/15 text-purple-300' : 'bg-emerald-500/15 text-emerald-400'
                    }`}>
                    {autoModeEnabled ? 'SmartLayer' : 'Standard'}
                </span>
            </div>

            {/* Cooldown timer bar */}
            {isCooling && (
                <div className="mb-4 rounded-xl bg-amber-500/10 border border-amber-500/20 px-4 py-3 flex items-center gap-3">
                    <Timer className="w-5 h-5 text-amber-400 animate-spin" style={{ animationDuration: '3s' }} />
                    <div className="flex-1">
                        <p className="text-sm font-medium text-amber-300">
                            Cooling down — next trade in <span className="font-mono text-amber-200">{remainingSec}s</span>
                        </p>
                        <div className="mt-1.5 h-1 rounded-full bg-amber-900/40 overflow-hidden">
                            <div
                                className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-300"
                                style={{ width: `${Math.max(0, Math.min(100, (remainingSec / Math.max(1, cooldownMs / 1000)) * 100))}%` }}
                            />
                        </div>
                    </div>
                </div>
            )}

            <Button
                onClick={botRunning ? onStopBot : onStartBot}
                className={`w-full h-14 text-lg font-bold uppercase tracking-wider transition-all ${botRunning
                    ? 'bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 text-white'
                    : 'bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white'
                    }`}
                disabled={!isAuthorized}
            >
                {botRunning ? (
                    <>
                        <Square className="w-5 h-5 mr-2" />
                        Stop Bot
                    </>
                ) : (
                    <>
                        <Play className="w-5 h-5 mr-2" />
                        Start Bot
                    </>
                )}
            </Button>

            {!isAuthorized && (
                <p className="text-sm text-yellow-500 mt-3 text-center">
                    Please login from the Dashboard first
                </p>
            )}
        </div>
    );
}

