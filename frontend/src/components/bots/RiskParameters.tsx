'use client';

import { AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BotConfig } from '@/lib/validation';

interface RiskParametersProps {
    baseStake: number;
    maxStake: number;
    stopLoss: number;
    takeProfit: number;
    cooldownMs: number;
    baseRiskPct: number;
    dailyLossLimitPct: number;
    drawdownLimitPct: number;
    maxConsecutiveLosses: number;
    lossCooldownMs: number;
    isLocked: boolean;
    setBotConfig: (config: Partial<Pick<BotConfig,
        'baseStake'
        | 'maxStake'
        | 'stopLoss'
        | 'takeProfit'
        | 'cooldownMs'
        | 'baseRiskPct'
        | 'dailyLossLimitPct'
        | 'drawdownLimitPct'
        | 'maxConsecutiveLosses'
        | 'lossCooldownMs'
    >>) => void;
}

export function RiskParameters({
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
    isLocked,
    setBotConfig,
}: RiskParametersProps) {
    const autoManaged = isLocked;
    return (
        <div className="glass-panel rounded-2xl p-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-yellow-500" />
                Risk Parameters
            </h2>
            {autoManaged && (
                <div className="mb-4 rounded-xl border border-purple-500/30 bg-purple-500/10 p-3 text-xs text-purple-200">
                    SmartLayer is managing risk caps. You can still adjust Stake, Stop Loss, and Take Profit.
                </div>
            )}

            <div className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="base-stake" className="text-muted-foreground text-sm uppercase tracking-wider">
                        Base Stake ($)
                    </Label>
                    <Input
                        id="base-stake"
                        type="number"
                        min="0"
                        step="0.01"
                        value={baseStake}
                        onChange={(e) => setBotConfig({ baseStake: Math.max(0, e.currentTarget.valueAsNumber || 0) })}
                        className="bg-muted/50 border-border font-mono text-lg"
                    />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="max-stake" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Max Stake ($)
                        </Label>
                        <Input
                            id="max-stake"
                            type="number"
                            min="0"
                            step="0.01"
                            value={maxStake}
                            onChange={(e) => setBotConfig({ maxStake: Math.max(0, e.currentTarget.valueAsNumber || 0) })}
                            className="bg-muted/50 border-border font-mono"
                            disabled={autoManaged}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="stop-loss" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Stop Loss ($)
                        </Label>
                        <Input
                            id="stop-loss"
                            type="number"
                            min="0"
                            step="0.01"
                            value={stopLoss}
                            onChange={(e) => setBotConfig({ stopLoss: Math.max(0, e.currentTarget.valueAsNumber || 0) })}
                            className="bg-muted/50 border-red-500/30 font-mono"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="take-profit" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Take Profit ($)
                        </Label>
                        <Input
                            id="take-profit"
                            type="number"
                            min="0"
                            step="0.01"
                            value={takeProfit}
                            onChange={(e) => setBotConfig({ takeProfit: Math.max(0, e.currentTarget.valueAsNumber || 0) })}
                            className="bg-muted/50 border-emerald-500/30 font-mono"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="cooldown" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Global Cooldown (sec)
                        </Label>
                        <Input
                            id="cooldown"
                            type="number"
                            min="0"
                            step="1"
                            value={Math.round(cooldownMs / 1000)}
                            onChange={(e) => {
                                const seconds = Math.max(0, e.currentTarget.valueAsNumber || 0);
                                setBotConfig({ cooldownMs: seconds * 1000 });
                            }}
                            className="bg-muted/50 border-border font-mono"
                            disabled={autoManaged}
                        />
                        <p className="text-[11px] text-muted-foreground">Per-bot cooldowns override this default.</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-border/60">
                    <div className="space-y-2">
                        <Label htmlFor="risk-per-trade" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Risk Per Trade (%)
                        </Label>
                        <Input
                            id="risk-per-trade"
                            type="number"
                            min="0"
                            step="0.05"
                            value={baseRiskPct}
                            onChange={(e) => setBotConfig({ baseRiskPct: Math.max(0, e.currentTarget.valueAsNumber || 0) })}
                            className="bg-muted/50 border-border font-mono"
                            disabled={autoManaged}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="daily-loss" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Daily Loss Cap (%)
                        </Label>
                        <Input
                            id="daily-loss"
                            type="number"
                            min="0"
                            step="0.1"
                            value={dailyLossLimitPct}
                            onChange={(e) => setBotConfig({ dailyLossLimitPct: Math.max(0, e.currentTarget.valueAsNumber || 0) })}
                            className="bg-muted/50 border-border font-mono"
                            disabled={autoManaged}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="drawdown-cap" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Drawdown Cap (%)
                        </Label>
                        <Input
                            id="drawdown-cap"
                            type="number"
                            min="0"
                            step="0.1"
                            value={drawdownLimitPct}
                            onChange={(e) => setBotConfig({ drawdownLimitPct: Math.max(0, e.currentTarget.valueAsNumber || 0) })}
                            className="bg-muted/50 border-border font-mono"
                            disabled={autoManaged}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="max-losses" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Max Losses
                        </Label>
                        <Input
                            id="max-losses"
                            type="number"
                            min="1"
                            step="1"
                            value={maxConsecutiveLosses}
                            onChange={(e) => setBotConfig({ maxConsecutiveLosses: Math.max(1, e.currentTarget.valueAsNumber || 1) })}
                            className="bg-muted/50 border-border font-mono"
                            disabled={autoManaged}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="loss-cooldown" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Loss Cooldown (min)
                        </Label>
                        <Input
                            id="loss-cooldown"
                            type="number"
                            min="1"
                            step="5"
                            value={Math.round(lossCooldownMs / 60000)}
                            onChange={(e) => {
                                const minutes = Math.max(1, e.currentTarget.valueAsNumber || 1);
                                setBotConfig({ lossCooldownMs: minutes * 60000 });
                            }}
                            className="bg-muted/50 border-border font-mono"
                            disabled={autoManaged}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
