import { useEffect, useRef, useCallback } from 'react';
import { useTradingStore } from '@/store/tradingStore';
import { apiUrl } from '@/lib/api';

/**
 * Hook to subscribe to real-time PnL SSE stream from backend.
 * Updates the trading store with realized/unrealized PnL, win/loss stats, and open positions.
 */
export function usePnLStream() {
    const eventSourceRef = useRef<EventSource | null>(null);
    const isAuthorized = useTradingStore((s) => s.isAuthorized);
    const updatePnL = useTradingStore((s) => s.updatePnL);

    const connect = useCallback(() => {
        if (!isAuthorized) return;

        // Close existing connection
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }

        const url = apiUrl('/api/trades/pnl/stream');
        const es = new EventSource(url, { withCredentials: true });
        eventSourceRef.current = es;

        es.addEventListener('pnl', (event) => {
            try {
                const data = JSON.parse(event.data);
                updatePnL(data);
            } catch {
                // ignore parse errors
            }
        });

        es.onerror = () => {
            // Auto-reconnect is handled by EventSource
        };

        return es;
    }, [isAuthorized, updatePnL]);

    useEffect(() => {
        const es = connect();

        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }
            if (es) {
                es.close();
            }
        };
    }, [connect]);
}
