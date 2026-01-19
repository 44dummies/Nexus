import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Account {
    id: string;
    token: string;
    currency: string;
    type: 'real' | 'demo';
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
    logout: () => void;
}

const MAX_TICK_HISTORY = 100;

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
                        balance: null, // Will be updated after re-auth
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

            setBotRunning: (running) => set({ botRunning: running }),

            setBotConfig: (config) =>
                set((state) => ({
                    baseStake: config.baseStake ?? state.baseStake,
                    stopLoss: config.stopLoss ?? state.stopLoss,
                    takeProfit: config.takeProfit ?? state.takeProfit,
                })),

            setLastTradeTime: (timestamp) => set({ lastTradeTime: timestamp }),

            setTradeInfo: (contractId, potentialProfit) =>
                set({ currentContractId: contractId, potentialProfit }),

            recordTradeResult: (profit) =>
                set((state) => ({
                    totalLossToday: profit < 0 ? state.totalLossToday + Math.abs(profit) : state.totalLossToday,
                    totalProfitToday: profit > 0 ? state.totalProfitToday + profit : state.totalProfitToday,
                })),

            resetDailyStats: () =>
                set({ totalLossToday: 0, totalProfitToday: 0 }),

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
            }),
        }),
        {
            name: 'derivnexus-store',
        }
    )
);
