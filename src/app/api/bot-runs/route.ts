import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActiveAccountId } from '@/lib/server/requestUtils';

export const runtime = 'nodejs';

export async function POST(request: Request) {
    const { client: supabaseAdmin, error, missing } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return NextResponse.json({ error: error || 'Supabase not configured', missing }, { status: 503 });
    }

    const activeAccount = await getActiveAccountId();

    if (!activeAccount) {
        return NextResponse.json({ error: 'No active account' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'start') {
        const botId = typeof body.botId === 'string' ? body.botId : null;
        const config = body.config ?? null;
        const now = new Date().toISOString();

        // Ensure only one running bot per account
        const { error: stopError } = await supabaseAdmin
            .from('bot_runs')
            .update({ run_status: 'stopped', stopped_at: now })
            .eq('account_id', activeAccount)
            .eq('run_status', 'running');

        if (stopError) {
            console.error('Supabase bot run stop failed', { error: stopError });
            return NextResponse.json({
                error: stopError.message,
                code: stopError.code,
                hint: stopError.hint,
                details: stopError.details,
            }, { status: 500 });
        }

        const { data, error } = await supabaseAdmin
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

        if (error) {
            console.error('Supabase bot run start failed', { error });
            return NextResponse.json({
                error: error.message,
                code: error.code,
                hint: error.hint,
                details: error.details,
            }, { status: 500 });
        }

        return NextResponse.json({ runId: data?.id });
    }

    if (action === 'stop') {
        const runId = typeof body.runId === 'string' ? body.runId : null;
        if (runId) {
            const { error } = await supabaseAdmin
                .from('bot_runs')
                .update({ run_status: 'stopped', stopped_at: new Date().toISOString() })
                .eq('id', runId)
                .eq('account_id', activeAccount);

            if (error) {
                console.error('Supabase bot run stop by id failed', { error });
                return NextResponse.json({
                    error: error.message,
                    code: error.code,
                    hint: error.hint,
                    details: error.details,
                }, { status: 500 });
            }
            return NextResponse.json({ success: true });
        }

        const { error } = await supabaseAdmin
            .from('bot_runs')
            .update({ run_status: 'stopped', stopped_at: new Date().toISOString() })
            .eq('account_id', activeAccount)
            .eq('run_status', 'running');

        if (error) {
            console.error('Supabase bot run stop failed', { error });
            return NextResponse.json({
                error: error.message,
                code: error.code,
                hint: error.hint,
                details: error.details,
            }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
}
