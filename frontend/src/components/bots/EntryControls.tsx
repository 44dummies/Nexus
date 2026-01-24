'use client';

import { Sliders } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { EXECUTION_PROFILES } from '@/lib/bot/executionProfiles';

interface EntryControlsProps {
    entryProfileId: string | null;
    entryMode: 'HYBRID_LIMIT_MARKET' | 'MARKET';
    entryTimeoutMs: number;
    entryPollingMs: number;
    entrySlippagePct: number;
    entryAggressiveness: number;
    entryMinEdgePct: number;
    setEntryConfig: (config: Partial<{
        entryProfileId: string | null;
        entryMode: 'HYBRID_LIMIT_MARKET' | 'MARKET';
        entryTimeoutMs: number;
        entryPollingMs: number;
        entrySlippagePct: number;
        entryAggressiveness: number;
        entryMinEdgePct: number;
    }>) => void;
}

export function EntryControls({
    entryProfileId,
    entryMode,
    entryTimeoutMs,
    entryPollingMs,
    entrySlippagePct,
    entryAggressiveness,
    entryMinEdgePct,
    setEntryConfig,
}: EntryControlsProps) {
    return (
        <div className="glass-panel rounded-2xl p-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Sliders className="w-5 h-5 text-accent" />
                Entry Logic
            </h2>

            <div className="space-y-4">
                <div className="space-y-2">
                    <Label className="text-muted-foreground text-sm uppercase tracking-wider">
                        Execution Profile
                    </Label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                        {EXECUTION_PROFILES.map((profile) => (
                            <button
                                key={profile.id}
                                onClick={() => setEntryConfig({
                                    entryProfileId: profile.id,
                                    entryTimeoutMs: profile.defaults.entryTimeoutMs,
                                    entryPollingMs: profile.defaults.entryPollingMs,
                                    entrySlippagePct: profile.defaults.entrySlippagePct,
                                    entryAggressiveness: profile.defaults.entryAggressiveness,
                                    entryMinEdgePct: profile.defaults.entryMinEdgePct,
                                })}
                                className={`text-left px-3 py-2 rounded-lg border transition-all ${entryProfileId === profile.id
                                    ? 'border-accent bg-accent/10 text-accent'
                                    : 'border-border bg-muted/30 text-muted-foreground hover:border-accent/50'
                                    }`}
                            >
                                <div className="text-sm font-medium">{profile.name}</div>
                                <div className="text-xs text-muted-foreground">{profile.summary}</div>
                            </button>
                        ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Profiles set defaults; you can fine tune below.
                    </p>
                </div>

                <div className="space-y-2">
                    <Label className="text-muted-foreground text-sm uppercase tracking-wider">
                        Entry Mode
                    </Label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <button
                            onClick={() => setEntryConfig({ entryMode: 'HYBRID_LIMIT_MARKET' })}
                            className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-all ${entryMode === 'HYBRID_LIMIT_MARKET'
                                ? 'border-accent bg-accent/10 text-accent'
                                : 'border-border bg-muted/30 text-muted-foreground hover:border-accent/50'
                                }`}
                        >
                            Hybrid Limit {'->'} Market
                        </button>
                        <button
                            onClick={() => setEntryConfig({ entryMode: 'MARKET' })}
                            className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-all ${entryMode === 'MARKET'
                                ? 'border-accent bg-accent/10 text-accent'
                                : 'border-border bg-muted/30 text-muted-foreground hover:border-accent/50'
                                }`}
                        >
                            Market Only
                        </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Hybrid waits for a better price; if not filled, it falls back to market.
                    </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="entry-timeout" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Limit Timeout (ms)
                        </Label>
                        <Input
                            id="entry-timeout"
                            type="number"
                            min="200"
                            step="50"
                            value={entryTimeoutMs}
                            onChange={(e) => setEntryConfig({ entryTimeoutMs: Math.max(200, e.currentTarget.valueAsNumber || 0) })}
                            className="bg-muted/50 border-border font-mono"
                            disabled={entryMode === 'MARKET'}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="entry-polling" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Polling Interval (ms)
                        </Label>
                        <Input
                            id="entry-polling"
                            type="number"
                            min="50"
                            step="50"
                            value={entryPollingMs}
                            onChange={(e) => setEntryConfig({ entryPollingMs: Math.max(50, e.currentTarget.valueAsNumber || 0) })}
                            className="bg-muted/50 border-border font-mono"
                            disabled={entryMode === 'MARKET'}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="entry-slippage" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Slippage Tolerance (%)
                        </Label>
                        <Input
                            id="entry-slippage"
                            type="number"
                            min="0"
                            step="0.01"
                            value={entrySlippagePct}
                            onChange={(e) => setEntryConfig({ entrySlippagePct: Math.max(0, e.currentTarget.valueAsNumber || 0) })}
                            className="bg-muted/50 border-border font-mono"
                            disabled={entryMode === 'MARKET'}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="entry-min-edge" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Min Edge (%)
                        </Label>
                        <Input
                            id="entry-min-edge"
                            type="number"
                            min="0"
                            step="0.01"
                            value={entryMinEdgePct}
                            onChange={(e) => setEntryConfig({ entryMinEdgePct: Math.max(0, e.currentTarget.valueAsNumber || 0) })}
                            className="bg-muted/50 border-border font-mono"
                            disabled={entryMode === 'MARKET'}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="entry-aggressiveness" className="text-muted-foreground text-sm uppercase tracking-wider">
                            Aggressiveness (0-1)
                        </Label>
                        <Input
                            id="entry-aggressiveness"
                            type="number"
                            min="0"
                            max="1"
                            step="0.05"
                            value={entryAggressiveness}
                            onChange={(e) => setEntryConfig({ entryAggressiveness: Math.min(1, Math.max(0, e.currentTarget.valueAsNumber || 0)) })}
                            className="bg-muted/50 border-border font-mono"
                            disabled={entryMode === 'MARKET'}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
