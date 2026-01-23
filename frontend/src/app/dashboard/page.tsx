'use client';

import dynamic from 'next/dynamic';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorFallback } from '@/components/ui/ErrorFallback';
import NotificationsPanel from '@/components/dashboard/NotificationsPanel';

const PerformanceHeatmap = dynamic(() => import('@/components/analytics/PerformanceHeatmap'), { ssr: false });

function DashboardContent() {
    return (
        <div className="relative min-h-screen">
            {/* Main Content */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Performance Heatmap (Summary) */}
                <div>
                    <h3 className="text-lg font-semibold mb-4">Performance Overview</h3>
                    <PerformanceHeatmap />
                </div>

                <NotificationsPanel />
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
