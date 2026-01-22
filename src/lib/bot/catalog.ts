export type BotRisk = 'Low' | 'Medium' | 'High';

export interface BotProfile {
    id: string;
    name: string;
    summary: string;
    risk: BotRisk;
    tags: string[];
    marketFit: string;
    edge: string;
    executionProfileId: 'conservative' | 'balanced' | 'fast';
}

export const BOT_CATALOG: BotProfile[] = [
    {
        id: 'rsi',
        name: 'Mean Reversion RSI',
        summary: 'Buys oversold dips and sells overbought spikes with tight exposure windows.',
        risk: 'Medium',
        tags: ['Volatility', 'Reversion', 'Short-Term'],
        marketFit: 'Range-bound markets',
        edge: 'Momentum exhaustion + fast mean pullback',
        executionProfileId: 'balanced',
    },
    {
        id: 'trend-rider',
        name: 'Trend Rider',
        summary: 'Follows directional bursts with a conservative entry filter and risk caps.',
        risk: 'Medium',
        tags: ['Momentum', 'Trend', 'Confirmation'],
        marketFit: 'Trending markets',
        edge: 'Directional persistence + controlled stake',
        executionProfileId: 'balanced',
    },
    {
        id: 'breakout-atr',
        name: 'Breakout ATR',
        summary: 'Enters on volatility expansion after consolidation to catch range breaks.',
        risk: 'High',
        tags: ['Breakout', 'Volatility', 'Timed'],
        marketFit: 'High volatility sessions',
        edge: 'Volatility expansion with strict timeouts',
        executionProfileId: 'fast',
    },
    {
        id: 'capital-guard',
        name: 'Capital Guard',
        summary: 'Low-risk profile with reduced frequency and strict drawdown protection.',
        risk: 'Low',
        tags: ['Defensive', 'Capital Preservation', 'Low Frequency'],
        marketFit: 'Choppy markets',
        edge: 'Capital protection + minimal exposure',
        executionProfileId: 'conservative',
    },
    {
        id: 'recovery-lite',
        name: 'Recovery Lite',
        summary: 'Controlled recovery steps with hard caps for disciplined risk.',
        risk: 'High',
        tags: ['Recovery', 'Risk-Capped', 'Adaptive'],
        marketFit: 'Stable volatility',
        edge: 'Limited recovery ladder with cooldowns',
        executionProfileId: 'balanced',
    },
];
