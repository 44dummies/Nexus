/**
 * Neural Recovery Network
 *
 * A lightweight feed-forward neural network (pure TypeScript, zero deps)
 * that learns from past recovery episodes to optimize recovery parameters.
 *
 * Architecture: 8 inputs → 16 hidden (ReLU) → 8 hidden (ReLU) → 4 outputs (sigmoid)
 *
 * Inputs (RecoveryFeatureVector):
 *   lossStreakNorm, deficitPctEquity, recentWinRate, regimeConfidence,
 *   volatilityNorm, timeSinceWinNorm, recoveryAttemptNorm, drawdownPct
 *
 * Outputs (mapped to RecoveryParams):
 *   stakeMultiplier (0.5–2.0), cooldownMultiplier (1.0–3.0),
 *   confidenceBoost (0.0–0.2), aggressiveness (0.0–1.0)
 *
 * Training: Online SGD with reward-weighted targets after each recovery episode.
 * Weights are serializable for persistence to Supabase.
 */

import type {
    RecoveryFeatureVector,
    RecoveryParams,
    NeuralWeights,
    RecoveryConfig,
} from './recoveryTypes';
import { DEFAULT_RECOVERY_PARAMS, DEFAULT_RECOVERY_CONFIG } from './recoveryTypes';
import { getSupabaseAdmin } from '../supabaseAdmin';
import { tradeLogger } from '../logger';

// ==================== CONSTANTS ====================

const INPUT_SIZE = 8;
const HIDDEN1_SIZE = 16;
const HIDDEN2_SIZE = 8;
const OUTPUT_SIZE = 4;

const INITIAL_LEARNING_RATE = 0.01;
const LEARNING_RATE_DECAY = 0.999;
const MIN_LEARNING_RATE = 0.0001;
const MIN_TRAINING_EPISODES = 3;

// ==================== ACTIVATIONS ====================

function relu(x: number): number {
    return x > 0 ? x : 0;
}

function reluDerivative(x: number): number {
    return x > 0 ? 1 : 0;
}

function sigmoid(x: number): number {
    // Clamp to avoid overflow
    const clamped = Math.max(-15, Math.min(15, x));
    return 1 / (1 + Math.exp(-clamped));
}

function sigmoidDerivative(output: number): number {
    return output * (1 - output);
}

// ==================== WEIGHT INITIALIZATION ====================

/** Xavier/Glorot initialization for better convergence */
function xavierInit(fanIn: number, fanOut: number): number {
    const limit = Math.sqrt(6 / (fanIn + fanOut));
    return (Math.random() * 2 - 1) * limit;
}

function initializeWeights(): NeuralWeights {
    const w1: number[] = [];
    const b1: number[] = new Array(HIDDEN1_SIZE).fill(0);
    for (let i = 0; i < INPUT_SIZE * HIDDEN1_SIZE; i++) {
        w1.push(xavierInit(INPUT_SIZE, HIDDEN1_SIZE));
    }

    const w2: number[] = [];
    const b2: number[] = new Array(HIDDEN2_SIZE).fill(0);
    for (let i = 0; i < HIDDEN1_SIZE * HIDDEN2_SIZE; i++) {
        w2.push(xavierInit(HIDDEN1_SIZE, HIDDEN2_SIZE));
    }

    const w3: number[] = [];
    const b3: number[] = new Array(OUTPUT_SIZE).fill(0);
    for (let i = 0; i < HIDDEN2_SIZE * OUTPUT_SIZE; i++) {
        w3.push(xavierInit(HIDDEN2_SIZE, OUTPUT_SIZE));
    }

    return { w1, b1, w2, b2, w3, b3, iterations: 0, lastTrainedAt: null };
}

// ==================== FEATURE VECTOR CONVERSION ====================

function featuresToArray(features: RecoveryFeatureVector): number[] {
    return [
        features.lossStreakNorm,
        features.deficitPctEquity,
        features.recentWinRate,
        features.regimeConfidence,
        features.volatilityNorm,
        features.timeSinceWinNorm,
        features.recoveryAttemptNorm,
        features.drawdownPct,
    ];
}

function outputToParams(output: number[], config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG): RecoveryParams {
    const { stakeMultiplierBounds, precisionThresholdBounds, confidenceBoostBounds } = config;
    return {
        stakeMultiplier: stakeMultiplierBounds.min + output[0] * (stakeMultiplierBounds.max - stakeMultiplierBounds.min),
        precisionThreshold: precisionThresholdBounds.min + output[1] * (precisionThresholdBounds.max - precisionThresholdBounds.min),
        confidenceBoost: confidenceBoostBounds.min + output[2] * (confidenceBoostBounds.max - confidenceBoostBounds.min),
        aggressiveness: output[3], // Already 0–1 from sigmoid
    };
}

