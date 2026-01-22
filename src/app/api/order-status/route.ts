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
    const limit = parseLimitParam(url.searchParams.get('limit'), 50, 200);
    const contractId = url.searchParams.get('contractId');

    const activeAccount = await getActiveAccountId();

    if (!activeAccount) {
        return NextResponse.json({ error: 'No active account' }, { status: 401 });
    }

    let query = supabaseAdmin
        .from('order_status')
        .select('id, contract_id, trade_id, event, status, price, latency_ms, payload, created_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (contractId) {
        query = query.eq('contract_id', Number(contractId));
    }

    const { data, error } = await query;

    if (error) {
        console.error('Supabase order status query failed', { error });
        return NextResponse.json({
            error: error.message,
            code: error.code,
            hint: error.hint,
            details: error.details,
        }, { status: 500 });
    }

    return NextResponse.json({ events: data || [] });
}
