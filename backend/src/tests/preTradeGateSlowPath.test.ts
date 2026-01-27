import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTradeServer } from '../trade';
import { clearAllRiskCaches } from '../lib/riskCache';

test('slow path enforces preTradeGate (fails when risk state missing)', async () => {
    clearAllRiskCaches();
    const originalUrl = process.env.SUPABASE_URL;
    const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const originalAnon = process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;

    await assert.rejects(
        () => executeTradeServer(
            'CALL',
            { stake: 1, symbol: 'R_100', duration: 5, durationUnit: 't' },
            { token: 'token', accountId: 'CR123', accountType: 'real', accountCurrency: 'USD' }
        ),
        /Risk state unavailable/
    );

    if (originalUrl !== undefined) {
        process.env.SUPABASE_URL = originalUrl;
    }
    if (originalService !== undefined) {
        process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
    }
    if (originalAnon !== undefined) {
        process.env.SUPABASE_ANON_KEY = originalAnon;
    }
});