// ==================== FORWARD PASS ====================

interface ForwardResult {
    input: number[];
    hidden1Pre: number[];
    hidden1: number[];
    hidden2Pre: number[];
    hidden2: number[];
    outputPre: number[];
    output: number[];
}

function forward(weights: NeuralWeights, input: number[]): ForwardResult {
    // Layer 1: input → hidden1 (ReLU)
    const hidden1Pre: number[] = new Array(HIDDEN1_SIZE);
    const hidden1: number[] = new Array(HIDDEN1_SIZE);
    for (let j = 0; j < HIDDEN1_SIZE; j++) {
        let sum = weights.b1[j];
        for (let i = 0; i < INPUT_SIZE; i++) {
            sum += input[i] * weights.w1[i * HIDDEN1_SIZE + j];
        }
        hidden1Pre[j] = sum;
        hidden1[j] = relu(sum);
    }

    // Layer 2: hidden1 → hidden2 (ReLU)
    const hidden2Pre: number[] = new Array(HIDDEN2_SIZE);
    const hidden2: number[] = new Array(HIDDEN2_SIZE);
    for (let j = 0; j < HIDDEN2_SIZE; j++) {
        let sum = weights.b2[j];
        for (let i = 0; i < HIDDEN1_SIZE; i++) {
            sum += hidden1[i] * weights.w2[i * HIDDEN2_SIZE + j];
        }
        hidden2Pre[j] = sum;
        hidden2[j] = relu(sum);
    }

    // Layer 3: hidden2 → output (Sigmoid)
    const outputPre: number[] = new Array(OUTPUT_SIZE);
    const output: number[] = new Array(OUTPUT_SIZE);
    for (let j = 0; j < OUTPUT_SIZE; j++) {
        let sum = weights.b3[j];
        for (let i = 0; i < HIDDEN2_SIZE; i++) {
            sum += hidden2[i] * weights.w3[i * OUTPUT_SIZE + j];
        }
        outputPre[j] = sum;
        output[j] = sigmoid(sum);
    }

    return { input, hidden1Pre, hidden1, hidden2Pre, hidden2, outputPre, output };
}

// ==================== BACKPROPAGATION ====================

/**
 * Train the network on one episode.
 * Target is computed from the reward: higher reward → target closer to actual outputs that produced it.
 * Lower reward → target pushes outputs toward conservative defaults.
 */
function backpropagate(
    weights: NeuralWeights,
    fwdResult: ForwardResult,
    target: number[],
    learningRate: number,
): number {
    // Output layer error
    const outputDelta: number[] = new Array(OUTPUT_SIZE);
    let totalLoss = 0;
    for (let j = 0; j < OUTPUT_SIZE; j++) {
        const error = target[j] - fwdResult.output[j];
        totalLoss += error * error;
        outputDelta[j] = error * sigmoidDerivative(fwdResult.output[j]);
    }

    // Hidden2 error
    const hidden2Delta: number[] = new Array(HIDDEN2_SIZE);
    for (let i = 0; i < HIDDEN2_SIZE; i++) {
        let error = 0;
        for (let j = 0; j < OUTPUT_SIZE; j++) {
            error += outputDelta[j] * weights.w3[i * OUTPUT_SIZE + j];
        }
        hidden2Delta[i] = error * reluDerivative(fwdResult.hidden2Pre[i]);
    }

    // Hidden1 error
    const hidden1Delta: number[] = new Array(HIDDEN1_SIZE);
    for (let i = 0; i < HIDDEN1_SIZE; i++) {
        let error = 0;
        for (let j = 0; j < HIDDEN2_SIZE; j++) {
            error += hidden2Delta[j] * weights.w2[i * HIDDEN2_SIZE + j];
        }
        hidden1Delta[i] = error * reluDerivative(fwdResult.hidden1Pre[i]);
    }

    // Update weights: Layer 3
    for (let i = 0; i < HIDDEN2_SIZE; i++) {
        for (let j = 0; j < OUTPUT_SIZE; j++) {
            weights.w3[i * OUTPUT_SIZE + j] += learningRate * outputDelta[j] * fwdResult.hidden2[i];
        }
    }
    for (let j = 0; j < OUTPUT_SIZE; j++) {
        weights.b3[j] += learningRate * outputDelta[j];
    }

    // Update weights: Layer 2
    for (let i = 0; i < HIDDEN1_SIZE; i++) {
        for (let j = 0; j < HIDDEN2_SIZE; j++) {
            weights.w2[i * HIDDEN2_SIZE + j] += learningRate * hidden2Delta[j] * fwdResult.hidden1[i];
        }
    }
    for (let j = 0; j < HIDDEN2_SIZE; j++) {
        weights.b2[j] += learningRate * hidden2Delta[j];
    }

    // Update weights: Layer 1
    for (let i = 0; i < INPUT_SIZE; i++) {
        for (let j = 0; j < HIDDEN1_SIZE; j++) {
            weights.w1[i * HIDDEN1_SIZE + j] += learningRate * hidden1Delta[j] * fwdResult.input[i];
        }
    }
    for (let j = 0; j < HIDDEN1_SIZE; j++) {
        weights.b1[j] += learningRate * hidden1Delta[j];
    }

    return totalLoss / OUTPUT_SIZE; // MSE
}

