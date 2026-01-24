'use client';

import dynamic from 'next/dynamic';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorFallback } from '@/components/ui/ErrorFallback';
import NotificationsPanel from '@/components/dashboard/NotificationsPanel';

const PerformanceHeatmap = dynamic(() => import('@/components/analytics/PerformanceHeatmap'), { ssr: false });

function DashboardContent() {
    return (
        <div className="relative min-h-screen">
            <div className="mx-auto w-full max-w-6xl px-6 py-8">
                <div className="mb-6 flex flex-col gap-2">
                    <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
                    <p className="text-sm text-muted-foreground">
                        Performance snapshot and recent activity across your bots.
                    </p>
                </div>

                <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr,1fr]">
                    <section className="glass-panel rounded-2xl p-6">
                        <div className="mb-4 flex items-center justify-between">
                            <h3 className="text-lg font-semibold">Performance Overview</h3>
                            <span className="text-xs uppercase tracking-widest text-muted-foreground">Last 30 days</span>
                        </div>
                        <PerformanceHeatmap />
                    </section>

                    <NotificationsPanel />
                </div>
            </div>
        </div>
    );
}

export default function DashboardPage() {
    return (
        <ErrorBoundary FallbackComponent={ErrorFallback}>
            <DashboardContent />
        </ErrorBoundary>
    );
}
