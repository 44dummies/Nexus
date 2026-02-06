'use client';

import type { ReactNode } from 'react';

export interface StrategyVisual {
    id: string;
    title: string;
    description: string;
    svg: ReactNode;
}

export interface StrategyDetail {
    summary: string;
    rules: string[];
    visuals: StrategyVisual[];
}

const baseSvgProps = {
    width: '100%',
    height: 110,
    viewBox: '0 0 220 110',
    xmlns: 'http://www.w3.org/2000/svg',
    role: 'img',
    'aria-hidden': true,
};

export const STRATEGY_DETAILS: Record<string, StrategyDetail> = {
    rsi: {
        summary: 'Mean reversion after momentum extremes using RSI thresholds and short exposure windows.',
        rules: [
            'RSI below the lower band triggers CALL; above the upper band triggers PUT.',
            'No trade in the mid-band to avoid chop.',
            'Short duration with strict stop and take-profit.',
        ],
        visuals: [
            {
                id: 'rsi-bands',
                title: 'RSI Bands',
                description: 'Upper/lower bands highlight exhaustion zones.',
                svg: (
                    <svg {...baseSvgProps}>
                        <rect x="8" y="8" width="204" height="94" rx="12" fill="currentColor" opacity="0.06" />
                        <line x1="20" y1="30" x2="200" y2="30" stroke="currentColor" strokeWidth="2" opacity="0.5" />
                        <line x1="20" y1="80" x2="200" y2="80" stroke="currentColor" strokeWidth="2" opacity="0.5" />
                        <path
                            d="M20 70 C40 60, 60 90, 80 60 C100 30, 120 40, 140 25 C160 10, 180 20, 200 35"
                            stroke="currentColor"
                            strokeWidth="3"
                            fill="none"
                        />
                    </svg>
                ),
            },
            {
                id: 'mean-revert',
                title: 'Mean Reversion',
                description: 'Price snaps back toward the midline after extremes.',
                svg: (
                    <svg {...baseSvgProps}>
                        <rect x="8" y="8" width="204" height="94" rx="12" fill="currentColor" opacity="0.06" />
                        <line x1="20" y1="55" x2="200" y2="55" stroke="currentColor" strokeDasharray="6 6" opacity="0.5" />
                        <path
                            d="M20 65 C45 90, 70 75, 95 55 C120 35, 145 25, 170 40 C185 50, 195 60, 200 70"
                            stroke="currentColor"
                            strokeWidth="3"
                            fill="none"
                        />
                        <circle cx="95" cy="55" r="4" fill="currentColor" />
                    </svg>
                ),
            },
        ],
    },
    'trend-rider': {
        summary: 'Directional momentum strategy with confirmation filters and controlled staking.',
        rules: [
            'EMA fast above EMA slow confirms an uptrend; inverse confirms downtrend.',
            'RSI confirmation avoids false breaks.',
            'Exits on momentum fade or cooldown.',
        ],
        visuals: [
            {
                id: 'ema-cross',
                title: 'EMA Alignment',
                description: 'Trend bias when fast EMA stays above slow EMA.',
                svg: (
                    <svg {...baseSvgProps}>
                        <rect x="8" y="8" width="204" height="94" rx="12" fill="currentColor" opacity="0.06" />
                        <path d="M20 75 C60 65, 100 55, 140 40 C170 30, 190 25, 200 20" stroke="currentColor" strokeWidth="3" fill="none" />
                        <path d="M20 85 C60 78, 100 70, 140 60 C175 55, 190 52, 200 50" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.5" />
                    </svg>
                ),
            },
            {
                id: 'trend-arrow',
                title: 'Trend Follow',
                description: 'Entry aligns with sustained directional move.',
                svg: (
                    <svg {...baseSvgProps}>
                        <rect x="8" y="8" width="204" height="94" rx="12" fill="currentColor" opacity="0.06" />
                        <path d="M30 80 L170 30" stroke="currentColor" strokeWidth="4" />
                        <path d="M160 28 L178 28 L170 46" fill="currentColor" />
                    </svg>
                ),
            },
        ],
    },
    'breakout-atr': {
        summary: 'Captures volatility expansion after consolidation using ATR-based filters.',
        rules: [
            'Wait for tight range and rising ATR.',
            'Enter on range break with strict timeout.',
            'Avoid retrace if momentum fades.',
        ],
        visuals: [
            {
                id: 'range-box',
                title: 'Consolidation Box',
                description: 'Price compresses before the breakout.',
                svg: (
                    <svg {...baseSvgProps}>
                        <rect x="8" y="8" width="204" height="94" rx="12" fill="currentColor" opacity="0.06" />
                        <rect x="50" y="45" width="90" height="30" rx="6" stroke="currentColor" strokeWidth="2" fill="none" />
                        <path d="M20 80 C40 75, 60 65, 80 65 C100 65, 120 70, 140 65 C160 60, 180 40, 200 30" stroke="currentColor" strokeWidth="3" fill="none" />
                    </svg>
                ),
            },
            {
                id: 'breakout',
                title: 'Volatility Expansion',
                description: 'Breakout leg accelerates after range.',
                svg: (
                    <svg {...baseSvgProps}>
                        <rect x="8" y="8" width="204" height="94" rx="12" fill="currentColor" opacity="0.06" />
                        <line x1="60" y1="70" x2="140" y2="70" stroke="currentColor" strokeWidth="2" opacity="0.4" />
                        <path d="M30 80 C70 75, 90 70, 120 60 C150 50, 170 35, 200 20" stroke="currentColor" strokeWidth="3" fill="none" />
                    </svg>
                ),
            },
        ],
    },
    'capital-guard': {
        summary: 'Defensive profile prioritizing drawdown control and lower trade frequency.',
        rules: [
            'Reduced frequency and smaller risk per trade.',
            'Stricter drawdown gates halt entries early.',
            'Avoids high-volatility regimes.',
        ],
        visuals: [
            {
                id: 'shield',
                title: 'Capital Shield',
                description: 'Risk gates reduce exposure.',
                svg: (
                    <svg {...baseSvgProps}>
                        <rect x="8" y="8" width="204" height="94" rx="12" fill="currentColor" opacity="0.06" />
                        <path d="M110 25 L150 40 L140 80 L110 95 L80 80 L70 40 Z" stroke="currentColor" strokeWidth="3" fill="none" />
                        <path d="M110 35 L110 85" stroke="currentColor" strokeWidth="2" opacity="0.6" />
                    </svg>
                ),
            },
            {
                id: 'steady-slope',
                title: 'Steady Equity',
                description: 'Focus on smoother equity curve.',
                svg: (
                    <svg {...baseSvgProps}>
                        <rect x="8" y="8" width="204" height="94" rx="12" fill="currentColor" opacity="0.06" />
                        <path d="M20 80 C60 70, 100 60, 140 50 C170 42, 190 38, 200 35" stroke="currentColor" strokeWidth="3" fill="none" />
                    </svg>
                ),
            },
        ],
    },
    'recovery-lite': {
        summary: 'Controlled recovery ladder with strict caps and cooldowns.',
        rules: [
            'Applies limited stake steps after losses.',
            'Stops after max steps or cooldown trigger.',
            'Resets on win to avoid overexposure.',
        ],
        visuals: [
            {
                id: 'recovery-steps',
                title: 'Recovery Ladder',
                description: 'Small step-ups capped at low count.',
                svg: (
                    <svg {...baseSvgProps}>
                        <rect x="8" y="8" width="204" height="94" rx="12" fill="currentColor" opacity="0.06" />
                        <path d="M30 85 L70 85 L70 65 L110 65 L110 45 L150 45 L150 25 L190 25" stroke="currentColor" strokeWidth="4" fill="none" />
                    </svg>
                ),
            },
            {
                id: 'cooldown',
                title: 'Cooldown Gate',
                description: 'Pauses after loss streaks.',
                svg: (
                    <svg {...baseSvgProps}>
                        <rect x="8" y="8" width="204" height="94" rx="12" fill="currentColor" opacity="0.06" />
                        <circle cx="110" cy="55" r="26" stroke="currentColor" strokeWidth="3" fill="none" />
                        <path d="M110 55 L110 40" stroke="currentColor" strokeWidth="3" />
                        <path d="M110 55 L125 65" stroke="currentColor" strokeWidth="3" />
                    </svg>
                ),
            },
        ],
    },
};

export function getStrategyDetail(strategyId: string, fallbackSummary?: string): StrategyDetail {
    return STRATEGY_DETAILS[strategyId] ?? {
        summary: fallbackSummary ?? 'Strategy overview not available.',
        rules: [],
        visuals: [],
    };
}