// ==================== PUBLIC API ====================

/** Per-account neural network instances */
const networks = new Map<string, NeuralWeights>();

/**
 * Get or initialize neural weights for an account.
 */
export function getOrCreateWeights(accountId: string): NeuralWeights {
    let weights = networks.get(accountId);
    if (!weights) {
        weights = initializeWeights();
        networks.set(accountId, weights);
    }
    return weights;
}

/**
 * Load pre-trained weights (e.g., from Supabase persistence).
 */
export function loadWeights(accountId: string, serialized: NeuralWeights): void {
    // Validate weight dimensions before loading
    if (
        serialized.w1.length !== INPUT_SIZE * HIDDEN1_SIZE ||
        serialized.b1.length !== HIDDEN1_SIZE ||
        serialized.w2.length !== HIDDEN1_SIZE * HIDDEN2_SIZE ||
        serialized.b2.length !== HIDDEN2_SIZE ||
        serialized.w3.length !== HIDDEN2_SIZE * OUTPUT_SIZE ||
        serialized.b3.length !== OUTPUT_SIZE
    ) {
        // Dimension mismatch — reinitialize
        networks.set(accountId, initializeWeights());
        return;
    }

    // Deep copy to prevent external mutation
    networks.set(accountId, {
        w1: [...serialized.w1],
        b1: [...serialized.b1],
        w2: [...serialized.w2],
        b2: [...serialized.b2],
        w3: [...serialized.w3],
        b3: [...serialized.b3],
        iterations: serialized.iterations,
        lastTrainedAt: serialized.lastTrainedAt,
    });
}

/**
 * Get serializable weights for persistence.
 */
export function getWeights(accountId: string): NeuralWeights | null {
    const weights = networks.get(accountId);
    if (!weights) return null;
    return {
        w1: [...weights.w1],
        b1: [...weights.b1],
        w2: [...weights.w2],
        b2: [...weights.b2],
        w3: [...weights.w3],
        b3: [...weights.b3],
        iterations: weights.iterations,
        lastTrainedAt: weights.lastTrainedAt,
    };
}

/**
 * Persist weights to Supabase neural_weights table.
 * Falling back to log if table missing/error.
 */
export async function persistWeights(accountId: string): Promise<void> {
    const weights = getWeights(accountId);
    if (!weights) return;

    const { client } = getSupabaseAdmin();
    if (!client) return;

    try {
        const { error } = await client
            .from('neural_weights')
            .upsert({
                account_id: accountId,
                weights: weights,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'account_id' });

        if (error) {
            tradeLogger.warn({ accountId, error }, 'Failed to persist neural weights');
        }
    } catch (err) {
        tradeLogger.error({ accountId, err }, 'Exception persisting neural weights');
    }
}

/**
 * Load all weights from Supabase on startup.
 */
export async function hydrateAllNetworks(): Promise<void> {
    const { client } = getSupabaseAdmin();
    if (!client) return;

    try {
        const { data, error } = await client
            .from('neural_weights')
            .select('account_id, weights');

        if (error) {
            tradeLogger.warn({ error }, 'Failed to hydrate neural weights');
            return;
        }

        if (data) {
            let loaded = 0;
            for (const row of data) {
                if (row.account_id && row.weights) {
                    loadWeights(row.account_id, row.weights as NeuralWeights);
                    loaded++;
                }
            }
            tradeLogger.info({ loaded }, 'Hydrated neural recovery networks');
        }
    } catch (err) {
        tradeLogger.error({ err }, 'Exception hydrating neural weights');
    }
}

/**
 * Predict optimal recovery parameters given current features.
 * Returns safe defaults if network is untrained (< MIN_TRAINING_EPISODES).
 */
