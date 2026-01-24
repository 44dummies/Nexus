import { registerConnectionReadyListener, sendMessageAsync } from './wsManager';
import { tradeLogger } from './logger';

const pendingSettlements = new Map<string, Set<number>>();
const registeredAccounts = new Set<string>();

export function registerPendingSettlement(accountId: string, contractId: number) {
    let bucket = pendingSettlements.get(accountId);
    if (!bucket) {
        bucket = new Set();
        pendingSettlements.set(accountId, bucket);
    }
    bucket.add(contractId);

    if (!registeredAccounts.has(accountId)) {
        registerConnectionReadyListener(accountId, (accId, isReconnect) => {
            if (!isReconnect) return;
            resubscribePendingSettlements(accId);
        });
        registeredAccounts.add(accountId);
    }
}

export function clearPendingSettlement(accountId: string, contractId: number) {
    const bucket = pendingSettlements.get(accountId);
    if (!bucket) return;
    bucket.delete(contractId);
    if (bucket.size === 0) {
        pendingSettlements.delete(accountId);
    }
}

export function resubscribePendingSettlements(accountId: string) {
    const bucket = pendingSettlements.get(accountId);
    if (!bucket || bucket.size === 0) return;

    for (const contractId of bucket) {
        try {
            sendMessageAsync(accountId, {
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1,
            });
        } catch (error) {
            tradeLogger.error({ accountId, contractId, error }, 'Settlement resubscribe failed');
        }
    }
}
