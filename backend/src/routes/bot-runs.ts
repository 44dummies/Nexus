import { Router } from 'express';
import { getSupabaseClient } from '../lib/supabaseAdmin';
import {
    startBotRun,
    stopBotRun,
    pauseBotRun,
    resumeBotRun,
    getBotRunStatus,
    getAccountBotRuns,
    hasActiveBackendRun,
} from '../lib/botController';
import {
    StartBackendSchema,
    StopBackendSchema,
    StartBotSchema,
    StopBotSchema,
    PauseBackendSchema,
    ResumeBackendSchema,
    StatusBackendSchema
} from '../lib/validation';
import { requireAuth } from '../lib/authMiddleware';

const router = Router();
router.use(requireAuth);

type BotRunStatus = ReturnType<typeof getBotRunStatus>;

export function enforceRunOwnership(activeAccount: string, runId: string): { status: number; error?: string; run?: BotRunStatus } {
    const status = getBotRunStatus(runId);
    if (!status) {
        return { status: 404, error: 'Bot run not found' };
    }
    if (status.accountId !== activeAccount) {
        return { status: 403, error: 'Unauthorized' };
    }
    return { status: 200, run: status };
}

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

    if (action === 'start') {
        const validation = StartBotSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid payload', details: validation.error.format() });
        }
        const { botId, config } = validation.data;
        const now = new Date().toISOString();

        const { error: stopError } = await supabaseClient
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

        const { data, error: insertError } = await supabaseClient
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
        const validation = StopBotSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid payload', details: validation.error.format() });
        }
        const { runId } = validation.data;
        if (runId) {
            const { error: stopError } = await supabaseClient
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

        const { error: stopError } = await supabaseClient
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

        const { botId, symbol, stake, maxStake, duration, durationUnit, cooldownMs, strategyConfig, risk, performance, entry } = validation.data;

        const auth = req.auth;
        if (!auth?.token) {
            return res.status(401).json({ error: 'User not authenticated' });
        }

        if (hasActiveBackendRun(activeAccount)) {
            return res.status(400).json({ error: 'Account already has an active backend bot run' });
        }

        const { data: existingRuns } = await supabaseClient
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

        const now = new Date().toISOString();
        const { data, error: insertError } = await supabaseClient
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
                    performance,
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
                auth.accountType,
                auth.token,
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
                    performance,
                },
                auth.currency || 'USD'
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
            const ownership = enforceRunOwnership(activeAccount, runId);
            if (ownership.status !== 200) {
                return res.status(ownership.status).json({ error: ownership.error });
            }
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
        const validation = PauseBackendSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid payload', details: validation.error.format() });
        }
        const { runId, reason } = validation.data;

        const ownership = enforceRunOwnership(activeAccount, runId);
        if (ownership.status !== 200) {
            return res.status(ownership.status).json({ error: ownership.error });
        }

        await pauseBotRun(runId, reason);
        return res.json({ success: true });
    }

    if (action === 'resume-backend') {
        const validation = ResumeBackendSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid payload', details: validation.error.format() });
        }
        const { runId } = validation.data;

        const ownership = enforceRunOwnership(activeAccount, runId);
        if (ownership.status !== 200) {
            return res.status(ownership.status).json({ error: ownership.error });
        }

        await resumeBotRun(runId);
        return res.json({ success: true });
    }

    if (action === 'status-backend') {
        const validation = StatusBackendSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid payload', details: validation.error.format() });
        }
        const { runId } = validation.data;

        if (runId) {
            const ownership = enforceRunOwnership(activeAccount, runId);
            if (ownership.status !== 200 || !ownership.run) {
                return res.status(ownership.status).json({ error: ownership.error });
            }
            const status = ownership.run;
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
