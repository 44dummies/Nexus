import { Router } from 'express';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { getValidatedAccountId, parseLimitParam } from '../lib/requestUtils';
import { clearKillSwitch, triggerKillSwitch } from '../lib/riskManager';

const router = Router();

router.get('/', async (req, res) => {
    const { client: supabaseAdmin, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const limit = parseLimitParam(req.query.limit as string | undefined, 50, 200);
    const type = typeof req.query.type === 'string' ? req.query.type : null;

    const activeAccount = getValidatedAccountId(req);
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    let query = supabaseAdmin
        .from('risk_events')
        .select('id, event_type, detail, metadata, created_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (type) {
        query = query.eq('event_type', type);
    }

    const { data, error: queryError } = await query;
    if (queryError) {
        console.error('Supabase risk events query failed', { error: queryError });
        return res.status(500).json({
            error: queryError.message,
            code: queryError.code,
            hint: queryError.hint,
            details: queryError.details,
        });
    }

    return res.json({ events: data || [] });
});

router.post('/', async (req, res) => {
    const { client: supabaseAdmin, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const activeAccount = getValidatedAccountId(req);
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    const eventType = typeof req.body?.eventType === 'string' ? req.body.eventType : 'unknown';
    const detail = typeof req.body?.detail === 'string' ? req.body.detail : null;
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : null;

    const { error: insertError } = await supabaseAdmin.from('risk_events').insert({
        account_id: activeAccount,
        event_type: eventType,
        detail,
        metadata,
    });

    if (insertError) {
        console.error('Supabase risk events insert failed', { error: insertError });
        return res.status(500).json({
            error: insertError.message,
            code: insertError.code,
            hint: insertError.hint,
            details: insertError.details,
        });
    }

    return res.json({ success: true });
});

router.post('/kill-switch', async (req, res) => {
    const activeAccount = getValidatedAccountId(req);
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    const adminToken = process.env.RISK_ADMIN_TOKEN;
    const providedToken = req.get('x-risk-token');
    if (adminToken && providedToken !== adminToken) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual';
    const scope = typeof req.body?.scope === 'string' ? req.body.scope : 'account';
    const targetAccount = scope === 'global' ? null : activeAccount;

    if (action === 'activate') {
        triggerKillSwitch(targetAccount, reason, true);
        return res.json({ success: true, status: 'active', scope });
    }

    if (action === 'clear') {
        clearKillSwitch(targetAccount);
        return res.json({ success: true, status: 'cleared', scope });
    }

    return res.status(400).json({ error: 'Invalid action' });
});

export default router;
