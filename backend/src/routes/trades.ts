import { Router } from 'express';
import { classifySupabaseError, getSupabaseAdmin } from '../lib/supabaseAdmin';
import { parseLimitParam } from '../lib/requestUtils';
import { subscribeTradeStream } from '../lib/tradeStream';
import { subscribePnLStream, getPnLSnapshot } from '../lib/pnlTracker';
import { executeTradeServerFast } from '../trade';
import { requireAuth } from '../lib/authMiddleware';
import { tradeRateLimit } from '../lib/rateLimit';
import { tradeLogger } from '../lib/logger';
import { metrics } from '../lib/metrics';
import { shouldAcceptWork } from '../lib/resourceMonitor';
import { ExecutionError } from '../lib/executionEngine';

const router = Router();

// Secure all trade routes with server-side auth
router.use(requireAuth);

// Apply trade-specific rate limits (50/min per account)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
router.use(tradeRateLimit as any);

router.get('/', async (req, res) => {
    const { client: supabaseClient, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseClient) {
        metrics.counter('trade.db_unavailable');
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const limit = parseLimitParam(req.query.limit as string | undefined, 50, 1000);
    const activeAccount = req.auth?.accountId;

    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    const { data, error: queryError } = await supabaseClient
        .from('trades')
        .select('id, contract_id, symbol, stake, duration, duration_unit, profit, buy_price, payout, direction, status, bot_id, bot_run_id, entry_profile_id, created_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (queryError) {
        const info = classifySupabaseError(queryError);
        tradeLogger.error({ error: info.message, code: info.code, category: info.category }, 'Supabase trades query failed');
        metrics.counter('trade.db_query_error');
        return res.status(500).json({
            error: info.message,
            code: info.code,
            category: info.category,
        });
    }

    return res.json({ trades: data || [] });
});

router.get('/stream', (req, res) => {
    const activeAccount = req.auth?.accountId;

    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    res.write(`event: ready\ndata: {"ok":true}\n\n`);

    const unsubscribe = subscribeTradeStream(activeAccount, res);

    req.on('close', () => {
        unsubscribe();
    });
});

router.post('/execute', async (req, res) => {
    const signal = typeof req.body?.signal === 'string' ? req.body.signal : '';
    const params = req.body || {};

    const auth = req.auth;
    if (!auth?.token || !auth.accountId) {
        return res.status(401).json({ error: 'User not authenticated' });
    }

    const resourceCheck = shouldAcceptWork();
    if (!resourceCheck.ok) {
        metrics.counter('trade.rejected_resource_circuit');
        return res.status(503).json({ error: 'System under load', code: 'RESOURCE_CIRCUIT_OPEN', detail: resourceCheck.reason });
    }

    try {
        const result = await executeTradeServerFast(signal as 'CALL' | 'PUT', params, {
            token: auth.token,
            accountId: auth.accountId,
            accountType: auth.accountType,
            accountCurrency: auth.currency || undefined,
        });
        return res.json(result);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Trade execution failed';
        if (error instanceof ExecutionError) {
            return res.status(400).json({ error: message, code: error.code, retryable: error.retryable, context: error.context ?? null });
        }
        return res.status(400).json({ error: message });
    }
});

/**
 * GET /api/trades/pnl — Current PnL snapshot (polling fallback)
 */
router.get('/pnl', (req, res) => {
    const activeAccount = req.auth?.accountId;
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    const snapshot = getPnLSnapshot(activeAccount);
    if (!snapshot) {
        return res.json({
            realizedPnL: 0,
            unrealizedPnL: 0,
            netPnL: 0,
            openPositionCount: 0,
            openExposure: 0,
            winCount: 0,
            lossCount: 0,
            avgWin: 0,
            avgLoss: 0,
            balanceDrift: null,
            lastKnownBalance: null,
            lastUpdated: Date.now(),
            positions: [],
        });
    }

    return res.json(snapshot);
});

/**
 * GET /api/trades/pnl/stream — Real-time PnL SSE stream
 */
router.get('/pnl/stream', (req, res) => {
    const activeAccount = req.auth?.accountId;
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    res.write(`event: ready\ndata: {"ok":true}\n\n`);

    const unsubscribe = subscribePnLStream(activeAccount, res);

    req.on('close', () => {
        unsubscribe();
    });
});

export default router;