export function predict(
    accountId: string,
    features: RecoveryFeatureVector,
    config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
): RecoveryParams {
    const weights = getOrCreateWeights(accountId);

    // If not enough training data, return conservative defaults
    if (weights.iterations < MIN_TRAINING_EPISODES) {
        return { ...DEFAULT_RECOVERY_PARAMS };
    }

    const input = featuresToArray(features);
    const result = forward(weights, input);
    return outputToParams(result.output, config);
}

/**
 * Train the network on a completed recovery episode.
 *
 * Reward function: (recovered / deficit) * (1 / sqrt(trades))
 * - Maximizes capital recovery while minimizing trade count
 * - Successful recovery with fewer trades = higher reward
 * - Partial recovery = partial reward
 *
 * Target generation:
 * - High reward → target = actual params used (reinforce what worked)
 * - Low reward → target = conservative defaults (pull toward safety)
 */
export function train(
    accountId: string,
    features: RecoveryFeatureVector,
    paramsUsed: RecoveryParams,
    reward: number,
    config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
): { loss: number; iterations: number } {
    const weights = getOrCreateWeights(accountId);

    // Compute current learning rate with decay
    const lr = Math.max(
        MIN_LEARNING_RATE,
        INITIAL_LEARNING_RATE * Math.pow(LEARNING_RATE_DECAY, weights.iterations),
    );

    // Clamp reward to [0, 1]
    const clampedReward = Math.max(0, Math.min(1, reward));

    // Generate target: blend between conservative defaults and actual params based on reward
    // High reward = keep using these params. Low reward = move toward defaults.
    const defaultNormalized = paramsToNormalized(DEFAULT_RECOVERY_PARAMS, config);
    const actualNormalized = paramsToNormalized(paramsUsed, config);

    const target: number[] = new Array(OUTPUT_SIZE);
    for (let i = 0; i < OUTPUT_SIZE; i++) {
        target[i] = defaultNormalized[i] + clampedReward * (actualNormalized[i] - defaultNormalized[i]);
    }

    // Forward pass
    const input = featuresToArray(features);
    const fwdResult = forward(weights, input);

    // Backpropagation
    const loss = backpropagate(weights, fwdResult, target, lr);

    weights.iterations += 1;
    weights.lastTrainedAt = Date.now();

    // Persist async (fire and forget)
    persistWeights(accountId).catch(err => {
        tradeLogger.error({ accountId, err }, 'Failed to persist weights after training');
    });

    return { loss, iterations: weights.iterations };
}

/**
 * Convert params to normalized [0,1] values for network output comparison.
 */
function paramsToNormalized(params: RecoveryParams, config: RecoveryConfig): number[] {
    const { stakeMultiplierBounds, precisionThresholdBounds, confidenceBoostBounds } = config;
    return [
        (params.stakeMultiplier - stakeMultiplierBounds.min) / (stakeMultiplierBounds.max - stakeMultiplierBounds.min),
        (params.precisionThreshold - precisionThresholdBounds.min) / (precisionThresholdBounds.max - precisionThresholdBounds.min),
        (params.confidenceBoost - confidenceBoostBounds.min) / (confidenceBoostBounds.max - confidenceBoostBounds.min),
        params.aggressiveness,
    ];
}

/**
 * Compute reward for a completed recovery episode.
 */
export function computeReward(
    recovered: number,
    originalDeficit: number,
    tradesUsed: number,
    success: boolean,
    winRate?: number,
): number {
    if (originalDeficit <= 0 || tradesUsed <= 0) return 0;

    const recoveryRatio = Math.min(1, recovered / originalDeficit);
    const efficiencyFactor = 1 / Math.sqrt(tradesUsed);
    const successBonus = success ? 0.2 : 0;
    // Accuracy bonus: reward high win rates heavily (precision-first)
    const accuracyBonus = winRate !== undefined ? winRate * 0.3 : 0;

    return Math.min(1, recoveryRatio * efficiencyFactor + successBonus + accuracyBonus);
}

// ==================== CLEANUP ====================

export function resetNetwork(accountId: string): void {
    networks.delete(accountId);
}

export function resetAllNetworks(): void {
    networks.clear();
}

// ==================== TEST EXPORTS ====================

export const __test = {
    forward,
    backpropagate,
    featuresToArray,
    outputToParams,
    paramsToNormalized,
    initializeWeights,
    relu,
    sigmoid,
    INPUT_SIZE,
    HIDDEN1_SIZE,
    HIDDEN2_SIZE,
    OUTPUT_SIZE,
};
