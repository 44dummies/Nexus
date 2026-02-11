
import test, { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as neuralRecoveryNet from '../lib/smartLayer/neuralRecoveryNet';
import * as supabaseAdmin from '../lib/supabaseAdmin';

describe('Neural Network Persistence', () => {
    const mockUpsert = mock.fn(() => Promise.resolve({ error: null })) as any;
    const mockSelect = mock.fn(() => Promise.resolve({ data: [], error: null })) as any;

    // Mock Supabase client
    const mockClient = {
        from: (table: string) => ({
            upsert: mockUpsert,
            select: mockSelect,
        } as any)
    };

    mock.method(supabaseAdmin, 'getSupabaseAdmin', () => ({
        client: mockClient as any,
        keyType: 'service',
    }));

    afterEach(() => {
        mockUpsert.mock.resetCalls();
        mockSelect.mock.resetCalls();
    });

    it('persists weights to Supabase', async () => {
        const accountId = 'acc_neural_test_1';
        // Initialize weights first
        neuralRecoveryNet.getOrCreateWeights(accountId);

        await neuralRecoveryNet.persistWeights(accountId);

        assert.strictEqual(mockUpsert.mock.callCount(), 1);
        if (mockUpsert.mock.calls.length > 0) {
            const args = mockUpsert.mock.calls[0].arguments;
            assert.strictEqual(args[0].account_id, accountId);
            assert.ok(args[0].weights);
            assert.ok(args[0].updated_at);
        }
    });

    it('hydrates weights from Supabase', async () => {
        const accountId = 'acc_neural_test_2';

        // Define dimensions based on neuralRecoveryNet constants
        // 8 inputs -> 16 hidden1 -> 8 hidden2 -> 4 outputs
        const INPUT_SIZE = 8;
        const HIDDEN1_SIZE = 16;
        const HIDDEN2_SIZE = 8;
        const OUTPUT_SIZE = 4;

        const mockWeights = {
            w1: new Array(INPUT_SIZE * HIDDEN1_SIZE).fill(0.1),
            b1: new Array(HIDDEN1_SIZE).fill(0.1),
            w2: new Array(HIDDEN1_SIZE * HIDDEN2_SIZE).fill(0.1),
            b2: new Array(HIDDEN2_SIZE).fill(0.1),
            w3: new Array(HIDDEN2_SIZE * OUTPUT_SIZE).fill(0.1),
            b3: new Array(OUTPUT_SIZE).fill(0.1),
            iterations: 100,
            lastTrainedAt: 1234567890
        };

        // Mock select return
        mockSelect.mock.mockImplementation(() => {
            return Promise.resolve({
                data: [{ account_id: accountId, weights: mockWeights }],
                error: null
            });
        });

        await neuralRecoveryNet.hydrateAllNetworks();

        assert.strictEqual(mockSelect.mock.callCount(), 1);

        // Verify weights are loaded in memory
        const loaded = neuralRecoveryNet.getWeights(accountId);
        assert.ok(loaded, 'Weights should be loaded in memory');
        assert.equal(loaded?.iterations, 100);
    });
});
