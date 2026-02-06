'use client';

import { useBotStream } from '@/hooks/useBotStream';
import { usePnLStream } from '@/hooks/usePnLStream';
import { useTradingStore } from '@/store/tradingStore';

export default function TradingStreamMonitor() {
    const activeRunId = useTradingStore((s) => s.activeRunId);
    const isAuthorized = useTradingStore((s) => s.isAuthorized);

    usePnLStream(isAuthorized);
    useBotStream(isAuthorized ? activeRunId : null);

    return null;
}
