'use client';

import { FallbackProps } from 'react-error-boundary';
import { AlertTriangle, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GlassCard } from '@/components/ui/GlassCard';

export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
    return (
        <div className="flex items-center justify-center min-h-[400px] w-full p-4">
            <GlassCard className="max-w-md w-full p-8 text-center bg-red-500/5 border-red-500/20">
                <div className="flex justify-center mb-6">
                    <div className="p-4 rounded-full bg-red-500/10 text-red-500 shadow-[0_0_20px_rgba(239,68,68,0.3)]">
                        <AlertTriangle className="w-12 h-12" />
                    </div>
                </div>

                <h2 className="text-2xl font-bold mb-2">Something went wrong</h2>
                <div className="bg-black/20 rounded-lg p-3 mb-6 overflow-auto max-h-32 text-left">
                    <p className="text-red-400 font-mono text-xs break-all">
                        {(error as Error).message || 'An unexpected error occurred.'}
                    </p>
                </div>

                <div className="flex flex-col sm:flex-row justify-center gap-3">
                    <Button
                        onClick={resetErrorBoundary}
                        variant="default"
                        className="bg-red-600 hover:bg-red-700 text-white border-none shadow-lg shadow-red-900/20"
                    >
                        <RefreshCcw className="w-4 h-4 mr-2" />
                        Try Again
                    </Button>
                    <Button
                        onClick={() => window.location.reload()}
                        variant="outline"
                        className="border-red-500/20 hover:bg-red-500/10"
                    >
                        Reload Page
                    </Button>
                </div>
            </GlassCard>
        </div>
    );
}
