import 'server-only';

import { cookies } from 'next/headers';

export async function getActiveAccountId() {
    const cookieStore = await cookies();

    return cookieStore.get('deriv_active_account')?.value
        || cookieStore.get('deriv_demo_account')?.value
        || cookieStore.get('deriv_account')?.value
        || null;
}

export function parseLimitParam(value: string | null, defaultLimit: number, maxLimit: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return defaultLimit;
    }

    return Math.min(Math.floor(parsed), maxLimit);
}
