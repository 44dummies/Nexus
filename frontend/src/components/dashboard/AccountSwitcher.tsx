'use client';

import { useTradingStore } from '@/store/tradingStore';
import { ChevronDown, Circle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { apiFetch } from '@/lib/api';

interface AccountSwitcherProps {
    compact?: boolean;
}

export default function AccountSwitcher({ compact = false }: AccountSwitcherProps) {
    const { accounts, activeAccountId, switchAccount } = useTradingStore();
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const firstItemRef = useRef<HTMLButtonElement | null>(null);

    const activeAccount = accounts.find(a => a.id === activeAccountId);

    // All hooks MUST be called before any conditional return (React rules of hooks)
    useEffect(() => {
        if (!isOpen) return;
        const handleClick = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [isOpen]);

    useEffect(() => {
        if (isOpen) {
            firstItemRef.current?.focus();
        }
    }, [isOpen]);

    // Early return AFTER all hooks — fixes React error #310
    // "Rendered more hooks than during the previous render"
    if (accounts.length <= 1) return null;

    return (
        <div ref={containerRef} className="relative z-[999] isolate">
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-controls="account-switcher-menu"
                aria-label={compact ? `Switch account (active: ${activeAccount?.id ?? 'unknown'})` : undefined}
                className={`flex items-center gap-2 rounded-lg bg-muted/30 hover:bg-muted/50 border border-border/70 shadow-soft transition-colors ${
                    compact ? 'h-11 w-11 justify-center p-0' : 'px-3 py-2'
                }`}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setIsOpen(true);
                    }
                }}
            >
                <Circle
                    className={`w-2 h-2 fill-current ${activeAccount?.type === 'real' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}
                />
                {!compact && (
                    <>
                        <span className="font-mono text-sm">{activeAccount?.id}</span>
                        <span className="text-xs text-muted-foreground uppercase">{activeAccount?.type}</span>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </>
                )}
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="absolute top-full mt-2 right-0 w-64 glass-panel rounded-xl overflow-hidden shadow-soft-lg ring-1 ring-border/40 z-[1000]"
                        id="account-switcher-menu"
                        role="menu"
                        aria-label="Switch account"
                    >
                        <div className="max-h-64 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-border/60">
                            <div className="text-xs text-muted-foreground uppercase tracking-widest px-3 py-2">
                                Switch Account
                            </div>
                            {accounts.map((account) => (
                                <button
                                    key={account.id}
                                    ref={account.id === accounts[0]?.id ? firstItemRef : undefined}
                                    onClick={async () => {
                                        if (account.type === 'real') {
                                            const confirmed = window.confirm('Switch to REAL account? This will place live trades.');
                                            if (!confirmed) return;
                                        }

                                        try {
                                            const res = await apiFetch('/api/auth/session', {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({
                                                    action: 'set-active-account',
                                                    accountId: account.id,
                                                    accountType: account.type,
                                                    currency: account.currency,
                                                }),
                                            });

                                            if (!res.ok) {
                                                throw new Error('Account switch failed');
                                            }

                                            switchAccount(account.id);
                                            setIsOpen(false);
                                        } catch (err) {
                                            console.error(err);
                                        }
                                    }}
                                    role="menuitem"
                                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${account.id === activeAccountId
                                        ? 'bg-accent/10 text-accent'
                                        : 'hover:bg-muted/40 text-foreground'
                                        }`}
                                >
                                    <Circle
                                        className={`w-2 h-2 fill-current ${account.type === 'real' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}
                                    />
                                    <div className="flex-1">
                                        <div className="font-mono text-sm">{account.id}</div>
                                        <div className="text-xs text-muted-foreground">{account.currency}</div>
                                    </div>
                                    <span className={`text-xs uppercase px-2 py-0.5 rounded ${account.type === 'real'
                                        ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                                        : 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                        }`}>
                                        {account.type}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
