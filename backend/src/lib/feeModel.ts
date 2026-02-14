/**
 * Unified fee model for live and backtest execution paths.
 */

export interface FeeModelInput {
    stake: number;
    commissionFlat?: number;
    commissionBps?: number;
}

export function calculateTradeFees(input: FeeModelInput): number {
    const stake = Number.isFinite(input.stake) ? input.stake : 0;
    const flat = Number.isFinite(input.commissionFlat) ? input.commissionFlat as number : 0;
    const bps = Number.isFinite(input.commissionBps) ? input.commissionBps as number : 0;
    const variableFee = stake * (bps / 10_000);
    const fees = flat + variableFee;
    return Number.isFinite(fees) ? fees : 0;
}
