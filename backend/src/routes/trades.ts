import { Router } from 'express';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { getValidatedAccountId, parseLimitParam } from '../lib/requestUtils';
import { executeTradeServer, executeTradeServerFast } from '../trade';

const router = Router();

router.get('/', async (req, res) => {
    const { client: supabaseAdmin, error: configError, missing } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        return res.status(503).json({ error: configError || 'Supabase not configured', missing });
    }

    const limit = parseLimitParam(req.query.limit as string | undefined, 50, 1000);
    const activeAccount = getValidatedAccountId(req);

    if (!activeAccount) {
        return res.status(401).json({ error: 'No active account' });
    }

    const { data, error: queryError } = await supabaseAdmin
        .from('trades')
        .select('id, contract_id, symbol, stake, duration, duration_unit, profit, status, bot_id, bot_run_id, entry_profile_id, created_at')
        .eq('account_id', activeAccount)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (queryError) {
        console.error('Supabase trades query failed', { error: queryError });
        return res.status(500).json({
            error: queryError.message,
            code: queryError.code,
            hint: queryError.hint,
            details: queryError.details,
        });
    }

    return res.json({ trades: data || [] });
});

router.post('/execute', async (req, res) => {
    const signal = typeof req.body?.signal === 'string' ? req.body.signal : '';
    const params = req.body || {};

    const realToken = req.cookies?.deriv_token;
    const demoToken = req.cookies?.deriv_demo_token;
    const activeTypeCookie = req.cookies?.deriv_active_type as 'real' | 'demo' | undefined;
    const activeType = activeTypeCookie || (demoToken ? 'demo' : 'real');
    const token = activeType === 'demo' ? demoToken : realToken;
    const accountId = activeType === 'demo'
        ? req.cookies?.deriv_demo_account || null
        : req.cookies?.deriv_account || null;
    const accountCurrency = activeType === 'demo'
        ? req.cookies?.deriv_demo_currency
        : req.cookies?.deriv_currency;

    if (!token) {
        return res.status(401).json({ error: 'User not authenticated' });
    }
    if (!accountId) {
        return res.status(401).json({ error: 'Account not available' });
    }

    try {
        // Use fast execution by default, fall back to slow if useFast=false
        const useFast = req.body?.useFast !== false;

        if (useFast) {
            const result = await executeTradeServerFast(signal as 'CALL' | 'PUT', params, {
                token,
                accountId,
                accountType: activeType,
                accountCurrency: accountCurrency || undefined,
            });
            return res.json(result);
        } else {
            const result = await executeTradeServer(signal as 'CALL' | 'PUT', params, {
                token,
                accountId,
                accountType: activeType,
                accountCurrency: accountCurrency || undefined,
            });
            return res.json(result);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Trade execution failed';
        return res.status(400).json({ error: message });
    }
});

export default router;
