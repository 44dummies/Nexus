import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TradingState {
    userEmail: string | null;
    balance: number | null;
    currency: string | null;
    isAuthorized: boolean;
    accessToken: string | null;

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
    setUser: (email: string, balance: number, currency: string, token: string) => void;
    setBalance: (balance: number) => void;
    setBotRunning: (running: boolean) => void;
    setBotConfig: (config: Partial<Pick<TradingState, 'baseStake' | 'stopLoss' | 'takeProfit'>>) => void;
    setLastTradeTime: (timestamp: number | null) => void;
    setTradeInfo: (contractId: number | null, potentialProfit: number | null) => void;
    recordTradeResult: (profit: number) => void;
    resetDailyStats: () => void;
    logout: () => void;
}

export const useTradingStore = create<TradingState>()(
    persist(
        (set) => ({
            userEmail: null,
            balance: null,
            currency: null,
            isAuthorized: false,
            accessToken: null,
            botRunning: false,
            baseStake: 1,
            stopLoss: 50,
            takeProfit: 50,
            totalLossToday: 0,
            totalProfitToday: 0,
            lastTradeTime: null,
            currentContractId: null,
            potentialProfit: null,

            setUser: (email, balance, currency, token) =>
                set({ userEmail: email, balance, currency, accessToken: token, isAuthorized: true }),

            setBalance: (balance) => set({ balance }),

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
                userEmail: null,
                balance: null,
                currency: null,
                isAuthorized: false,
                accessToken: null,
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
            name: 'derivnexus-store', // Request persistent storage
        }
    )
);
