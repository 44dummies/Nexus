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

export async function GET(request: Request) {
    if (!supabaseAdmin) {
        return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get('limit') || '50'), 200);
    const type = url.searchParams.get('type');

    const cookieStore = await cookies();
    const activeAccount = cookieStore.get('deriv_active_account')?.value
        || cookieStore.get('deriv_demo_account')?.value
        || cookieStore.get('deriv_account')?.value
        || null;

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

    const { data, error } = await query;
    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ events: data || [] });
}

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
    const eventType = typeof body.eventType === 'string' ? body.eventType : 'unknown';
    const detail = typeof body.detail === 'string' ? body.detail : null;
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : null;

    const { error } = await supabaseAdmin.from('risk_events').insert({
        account_id: activeAccount,
        event_type: eventType,
        detail,
        metadata,
    });

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}
