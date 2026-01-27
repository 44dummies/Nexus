import { Router } from 'express';
import { getSupabaseClient } from '../lib/supabaseAdmin';
import { parseLimitParam } from '../lib/requestUtils';
import { subscribeTradeStream } from '../lib/tradeStream';
import { executeTradeServer, executeTradeServerFast } from '../trade';
import { requireAuth } from '../lib/authMiddleware';
import { tradeRateLimit } from '../lib/rateLimit';

const router = Router();

// Secure all trade routes with server-side auth
router.use(requireAuth);

// Apply trade-specific rate limits (50/min per account)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
router.use(tradeRateLimit as any);

router.get('/', async (req, res) => {
    const { client: supabaseClient, error: configError, missing } = getSupabaseClient();
    if (!supabaseClient) {
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const limit = parseLimitParam(req.query.limit as string | undefined, 50, 1000);
    const activeAccount = req.auth?.accountId;

    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    const { data, error: queryError } = await supabaseClient
        .from('trades')
        .select('id, contract_id, symbol, stake, duration, duration_unit, profit, status, bot_id, bot_run_id, entry_profile_id, created_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (queryError) {
        console.error('Supabase trades query failed', { error: queryError });
        return res.status(500).json({
            error: queryError.message,
            code: queryError.code,
            hint: queryError.hint,
            details: queryError.details,
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

    try {
        // Use fast execution by default, fall back to slow if useFast=false
        const useFast = req.body?.useFast !== false;

        if (useFast) {
            const result = await executeTradeServerFast(signal as 'CALL' | 'PUT', params, {
                token: auth.token,
                accountId: auth.accountId,
                accountType: auth.accountType,
                accountCurrency: auth.currency || undefined,
            });
            return res.json(result);
        } else {
            const result = await executeTradeServer(signal as 'CALL' | 'PUT', params, {
                token: auth.token,
                accountId: auth.accountId,
                accountType: auth.accountType,
                accountCurrency: auth.currency || undefined,
            });
            return res.json(result);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Trade execution failed';
        return res.status(400).json({ error: message });
    }
});

export default router;
