import { Router } from 'express';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { getValidatedAccountId } from '../lib/requestUtils';
import {
    startBotRun,
    stopBotRun,
    pauseBotRun,
    resumeBotRun,
    getBotRunStatus,
    getAccountBotRuns,
    hasActiveBackendRun,
} from '../lib/botController';
import { StartBackendSchema, StopBackendSchema } from '../lib/validation';

const router = Router();

router.post('/', async (req, res) => {
    const { client: supabaseAdmin, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const activeAccount = getValidatedAccountId(req);
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

    // ==================== BACKEND MODE ACTIONS ====================



    if (action === 'start-backend') {
        const validation = StartBackendSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid configuration', details: validation.error.format() });
        }

        const { botId, symbol, stake, maxStake, duration, durationUnit, cooldownMs, strategyConfig, risk, entry } = validation.data;

        // IMPORTANT: Select token based on active account type to prevent cross-mode trading
        const accountType = req.cookies?.deriv_active_type === 'demo' ? 'demo' : 'real';
        const token = accountType === 'demo'
            ? req.cookies?.deriv_demo_token
            : req.cookies?.deriv_token;
        const currency = accountType === 'demo'
            ? (req.cookies?.deriv_demo_currency || 'USD')
            : (req.cookies?.deriv_currency || 'USD');

        if (!token) {
            return res.status(401).json({
                error: `No Deriv ${accountType} token available. Please log in with a ${accountType} account.`
            });
        }

        // Check if already has backend run (in-memory)
        if (hasActiveBackendRun(activeAccount)) {
            return res.status(400).json({ error: 'Account already has an active backend bot run' });
        }

        // Also check DB for active backend runs (in case of server restart or multi-instance)
        const { data: existingRuns } = await supabaseAdmin
            .from('bot_runs')
            .select('id')
            .eq('account_id', activeAccount)
            .eq('backend_mode', true)
            .eq('run_status', 'running')
            .limit(1);

        if (existingRuns && existingRuns.length > 0) {
            return res.status(400).json({
                error: 'Account has an active backend bot run in database. Stop it first or wait for it to finish.',
                activeRunId: existingRuns[0].id
            });
        }

        // Create DB record first
        const now = new Date().toISOString();
        const { data, error: insertError } = await supabaseAdmin
            .from('bot_runs')
            .insert({
                account_id: activeAccount,
                bot_id: botId,
                run_status: 'running',
                started_at: now,
                backend_mode: true,
                config: {
                    symbol,
                    stake,
                    maxStake,
                    duration,
                    durationUnit,
                    cooldownMs,
                    strategyConfig,
                    risk,
                },
            })
            .select('id')
            .single();

        if (insertError) {
            console.error('Supabase bot run start failed', { error: insertError });
            return res.status(500).json({ error: insertError.message });
        }

        const runId = data?.id;
        if (!runId) {
            return res.status(500).json({ error: 'Failed to create bot run' });
        }

        try {
            await startBotRun(
                runId,
                activeAccount,
                accountType as 'real' | 'demo',
                token,
                {
                    strategyId: botId,
                    symbol,
                    stake,
                    maxStake,
                    duration,
                    durationUnit,
                    cooldownMs,
                    strategyConfig,
                    risk,
                },
                currency
            );

            return res.json({ runId, mode: 'backend', status: 'running' });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to start backend bot';
            return res.status(500).json({ error: message });
        }
    }



    if (action === 'stop-backend') {
        const validation = StopBackendSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid payload', details: validation.error.format() });
        }
        const { runId } = validation.data;

        if (runId) {
            await stopBotRun(runId);
            return res.json({ success: true });
        }

        // Stop all backend runs for this account
        const runs = getAccountBotRuns(activeAccount);
        for (const run of runs) {
            await stopBotRun(run.id);
        }
        return res.json({ success: true, stoppedCount: runs.length });
    }

    if (action === 'pause-backend') {
        const runId = typeof req.body?.runId === 'string' ? req.body.runId : null;
        const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

        if (!runId) {
            return res.status(400).json({ error: 'runId required' });
        }

        await pauseBotRun(runId, reason);
        return res.json({ success: true });
    }

    if (action === 'resume-backend') {
        const runId = typeof req.body?.runId === 'string' ? req.body.runId : null;

        if (!runId) {
            return res.status(400).json({ error: 'runId required' });
        }

        await resumeBotRun(runId);
        return res.json({ success: true });
    }

    if (action === 'status-backend') {
        const runId = typeof req.body?.runId === 'string' ? req.body.runId : null;

        if (runId) {
            const status = getBotRunStatus(runId);
            if (!status) {
                return res.json({ active: false });
            }
            return res.json({
                active: true,
                id: status.id,
                status: status.status,
                strategyId: status.config.strategyId,
                symbol: status.config.symbol,
                tradesExecuted: status.tradesExecuted,
                totalProfit: status.totalProfit,
                startedAt: status.startedAt.toISOString(),
            });
        }

        // Return all backend runs for account
        const runs = getAccountBotRuns(activeAccount);
        return res.json({
            hasBackendRuns: runs.length > 0,
            runs: runs.map(r => ({
                id: r.id,
                status: r.status,
                strategyId: r.config.strategyId,
                symbol: r.config.symbol,
                tradesExecuted: r.tradesExecuted,
                totalProfit: r.totalProfit,
            })),
        });
    }

    return res.status(400).json({ error: 'Unsupported action' });
});

export default router;

