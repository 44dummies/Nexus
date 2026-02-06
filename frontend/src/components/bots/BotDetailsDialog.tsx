'use client';

import { useEffect, useId, useRef } from 'react';
import { X, Shield, Zap, Activity } from 'lucide-react';
import type { BotProfile } from '@/lib/bot/catalog';
import { getExecutionProfile } from '@/lib/bot/executionProfiles';
import { getStrategyDetail } from '@/lib/bot/strategyDetails';
import { Button } from '@/components/ui/button';

interface BotDetailsDialogProps {
    open: boolean;
    bot: BotProfile | null;
    isLocked: boolean;
    isSelected: boolean;
    onClose: () => void;
    onSelect: (id: string) => void;
}

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

export default function BotDetailsDialog({
    open,
    bot,
    isLocked,
    isSelected,
    onClose,
    onSelect,
}: BotDetailsDialogProps) {
    const dialogId = useId();
    const panelRef = useRef<HTMLDivElement | null>(null);
    const closeRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const previousActive = document.activeElement as HTMLElement | null;
        const panel = panelRef.current;

        const focusFirst = () => {
            const focusable = panel?.querySelectorAll<HTMLElement>(FOCUSABLE);
            if (focusable && focusable.length > 0) {
                focusable[0].focus();
            } else {
                closeRef.current?.focus();
            }
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
                return;
            }

            if (event.key !== 'Tab') return;
            const focusable = panel?.querySelectorAll<HTMLElement>(FOCUSABLE);
            if (!focusable || focusable.length === 0) return;

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        document.body.style.overflow = 'hidden';
        focusFirst();

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = '';
            previousActive?.focus();
        };
    }, [open, onClose]);

    if (!open || !bot) return null;

    const execution = getExecutionProfile(bot.executionProfileId);
    const detail = getStrategyDetail(bot.id, bot.summary);

    return (
        <div className="fixed inset-0 z-50 flex justify-end">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={`${dialogId}-title`}
                className="relative w-full sm:max-w-lg h-full bg-background border-l border-border shadow-2xl overflow-y-auto animate-in slide-in-from-right"
            >
                <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-border bg-background/90 backdrop-blur">
                    <div>
                        <h3 id={`${dialogId}-title`} className="text-lg font-semibold">
                            {bot.name}
                        </h3>
                        <p className="text-xs text-muted-foreground uppercase tracking-widest mt-1">
                            {bot.risk} risk · {execution.name}
                        </p>
                    </div>
                    <button
                        ref={closeRef}
                        onClick={onClose}
                        className="flex items-center justify-center w-11 h-11 rounded-xl hover:bg-muted transition-colors"
                        aria-label="Close strategy details"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-4 sm:p-6 space-y-6">
                    <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <p className="text-xs text-muted-foreground uppercase tracking-widest">Strategy Summary</p>
                                <p className="text-sm text-foreground mt-1">{detail.summary}</p>
                            </div>
                            <span className={`px-3 py-1 rounded-full text-xs uppercase tracking-widest ${
                                isLocked ? 'bg-purple-500/20 text-purple-300' : 'bg-emerald-500/20 text-emerald-400'
                            }`}>
                                {isLocked ? 'SmartLayer' : 'Standard'}
                            </span>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                        <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                            <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
                                <Activity className="w-3.5 h-3.5 text-accent" />
                                Market fit
                            </div>
                            <p className="mt-2 text-sm font-medium">{bot.marketFit}</p>
                        </div>
                        <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                            <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
                                <Zap className="w-3.5 h-3.5 text-amber-400" />
                                Edge
                            </div>
                            <p className="mt-2 text-sm font-medium">{bot.edge}</p>
                        </div>
                        <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                            <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
                                <Shield className="w-3.5 h-3.5 text-blue-400" />
                                Execution profile
                            </div>
                            <p className="mt-2 text-sm font-medium">{execution.name}</p>
                        </div>
                    </div>

                    {detail.rules.length > 0 && (
                        <div>
                            <h4 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
                                Decision rules
                            </h4>
                            <ul className="space-y-2 text-sm text-muted-foreground">
                                {detail.rules.map((rule, index) => (
                                    <li key={index} className="flex gap-2">
                                        <span className="text-accent font-semibold">{index + 1}.</span>
                                        <span>{rule}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {detail.visuals.length > 0 && (
                        <div>
                            <h4 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
                                Visual examples
                            </h4>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {detail.visuals.map((visual) => (
                                    <div key={visual.id} className="rounded-xl border border-border/60 bg-muted/20 p-3">
                                        <div className="text-xs font-semibold mb-2">{visual.title}</div>
                                        <div className="text-foreground/70">{visual.svg}</div>
                                        <p className="mt-2 text-xs text-muted-foreground">{visual.description}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="flex flex-wrap items-center gap-3 pt-2">
                        {!isLocked && (
                            <Button
                                onClick={() => onSelect(bot.id)}
                                variant={isSelected ? 'secondary' : 'default'}
                                className="min-w-[160px]"
                            >
                                {isSelected ? 'Selected' : 'Use Strategy'}
                            </Button>
                        )}
                        <button
                            onClick={onClose}
                            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                        >
                            Close
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
