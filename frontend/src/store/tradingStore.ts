import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
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

export interface TradeResultEntry {
    id: string;
    timestamp: number;
    profit: number;
    contractId?: number;
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
    selectedSymbol: string | null;
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
    tradeResults: TradeResultEntry[];

    // Logging
    botLogs: BotLogEntry[];

    // User Preferences
    notifyTradeAlerts: boolean;
    notifyErrorAlerts: boolean;
    notifyBotStatus: boolean;
    chartDefaultSize: 'compact' | 'default' | 'expanded';

    // Smart Layer / Auto Mode
    autoModeEnabled: boolean;
    currentRegime: string | null;
    regimeConfidence: number | null;
    activeAutoStrategy: string | null;
    smartLayerRiskGate: string | null;
    smartLayerCorrelationId: string | null;
    lastStrategySwitchReason: string | null;

    // PnL Tracking (from backend SSE stream)
    pnlRealizedPnL: number;
    pnlUnrealizedPnL: number;
    pnlNetPnL: number;
    pnlOpenPositionCount: number;
    pnlOpenExposure: number;
    pnlWinCount: number;
    pnlLossCount: number;
    pnlAvgWin: number;
    pnlAvgLoss: number;
    pnlBalanceDrift: number | null;
    pnlLastKnownBalance: number | null;
    pnlLastUpdated: number | null;
    pnlPositions: Array<{
        contractId: number;
        symbol: string;
        direction: string;
        buyPrice: number;
        stake: number;
        payout: number;
        lastMarkPrice: number;
        unrealizedPnL: number;
        openedAt: number;
    }>;

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
    setSelectedSymbol: (symbol: string | null) => void;
    setActiveRunId: (runId: string | null) => void;
    setBotConfigFor: (botId: string, config: Partial<BotConfig>) => void;
    setEntryConfig: (config: Partial<Pick<TradingState, 'entryProfileId' | 'entryMode' | 'entryTimeoutMs' | 'entryPollingMs' | 'entrySlippagePct' | 'entryAggressiveness' | 'entryMinEdgePct'>>) => void;
    setBotConfig: (config: Partial<Pick<TradingState, 'baseStake' | 'maxStake' | 'stopLoss' | 'takeProfit' | 'cooldownMs' | 'baseRiskPct' | 'dailyLossLimitPct' | 'drawdownLimitPct' | 'maxConsecutiveLosses' | 'lossCooldownMs'>>) => void;
    setLastTradeTime: (timestamp: number | null) => void;
    setTradeInfo: (contractId: number | null, potentialProfit: number | null) => void;
    recordTradeResult: (result: { profit: number; contractId?: number }) => void;
    resetDailyStats: () => void;
    addLog: (type: BotLogEntry['type'], message: string, data?: Record<string, unknown>) => void;
    clearLogs: () => void;
    setNotifyTradeAlerts: (enabled: boolean) => void;
    setNotifyErrorAlerts: (enabled: boolean) => void;
    setNotifyBotStatus: (enabled: boolean) => void;
    setChartDefaultSize: (size: 'compact' | 'default' | 'expanded') => void;
    setAutoModeEnabled: (enabled: boolean) => void;
    updateSmartLayerState: (state: {
        regime?: string | null;
        regimeConfidence?: number | null;
        activeStrategy?: string | null;
        riskGate?: string | null;
        correlationId?: string | null;
        switchReason?: string | null;
    }) => void;
    updatePnL: (data: {
        realizedPnL?: number;
        unrealizedPnL?: number;
        netPnL?: number;
        openPositionCount?: number;
        openExposure?: number;
        winCount?: number;
        lossCount?: number;
        avgWin?: number;
        avgLoss?: number;
        balanceDrift?: number | null;
        lastKnownBalance?: number | null;
        lastUpdated?: number;
        positions?: Array<{
            contractId: number;
            symbol: string;
            direction: string;
            buyPrice: number;
            stake: number;
            payout: number;
            lastMarkPrice: number;
            unrealizedPnL: number;
            openedAt: number;
        }>;
    }) => void;
    logout: () => void;
}

const MAX_TICK_HISTORY = 100;
const MAX_LOGS = 50;
const MAX_TRADE_RESULTS = 1000;
const LOW_LATENCY_MODE = process.env.NEXT_PUBLIC_LOW_LATENCY_MODE === 'true';
const DEFAULT_COOLDOWN_MS = LOW_LATENCY_MODE ? 0 : 10000;

