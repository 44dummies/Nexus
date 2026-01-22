/**
 * Toast notification service for DerivNexus
 * Provides centralized toast notifications that can be called from anywhere
 */

import { toast } from 'sonner';

export const showTradeToast = {
    success: (contractId: number, profit: number) => {
        toast.success('Trade Executed', {
            description: `Contract #${contractId} placed. Potential profit: $${profit.toFixed(2)}`,
        });
    },

    error: (message: string) => {
        toast.error('Trade Failed', {
            description: message,
        });
    },

    win: (profit: number) => {
        toast.success('Trade Won! 🎉', {
            description: `Profit: +$${profit.toFixed(2)}`,
        });
    },

    loss: (loss: number) => {
        toast.error('Trade Lost', {
            description: `Loss: -$${Math.abs(loss).toFixed(2)}`,
        });
    },

    signal: (signal: 'CALL' | 'PUT', rsi: number) => {
        toast.info(`Signal: ${signal}`, {
            description: `RSI: ${rsi.toFixed(2)}`,
        });
    },

    cooldown: (secondsLeft: number) => {
        toast.warning('Cooldown Active', {
            description: `Wait ${secondsLeft}s before next trade`,
        });
    },

    halted: () => {
        toast.error('Bot Halted', {
            description: 'Risk limit reached. Bot stopped automatically.',
        });
    },

    connectionError: () => {
        toast.error('Connection Error', {
            description: 'WebSocket is not connected. Please refresh.',
        });
    },

    started: () => {
        toast.success('Bot Started', {
            description: 'Trading is now active',
        });
    },

    stopped: () => {
        toast.info('Bot Stopped', {
            description: 'Trading has been paused',
        });
    },
};
