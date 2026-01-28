import { useEffect, useRef } from 'react';
import { useTradingStore } from '@/store/tradingStore';
import { apiUrl } from '@/lib/api';

export function useBotStream(botRunId: string | null) {
    const eventSourceRef = useRef<EventSource | null>(null);
    const addLog = useTradingStore((state) => state.addLog);

    useEffect(() => {
        if (!botRunId) {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }
            return;
        }

        // Close existing connection if any
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }

        const url = apiUrl(`/api/bot-runs/${botRunId}/stream`);
        const es = new EventSource(url, { withCredentials: true });
        eventSourceRef.current = es;

        es.onopen = () => {
            console.log('Bot stream connected');
        };

        es.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.ok) return; // handshake
                if (payload.type === 'log') {
                    // payload.data is the log entry
                    const log = payload.data;
                    // Log level mapping handled in store or here?
                    // Store expects: type: 'info' | 'error' | 'signal' | 'trade' | 'result'
                    // Backend sends: level: 'trade' | 'error' | 'info' | 'signal' | 'result'
                    // It matches directly.
                    addLog(log.level, log.message, log.data);
                } else if (payload.type === 'status') {
                    // Handle status updates if needed
                    console.log('Bot status update:', payload.status);
                    if (payload.status === 'stopped') {
                        addLog('info', 'Bot stopped (remote)');
                        es.close();
                    }
                }
            } catch (error) {
                console.error('Failed to parse bot stream message', error);
            }
        };

        es.onerror = (error) => {
            console.error('Bot stream error', error);
            // EventSource auto-reconnects, but if it's 401/403/404 we might want to close
            if (es.readyState === EventSource.CLOSED) {
                // Closed
            }
        };

        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }
        };
    }, [botRunId, addLog]);
}
