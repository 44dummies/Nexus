/**
 * Neural Recovery Network Tests
 * Tests for the lightweight neural network used in SMRT recovery
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getOrCreateWeights,
    loadWeights,
    getWeights,
    predict,
    train,
    computeReward,
    resetNetwork,
    resetAllNetworks,
    __test,
} from '../lib/smartLayer/neuralRecoveryNet';
import type { RecoveryFeatureVector, NeuralWeights } from '../lib/smartLayer/recoveryTypes';
import { DEFAULT_RECOVERY_CONFIG } from '../lib/smartLayer/recoveryTypes';

// ==================== HELPERS ====================

const ACCOUNT = 'test-account-neural';

function cleanup() {
    resetAllNetworks();
}

function makeFeatures(overrides?: Partial<RecoveryFeatureVector>): RecoveryFeatureVector {
    return {
        lossStreakNorm: 0.3,
        deficitPctEquity: 0.1,
        recentWinRate: 0.5,
        regimeConfidence: 0.7,
        volatilityNorm: 0.4,
        timeSinceWinNorm: 0.2,
        recoveryAttemptNorm: 0.1,
        drawdownPct: 0.05,
        ...overrides,
    };
}

// ==================== ACTIVATION FUNCTION TESTS ====================

test('Neural: ReLU returns 0 for negative, x for positive', () => {
    assert.equal(__test.relu(-5), 0);
    assert.equal(__test.relu(0), 0);
    assert.equal(__test.relu(3), 3);
    assert.equal(__test.relu(0.001), 0.001);
});

test('Neural: Sigmoid outputs between 0 and 1', () => {
    assert.ok(__test.sigmoid(0) > 0.49 && __test.sigmoid(0) < 0.51);
    assert.ok(__test.sigmoid(10) > 0.99);
    assert.ok(__test.sigmoid(-10) < 0.01);
    assert.ok(__test.sigmoid(100) <= 1); // Should not overflow
    assert.ok(__test.sigmoid(-100) >= 0); // Should not underflow
});

// ==================== FORWARD PASS TESTS ====================

test('Neural: forward pass produces bounded outputs', () => {
    cleanup();
    const weights = __test.initializeWeights();
    const input = __test.featuresToArray(makeFeatures());

    const result = __test.forward(weights, input);

    // All outputs should be between 0 and 1 (sigmoid)
    for (let i = 0; i < __test.OUTPUT_SIZE; i++) {
        assert.ok(result.output[i] >= 0, `Output ${i} should be >= 0, got ${result.output[i]}`);
        assert.ok(result.output[i] <= 1, `Output ${i} should be <= 1, got ${result.output[i]}`);
    }

    // Hidden1 should all be >= 0 (ReLU)
    for (let i = 0; i < __test.HIDDEN1_SIZE; i++) {
        assert.ok(result.hidden1[i] >= 0, `Hidden1 ${i} should be >= 0`);
    }

    // Hidden2 should all be >= 0 (ReLU)
    for (let i = 0; i < __test.HIDDEN2_SIZE; i++) {
        assert.ok(result.hidden2[i] >= 0, `Hidden2 ${i} should be >= 0`);
    }
    cleanup();
});

test('Neural: forward pass is deterministic', () => {
    cleanup();
    const weights = __test.initializeWeights();
    const input = __test.featuresToArray(makeFeatures());

    const result1 = __test.forward(weights, input);
    const result2 = __test.forward(weights, input);

    for (let i = 0; i < __test.OUTPUT_SIZE; i++) {
        assert.equal(result1.output[i], result2.output[i], `Output ${i} should be deterministic`);
    }
    cleanup();
});

// ==================== PREDICT TESTS ====================

test('Neural: predict returns safe defaults for untrained network', () => {
    cleanup();
    const params = predict(ACCOUNT, makeFeatures());

    // Should return DEFAULT_RECOVERY_PARAMS (precision-first)
    assert.equal(params.stakeMultiplier, 1.0);
    assert.equal(params.precisionThreshold, 0.7);
    assert.equal(params.confidenceBoost, 0.15);
    assert.equal(params.aggressiveness, 0.5);
    cleanup();
});

test('Neural: predict returns bounded output after training', () => {
    cleanup();
    const features = makeFeatures();
    const params = { stakeMultiplier: 1.2, precisionThreshold: 0.8, confidenceBoost: 0.15, aggressiveness: 0.6 };

    // Train enough to pass threshold
    for (let i = 0; i < 5; i++) {
        train(ACCOUNT, features, params, 0.8);
    }

    const predicted = predict(ACCOUNT, features);

    const { stakeMultiplierBounds, precisionThresholdBounds, confidenceBoostBounds } = DEFAULT_RECOVERY_CONFIG;
    assert.ok(predicted.stakeMultiplier >= stakeMultiplierBounds.min,
        `Stake ${predicted.stakeMultiplier} >= ${stakeMultiplierBounds.min}`);
    assert.ok(predicted.stakeMultiplier <= stakeMultiplierBounds.max,
        `Stake ${predicted.stakeMultiplier} <= ${stakeMultiplierBounds.max}`);
    assert.ok(predicted.precisionThreshold >= precisionThresholdBounds.min,
        `Precision ${predicted.precisionThreshold} >= ${precisionThresholdBounds.min}`);
    assert.ok(predicted.precisionThreshold <= precisionThresholdBounds.max,
        `Precision ${predicted.precisionThreshold} <= ${precisionThresholdBounds.max}`);
    assert.ok(predicted.confidenceBoost >= confidenceBoostBounds.min,
        `Boost ${predicted.confidenceBoost} >= ${confidenceBoostBounds.min}`);
    assert.ok(predicted.confidenceBoost <= confidenceBoostBounds.max,
        `Boost ${predicted.confidenceBoost} <= ${confidenceBoostBounds.max}`);
    assert.ok(predicted.aggressiveness >= 0 && predicted.aggressiveness <= 1);
    cleanup();
});

// ==================== TRAINING TESTS ====================

test('Neural: training reduces loss over iterations', () => {
    cleanup();
    const features = makeFeatures();
    const params = { stakeMultiplier: 1.5, precisionThreshold: 0.75, confidenceBoost: 0.05, aggressiveness: 0.7 };

    let firstLoss: number | null = null;
    let lastLoss: number | null = null;

    for (let i = 0; i < 20; i++) {
        const result = train(ACCOUNT, features, params, 0.9);
        if (firstLoss === null) firstLoss = result.loss;
        lastLoss = result.loss;
    }

    assert.ok(firstLoss !== null && lastLoss !== null);
    // Loss should decrease after training (network is learning)
    assert.ok(lastLoss! < firstLoss!, `Loss should decrease: first=${firstLoss}, last=${lastLoss}`);
    cleanup();
});

test('Neural: training iteration count increments', () => {
    cleanup();
    const features = makeFeatures();
    const params = { stakeMultiplier: 1.0, precisionThreshold: 0.7, confidenceBoost: 0.1, aggressiveness: 0.5 };

    const result1 = train(ACCOUNT, features, params, 0.5);
    assert.equal(result1.iterations, 1);

    const result2 = train(ACCOUNT, features, params, 0.6);
    assert.equal(result2.iterations, 2);

    const result3 = train(ACCOUNT, features, params, 0.7);
    assert.equal(result3.iterations, 3);
    cleanup();
});

// ==================== WEIGHT SERIALIZATION TESTS ====================

test('Neural: weight serialization roundtrip', () => {
    cleanup();
    // Create and modify weights via training
    const features = makeFeatures();
    const params = { stakeMultiplier: 1.3, precisionThreshold: 0.8, confidenceBoost: 0.12, aggressiveness: 0.5 };
    train(ACCOUNT, features, params, 0.7);
    train(ACCOUNT, features, params, 0.8);

    // Serialize
    const serialized = getWeights(ACCOUNT);
    assert.ok(serialized);
    assert.equal(serialized.iterations, 2);
    assert.ok(serialized.lastTrainedAt !== null);

    // Validate dimensions
    assert.equal(serialized.w1.length, __test.INPUT_SIZE * __test.HIDDEN1_SIZE);
    assert.equal(serialized.b1.length, __test.HIDDEN1_SIZE);
    assert.equal(serialized.w2.length, __test.HIDDEN1_SIZE * __test.HIDDEN2_SIZE);
    assert.equal(serialized.b2.length, __test.HIDDEN2_SIZE);
    assert.equal(serialized.w3.length, __test.HIDDEN2_SIZE * __test.OUTPUT_SIZE);
    assert.equal(serialized.b3.length, __test.OUTPUT_SIZE);

    // Reset and reload
    resetNetwork(ACCOUNT);
    assert.equal(getWeights(ACCOUNT), null);

    loadWeights(ACCOUNT, serialized);

    // Predict should produce same output
    // Train enough to pass threshold
    const restoredWeights = getWeights(ACCOUNT);
    assert.ok(restoredWeights);
    assert.equal(restoredWeights.iterations, 2);

    // Compare weights
    for (let i = 0; i < serialized.w1.length; i++) {
        assert.equal(restoredWeights.w1[i], serialized.w1[i]);
    }
    cleanup();
});

test('Neural: loadWeights rejects invalid dimensions', () => {
    cleanup();
    const badWeights: NeuralWeights = {
        w1: [1, 2, 3], // Wrong size
        b1: [1],
        w2: [1, 2],
        b2: [1],
        w3: [1],
        b3: [1],
        iterations: 10,
        lastTrainedAt: Date.now(),
    };

    loadWeights(ACCOUNT, badWeights);

    // Should have been reinitialized (not the bad weights)
    const weights = getWeights(ACCOUNT);
    assert.ok(weights);
    assert.equal(weights.iterations, 0); // Fresh init
    assert.equal(weights.w1.length, __test.INPUT_SIZE * __test.HIDDEN1_SIZE);
    cleanup();
});

// ==================== REWARD COMPUTATION TESTS ====================

test('Neural: computeReward returns bounded values', () => {
    // Full recovery in few trades = high reward
    const highReward = computeReward(100, 100, 3, true);
    assert.ok(highReward > 0.5, `High reward: ${highReward}`);
    assert.ok(highReward <= 1);

    // Partial recovery in many trades = low reward
    const lowReward = computeReward(30, 100, 20, false);
    assert.ok(lowReward >= 0);
    assert.ok(lowReward < 0.5, `Low reward: ${lowReward}`);

    // Zero values
    assert.equal(computeReward(0, 0, 1, false), 0);
    assert.equal(computeReward(10, 10, 0, true), 0);
});

test('Neural: reward is higher for successful recovery', () => {
    const successReward = computeReward(100, 100, 5, true);
    const failReward = computeReward(100, 100, 5, false);
    assert.ok(successReward > failReward, 'Success reward should > failure reward');
});

test('Neural: reward penalizes more trades', () => {
    const fewTrades = computeReward(100, 100, 2, true);
    const manyTrades = computeReward(100, 100, 50, true);
    assert.ok(fewTrades > manyTrades, 'Fewer trades should yield higher reward');
});

// ==================== NUMERICAL STABILITY TESTS ====================

test('Neural: handles extreme feature inputs', () => {
    cleanup();
    const features = makeFeatures({
        lossStreakNorm: 1,
        deficitPctEquity: 1,
        recentWinRate: 0,
        regimeConfidence: 0,
        volatilityNorm: 1,
        timeSinceWinNorm: 1,
        recoveryAttemptNorm: 1,
        drawdownPct: 1,
    });

    // Should not throw or produce NaN
    const weights = __test.initializeWeights();
    const result = __test.forward(weights, __test.featuresToArray(features));

    for (let i = 0; i < __test.OUTPUT_SIZE; i++) {
        assert.ok(!isNaN(result.output[i]), `Output ${i} should not be NaN`);
        assert.ok(isFinite(result.output[i]), `Output ${i} should be finite`);
    }
    cleanup();
});

test('Neural: handles all-zero features', () => {
    cleanup();
    const features = makeFeatures({
        lossStreakNorm: 0,
        deficitPctEquity: 0,
        recentWinRate: 0,
        regimeConfidence: 0,
        volatilityNorm: 0,
        timeSinceWinNorm: 0,
        recoveryAttemptNorm: 0,
        drawdownPct: 0,
    });

    const weights = __test.initializeWeights();
    const result = __test.forward(weights, __test.featuresToArray(features));

    for (let i = 0; i < __test.OUTPUT_SIZE; i++) {
        assert.ok(!isNaN(result.output[i]), `Output ${i} should not be NaN`);
        assert.ok(isFinite(result.output[i]), `Output ${i} should be finite`);
    }
    cleanup();
});

// ==================== LIFECYCLE TESTS ====================

test('Neural: getOrCreateWeights initializes if missing', () => {
    cleanup();
    const weights = getOrCreateWeights('new-account');
    assert.ok(weights);
    assert.equal(weights.iterations, 0);
    assert.equal(weights.lastTrainedAt, null);
    cleanup();
});

test('Neural: resetNetwork clears specific account', () => {
    cleanup();
    getOrCreateWeights('account-a');
    getOrCreateWeights('account-b');

    resetNetwork('account-a');

    assert.equal(getWeights('account-a'), null);
    assert.ok(getWeights('account-b'));
    cleanup();
});
