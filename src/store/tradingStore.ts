import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_BOT_CONFIGS, type BotConfig } from '@/lib/bot/config';

interface Account {
    id: string;
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
    activeAccountType: 'real' | 'demo' | null;
    activeCurrency: string | null;
    userEmail: string | null;
    balance: number | null;
    currency: string | null;
    isAuthorized: boolean;
    isConnected: boolean;

    // Live Feed
    tickHistory: number[];
    lastTick: number;
    prevTick: number;

    // Bot state
    botRunning: boolean;
    selectedBotId: string | null;
    botConfigs: Record<string, BotConfig>;
    entryProfileId: string | null;
    entryMode: 'HYBRID_LIMIT_MARKET' | 'MARKET';
    entryTimeoutMs: number;
    entryPollingMs: number;
    entrySlippagePct: number;
    entryAggressiveness: number;
    entryMinEdgePct: number;
    baseStake: number;
    maxStake: number;
    stopLoss: number;
    takeProfit: number;
    cooldownMs: number;
    baseRiskPct: number;
    dailyLossLimitPct: number;
    drawdownLimitPct: number;
    maxConsecutiveLosses: number;
    lossCooldownMs: number;
    totalLossToday: number;
    totalProfitToday: number;
    lossStreak: number;
    consecutiveWins: number;
    equity: number | null;
    equityPeak: number | null;
    dailyStartEquity: number | null;
    lastLossTime: number | null;
    lastTradeProfit: number | null;
    activeRunId: string | null;
    lastTradeTime: number | null;
    currentContractId: number | null;
    potentialProfit: number | null;

    // Logging
    botLogs: BotLogEntry[];

    // Actions
    setAccounts: (accounts: Account[], email: string, activeAccountId?: string | null, activeAccountType?: 'real' | 'demo' | null, activeCurrency?: string | null) => void;
    switchAccount: (accountId: string) => void;
    setActiveAccount: (accountId: string, accountType: 'real' | 'demo', currency: string) => void;
    setUser: (email: string, balance: number, currency: string) => void;
    setBalance: (balance: number) => void;
    addTick: (tick: number) => void;
    setBotRunning: (running: boolean) => void;
    setConnectionStatus: (connected: boolean) => void;
    setSelectedBotId: (botId: string) => void;
    setActiveRunId: (runId: string | null) => void;
    setBotConfigFor: (botId: string, config: Partial<BotConfig>) => void;
    setEntryConfig: (config: Partial<Pick<TradingState, 'entryProfileId' | 'entryMode' | 'entryTimeoutMs' | 'entryPollingMs' | 'entrySlippagePct' | 'entryAggressiveness' | 'entryMinEdgePct'>>) => void;
    setBotConfig: (config: Partial<Pick<TradingState, 'baseStake' | 'maxStake' | 'stopLoss' | 'takeProfit' | 'cooldownMs' | 'baseRiskPct' | 'dailyLossLimitPct' | 'drawdownLimitPct' | 'maxConsecutiveLosses' | 'lossCooldownMs'>>) => void;
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
            activeAccountType: null,
            activeCurrency: null,
            userEmail: null,
            balance: null,
            currency: null,
            isAuthorized: false,
            isConnected: false,
            tickHistory: [],
            lastTick: 0,
            prevTick: 0,
            botRunning: false,
            selectedBotId: 'rsi',
            botConfigs: DEFAULT_BOT_CONFIGS,
            entryProfileId: 'balanced',
            entryMode: 'HYBRID_LIMIT_MARKET',
            entryTimeoutMs: 2000,
            entryPollingMs: 250,
            entrySlippagePct: 0.05,
            entryAggressiveness: 0.65,
            entryMinEdgePct: 0.12,
            baseStake: 1,
            maxStake: 2,
            stopLoss: 50,
            takeProfit: 50,
            cooldownMs: 10000,
            baseRiskPct: 0.35,
            dailyLossLimitPct: 2,
            drawdownLimitPct: 6,
            maxConsecutiveLosses: 3,
            lossCooldownMs: 2 * 60 * 60 * 1000,
            totalLossToday: 0,
            totalProfitToday: 0,
            lossStreak: 0,
            consecutiveWins: 0,
            equity: null,
            equityPeak: null,
            dailyStartEquity: null,
            lastLossTime: null,
            lastTradeProfit: null,
            activeRunId: null,
            lastTradeTime: null,
            currentContractId: null,
            potentialProfit: null,
            botLogs: [],

