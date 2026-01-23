'use server';

import { cookies } from 'next/headers';

/**
 * Refreshes the session expiration (Sliding Window).
 * Call this periodically or on user activity to extend the session.
 */
export async function refreshSession() {
    const cookieStore = await cookies();

    const token = cookieStore.get('deriv_token')?.value;
    const account = cookieStore.get('deriv_account')?.value;
    const currency = cookieStore.get('deriv_currency')?.value;
    const demoToken = cookieStore.get('deriv_demo_token')?.value;
    const demoAccount = cookieStore.get('deriv_demo_account')?.value;
    const demoCurrency = cookieStore.get('deriv_demo_currency')?.value;
    const activeType = cookieStore.get('deriv_active_type')?.value;
    const activeAccount = cookieStore.get('deriv_active_account')?.value;
    const activeCurrency = cookieStore.get('deriv_active_currency')?.value;

    if (!token) {
        return { success: false, error: 'No active session' };
    }

    const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 60, // Reset to 1 hour
        path: '/',
        sameSite: 'strict' as const,
    };

    // Re-set all cookies with fresh expiry
    cookieStore.set('deriv_token', token, cookieOptions);
    if (account) cookieStore.set('deriv_account', account, cookieOptions);
    if (currency) cookieStore.set('deriv_currency', currency, cookieOptions);

    if (demoToken) {
        cookieStore.set('deriv_demo_token', demoToken, cookieOptions);
        if (demoAccount) cookieStore.set('deriv_demo_account', demoAccount, cookieOptions);
        if (demoCurrency) cookieStore.set('deriv_demo_currency', demoCurrency, cookieOptions);
    }

    if (activeType) cookieStore.set('deriv_active_type', activeType, cookieOptions);
    if (activeAccount) cookieStore.set('deriv_active_account', activeAccount, cookieOptions);
    if (activeCurrency) cookieStore.set('deriv_active_currency', activeCurrency, cookieOptions);

    return { success: true };
}
