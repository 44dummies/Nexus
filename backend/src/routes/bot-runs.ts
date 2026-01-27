import { Router } from 'express';
import { getSupabaseClient } from '../lib/supabaseAdmin';
import {
    startBotRun,
    stopBotRun,
    pauseBotRun,
    resumeBotRun,
    getBotRunStatus,
    hasActiveBackendRun,
    getActiveBackendRun,
    stopActiveBackendRun,
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
            // Check if it's a zombie run (DB says running, but memory says no)
            // We already checked hasActiveBackendRun(activeAccount) above, so we know it's not running in memory.
            // This happens if the server restarted while a bot was running.
            // We should auto-resolve this by marking the old run as stopped.

            const zombieRunId = existingRuns[0].id;
            console.warn(`Found zombie backend bot run ${zombieRunId}. Marking as stopped.`);

            const { error: stopError } = await supabaseClient
                .from('bot_runs')
                .update({
                    run_status: 'stopped',
                    stopped_at: new Date().toISOString()
                })
                .eq('id', zombieRunId);

            if (stopError) {
                console.error('Failed to stop zombie bot run', stopError);
                return res.status(500).json({
                    error: 'Failed to clean up stale bot run. Please try again.',
                    details: stopError
                });
            }

            // Proceed with starting the new bot...
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

            return res.json({ botRunId: runId, mode: 'backend', status: 'running' });
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
            // Verify ownership explicitly for requested ID
            const ownership = enforceRunOwnership(activeAccount, runId);
            if (ownership.status !== 200) {
                // If not found in memory, try detailed lookup or just fail
                // For now, if 404, we accept it might be ghost, but ownership returns 404
                return res.status(ownership.status).json({ error: ownership.error });
            }
            await stopBotRun(runId);
            return res.json({ stopped: true, botRunId: runId });
        }

        // Stop active backend run for this account, if any
        const stoppedRun = await stopActiveBackendRun(activeAccount);

        // Also clear any stale DB entries marked as running for this account
        const { error: staleStopError } = await supabaseClient
            .from('bot_runs')
            .update({ run_status: 'stopped', stopped_at: new Date().toISOString() })
            .eq('account_id', activeAccount)
            .eq('backend_mode', true)
            .eq('run_status', 'running');

        if (staleStopError) {
            console.error('Supabase stale bot run stop failed', { error: staleStopError });
            // Non-blocking but logged
        }

        return res.json({ stopped: true, botRunId: stoppedRun?.id ?? null });
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

        let run = null;
        if (runId) {
            const status = getBotRunStatus(runId);
            if (status && status.accountId === activeAccount) {
                run = status;
            }
        } else {
            run = getActiveBackendRun(activeAccount);
        }

        if (!run) {
            return res.json({ active: false });
        }

        return res.json({
            active: true,
            botRunId: run.id,
            strategyId: run.config.strategyId,
            symbol: run.config.symbol,
            startedAt: run.startedAt.toISOString(),
            configSummary: {
                stake: run.config.stake,
                maxStake: run.config.maxStake,
                duration: run.config.duration,
                durationUnit: run.config.durationUnit,
                cooldownMs: run.config.cooldownMs,
            },
        });
    }

    return res.status(400).json({ error: 'Unsupported action' });
});

export default router;
