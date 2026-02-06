/**
 * Bot Profit Attribution Registry
 * Tracks which contracts belong to which bot run for profit attribution.
 * Separated from botController to avoid circular imports with tradePersistence.
 */

// contractId -> botRunId
const pendingContracts = new Map<number, string>();

// botRunId -> { totalProfit, callback }
type ProfitCallback = (contractId: number, profit: number) => void;
const callbacks = new Map<string, ProfitCallback>();

export function registerBotContract(contractId: number, botRunId: string): void {
    pendingContracts.set(contractId, botRunId);
}

export function registerProfitCallback(botRunId: string, cb: ProfitCallback): void {
    callbacks.set(botRunId, cb);
}

export function unregisterProfitCallback(botRunId: string): void {
    callbacks.delete(botRunId);
}

/**
 * Called by tradePersistence when a trade settles.
 * Routes the profit to the correct bot run via the registered callback.
 */
export function attributeSettledProfit(contractId: number, profit: number): void {
    const botRunId = pendingContracts.get(contractId);
    if (!botRunId) return;
    pendingContracts.delete(contractId);
    const cb = callbacks.get(botRunId);
    if (cb) {
        try {
            cb(contractId, profit);
        } catch {
            // swallow - don't let attribution errors break persistence
        }
    }
}
