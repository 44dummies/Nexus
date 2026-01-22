'use client';

import { Square, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BotControlPanelProps {
    botRunning: boolean;
    isAuthorized: boolean;
    onStartBot: () => void;
    onStopBot: () => void;
}

export function BotControlPanel({ botRunning, isAuthorized, onStartBot, onStopBot }: BotControlPanelProps) {
    return (
        <div className="glass-panel rounded-2xl p-6">
            <h2 className="text-lg font-semibold mb-4">Bot Control</h2>

            <div className="flex items-center gap-4 mb-6">
                <div className={`w-4 h-4 rounded-full ${botRunning ? 'bg-emerald-500 animate-pulse shadow-lg shadow-emerald-500/50' : 'bg-gray-500'}`} />
                <span className="text-lg font-medium">
                    {botRunning ? 'Bot is Running' : 'Bot is Stopped'}
                </span>
            </div>

            <Button
                onClick={botRunning ? onStopBot : onStartBot}
                className={`w-full h-14 text-lg font-bold uppercase tracking-wider transition-all ${botRunning
                    ? 'bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 text-white'
                    : 'bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white'
                    }`}
                disabled={!isAuthorized}
            >
                {botRunning ? (
                    <>
                        <Square className="w-5 h-5 mr-2" />
                        Stop Bot
                    </>
                ) : (
                    <>
                        <Play className="w-5 h-5 mr-2" />
                        Start Bot
                    </>
                )}
            </Button>

            {!isAuthorized && (
                <p className="text-sm text-yellow-500 mt-3 text-center">
                    Please login from the Dashboard first
                </p>
            )}
        </div>
    );
}
