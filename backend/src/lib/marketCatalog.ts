export type MarketCategory = 'synthetic' | 'crash_boom' | 'jump' | 'forex' | 'crypto' | 'commodities';

export type MarketInfo = {
    symbol: string;
    displayName: string;
    category: MarketCategory;
};

export const MARKET_CATALOG: MarketInfo[] = [
    { symbol: 'R_10', displayName: 'Volatility 10 Index', category: 'synthetic' },
    { symbol: 'R_25', displayName: 'Volatility 25 Index', category: 'synthetic' },
    { symbol: 'R_50', displayName: 'Volatility 50 Index', category: 'synthetic' },
    { symbol: 'R_75', displayName: 'Volatility 75 Index', category: 'synthetic' },
    { symbol: 'R_100', displayName: 'Volatility 100 Index', category: 'synthetic' },
    { symbol: '1HZ10V', displayName: 'Volatility 10 (1s) Index', category: 'synthetic' },
    { symbol: '1HZ25V', displayName: 'Volatility 25 (1s) Index', category: 'synthetic' },
    { symbol: '1HZ50V', displayName: 'Volatility 50 (1s) Index', category: 'synthetic' },
    { symbol: '1HZ75V', displayName: 'Volatility 75 (1s) Index', category: 'synthetic' },
    { symbol: '1HZ100V', displayName: 'Volatility 100 (1s) Index', category: 'synthetic' },
    { symbol: 'BOOM1000', displayName: 'Boom 1000 Index', category: 'crash_boom' },
    { symbol: 'BOOM500', displayName: 'Boom 500 Index', category: 'crash_boom' },
    { symbol: 'CRASH1000', displayName: 'Crash 1000 Index', category: 'crash_boom' },
    { symbol: 'CRASH500', displayName: 'Crash 500 Index', category: 'crash_boom' },
    { symbol: 'JD100', displayName: 'Jump 100 Index', category: 'jump' },
    { symbol: 'JD50', displayName: 'Jump 50 Index', category: 'jump' },
    { symbol: 'frxEURUSD', displayName: 'EUR/USD', category: 'forex' },
    { symbol: 'frxGBPUSD', displayName: 'GBP/USD', category: 'forex' },
    { symbol: 'frxUSDJPY', displayName: 'USD/JPY', category: 'forex' },
    { symbol: 'frxAUDUSD', displayName: 'AUD/USD', category: 'forex' },
    { symbol: 'frxUSDCAD', displayName: 'USD/CAD', category: 'forex' },
    { symbol: 'cryBTCUSD', displayName: 'BTC/USD', category: 'crypto' },
    { symbol: 'cryETHUSD', displayName: 'ETH/USD', category: 'crypto' },
    { symbol: 'frxXAUUSD', displayName: 'Gold/USD', category: 'commodities' },
    { symbol: 'frxXAGUSD', displayName: 'Silver/USD', category: 'commodities' },
];
