import { Router } from 'express';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { parseLimitParam } from '../lib/requestUtils';
import { clearKillSwitch, triggerKillSwitch } from '../lib/riskManager';
import { requireAuth } from '../lib/authMiddleware';
import { riskLogger } from '../lib/logger';
import { assertKillSwitchAuthorization } from '../lib/killSwitchAuth';

const router = Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
    const { client: supabaseClient, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseClient) {
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const limit = parseLimitParam(req.query.limit as string | undefined, 50, 200);
    const type = typeof req.query.type === 'string' ? req.query.type : null;

    const activeAccount = req.auth?.accountId;
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    let query = supabaseClient
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
    const { client: supabaseClient, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseClient) {
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const activeAccount = req.auth?.accountId;
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    const eventType = typeof req.body?.eventType === 'string' ? req.body.eventType : 'unknown';
    const detail = typeof req.body?.detail === 'string' ? req.body.detail : null;
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : null;

    const { error: insertError } = await supabaseClient.from('risk_events').insert({
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
    const activeAccount = req.auth?.accountId;
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    const providedToken = req.get('x-risk-token');

    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual';
    const scope = typeof req.body?.scope === 'string' ? req.body.scope : 'account';
    const targetAccount = scope === 'global' ? null : activeAccount;

    const authz = assertKillSwitchAuthorization(scope, providedToken);
    if (!authz.ok) {
        return res.status(authz.status).json({ error: authz.error });
    }

    if (action === 'activate') {
        triggerKillSwitch(targetAccount, reason, true);
        riskLogger.info({
            requestId: req.requestId,
            actorAccountId: activeAccount,
            scope,
            action,
        }, 'Kill switch activated');
        return res.json({ success: true, status: 'active', scope });
    }

    if (action === 'clear') {
        clearKillSwitch(targetAccount);
        riskLogger.info({
            requestId: req.requestId,
            actorAccountId: activeAccount,
            scope,
            action,
        }, 'Kill switch cleared');
        return res.json({ success: true, status: 'cleared', scope });
    }

    return res.status(400).json({ error: 'Invalid action' });
});

export default router;
