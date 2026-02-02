export type HealthState = 'ok' | 'degraded' | 'error';

export interface ComponentStatus {
    state: HealthState;
    detail?: string;
    lastUpdated: string;
}

const componentStatus = new Map<string, ComponentStatus>();

export function setComponentStatus(component: string, state: HealthState, detail?: string): void {
    componentStatus.set(component, {
        state,
        detail,
        lastUpdated: new Date().toISOString(),
    });
}

export function getComponentStatus(component: string): ComponentStatus {
    return componentStatus.get(component) || {
        state: 'ok',
        lastUpdated: new Date().toISOString(),
    };
}

export function getHealthSnapshot(): { ok: boolean; components: Record<string, ComponentStatus> } {
    const components: Record<string, ComponentStatus> = {};
    let ok = true;
    for (const [name, status] of componentStatus.entries()) {
        components[name] = status;
        if (status.state !== 'ok') {
            ok = false;
        }
    }
    return { ok, components };
}
