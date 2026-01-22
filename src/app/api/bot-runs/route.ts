import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
    })
    : null;

export async function POST(request: Request) {
    if (!supabaseAdmin) {
        return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const cookieStore = await cookies();
    const activeAccount = cookieStore.get('deriv_active_account')?.value
        || cookieStore.get('deriv_demo_account')?.value
        || cookieStore.get('deriv_account')?.value
        || null;

    if (!activeAccount) {
        return NextResponse.json({ error: 'No active account' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'start') {
        const botId = typeof body.botId === 'string' ? body.botId : null;
        const config = body.config ?? null;
        const { data, error } = await supabaseAdmin
            .from('bot_runs')
            .insert({
                account_id: activeAccount,
                bot_id: botId,
                run_status: 'running',
                config,
            })
            .select('id')
            .single();

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
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
                return NextResponse.json({ error: error.message }, { status: 500 });
            }
            return NextResponse.json({ success: true });
        }

        const { error } = await supabaseAdmin
            .from('bot_runs')
            .update({ run_status: 'stopped', stopped_at: new Date().toISOString() })
            .eq('account_id', activeAccount)
            .eq('run_status', 'running');

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
}
