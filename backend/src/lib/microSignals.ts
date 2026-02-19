import type { TradeSignal } from './strategyTypes';

export interface MicrostructureContext {
    imbalance: number | null;
    spread: number | null;
    momentum: number | null;
    mode: 'order_book' | 'synthetic' | null;
}

export interface MicroSignalResult {
    signal: TradeSignal | null;
    confidence: number;
    reasonCodes: string[];
    detail: string;
}

export interface MicroSignalConfig {
    imbalanceLevels?: number;
    imbalanceThreshold?: number;
    spreadThreshold?: number;
    momentumWindowMs?: number;
    momentumThreshold?: number;
    minConfidence?: number;
    enableImbalance?: boolean;
    enableMomentum?: boolean;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function evaluateMicrostructureSignals(
    ctx: MicrostructureContext,
    config: MicroSignalConfig = {}
): MicroSignalResult {
    const reasonCodes: string[] = [];
    let bestSignal: TradeSignal | null = null;
    let bestConfidence = 0;

    const enableImbalance = config.enableImbalance !== false;
    const enableMomentum = config.enableMomentum !== false;
    const imbalanceThreshold = config.imbalanceThreshold ?? 0.15;
    const momentumThreshold = config.momentumThreshold ?? 0.0005;
    const spreadThreshold = config.spreadThreshold ?? 0;
    const minConfidence = config.minConfidence ?? 0.4;

    if (enableImbalance && typeof ctx.imbalance === 'number') {
        if (ctx.imbalance >= imbalanceThreshold) {
            const confidence = clamp01(ctx.imbalance / Math.max(imbalanceThreshold, 1e-6));
            if (confidence > bestConfidence) {
                bestSignal = 'CALL';
                bestConfidence = confidence;
            }
            reasonCodes.push(`IMB_UP:${ctx.imbalance.toFixed(3)}`);
        } else if (ctx.imbalance <= -imbalanceThreshold) {
            const confidence = clamp01(Math.abs(ctx.imbalance) / Math.max(imbalanceThreshold, 1e-6));
            if (confidence > bestConfidence) {
                bestSignal = 'PUT';
                bestConfidence = confidence;
            }
            reasonCodes.push(`IMB_DN:${ctx.imbalance.toFixed(3)}`);
        }
    }

    if (enableMomentum && typeof ctx.momentum === 'number') {
        const spreadOk = typeof ctx.spread === 'number' ? ctx.spread <= spreadThreshold : true;
        if (spreadOk && ctx.momentum >= momentumThreshold) {
            const confidence = clamp01(ctx.momentum / Math.max(momentumThreshold, 1e-6));
            if (confidence > bestConfidence) {
                bestSignal = 'CALL';
                bestConfidence = confidence;
            }
            reasonCodes.push(`MOMO_UP:${ctx.momentum.toFixed(5)}`);
        } else if (spreadOk && ctx.momentum <= -momentumThreshold) {
            const confidence = clamp01(Math.abs(ctx.momentum) / Math.max(momentumThreshold, 1e-6));
            if (confidence > bestConfidence) {
                bestSignal = 'PUT';
                bestConfidence = confidence;
            }
            reasonCodes.push(`MOMO_DN:${ctx.momentum.toFixed(5)}`);
        }
    }

    if (!bestSignal || bestConfidence < minConfidence) {
        return {
            signal: null,
            confidence: bestConfidence,
            reasonCodes,
            detail: `NEUTRAL | mode=${ctx.mode ?? 'unknown'}`,
        };
    }

    return {
        signal: bestSignal,
        confidence: bestConfidence,
        reasonCodes,
        detail: `${bestSignal} | conf=${bestConfidence.toFixed(2)} | mode=${ctx.mode ?? 'unknown'}`,
    };
}
