'use client';

import { Activity, Wallet } from 'lucide-react';
import dynamic from 'next/dynamic';

const AccountSwitcher = dynamic(() => import('@/components/dashboard/AccountSwitcher'), { ssr: false });

interface DashboardHeaderProps {
    isAuthorized: boolean;
    isConnected: boolean;
    currency: string | null;
    balance: number | null;
}

export function DashboardHeader({ isAuthorized, isConnected, currency, balance }: DashboardHeaderProps) {
    return (
        <header className="flex flex-wrap justify-between items-center gap-4 mb-6 glass-panel rounded-xl px-5 py-3">
            <div className="flex items-center gap-4">
                <h1 className="text-xl font-bold flex items-center gap-2">
                    <Activity className="text-accent w-5 h-5" />
                    <span>Market View</span>
                </h1>
                {isAuthorized && (
                    <div className="flex items-center gap-2 text-sm">
                        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-yellow-500 animate-pulse'}`} />
                        <span className="text-muted-foreground">{isConnected ? 'Live' : 'Connecting...'}</span>
                    </div>
                )}
            </div>

            <div className="flex gap-4 items-center">
                <AccountSwitcher />
                <div className="text-right">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Balance</p>
                    <div className="flex items-center justify-end gap-1.5 text-accent font-mono text-lg">
                        <Wallet className="w-4 h-4" />
                        <span>{currency} {balance?.toFixed(2) || '0.00'}</span>
                    </div>
                </div>
            </div>
        </header>
    );
}
