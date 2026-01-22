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
    const limit = parseLimitParam(url.searchParams.get('limit'), 20, 100);
    const type = url.searchParams.get('type');
    const unreadOnly = url.searchParams.get('unread') === 'true';

    const activeAccount = await getActiveAccountId();

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
        console.error('Supabase notifications query failed', { error });
        return NextResponse.json({
            error: error.message,
            code: error.code,
            hint: error.hint,
            details: error.details,
        }, { status: 500 });
    }

    return NextResponse.json({ notifications: data || [] });
}

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
        console.error('Supabase notifications update failed', { error });
        return NextResponse.json({
            error: error.message,
            code: error.code,
            hint: error.hint,
            details: error.details,
        }, { status: 500 });
    }

    return NextResponse.json({ success: true, updated: data || [] });
}
