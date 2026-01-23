import { Router } from 'express';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { getActiveAccountId, parseLimitParam } from '../lib/requestUtils';

const router = Router();

router.get('/', async (req, res) => {
    const { client: supabaseAdmin, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const limit = parseLimitParam(req.query.limit as string | undefined, 50, 200);
    const contractId = req.query.contractId as string | undefined;

    const activeAccount = getActiveAccountId(req);
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    let query = supabaseAdmin
        .from('order_status')
        .select('id, contract_id, trade_id, event, status, price, latency_ms, payload, created_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (contractId) {
        query = query.eq('contract_id', Number(contractId));
    }

    const { data, error: queryError } = await query;
    if (queryError) {
        console.error('Supabase order status query failed', { error: queryError });
        return res.status(500).json({
            error: queryError.message,
            code: queryError.code,
            hint: queryError.hint,
            details: queryError.details,
        });
    }

    return res.json({ events: data || [] });
});

export default router;
