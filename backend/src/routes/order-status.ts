import { Router } from 'express';
import { classifySupabaseError, getSupabaseAdmin } from '../lib/supabaseAdmin';
import { parseLimitParam } from '../lib/requestUtils';
import { requireAuth } from '../lib/authMiddleware';
import { tradeLogger } from '../lib/logger';
import { metrics } from '../lib/metrics';

const router = Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
    const { client: supabaseClient, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseClient) {
        metrics.counter('order_status.db_unavailable');
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const limit = parseLimitParam(req.query.limit as string | undefined, 50, 200);
    const contractId = req.query.contractId as string | undefined;

    const activeAccount = req.auth?.accountId;
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    let query = supabaseClient
        .from('order_status')
        .select('id, contract_id, trade_id, event, status, price, latency_ms, payload, created_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (contractId) {
        const parsedContractId = Number(contractId);
        // SEC: API-05 - Validate contractId is a valid positive integer
        if (!Number.isFinite(parsedContractId) || parsedContractId <= 0 || !Number.isInteger(parsedContractId)) {
            return res.status(400).json({ error: 'Invalid contractId - must be a positive integer' });
        }
        query = query.eq('contract_id', parsedContractId);
    }

    const { data, error: queryError } = await query;
    if (queryError) {
        const info = classifySupabaseError(queryError);
        tradeLogger.error({ error: info.message, code: info.code, category: info.category }, 'Supabase order status query failed');
        metrics.counter('order_status.db_query_error');
        return res.status(500).json({
            error: info.message,
            code: info.code,
            category: info.category,
        });
    }

    return res.json({ events: data || [] });
});

export default router;
