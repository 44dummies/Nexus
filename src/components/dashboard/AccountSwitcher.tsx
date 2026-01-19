'use client';

import { useTradingStore } from '@/store/tradingStore';
import { ChevronDown, Circle } from 'lucide-react';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function AccountSwitcher() {
    const { accounts, activeAccountId, switchAccount } = useTradingStore();
    const [isOpen, setIsOpen] = useState(false);

    const activeAccount = accounts.find(a => a.id === activeAccountId);

    if (accounts.length <= 1) return null;

    return (
        <div className="relative z-[100]">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
            >
                <Circle
                    className={`w-2 h-2 fill-current ${activeAccount?.type === 'real' ? 'text-emerald-400' : 'text-amber-400'}`}
                />
                <span className="font-mono text-sm">{activeAccount?.id}</span>
                <span className="text-xs text-gray-500 uppercase">{activeAccount?.type}</span>
                <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
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
                            <div className="text-xs text-gray-500 uppercase tracking-widest px-3 py-2">
                                Switch Account
                            </div>
                            {accounts.map((account) => (
                                <button
                                    key={account.id}
                                    onClick={() => {
                                        switchAccount(account.id);
                                        setIsOpen(false);
                                    }}
                                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${account.id === activeAccountId
                                        ? 'bg-[#00f5ff]/10 text-[#00f5ff]'
                                        : 'hover:bg-white/5 text-white'
                                        }`}
                                >
                                    <Circle
                                        className={`w-2 h-2 fill-current ${account.type === 'real' ? 'text-emerald-400' : 'text-amber-400'}`}
                                    />
                                    <div className="flex-1">
                                        <div className="font-mono text-sm">{account.id}</div>
                                        <div className="text-xs text-gray-500">{account.currency}</div>
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