            setAccounts: (accounts, email, activeAccountId, activeAccountType, activeCurrency) => {
                const firstAccount = accounts[0];
                set({
                    accounts,
                    userEmail: email,
                    activeAccountId: activeAccountId ?? firstAccount?.id ?? null,
                    activeAccountType: activeAccountType ?? firstAccount?.type ?? null,
                    activeCurrency: activeCurrency ?? firstAccount?.currency ?? null,
                    currency: activeCurrency ?? firstAccount?.currency ?? null,
                    isAuthorized: accounts.length > 0,
                });
            },

            switchAccount: (accountId) => {
                const account = get().accounts.find(a => a.id === accountId);
                if (account) {
                    set({
                        activeAccountId: accountId,
                        activeAccountType: account.type,
                        activeCurrency: account.currency,
                        currency: account.currency,
                        balance: null,
                        equity: null,
                        equityPeak: null,
                        dailyStartEquity: null,
                        totalLossToday: 0,
                        totalProfitToday: 0,
                        lossStreak: 0,
                        consecutiveWins: 0,
                        lastLossTime: null,
                        lastTradeTime: null,
                        activeRunId: null,
                    });
                }
            },

            setActiveAccount: (accountId, accountType, currency) =>
                set({
                    activeAccountId: accountId,
                    activeAccountType: accountType,
                    activeCurrency: currency,
                    currency,
                }),

            setUser: (email, balance, currency) =>
                set((state) => {
                    const nextBalance = Number.isFinite(balance) ? balance : state.balance;
                    const nextEquity = Number.isFinite(balance) ? balance : state.equity;
                    const nextEquityPeak = nextEquity === null
                        ? state.equityPeak
                        : Math.max(state.equityPeak ?? nextEquity, nextEquity);
                    const nextDailyStart = state.dailyStartEquity ?? nextEquity;
                    return {
                        userEmail: email,
                        balance: nextBalance,
                        currency,
                        isAuthorized: true,
                        equity: nextEquity,
                        equityPeak: nextEquityPeak,
                        dailyStartEquity: nextDailyStart,
                    };
                }),

            setBalance: (balance) =>
                set((state) => {
                    const nextEquity = Number.isFinite(balance) ? balance : state.equity;
                    const nextEquityPeak = nextEquity === null
                        ? state.equityPeak
                        : Math.max(state.equityPeak ?? nextEquity, nextEquity);
                    return {
                        balance,
                        equity: nextEquity,
                        equityPeak: nextEquityPeak,
                        dailyStartEquity: state.dailyStartEquity ?? nextEquity,
                    };
                }),

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

            setConnectionStatus: (connected) => set({ isConnected: connected }),

            setSelectedBotId: (botId) => set({ selectedBotId: botId }),

            setActiveRunId: (runId) => set({ activeRunId: runId }),

            setBotConfigFor: (botId, config) =>
                set((state) => ({
                    botConfigs: {
                        ...state.botConfigs,
                        [botId]: {
                            ...state.botConfigs[botId],
                            ...config,
                        },
                    },
                })),

            setEntryConfig: (config) =>
                set((state) => ({
                    entryProfileId: config.entryProfileId ?? state.entryProfileId,
                    entryMode: config.entryMode ?? state.entryMode,
                    entryTimeoutMs: config.entryTimeoutMs ?? state.entryTimeoutMs,
                    entryPollingMs: config.entryPollingMs ?? state.entryPollingMs,
                    entrySlippagePct: config.entrySlippagePct ?? state.entrySlippagePct,
                    entryAggressiveness: config.entryAggressiveness ?? state.entryAggressiveness,
                    entryMinEdgePct: config.entryMinEdgePct ?? state.entryMinEdgePct,
                })),

