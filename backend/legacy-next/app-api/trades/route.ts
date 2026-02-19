import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActiveAccountId, parseLimitParam } from '@/lib/server/requestUtils';

export const runtime = 'nodejs';
const LEGACY_API_ENABLED = process.env.ENABLE_LEGACY_NEXT_API === 'true';

export async function GET(request: Request) {
    if (!LEGACY_API_ENABLED) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { client: supabaseAdmin, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return NextResponse.json({ error: configError || 'Supabase not configured', missing }, { status: 503 });
    }

    const url = new URL(request.url);
    const limit = parseLimitParam(url.searchParams.get('limit'), 50, 1000);
    const activeAccount = await getActiveAccountId();

    if (!activeAccount) {
        return NextResponse.json({ error: 'No active account' }, { status: 401 });
    }

    const { data, error: queryError } = await supabaseAdmin
        .from('trades')
        .select('id, contract_id, symbol, stake, duration, duration_unit, profit, status, bot_id, bot_run_id, entry_profile_id, created_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (queryError) {
        console.error('Supabase trades query failed', { error: queryError });
        return NextResponse.json({
            error: queryError.message,
            code: queryError.code,
            hint: queryError.hint,
            details: queryError.details,
        }, { status: 500 });
    }

    return NextResponse.json({ trades: data || [] });
}
