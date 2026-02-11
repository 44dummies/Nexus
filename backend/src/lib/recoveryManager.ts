import logger from './logger';
import { metrics } from './metrics';
import { getComponentStatus, setComponentStatus } from './healthStatus';
import { cleanupAllConnections } from './wsManager';

type RecoveryState = 'idle' | 'recovering' | 'cooldown';

const RECOVERY_INTERVAL_MS = Math.max(1000, Number(process.env.RECOVERY_INTERVAL_MS) || 10000);
const RECOVERY_COOLDOWN_MS = Math.max(5000, Number(process.env.RECOVERY_COOLDOWN_MS) || 30000);

let state: RecoveryState = 'idle';
let cooldownUntil = 0;

function attemptWsRecovery(): void {
    try {
        cleanupAllConnections();
        metrics.counter('recovery.ws');
        logger.warn('Recovery: WebSocket connections reset');
    } catch (error) {
        logger.error({ error }, 'Recovery: WebSocket reset failed');
    }
}

function evaluateRecovery(): void {
    const now = Date.now();
    if (state === 'cooldown' && now < cooldownUntil) {
        return;
    }
    if (state === 'cooldown' && now >= cooldownUntil) {
        state = 'idle';
    }

    if (state !== 'idle') return;

    const wsStatus = getComponentStatus('ws');
    if (wsStatus.state === 'error' || wsStatus.state === 'degraded') {
        state = 'recovering';
        setComponentStatus('recovery', 'degraded', 'attempting ws recovery');
        attemptWsRecovery();
        state = 'cooldown';
        cooldownUntil = now + RECOVERY_COOLDOWN_MS;
        setComponentStatus('recovery', 'ok', 'cooldown');
    }
}

import { hydrateAllNetworks } from './smartLayer/neuralRecoveryNet';

export function initRecoveryManager(): void {
    // Load persisted weights
    hydrateAllNetworks().catch(err => {
        logger.error({ err }, 'Failed to hydrate neural networks');
    });

    const recoveryTimer = setInterval(() => {
        evaluateRecovery();
    }, RECOVERY_INTERVAL_MS);
    recoveryTimer.unref();
}
