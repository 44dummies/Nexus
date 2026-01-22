import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActiveAccountId, parseLimitParam } from '@/lib/server/requestUtils';

export const runtime = 'nodejs';

export async function GET(request: Request) {
    const { client: supabaseAdmin, error, missing } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return NextResponse.json({ error: error || 'Supabase not configured', missing }, { status: 503 });
    }

    const url = new URL(request.url);
    const limit = parseLimitParam(url.searchParams.get('limit'), 50, 1000);
    const activeAccount = await getActiveAccountId();

    if (!activeAccount) {
        return NextResponse.json({ error: 'No active account' }, { status: 401 });
    }

    const { data, error } = await supabaseAdmin
        .from('trades')
        .select('id, contract_id, symbol, stake, duration, duration_unit, profit, status, bot_id, bot_run_id, entry_profile_id, created_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) {
        console.error('Supabase trades query failed', { error });
        return NextResponse.json({
            error: error.message,
            code: error.code,
            hint: error.hint,
            details: error.details,
        }, { status: 500 });
    }

    return NextResponse.json({ trades: data || [] });
}
