import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActiveAccountId, parseLimitParam } from '@/lib/server/requestUtils';

export const runtime = 'nodejs';

export async function GET(request: Request) {
    const { client: supabaseAdmin, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return NextResponse.json({ error: configError || 'Supabase not configured', missing }, { status: 503 });
    }

    const url = new URL(request.url);
    const limit = parseLimitParam(url.searchParams.get('limit'), 50, 200);
    const type = url.searchParams.get('type');

    const activeAccount = await getActiveAccountId();

    if (!activeAccount) {
        return NextResponse.json({ error: 'No active account' }, { status: 401 });
    }

    let query = supabaseAdmin
        .from('risk_events')
        .select('id, event_type, detail, metadata, created_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (type) {
        query = query.eq('event_type', type);
    }

    const { data, error: queryError } = await query;
    if (queryError) {
        console.error('Supabase risk events query failed', { error: queryError });
        return NextResponse.json({
            error: queryError.message,
            code: queryError.code,
            hint: queryError.hint,
            details: queryError.details,
        }, { status: 500 });
    }

    return NextResponse.json({ events: data || [] });
}

export async function POST(request: Request) {
    const { client: supabaseAdmin, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return NextResponse.json({ error: configError || 'Supabase not configured', missing }, { status: 503 });
    }

    const activeAccount = await getActiveAccountId();

    if (!activeAccount) {
        return NextResponse.json({ error: 'No active account' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const eventType = typeof body.eventType === 'string' ? body.eventType : 'unknown';
    const detail = typeof body.detail === 'string' ? body.detail : null;
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : null;

    const { error: insertError } = await supabaseAdmin.from('risk_events').insert({
        account_id: activeAccount,
        event_type: eventType,
        detail,
        metadata,
    });

    if (insertError) {
        console.error('Supabase risk events insert failed', { error: insertError });
        return NextResponse.json({
            error: insertError.message,
            code: insertError.code,
            hint: insertError.hint,
            details: insertError.details,
        }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}
