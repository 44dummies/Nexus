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
    const limit = Math.min(Number(url.searchParams.get('limit') || '20'), 100);
    const type = url.searchParams.get('type');
    const unreadOnly = url.searchParams.get('unread') === 'true';

    const cookieStore = await cookies();
    const activeAccount = cookieStore.get('deriv_active_account')?.value
        || cookieStore.get('deriv_demo_account')?.value
        || cookieStore.get('deriv_account')?.value
        || null;

    if (!activeAccount) {
        return NextResponse.json({ error: 'No active account' }, { status: 401 });
    }

    let query = supabaseAdmin
        .from('notifications')
        .select('id, title, body, type, data, created_at, read_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (type) {
        query = query.eq('type', type);
    }
    if (unreadOnly) {
        query = query.is('read_at', null);
    }

    const { data, error } = await query;

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ notifications: data || [] });
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
    const action = typeof body.action === 'string' ? body.action : '';

    if (action !== 'mark-read') {
        return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const ids = Array.isArray(body.ids)
        ? body.ids.filter((id: unknown): id is string => typeof id === 'string')
        : [];
    const markAll = body.all === true;

    let query = supabaseAdmin
        .from('notifications')
        .update({ read_at: now })
        .eq('account_id', activeAccount);

    if (markAll) {
        query = query.is('read_at', null);
    } else if (ids.length > 0) {
        query = query.in('id', ids);
    } else {
        return NextResponse.json({ error: 'No notifications provided' }, { status: 400 });
    }

    const { data, error } = await query.select('id, read_at');

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, updated: data || [] });
}