            setBotConfig: (config) =>
                set((state) => ({
                    baseStake: config.baseStake ?? state.baseStake,
                    maxStake: config.maxStake ?? state.maxStake,
                    stopLoss: config.stopLoss ?? state.stopLoss,
                    takeProfit: config.takeProfit ?? state.takeProfit,
                    cooldownMs: config.cooldownMs ?? state.cooldownMs,
                    baseRiskPct: config.baseRiskPct ?? state.baseRiskPct,
                    dailyLossLimitPct: config.dailyLossLimitPct ?? state.dailyLossLimitPct,
                    drawdownLimitPct: config.drawdownLimitPct ?? state.drawdownLimitPct,
                    maxConsecutiveLosses: config.maxConsecutiveLosses ?? state.maxConsecutiveLosses,
                    lossCooldownMs: config.lossCooldownMs ?? state.lossCooldownMs,
                })),

            setLastTradeTime: (timestamp) => set({ lastTradeTime: timestamp }),

            setTradeInfo: (contractId, potentialProfit) =>
                set({ currentContractId: contractId, potentialProfit }),

            recordTradeResult: (profit) => {
                set((state) => {
                    const nextEquity = state.equity === null ? null : state.equity + profit;
                    const nextEquityPeak = nextEquity === null
                        ? state.equityPeak
                        : Math.max(state.equityPeak ?? nextEquity, nextEquity);
                    return {
                        totalLossToday: profit < 0 ? state.totalLossToday + Math.abs(profit) : state.totalLossToday,
                        totalProfitToday: profit > 0 ? state.totalProfitToday + profit : state.totalProfitToday,
                        lossStreak: profit < 0 ? state.lossStreak + 1 : 0,
                        consecutiveWins: profit > 0 ? state.consecutiveWins + 1 : 0,
                        equity: nextEquity,
                        equityPeak: nextEquityPeak,
                        lastLossTime: profit < 0 ? Date.now() : state.lastLossTime,
                        lastTradeProfit: profit,
                    };
                });
                get().addLog('result', profit >= 0 ? `WIN: +$${profit.toFixed(2)}` : `LOSS: -$${Math.abs(profit).toFixed(2)}`, { profit });
            },

            resetDailyStats: () =>
                set((state) => ({
                    totalLossToday: 0,
                    totalProfitToday: 0,
                    dailyStartEquity: state.equity ?? state.balance ?? state.dailyStartEquity ?? null,
                    lossStreak: 0,
                    consecutiveWins: 0,
                })),

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
                activeAccountType: null,
                activeCurrency: null,
                userEmail: null,
                balance: null,
                currency: null,
                isAuthorized: false,
                isConnected: false,
                tickHistory: [],
                lastTick: 0,
                prevTick: 0,
                botRunning: false,
                selectedBotId: 'rsi',
                botConfigs: DEFAULT_BOT_CONFIGS,
                entryProfileId: 'balanced',
                entryMode: 'HYBRID_LIMIT_MARKET',
                entryTimeoutMs: 2000,
                entryPollingMs: 250,
                entrySlippagePct: 0.05,
                entryAggressiveness: 0.65,
                entryMinEdgePct: 0.12,
                baseStake: 1,
                maxStake: 2,
                stopLoss: 50,
                takeProfit: 50,
                cooldownMs: 10000,
                baseRiskPct: 0.35,
                dailyLossLimitPct: 2,
                drawdownLimitPct: 6,
                maxConsecutiveLosses: 3,
                lossCooldownMs: 2 * 60 * 60 * 1000,
                totalLossToday: 0,
                totalProfitToday: 0,
                lossStreak: 0,
                consecutiveWins: 0,
                equity: null,
                equityPeak: null,
                dailyStartEquity: null,
                lastLossTime: null,
                lastTradeProfit: null,
                activeRunId: null,
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
