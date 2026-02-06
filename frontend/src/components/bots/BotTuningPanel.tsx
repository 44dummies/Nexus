'use client';

import { Settings2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { BotConfig, DurationUnit } from '@/lib/bot/config';

interface BotTuningPanelProps {
    botId: string;
    config: BotConfig;
    isLocked: boolean;
    onUpdate: (patch: Partial<BotConfig>) => void;
}

const durationOptions: { value: DurationUnit; label: string }[] = [
    { value: 't', label: 'Ticks' },
    { value: 's', label: 'Seconds' },
    { value: 'm', label: 'Minutes' },
    { value: 'h', label: 'Hours' },
    { value: 'd', label: 'Days' },
];

const normalizeNumber = (value: number, fallback: number, min = 0) => {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, value);
};

export function BotTuningPanel({ botId, config, isLocked, onUpdate }: BotTuningPanelProps) {
    return (
        <div className="glass-panel rounded-2xl p-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                        <Settings2 className="w-5 h-5 text-accent" />
                        Bot Tuning
                    </h2>
                    <p className="text-xs text-muted-foreground uppercase tracking-widest mt-1">
                        Per-bot thresholds and cadence
                    </p>
                </div>
                <span className="text-xs text-muted-foreground uppercase tracking-widest">
                    {botId}
                </span>
            </div>
            {isLocked && (
                <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 p-3 text-xs text-purple-200">
                    Bot tuning is locked while SmartLayer Auto Mode is active.
                </div>
            )}

            <fieldset disabled={isLocked} className={isLocked ? 'opacity-60' : ''}>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                        <Label className="text-muted-foreground text-sm uppercase tracking-wider">
                            Duration
                        </Label>
                        <Input
                            type="number"
                            min="1"
                            step="1"
                            value={config.duration ?? 5}
                            onChange={(e) => onUpdate({
                                duration: normalizeNumber(e.currentTarget.valueAsNumber, config.duration ?? 5, 1),
                            })}
                            className="bg-muted/50 border-border font-mono"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label className="text-muted-foreground text-sm uppercase tracking-wider">
                            Duration Unit
                        </Label>
                        <select
                            value={config.durationUnit ?? 't'}
                            onChange={(e) => onUpdate({ durationUnit: e.currentTarget.value as DurationUnit })}
                            className="w-full h-10 rounded-md bg-muted/50 border border-border px-3 text-sm"
                        >
                            {durationOptions.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="space-y-2">
                        <Label className="text-muted-foreground text-sm uppercase tracking-wider">
                            Cooldown (sec)
                        </Label>
                        <Input
                            type="number"
                            min="0"
                            step="1"
                            value={Math.round((config.cooldownMs ?? 10_000) / 1000)}
                            onChange={(e) => onUpdate({
                                cooldownMs: normalizeNumber(e.currentTarget.valueAsNumber, (config.cooldownMs ?? 10_000) / 1000, 0) * 1000,
                            })}
                            className="bg-muted/50 border-border font-mono"
                        />
                    </div>
                </div>

                {botId === 'rsi' && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Period</Label>
                            <Input
                                type="number"
                                min="2"
                                step="1"
                                value={config.rsiPeriod ?? 14}
                                onChange={(e) => onUpdate({ rsiPeriod: normalizeNumber(e.currentTarget.valueAsNumber, config.rsiPeriod ?? 14, 2) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Lower</Label>
                            <Input
                                type="number"
                                min="1"
                                max="50"
                                step="1"
                                value={config.rsiLower ?? 28}
                                onChange={(e) => onUpdate({ rsiLower: normalizeNumber(e.currentTarget.valueAsNumber, config.rsiLower ?? 28, 1) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Upper</Label>
                            <Input
                                type="number"
                                min="50"
                                max="99"
                                step="1"
                                value={config.rsiUpper ?? 72}
                                onChange={(e) => onUpdate({ rsiUpper: normalizeNumber(e.currentTarget.valueAsNumber, config.rsiUpper ?? 72, 50) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                    </div>
                )}

                {botId === 'trend-rider' && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">EMA Fast</Label>
                            <Input
                                type="number"
                                min="2"
                                step="1"
                                value={config.emaFast ?? 9}
                                onChange={(e) => onUpdate({ emaFast: normalizeNumber(e.currentTarget.valueAsNumber, config.emaFast ?? 9, 2) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">EMA Slow</Label>
                            <Input
                                type="number"
                                min="4"
                                step="1"
                                value={config.emaSlow ?? 26}
                                onChange={(e) => onUpdate({ emaSlow: normalizeNumber(e.currentTarget.valueAsNumber, config.emaSlow ?? 26, 4) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Period</Label>
                            <Input
                                type="number"
                                min="2"
                                step="1"
                                value={config.rsiPeriod ?? 14}
                                onChange={(e) => onUpdate({ rsiPeriod: normalizeNumber(e.currentTarget.valueAsNumber, config.rsiPeriod ?? 14, 2) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">Trend Strength</Label>
                            <Input
                                type="number"
                                min="0.1"
                                step="0.05"
                                value={config.trendStrengthMultiplier ?? 0.6}
                                onChange={(e) => onUpdate({ trendStrengthMultiplier: normalizeNumber(e.currentTarget.valueAsNumber, config.trendStrengthMultiplier ?? 0.6, 0.1) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Lower</Label>
                            <Input
                                type="number"
                                min="1"
                                max="50"
                                step="1"
                                value={config.trendRsiLower ?? 45}
                                onChange={(e) => onUpdate({ trendRsiLower: normalizeNumber(e.currentTarget.valueAsNumber, config.trendRsiLower ?? 45, 1) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Upper</Label>
                            <Input
                                type="number"
                                min="50"
                                max="99"
                                step="1"
                                value={config.trendRsiUpper ?? 55}
                                onChange={(e) => onUpdate({ trendRsiUpper: normalizeNumber(e.currentTarget.valueAsNumber, config.trendRsiUpper ?? 55, 50) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                    </div>
                )}

                {botId === 'breakout-atr' && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">ATR Fast</Label>
                            <Input
                                type="number"
                                min="2"
                                step="1"
                                value={config.atrFast ?? 14}
                                onChange={(e) => onUpdate({ atrFast: normalizeNumber(e.currentTarget.valueAsNumber, config.atrFast ?? 14, 2) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">ATR Slow</Label>
                            <Input
                                type="number"
                                min="5"
                                step="1"
                                value={config.atrSlow ?? 42}
                                onChange={(e) => onUpdate({ atrSlow: normalizeNumber(e.currentTarget.valueAsNumber, config.atrSlow ?? 42, 5) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">Breakout Lookback</Label>
                            <Input
                                type="number"
                                min="5"
                                step="1"
                                value={config.breakoutLookback ?? 20}
                                onChange={(e) => onUpdate({ breakoutLookback: normalizeNumber(e.currentTarget.valueAsNumber, config.breakoutLookback ?? 20, 5) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">Buffer Multiplier</Label>
                            <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={config.breakoutBufferMultiplier ?? 0.18}
                                onChange={(e) => onUpdate({ breakoutBufferMultiplier: normalizeNumber(e.currentTarget.valueAsNumber, config.breakoutBufferMultiplier ?? 0.18, 0) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">Expansion Multiplier</Label>
                            <Input
                                type="number"
                                min="1"
                                step="0.01"
                                value={config.breakoutExpansionMultiplier ?? 1.15}
                                onChange={(e) => onUpdate({ breakoutExpansionMultiplier: normalizeNumber(e.currentTarget.valueAsNumber, config.breakoutExpansionMultiplier ?? 1.15, 1) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                    </div>
                )}

                {botId === 'capital-guard' && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">ATR Fast</Label>
                            <Input
                                type="number"
                                min="2"
                                step="1"
                                value={config.atrFast ?? 14}
                                onChange={(e) => onUpdate({ atrFast: normalizeNumber(e.currentTarget.valueAsNumber, config.atrFast ?? 14, 2) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">ATR Slow</Label>
                            <Input
                                type="number"
                                min="5"
                                step="1"
                                value={config.atrSlow ?? 55}
                                onChange={(e) => onUpdate({ atrSlow: normalizeNumber(e.currentTarget.valueAsNumber, config.atrSlow ?? 55, 5) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">SMA Period</Label>
                            <Input
                                type="number"
                                min="5"
                                step="1"
                                value={config.smaPeriod ?? 30}
                                onChange={(e) => onUpdate({ smaPeriod: normalizeNumber(e.currentTarget.valueAsNumber, config.smaPeriod ?? 30, 5) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Period</Label>
                            <Input
                                type="number"
                                min="2"
                                step="1"
                                value={config.rsiPeriod ?? 14}
                                onChange={(e) => onUpdate({ rsiPeriod: normalizeNumber(e.currentTarget.valueAsNumber, config.rsiPeriod ?? 14, 2) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Lower</Label>
                            <Input
                                type="number"
                                min="1"
                                max="50"
                                step="1"
                                value={config.capitalRsiLower ?? 25}
                                onChange={(e) => onUpdate({ capitalRsiLower: normalizeNumber(e.currentTarget.valueAsNumber, config.capitalRsiLower ?? 25, 1) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Upper</Label>
                            <Input
                                type="number"
                                min="50"
                                max="99"
                                step="1"
                                value={config.capitalRsiUpper ?? 75}
                                onChange={(e) => onUpdate({ capitalRsiUpper: normalizeNumber(e.currentTarget.valueAsNumber, config.capitalRsiUpper ?? 75, 50) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">Calm ATR Mult</Label>
                            <Input
                                type="number"
                                min="0.5"
                                max="1.5"
                                step="0.01"
                                value={config.capitalCalmMultiplier ?? 0.85}
                                onChange={(e) => onUpdate({ capitalCalmMultiplier: normalizeNumber(e.currentTarget.valueAsNumber, config.capitalCalmMultiplier ?? 0.85, 0.1) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">Mean Distance Mult</Label>
                            <Input
                                type="number"
                                min="0.5"
                                max="2"
                                step="0.05"
                                value={config.capitalMeanDistanceMultiplier ?? 1.0}
                                onChange={(e) => onUpdate({ capitalMeanDistanceMultiplier: normalizeNumber(e.currentTarget.valueAsNumber, config.capitalMeanDistanceMultiplier ?? 1.0, 0.5) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                    </div>
                )}

                {botId === 'recovery-lite' && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Period</Label>
                            <Input
                                type="number"
                                min="2"
                                step="1"
                                value={config.rsiPeriod ?? 14}
                                onChange={(e) => onUpdate({ rsiPeriod: normalizeNumber(e.currentTarget.valueAsNumber, config.rsiPeriod ?? 14, 2) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Lower</Label>
                            <Input
                                type="number"
                                min="1"
                                max="50"
                                step="1"
                                value={config.recoveryRsiLower ?? 30}
                                onChange={(e) => onUpdate({ recoveryRsiLower: normalizeNumber(e.currentTarget.valueAsNumber, config.recoveryRsiLower ?? 30, 1) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">RSI Upper</Label>
                            <Input
                                type="number"
                                min="50"
                                max="99"
                                step="1"
                                value={config.recoveryRsiUpper ?? 70}
                                onChange={(e) => onUpdate({ recoveryRsiUpper: normalizeNumber(e.currentTarget.valueAsNumber, config.recoveryRsiUpper ?? 70, 50) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">Max Loss Streak</Label>
                            <Input
                                type="number"
                                min="0"
                                step="1"
                                value={config.recoveryMaxLossStreak ?? 3}
                                onChange={(e) => onUpdate({ recoveryMaxLossStreak: normalizeNumber(e.currentTarget.valueAsNumber, config.recoveryMaxLossStreak ?? 3, 0) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">Step Multiplier</Label>
                            <Input
                                type="number"
                                min="0"
                                step="0.05"
                                value={config.recoveryStepMultiplier ?? 0.3}
                                onChange={(e) => onUpdate({ recoveryStepMultiplier: normalizeNumber(e.currentTarget.valueAsNumber, config.recoveryStepMultiplier ?? 0.3, 0) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-muted-foreground text-sm uppercase tracking-wider">Max Steps</Label>
                            <Input
                                type="number"
                                min="0"
                                step="1"
                                value={config.recoveryMaxSteps ?? 2}
                                onChange={(e) => onUpdate({ recoveryMaxSteps: normalizeNumber(e.currentTarget.valueAsNumber, config.recoveryMaxSteps ?? 2, 0) })}
                                className="bg-muted/50 border-border font-mono"
                            />
                        </div>
                    </div>
                )}
            </fieldset>
        </div>
    );
}
