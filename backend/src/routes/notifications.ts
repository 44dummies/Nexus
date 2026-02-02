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
        metrics.counter('notifications.db_unavailable');
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
        const info = classifySupabaseError(queryError);
        tradeLogger.error({ error: info.message, code: info.code, category: info.category }, 'Supabase notifications query failed');
        metrics.counter('notifications.db_query_error');
        return res.status(500).json({
            error: info.message,
            code: info.code,
            category: info.category,
        });
    }

    return res.json({ notifications: data || [] });
});

router.post('/', async (req, res) => {
    const { client: supabaseClient, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseClient) {
        metrics.counter('notifications.db_unavailable');
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
    const MAX_BATCH_SIZE = 100; // SEC: API-04 - Prevent DoS via huge batch
    const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string').slice(0, MAX_BATCH_SIZE)
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
        const info = classifySupabaseError(updateError);
        tradeLogger.error({ error: info.message, code: info.code, category: info.category }, 'Supabase notifications update failed');
        metrics.counter('notifications.db_update_error');
        return res.status(500).json({
            error: info.message,
            code: info.code,
            category: info.category,
        });
    }

    return res.json({ success: true, updated: data || [] });
});

export default router;
