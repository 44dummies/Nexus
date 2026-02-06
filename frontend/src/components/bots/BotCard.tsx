'use client';

import { BotProfile } from '@/lib/bot/catalog';
import { cn } from '@/lib/utils';
import { CheckCircle2 } from 'lucide-react';
import { EXECUTION_PROFILES } from '@/lib/bot/executionProfiles';

interface BotCardProps {
    profile: BotProfile;
    selected: boolean;
    onSelect: (id: string) => void;
}

const riskClasses: Record<BotProfile['risk'], string> = {
    Low: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    Medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
    High: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
};

const profileNameById = EXECUTION_PROFILES.reduce<Record<string, string>>((acc, profile) => {
    acc[profile.id] = profile.name;
    return acc;
}, {});

export function BotCard({ profile, selected, onSelect }: BotCardProps) {
    return (
        <button
            onClick={() => onSelect(profile.id)}
            className={cn(
                'group relative text-left rounded-2xl border transition-all p-5 h-full',
                'bg-card/70 border-border/60 hover:border-accent/50 hover:shadow-soft-lg',
                selected && 'border-accent ring-1 ring-accent/30 shadow-soft-lg'
            )}
        >
            {selected && (
                <div className="absolute top-4 right-4 text-accent">
                    <CheckCircle2 className="w-5 h-5" />
                </div>
            )}

            <div className="flex items-center gap-3 mb-4">
                <div className="h-10 w-10 rounded-xl bg-muted/60 flex items-center justify-center text-accent font-semibold">
                    {profile.name.split(' ').map(word => word[0]).slice(0, 2).join('')}
                </div>
                <div>
                    <p className="text-base font-semibold">{profile.name}</p>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className={cn('text-xs border px-2 py-0.5 rounded-full', riskClasses[profile.risk])}>
                            {profile.risk} Risk
                        </span>
                        <span className="text-xs border px-2 py-0.5 rounded-full border-border/60 text-muted-foreground">
                            {profileNameById[profile.executionProfileId] || 'Balanced'}
                        </span>
                    </div>
                </div>
            </div>

            <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
                {profile.summary}
            </p>

            <div className="flex flex-wrap gap-2 mb-4">
                {profile.tags.map((tag) => (
                    <span
                        key={tag}
                        className="text-[10px] uppercase tracking-wider px-2 py-1 rounded-full bg-muted/50 text-muted-foreground"
                    >
                        {tag}
                    </span>
                ))}
            </div>

            <div className="text-xs text-muted-foreground">
                <div className="flex justify-between">
                    <span>Market Fit</span>
                    <span className="text-foreground">{profile.marketFit}</span>
                </div>
                <div className="flex justify-between mt-1">
                    <span>Edge</span>
                    <span className="text-foreground">{profile.edge}</span>
                </div>
            </div>

            <div className="mt-4 text-[10px] uppercase tracking-widest text-muted-foreground">
                Tap for details
            </div>
        </button>
    );
}
