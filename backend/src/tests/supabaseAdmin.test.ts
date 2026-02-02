import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySupabaseError, withSupabaseRetry, setSupabaseClientForTest, clearSupabaseClientForTest } from '../lib/supabaseAdmin';

test('classifySupabaseError categorizes permission errors', () => {
    const info = classifySupabaseError({ message: 'permission denied', status: 403 });
    assert.equal(info.category, 'permission');
});

test('classifySupabaseError categorizes connectivity errors', () => {
    const info = classifySupabaseError({ message: 'Network timeout', code: 'ECONNRESET' });
    assert.equal(info.category, 'connectivity');
});

test('classifySupabaseError categorizes query errors', () => {
    const info = classifySupabaseError({ message: 'Row not found', code: 'PGRST116' });
    assert.equal(info.category, 'query');
});

test('withSupabaseRetry retries connectivity failures', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_URL = 'http://localhost';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

    let calls = 0;
    const fakeClient = {
        from: () => ({
            insert: async () => {
                calls += 1;
                if (calls < 2) {
                    throw { message: 'network timeout' };
                }
                return { data: [{ id: 1 }], error: null };
            },
        }),
    } as any;

    setSupabaseClientForTest(fakeClient, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await withSupabaseRetry('test.insert', (client: any) => client.from('x').insert({}));
    assert.equal(calls, 2);
    clearSupabaseClientForTest();
    if (prevUrl === undefined) {
        delete process.env.SUPABASE_URL;
    } else {
        process.env.SUPABASE_URL = prevUrl;
    }
    if (prevKey === undefined) {
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
        process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    }
});
