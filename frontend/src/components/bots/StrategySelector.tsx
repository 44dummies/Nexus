'use client';

import { useState } from 'react';
import { Zap, ChevronDown } from 'lucide-react';

interface Strategy {
    id: string;
    name: string;
    description: string;
    risk: 'Low' | 'Medium' | 'High';
}

const strategies: Strategy[] = [
    { id: 'rsi', name: 'RSI Strategy', description: 'Buy when RSI < 30, Sell when RSI > 70', risk: 'Medium' },
    { id: 'martingale', name: 'Martingale', description: 'Double stake after loss', risk: 'High' },
    { id: 'anti-martingale', name: 'Anti-Martingale', description: 'Double stake after win', risk: 'High' },
    { id: 'fixed', name: 'Fixed Stake', description: 'Constant stake amount', risk: 'Low' },
];

interface StrategySelectorProps {
    selectedStrategy: string;
    onSelectStrategy: (id: string) => void;
}

export function StrategySelector({ selectedStrategy, onSelectStrategy }: StrategySelectorProps) {
    const [showStrategies, setShowStrategies] = useState(false);

    const currentStrategy = strategies.find(s => s.id === selectedStrategy);

    return (
        <div className="glass-panel rounded-2xl p-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Zap className="w-5 h-5 text-accent" />
                Trading Strategy
            </h2>

            <div className="relative">
                <button
                    onClick={() => setShowStrategies(!showStrategies)}
                    className="w-full flex items-center justify-between p-4 rounded-xl bg-muted/50 border border-border hover:border-accent/50 transition-all"
                >
                    <div className="text-left">
                        <p className="font-medium">{currentStrategy?.name}</p>
                        <p className="text-sm text-muted-foreground">{currentStrategy?.description}</p>
                    </div>
                    <ChevronDown className={`w-5 h-5 transition-transform ${showStrategies ? 'rotate-180' : ''}`} />
                </button>

                {showStrategies && (
                    <div className="absolute top-full left-0 right-0 mt-2 bg-card border border-border rounded-xl shadow-xl z-10 overflow-hidden">
                        {strategies.map((strategy) => (
                            <button
                                key={strategy.id}
                                onClick={() => {
                                    onSelectStrategy(strategy.id);
                                    setShowStrategies(false);
                                }}
                                className={`w-full p-4 text-left hover:bg-muted/50 transition-colors ${selectedStrategy === strategy.id ? 'bg-accent/10' : ''}`}
                            >
                                <div className="flex justify-between items-start">
                                    <div>
                                        <p className="font-medium">{strategy.name}</p>
                                        <p className="text-sm text-muted-foreground">{strategy.description}</p>
                                    </div>
                                    <span className={`text-xs px-2 py-1 rounded ${strategy.risk === 'Low' ? 'bg-emerald-500/20 text-emerald-400' :
                                        strategy.risk === 'Medium' ? 'bg-yellow-500/20 text-yellow-400' :
                                            'bg-red-500/20 text-red-400'
                                        }`}>
                                        {strategy.risk}
                                    </span>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export { strategies }; // Export for usage elsewhere if needed, or keeping validation consistent
