
// ARCHIVED: Legacy Slow Mode Execution
// This code was removed from production to fix DoS vulnerabilities.
// It created a new WebSocket connection per request.
/*
export async function executeTradeServer(
    signal: 'CALL' | 'PUT',
    params: ExecuteTradeParams,
    auth: { token: string; accountId: string; accountType: 'real' | 'demo'; accountCurrency?: string | null },
    latencyTrace?: LatencyTrace
): Promise<TradeResult> {
    const signalValidation = TradeSignalSchema.safeParse(signal);
    if (!signalValidation.success) {
        throw new Error('Invalid trade signal');
    }

    const paramsValidation = ExecuteTradeParamsSchema.safeParse(params);
    if (!paramsValidation.success) {
        throw new Error(`Invalid trade parameters: ${paramsValidation.error.issues.map(e => e.message).join(', ')}`);
    }

    const { token, accountId, accountType, accountCurrency } = auth;
    let stake = params.stake;

    const gate = preTradeGate({
        accountId,
        stake,
        botRunId: params.botRunId ?? null,
    }, latencyTrace);
    stake = gate.stake;

    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);
        let reqId = 1;
        const getReqId = () => reqId++;
        const timestamps = {
            proposalRequestedAt: 0,
            proposalReceivedAt: 0,
            buySentAt: 0,
            buyConfirmedAt: 0,
        };
        let proposalSentPerfTs: number | null = null;
        let buySentPerfTs: number | null = null;
        let contractId: number | null = null;
        let rollbackApplied = false;

        const rollback = () => {
            if (rollbackApplied) return;
            rollbackApplied = true;
            recordTradeFailedAttemptOnce(accountId, contractId, stake);
        };

        const cleanup = () => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        };

        // ... (rest of implementation ommitted for brevity, check git history before Jan 2026)
    });
}
*/
