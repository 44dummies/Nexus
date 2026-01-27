import { Router } from 'express';
import { getSupabaseClient } from '../lib/supabaseAdmin';
import { parseLimitParam } from '../lib/requestUtils';
import { requireAuth } from '../lib/authMiddleware';

const router = Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
    const { client: supabaseClient, error: configError, missing } = getSupabaseClient();
    if (!supabaseClient) {
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const limit = parseLimitParam(req.query.limit as string | undefined, 20, 100);
    const type = typeof req.query.type === 'string' ? req.query.type : null;
    const unreadOnly = req.query.unread === 'true';

    const activeAccount = req.auth?.accountId;
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    let query = supabaseClient
        .from('notifications')
        .select('id, title, body, type, data, created_at, read_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (type) {
        query = query.eq('type', type);
    }
    if (unreadOnly) {
        query = query.is('read_at', null);
    }

    const { data, error: queryError } = await query;
    if (queryError) {
        console.error('Supabase notifications query failed', { error: queryError });
        return res.status(500).json({
            error: queryError.message,
            code: queryError.code,
            hint: queryError.hint,
            details: queryError.details,
        });
    }

    return res.json({ notifications: data || [] });
});

router.post('/', async (req, res) => {
    const { client: supabaseClient, error: configError, missing } = getSupabaseClient();
    if (!supabaseClient) {
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const activeAccount = req.auth?.accountId;
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    if (action !== 'mark-read') {
        return res.status(400).json({ error: 'Unsupported action' });
    }

    const now = new Date().toISOString();
    const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string')
        : [];
    const markAll = req.body?.all === true;

    let query = supabaseClient
        .from('notifications')
        .update({ read_at: now })
        .eq('account_id', activeAccount);

    if (markAll) {
        query = query.is('read_at', null);
    } else if (ids.length > 0) {
        query = query.in('id', ids);
    } else {
        return res.status(400).json({ error: 'No notifications provided' });
    }

    const { data, error: updateError } = await query.select('id, read_at');
    if (updateError) {
        console.error('Supabase notifications update failed', { error: updateError });
        return res.status(500).json({
            error: updateError.message,
            code: updateError.code,
            hint: updateError.hint,
            details: updateError.details,
        });
    }

    return res.json({ success: true, updated: data || [] });
});

export default router;
