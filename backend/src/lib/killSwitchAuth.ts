export function assertKillSwitchAuthorization(scope: string, providedToken: string | undefined | null): { ok: boolean; status: number; error?: string } {
    const adminToken = process.env.KILL_SWITCH_ADMIN_TOKEN;
    if (!adminToken) {
        return { ok: false, status: 503, error: 'Kill switch unavailable' };
    }
    if (scope === 'global' && providedToken !== adminToken) {
        return { ok: false, status: 403, error: 'Unauthorized' };
    }
    return { ok: true, status: 200 };
}
