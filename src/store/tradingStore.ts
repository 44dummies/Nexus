import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Account {
    id: string;
    token: string;
    currency: string;
    type: 'real' | 'demo';
}

export interface BotLogEntry {
    id: string;
    timestamp: number;
    type: 'info' | 'signal' | 'trade' | 'error' | 'result';
    message: string;
    data?: Record<string, unknown>;
}

interface TradingState {
    // Account Management
    accounts: Account[];
    activeAccountId: string | null;
    userEmail: string | null;
    balance: number | null;
    currency: string | null;
    isAuthorized: boolean;
    accessToken: string | null;

    // Live Feed
    tickHistory: number[];
    lastTick: number;
    prevTick: number;

    // Bot state
    botRunning: boolean;
    baseStake: number;
    stopLoss: number;
    takeProfit: number;
    totalLossToday: number;
    totalProfitToday: number;
    lastTradeTime: number | null;
    currentContractId: number | null;
    potentialProfit: number | null;

    // Logging
    botLogs: BotLogEntry[];

    // Actions
    setAccounts: (accounts: Account[], email: string) => void;
    switchAccount: (accountId: string) => void;
    setUser: (email: string, balance: number, currency: string, token: string) => void;
    setBalance: (balance: number) => void;
    addTick: (tick: number) => void;
    setBotRunning: (running: boolean) => void;
    setBotConfig: (config: Partial<Pick<TradingState, 'baseStake' | 'stopLoss' | 'takeProfit'>>) => void;
    setLastTradeTime: (timestamp: number | null) => void;
    setTradeInfo: (contractId: number | null, potentialProfit: number | null) => void;
    recordTradeResult: (profit: number) => void;
    resetDailyStats: () => void;
    addLog: (type: BotLogEntry['type'], message: string, data?: Record<string, unknown>) => void;
    clearLogs: () => void;
    logout: () => void;
}

const MAX_TICK_HISTORY = 100;
const MAX_LOGS = 50;

export const useTradingStore = create<TradingState>()(
    persist(
        (set, get) => ({
            accounts: [],
            activeAccountId: null,
            userEmail: null,
            balance: null,
            currency: null,
            isAuthorized: false,
            accessToken: null,
            tickHistory: [],
            lastTick: 0,
            prevTick: 0,
            botRunning: false,
            baseStake: 1,
            stopLoss: 50,
            takeProfit: 50,
            totalLossToday: 0,
            totalProfitToday: 0,
            lastTradeTime: null,
            currentContractId: null,
            potentialProfit: null,
            botLogs: [],

            setAccounts: (accounts, email) => {
                const firstAccount = accounts[0];
                set({
                    accounts,
                    userEmail: email,
                    activeAccountId: firstAccount?.id || null,
                    accessToken: firstAccount?.token || null,
                    currency: firstAccount?.currency || null,
                    isAuthorized: accounts.length > 0,
                });
            },

            switchAccount: (accountId) => {
                const account = get().accounts.find(a => a.id === accountId);
                if (account) {
                    set({
                        activeAccountId: accountId,
                        accessToken: account.token,
                        currency: account.currency,
                        balance: null,
                    });
                }
            },

            setUser: (email, balance, currency, token) =>
                set({ userEmail: email, balance, currency, accessToken: token, isAuthorized: true }),

            setBalance: (balance) => set({ balance }),

            addTick: (tick) => {
                const { tickHistory, lastTick } = get();
                const newHistory = [...tickHistory, tick].slice(-MAX_TICK_HISTORY);
                set({
                    tickHistory: newHistory,
                    prevTick: lastTick,
                    lastTick: tick,
                });
            },

            setBotRunning: (running) => {
                set({ botRunning: running });
                get().addLog('info', running ? 'Bot STARTED' : 'Bot STOPPED');
            },

            setBotConfig: (config) =>
                set((state) => ({
                    baseStake: config.baseStake ?? state.baseStake,
                    stopLoss: config.stopLoss ?? state.stopLoss,
                    takeProfit: config.takeProfit ?? state.takeProfit,
                })),

            setLastTradeTime: (timestamp) => set({ lastTradeTime: timestamp }),

            setTradeInfo: (contractId, potentialProfit) =>
                set({ currentContractId: contractId, potentialProfit }),

            recordTradeResult: (profit) => {
                set((state) => ({
                    totalLossToday: profit < 0 ? state.totalLossToday + Math.abs(profit) : state.totalLossToday,
                    totalProfitToday: profit > 0 ? state.totalProfitToday + profit : state.totalProfitToday,
                }));
                get().addLog('result', profit >= 0 ? `WIN: +$${profit.toFixed(2)}` : `LOSS: -$${Math.abs(profit).toFixed(2)}`, { profit });
            },

            resetDailyStats: () =>
                set({ totalLossToday: 0, totalProfitToday: 0 }),

            addLog: (type, message, data) => {
                const log: BotLogEntry = {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    timestamp: Date.now(),
                    type,
                    message,
                    data,
                };
                set((state) => ({
                    botLogs: [log, ...state.botLogs].slice(0, MAX_LOGS),
                }));
            },

            clearLogs: () => set({ botLogs: [] }),

            logout: () => set({
                accounts: [],
                activeAccountId: null,
                userEmail: null,
                balance: null,
                currency: null,
                isAuthorized: false,
                accessToken: null,
                tickHistory: [],
                lastTick: 0,
                prevTick: 0,
                botRunning: false,
                baseStake: 1,
                stopLoss: 50,
                takeProfit: 50,
                totalLossToday: 0,
                totalProfitToday: 0,
                lastTradeTime: null,
                currentContractId: null,
                potentialProfit: null,
                botLogs: [],
            }),
        }),
        {
            name: 'derivnexus-store',
        }
    )
);
