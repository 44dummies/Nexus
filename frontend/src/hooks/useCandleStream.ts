import { useEffect, useRef, useCallback, useState } from 'react';
import { useTradingStore } from '@/store/tradingStore';
import { apiUrl } from '@/lib/api';

// ==================== Types ====================

export interface OHLCCandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    tickCount: number;
    isLive: boolean;
}

export type CandleTimeframe = '1s' | '5s' | '15s' | '1m' | '5m';

type CandleSSEEvent =
    | { type: 'snapshot'; timeframe: CandleTimeframe; candles: OHLCCandle[] }
    | { type: 'open' | 'update' | 'close'; timeframe: CandleTimeframe; candle: OHLCCandle };

// ==================== Hook ====================

/**
 * Hook to subscribe to real-time server-side OHLC candle stream.
 * Replaces the naive client-side tick aggregation with proper time-aligned candles.
 *
 * @param symbol - Market symbol (e.g. 'R_50')
 * @param timeframe - Candle timeframe ('1s', '5s', '15s', '1m', '5m')
 * @param enabled - Whether the stream should be active
 */
export function useCandleStream(
    symbol: string | null,
    timeframe: CandleTimeframe = '5s',
    enabled: boolean = true,
) {
    const eventSourceRef = useRef<EventSource | null>(null);
    const isAuthorized = useTradingStore((s) => s.isAuthorized);

    const [candles, setCandles] = useState<OHLCCandle[]>([]);
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const connect = useCallback(() => {
        if (!isAuthorized || !symbol || !enabled) return;

        // Close existing connection
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
        }

        const url = apiUrl(`/api/trades/candles/stream?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`);
        const es = new EventSource(url, { withCredentials: true });
        eventSourceRef.current = es;

        es.onopen = () => {
            setIsConnected(true);
            setError(null);
        };

        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data) as CandleSSEEvent;

                if (data.type === 'snapshot') {
                    // Initial snapshot — replace all candles
                    setCandles(data.candles);
                } else if (data.type === 'close') {
                    // A candle has closed — append it and remove the live candle that was tracking it
                    setCandles(prev => {
                        const closed = { ...data.candle, isLive: false };
                        // Remove any existing candle with same time, then append
                        const filtered = prev.filter(c => c.time !== closed.time);
                        return [...filtered, closed];
                    });
                } else if (data.type === 'open') {
                    // New live candle started
                    setCandles(prev => [...prev, data.candle]);
                } else if (data.type === 'update') {
                    // Update the current live candle
                    setCandles(prev => {
                        const idx = prev.findIndex(c => c.time === data.candle.time);
                        if (idx >= 0) {
                            const next = [...prev];
                            next[idx] = data.candle;
                            return next;
                        }
                        return [...prev, data.candle];
                    });
                }
            } catch {
                // Ignore parse errors
            }
        };

        es.onerror = () => {
            setIsConnected(false);
            setError('Connection lost, reconnecting...');
            // EventSource auto-reconnects
        };

        return es;
    }, [isAuthorized, symbol, timeframe, enabled]);

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
            setIsConnected(false);
        };
    }, [connect]);

    // Reset candles when symbol or timeframe changes
    useEffect(() => {
        setCandles([]);
    }, [symbol, timeframe]);

    return {
        candles,
        isConnected,
        error,
    };
}
