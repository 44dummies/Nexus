import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function GET(request: NextRequest) {
    const cookieStore = await cookies();

    // Primary account (real or first account)
    const token = cookieStore.get('deriv_token')?.value;
    const account = cookieStore.get('deriv_account')?.value;
    const currency = cookieStore.get('deriv_currency')?.value;

    // Demo account (if available)
    const demoToken = cookieStore.get('deriv_demo_token')?.value;
    const demoAccount = cookieStore.get('deriv_demo_account')?.value;
    const demoCurrency = cookieStore.get('deriv_demo_currency')?.value;

    if (!token) {
        return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    return NextResponse.json({
        authenticated: true,
        token,
        account,
        currency,
        demoToken,
        demoAccount,
        demoCurrency,
    });
}
