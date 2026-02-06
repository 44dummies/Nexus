'use client';

import { useTradingStore } from '@/store/tradingStore';
import { Brain, Activity, Shield, ArrowRightLeft, ChevronDown, ChevronUp, Zap } from 'lucide-react';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const REGIME_LABELS: Record<string, { label: string; color: string; icon: string }> = {
    REGIME_TREND: { label: 'Trending', color: 'text-emerald-400', icon: '📈' },
    REGIME_RANGE: { label: 'Ranging', color: 'text-blue-400', icon: '📊' },
    REGIME_HIGH_VOL: { label: 'High Volatility', color: 'text-amber-400', icon: '⚡' },
    REGIME_LOW_LIQUIDITY: { label: 'Low Liquidity', color: 'text-red-400', icon: '🚫' },
    REGIME_UNCERTAIN: { label: 'Uncertain', color: 'text-gray-400', icon: '❓' },
};

const STRATEGY_LABELS: Record<string, string> = {
    S1_TREND_FOLLOW: 'Trend Follow',
    S2_MEAN_REVERSION: 'Mean Reversion',
    S3_BREAKOUT_GUARD: 'Breakout Guard',
    S0_SAFE_MODE: 'Safe Mode',
};

const RISK_GATE_COLORS: Record<string, string> = {
    ALLOW_TRADE: 'text-emerald-400',
    REDUCED_RISK: 'text-amber-400',
    HALT: 'text-red-400',
};

export default function SmartLayerPanel() {
    const [expanded, setExpanded] = useState(false);

    const autoModeEnabled = useTradingStore((s) => s.autoModeEnabled);
    const setAutoModeEnabled = useTradingStore((s) => s.setAutoModeEnabled);
    const currentRegime = useTradingStore((s) => s.currentRegime);
    const regimeConfidence = useTradingStore((s) => s.regimeConfidence);
    const activeAutoStrategy = useTradingStore((s) => s.activeAutoStrategy);
    const riskGate = useTradingStore((s) => s.smartLayerRiskGate);
    const correlationId = useTradingStore((s) => s.smartLayerCorrelationId);
    const switchReason = useTradingStore((s) => s.lastStrategySwitchReason);
    const botRunning = useTradingStore((s) => s.botRunning);

    const regimeInfo = currentRegime ? REGIME_LABELS[currentRegime] : null;
    const strategyLabel = activeAutoStrategy ? STRATEGY_LABELS[activeAutoStrategy] ?? activeAutoStrategy : null;
    const riskGateColor = riskGate ? RISK_GATE_COLORS[riskGate] ?? 'text-gray-400' : 'text-gray-500';
    const confidencePct = regimeConfidence !== null ? Math.round(regimeConfidence * 100) : null;

    return (
        <div className="glass-panel rounded-2xl overflow-hidden">
            {/* Header with toggle */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <Brain className="w-4 h-4 text-violet-400" />
                    <span className="text-sm font-medium text-white/90">Smart Layer</span>
                    {autoModeEnabled && botRunning && currentRegime && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium bg-violet-500/20 text-violet-300 rounded-full">
                            LIVE
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-3">
                    {/* Auto Mode Toggle */}
                    <button
                        onClick={() => setAutoModeEnabled(!autoModeEnabled)}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${
                            autoModeEnabled ? 'bg-violet-500' : 'bg-white/10'
                        }`}
                        role="switch"
                        aria-checked={autoModeEnabled}
                        aria-label="Toggle Auto Mode"
                    >
                        <span
                            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                                autoModeEnabled ? 'translate-x-4' : 'translate-x-0.5'
                            } mt-0.5`}
                        />
                    </button>
                    <span className="text-xs text-white/50">Auto</span>

                    <button
                        onClick={() => setExpanded(!expanded)}
                        className="p-1 hover:bg-white/5 rounded-lg transition-colors"
                    >
                        {expanded ? (
                            <ChevronUp className="w-3.5 h-3.5 text-white/40" />
                        ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-white/40" />
                        )}
                    </button>
                </div>
            </div>

            {/* Compact view: always shown when auto mode is enabled */}
            {autoModeEnabled && (
                <div className="px-4 py-2.5 flex items-center gap-4 text-xs">
                    {/* Regime */}
                    <div className="flex items-center gap-1.5">
                        <span className="text-white/40">Regime:</span>
                        {regimeInfo ? (
                            <span className={`font-medium ${regimeInfo.color}`}>
                                {regimeInfo.icon} {regimeInfo.label}
                            </span>
                        ) : (
                            <span className="text-white/30">Waiting…</span>
                        )}
                    </div>

                    {/* Confidence */}
                    {confidencePct !== null && (
                        <div className="flex items-center gap-1">
                            <Activity className="w-3 h-3 text-white/30" />
                            <span className="text-white/60">{confidencePct}%</span>
                        </div>
                    )}

                    {/* Strategy */}
                    {strategyLabel && (
                        <div className="flex items-center gap-1">
                            <Zap className="w-3 h-3 text-violet-400" />
                            <span className="text-white/70">{strategyLabel}</span>
                        </div>
                    )}

                    {/* Risk Gate */}
                    {riskGate && (
                        <div className="flex items-center gap-1">
                            <Shield className={`w-3 h-3 ${riskGateColor}`} />
                            <span className={`${riskGateColor} font-medium`}>
                                {riskGate === 'ALLOW_TRADE' ? 'OK' : riskGate === 'REDUCED_RISK' ? 'Reduced' : 'Halted'}
                            </span>
                        </div>
                    )}
                </div>
            )}

            {!autoModeEnabled && (
                <div className="px-4 py-2.5 text-xs text-white/30">
                    Auto Mode is off — strategy and parameters are manual.
                </div>
            )}

            {/* Expanded details */}
            <AnimatePresence>
                {expanded && autoModeEnabled && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                    >
                        <div className="px-4 pb-3 space-y-2 border-t border-white/5 pt-2">
                            {/* Confidence bar */}
                            {confidencePct !== null && (
                                <div>
                                    <div className="flex items-center justify-between text-xs mb-1">
                                        <span className="text-white/40">Regime Confidence</span>
                                        <span className="text-white/60">{confidencePct}%</span>
                                    </div>
                                    <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                                        <div
                                            className={`h-full rounded-full transition-all duration-500 ${
                                                confidencePct > 70
                                                    ? 'bg-emerald-400'
                                                    : confidencePct > 40
                                                    ? 'bg-amber-400'
                                                    : 'bg-red-400'
                                            }`}
                                            style={{ width: `${confidencePct}%` }}
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Last switch reason */}
                            {switchReason && (
                                <div className="flex items-start gap-1.5 text-xs">
                                    <ArrowRightLeft className="w-3 h-3 text-white/30 mt-0.5 shrink-0" />
                                    <span className="text-white/40">Last switch: {switchReason}</span>
                                </div>
                            )}

                            {/* Correlation ID for audit */}
                            {correlationId && (
                                <div className="text-[10px] text-white/20 font-mono truncate">
                                    ID: {correlationId}
                                </div>
                            )}

                            {/* Why panel */}
                            <div className="text-[10px] text-white/20 mt-1">
                                The Smart Layer automatically adjusts cooldown, concurrent trades, confidence thresholds, and risk gates based on detected market regime. Stake, SL, and TP are never modified.
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