const memoryStorage = new Map<string, string>();
const safeStorage = createJSONStorage(() => {
    if (typeof window === 'undefined') {
        return {
            getItem: (name: string) => memoryStorage.get(name) ?? null,
            setItem: (name: string, value: string) => {
                memoryStorage.set(name, value);
            },
            removeItem: (name: string) => {
                memoryStorage.delete(name);
            },
        };
    }

    try {
        const testKey = '__storage_test__';
        window.localStorage.setItem(testKey, '1');
        window.localStorage.removeItem(testKey);
        return window.localStorage;
    } catch (error) {
        console.warn('localStorage unavailable, using in-memory store', error);
        return {
            getItem: (name: string) => memoryStorage.get(name) ?? null,
            setItem: (name: string, value: string) => {
                memoryStorage.set(name, value);
            },
            removeItem: (name: string) => {
                memoryStorage.delete(name);
            },
        };
    }
});

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
            selectedSymbol: 'R_100',
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
            cooldownMs: DEFAULT_COOLDOWN_MS,
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
            tradeResults: [],
            botLogs: [],
            notifyTradeAlerts: true,
            notifyErrorAlerts: true,
            notifyBotStatus: true,
            chartDefaultSize: 'default',
            autoModeEnabled: false,
            currentRegime: null,
            regimeConfidence: null,
            activeAutoStrategy: null,
            smartLayerRiskGate: null,
            smartLayerCorrelationId: null,
            lastStrategySwitchReason: null,
            pnlRealizedPnL: 0,
            pnlUnrealizedPnL: 0,
            pnlNetPnL: 0,
            pnlOpenPositionCount: 0,
            pnlOpenExposure: 0,
            pnlWinCount: 0,
            pnlLossCount: 0,
            pnlAvgWin: 0,
            pnlAvgLoss: 0,
            pnlBalanceDrift: null,
            pnlLastKnownBalance: null,
            pnlLastUpdated: null,
            pnlPositions: [],

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
                        selectedSymbol: 'R_100',
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

            setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),

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

            recordTradeResult: ({ profit, contractId }) => {
                set((state) => {
                    const nextEquity = state.equity === null ? null : state.equity + profit;
                    const nextEquityPeak = nextEquity === null
                        ? state.equityPeak
                        : Math.max(state.equityPeak ?? nextEquity, nextEquity);
                    const timestamp = Date.now();
                    const tradeEntry: TradeResultEntry = {
                        id: `${contractId ?? 'trade'}-${timestamp}-${Math.random().toString(36).slice(2, 6)}`,
                        timestamp,
                        profit,
                        contractId,
                    };
                    return {
                        totalLossToday: profit < 0 ? state.totalLossToday + Math.abs(profit) : state.totalLossToday,
                        totalProfitToday: profit > 0 ? state.totalProfitToday + profit : state.totalProfitToday,
                        lossStreak: profit < 0 ? state.lossStreak + 1 : 0,
                        consecutiveWins: profit > 0 ? state.consecutiveWins + 1 : 0,
                        equity: nextEquity,
                        equityPeak: nextEquityPeak,
                        lastLossTime: profit < 0 ? Date.now() : state.lastLossTime,
                        lastTradeProfit: profit,
                        tradeResults: [tradeEntry, ...state.tradeResults].slice(0, MAX_TRADE_RESULTS),
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

            setNotifyTradeAlerts: (enabled) => set({ notifyTradeAlerts: enabled }),
            setNotifyErrorAlerts: (enabled) => set({ notifyErrorAlerts: enabled }),
            setNotifyBotStatus: (enabled) => set({ notifyBotStatus: enabled }),
            setChartDefaultSize: (size) => set({ chartDefaultSize: size }),

            setAutoModeEnabled: (enabled) => set({
                autoModeEnabled: enabled,
                // Reset smart layer state when toggling
                currentRegime: enabled ? null : null,
                regimeConfidence: enabled ? null : null,
                activeAutoStrategy: enabled ? null : null,
                smartLayerRiskGate: enabled ? null : null,
                smartLayerCorrelationId: enabled ? null : null,
                lastStrategySwitchReason: enabled ? null : null,
            }),

            updateSmartLayerState: (state) => set((prev) => ({
                currentRegime: state.regime !== undefined ? state.regime : prev.currentRegime,
                regimeConfidence: state.regimeConfidence !== undefined ? state.regimeConfidence : prev.regimeConfidence,
                activeAutoStrategy: state.activeStrategy !== undefined ? state.activeStrategy : prev.activeAutoStrategy,
                smartLayerRiskGate: state.riskGate !== undefined ? state.riskGate : prev.smartLayerRiskGate,
                smartLayerCorrelationId: state.correlationId !== undefined ? state.correlationId : prev.smartLayerCorrelationId,
                lastStrategySwitchReason: state.switchReason !== undefined ? state.switchReason : prev.lastStrategySwitchReason,
            })),

            updatePnL: (data) => set({
                pnlRealizedPnL: data.realizedPnL ?? 0,
                pnlUnrealizedPnL: data.unrealizedPnL ?? 0,
                pnlNetPnL: data.netPnL ?? 0,
                pnlOpenPositionCount: data.openPositionCount ?? 0,
                pnlOpenExposure: data.openExposure ?? 0,
                pnlWinCount: data.winCount ?? 0,
                pnlLossCount: data.lossCount ?? 0,
                pnlAvgWin: data.avgWin ?? 0,
                pnlAvgLoss: data.avgLoss ?? 0,
                pnlBalanceDrift: data.balanceDrift ?? null,
                pnlLastKnownBalance: data.lastKnownBalance ?? null,
                pnlLastUpdated: data.lastUpdated ?? Date.now(),
                pnlPositions: data.positions ?? [],
            }),

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
                selectedSymbol: 'R_100',
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
                cooldownMs: DEFAULT_COOLDOWN_MS,
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
                tradeResults: [],
                botLogs: [],
                notifyTradeAlerts: true,
                notifyErrorAlerts: true,
                notifyBotStatus: true,
                chartDefaultSize: 'default',
                autoModeEnabled: false,
                currentRegime: null,
                regimeConfidence: null,
                activeAutoStrategy: null,
                smartLayerRiskGate: null,
                smartLayerCorrelationId: null,
                lastStrategySwitchReason: null,
                pnlRealizedPnL: 0,
                pnlUnrealizedPnL: 0,
                pnlNetPnL: 0,
                pnlOpenPositionCount: 0,
                pnlOpenExposure: 0,
                pnlWinCount: 0,
                pnlLossCount: 0,
                pnlAvgWin: 0,
                pnlAvgLoss: 0,
                pnlBalanceDrift: null,
                pnlLastKnownBalance: null,
                pnlLastUpdated: null,
                pnlPositions: [],
            }),
        }),
        {
            name: 'derivnexus-store',
            storage: safeStorage,
            // Security: Exclude sensitive/ephemeral data from localStorage
            partialize: (state) => ({
                // Persist only non-sensitive configuration
                selectedBotId: state.selectedBotId,
                selectedSymbol: state.selectedSymbol,
                botConfigs: state.botConfigs,
                entryProfileId: state.entryProfileId,
                entryMode: state.entryMode,
                entryTimeoutMs: state.entryTimeoutMs,
                entryPollingMs: state.entryPollingMs,
                entrySlippagePct: state.entrySlippagePct,
                entryAggressiveness: state.entryAggressiveness,
                entryMinEdgePct: state.entryMinEdgePct,
                baseStake: state.baseStake,
                maxStake: state.maxStake,
                stopLoss: state.stopLoss,
                takeProfit: state.takeProfit,
                cooldownMs: state.cooldownMs,
                baseRiskPct: state.baseRiskPct,
                dailyLossLimitPct: state.dailyLossLimitPct,
                drawdownLimitPct: state.drawdownLimitPct,
                maxConsecutiveLosses: state.maxConsecutiveLosses,
                lossCooldownMs: state.lossCooldownMs,
                notifyTradeAlerts: state.notifyTradeAlerts,
                notifyErrorAlerts: state.notifyErrorAlerts,
                notifyBotStatus: state.notifyBotStatus,
                chartDefaultSize: state.chartDefaultSize,
                autoModeEnabled: state.autoModeEnabled,
                // Excluded from persistence (sensitive/ephemeral):
                // accounts, userEmail, balance, currency, isAuthorized, isConnected,
                // tickHistory, botRunning, tradeResults, botLogs, equity, etc.
            }),
        }
    )
);
