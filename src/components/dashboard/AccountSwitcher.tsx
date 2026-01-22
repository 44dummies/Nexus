'use client';

import { useTradingStore } from '@/store/tradingStore';
import { ChevronDown, Circle } from 'lucide-react';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function AccountSwitcher() {
    const { accounts, activeAccountId, setActiveAccount } = useTradingStore();
    const [isOpen, setIsOpen] = useState(false);

    const activeAccount = accounts.find(a => a.id === activeAccountId);

    if (accounts.length <= 1) return null;

    return (
        <div className="relative z-[100]">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/40 hover:bg-muted/60 border border-border transition-colors"
            >
                <Circle
                    className={`w-2 h-2 fill-current ${activeAccount?.type === 'real' ? 'text-emerald-400' : 'text-amber-400'}`}
                />
                <span className="font-mono text-sm">{activeAccount?.id}</span>
                <span className="text-xs text-muted-foreground uppercase">{activeAccount?.type}</span>
                <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="absolute top-full mt-2 right-0 w-56 glass-panel rounded-xl overflow-hidden z-50"
                    >
                        <div className="p-2">
                            <div className="text-xs text-muted-foreground uppercase tracking-widest px-3 py-2">
                                Switch Account
                            </div>
                            {accounts.map((account) => (
                                <button
                                    key={account.id}
                                    onClick={async () => {
                                        if (account.type === 'real') {
                                            const confirmed = window.confirm('Switch to REAL account? This will place live trades.');
                                            if (!confirmed) return;
                                        }

                                        try {
                                            const res = await fetch('/api/auth/session', {
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

                                            setActiveAccount(account.id, account.type, account.currency);
                                            setIsOpen(false);
                                        } catch (err) {
                                            console.error(err);
                                        }
                                    }}
                                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${account.id === activeAccountId
                                        ? 'bg-accent/10 text-accent'
                                        : 'hover:bg-muted/40 text-foreground'
                                        }`}
                                >
                                    <Circle
                                        className={`w-2 h-2 fill-current ${account.type === 'real' ? 'text-emerald-400' : 'text-amber-400'}`}
                                    />
                                    <div className="flex-1">
                                        <div className="font-mono text-sm">{account.id}</div>
                                        <div className="text-xs text-muted-foreground">{account.currency}</div>
                                    </div>
                                    <span className={`text-xs uppercase px-2 py-0.5 rounded ${account.type === 'real'
                                        ? 'bg-emerald-500/20 text-emerald-400'
                                        : 'bg-amber-500/20 text-amber-400'
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
