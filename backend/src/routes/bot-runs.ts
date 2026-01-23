import { Router } from 'express';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { getActiveAccountId } from '../lib/requestUtils';

const router = Router();

router.post('/', async (req, res) => {
    const { client: supabaseAdmin, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const activeAccount = getActiveAccountId(req);
    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    const action = typeof req.body?.action === 'string' ? req.body.action : '';

    if (action === 'start') {
        const botId = typeof req.body?.botId === 'string' ? req.body.botId : null;
        const config = req.body?.config ?? null;
        const now = new Date().toISOString();

        const { error: stopError } = await supabaseAdmin
            .from('bot_runs')
            .update({ run_status: 'stopped', stopped_at: now })
            .eq('account_id', activeAccount)
            .eq('run_status', 'running');

        if (stopError) {
            console.error('Supabase bot run stop failed', { error: stopError });
            return res.status(500).json({
                error: stopError.message,
                code: stopError.code,
                hint: stopError.hint,
                details: stopError.details,
            });
        }

        const { data, error: insertError } = await supabaseAdmin
            .from('bot_runs')
            .insert({
                account_id: activeAccount,
                bot_id: botId,
                run_status: 'running',
                started_at: now,
                config,
            })
            .select('id')
            .single();

        if (insertError) {
            console.error('Supabase bot run start failed', { error: insertError });
            return res.status(500).json({
                error: insertError.message,
                code: insertError.code,
                hint: insertError.hint,
                details: insertError.details,
            });
        }

        return res.json({ runId: data?.id });
    }

    if (action === 'stop') {
        const runId = typeof req.body?.runId === 'string' ? req.body.runId : null;
        if (runId) {
            const { error: stopError } = await supabaseAdmin
                .from('bot_runs')
                .update({ run_status: 'stopped', stopped_at: new Date().toISOString() })
                .eq('id', runId)
                .eq('account_id', activeAccount);

            if (stopError) {
                console.error('Supabase bot run stop by id failed', { error: stopError });
                return res.status(500).json({
                    error: stopError.message,
                    code: stopError.code,
                    hint: stopError.hint,
                    details: stopError.details,
                });
            }
            return res.json({ success: true });
        }

        const { error: stopError } = await supabaseAdmin
            .from('bot_runs')
            .update({ run_status: 'stopped', stopped_at: new Date().toISOString() })
            .eq('account_id', activeAccount)
            .eq('run_status', 'running');

        if (stopError) {
            console.error('Supabase bot run stop failed', { error: stopError });
            return res.status(500).json({
                error: stopError.message,
                code: stopError.code,
                hint: stopError.hint,
                details: stopError.details,
            });
        }

        return res.json({ success: true });
    }

    return res.status(400).json({ error: 'Unsupported action' });
});

export default router;
