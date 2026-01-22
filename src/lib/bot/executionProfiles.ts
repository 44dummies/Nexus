export interface ExecutionProfileDefaults {
    entryTimeoutMs: number;
    entryPollingMs: number;
    entrySlippagePct: number;
    entryAggressiveness: number;
    entryMinEdgePct: number;
}

export interface ExecutionProfile {
    id: 'conservative' | 'balanced' | 'fast';
    name: string;
    summary: string;
    defaults: ExecutionProfileDefaults;
    lossCooldownMs: number;
    baseRiskPct: number;
}

export const EXECUTION_PROFILES: ExecutionProfile[] = [
    {
        id: 'conservative',
        name: 'Conservative',
        summary: 'Swing-ish execution with wider edge requirement and slower polling.',
        defaults: {
            entryTimeoutMs: 4000,
            entryPollingMs: 500,
            entrySlippagePct: 0.05,
            entryAggressiveness: 0.45,
            entryMinEdgePct: 0.2,
        },
        lossCooldownMs: 6 * 60 * 60 * 1000,
        baseRiskPct: 0.25,
    },
    {
        id: 'balanced',
        name: 'Balanced',
        summary: 'General-purpose execution tuned for stable fill quality.',
        defaults: {
            entryTimeoutMs: 2000,
            entryPollingMs: 250,
            entrySlippagePct: 0.05,
            entryAggressiveness: 0.65,
            entryMinEdgePct: 0.12,
        },
        lossCooldownMs: 2 * 60 * 60 * 1000,
        baseRiskPct: 0.35,
    },
    {
        id: 'fast',
        name: 'Fast',
        summary: 'Scalping execution with tight timeouts and higher aggressiveness.',
        defaults: {
            entryTimeoutMs: 600,
            entryPollingMs: 100,
            entrySlippagePct: 0.1,
            entryAggressiveness: 0.8,
            entryMinEdgePct: 0.2,
        },
        lossCooldownMs: 45 * 60 * 1000,
        baseRiskPct: 0.45,
    },
];

export const getExecutionProfile = (id?: string | null) => {
    if (id) {
        const match = EXECUTION_PROFILES.find((profile) => profile.id === id);
        if (match) return match;
    }
    return EXECUTION_PROFILES[1];
};
