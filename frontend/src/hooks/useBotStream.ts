import { useEffect, useRef } from 'react';
import { useTradingStore } from '@/store/tradingStore';
import { apiUrl } from '@/lib/api';

export function useBotStream(botRunId: string | null) {
    const eventSourceRef = useRef<EventSource | null>(null);
    const addLog = useTradingStore((state) => state.addLog);
    const updateSmartLayerState = useTradingStore((state) => state.updateSmartLayerState);
    const setCooldownUntil = useTradingStore((state) => state.setCooldownUntil);
    const isAuthorized = useTradingStore((state) => state.isAuthorized);

    useEffect(() => {
        if (!isAuthorized || !botRunId) {
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
                    addLog(log.level, log.message, log.data);
                } else if (payload.type === 'status') {
                    // Handle status updates if needed
                    console.log('Bot status update:', payload.status);
                    if (payload.status === 'stopped') {
                        addLog('info', 'Bot stopped (remote)');
                        es.close();
                    } else if (payload.status === 'paused') {
                        const reason = typeof payload.reason === 'string' && payload.reason.length > 0
                            ? `: ${payload.reason}`
                            : '';
                        addLog('error', `Bot paused${reason}`);
                    }
                } else if (payload.type === 'cooldown') {
                    const d = payload.data;
                    setCooldownUntil(d.cooldownUntil ?? null);
                } else if (payload.type === 'smartlayer') {
                    // Smart Layer telemetry: update regime, strategy, risk gate
                    const d = payload.data;
                    updateSmartLayerState({
                        regime: d.regime ?? null,
                        regimeConfidence: d.regimeConfidence ?? null,
                        activeStrategy: d.strategyId ?? null,
                        riskGate: d.riskGate ?? null,
                        correlationId: d.correlationId ?? null,
                    });
                }
            } catch (error) {
                console.error('Failed to parse bot stream message', error);
            }
        };

        es.onerror = (error) => {
            console.error('Bot stream error', error);
        };

        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }
        };
    }, [botRunId, isAuthorized, addLog, updateSmartLayerState, setCooldownUntil]);
}
