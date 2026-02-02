import fs from 'fs';
import path from 'path';

export type ObstacleSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ObstacleEntry {
    section: string;
    title: string;
    detail: string;
    severity: ObstacleSeverity;
    filePaths: string[];
    timestamp: string;
}

const obstacles: ObstacleEntry[] = [];
const seenKeys = new Set<string>();

function buildKey(entry: Omit<ObstacleEntry, 'timestamp'>): string {
    return `${entry.section}::${entry.title}::${entry.severity}::${entry.detail}`;
}

export function recordObstacle(
    section: string,
    title: string,
    detail: string,
    severity: ObstacleSeverity = 'medium',
    filePaths: string[] = []
): void {
    const entry: Omit<ObstacleEntry, 'timestamp'> = {
        section,
        title,
        detail,
        severity,
        filePaths,
    };
    const key = buildKey(entry);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    obstacles.push({
        ...entry,
        timestamp: new Date().toISOString(),
    });
}

// Required signature alias: record(section, title, detail, severity, filePaths[])
export const record = recordObstacle;

export function getObstacles(): ObstacleEntry[] {
    return [...obstacles];
}

function formatObstacles(): string {
    if (obstacles.length === 0) {
        return 'Obstacle Log: none\n';
    }

    const grouped = new Map<string, ObstacleEntry[]>();
    for (const entry of obstacles) {
        const list = grouped.get(entry.section) ?? [];
        list.push(entry);
        grouped.set(entry.section, list);
    }

    let output = 'Obstacle Log:\n';
    for (const [section, entries] of grouped.entries()) {
        output += `- ${section}\n`;
        for (const entry of entries) {
            const files = entry.filePaths.length > 0 ? ` [${entry.filePaths.join(', ')}]` : '';
            output += `  - (${entry.severity}) ${entry.title}: ${entry.detail}${files}\n`;
        }
    }
    return output;
}

function writeCiSummary(): void {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY || process.env.CI_SUMMARY_PATH || '';
    if (!summaryPath) return;

    try {
        const dir = path.dirname(summaryPath);
        if (dir && dir !== '.' && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(summaryPath, `\n## Obstacle Log\n\n${formatObstacles()}\n`);
    } catch (error) {
        console.error('Failed to write CI summary for obstacles', error);
    }
}

export function printObstacleLog(): void {
    const output = formatObstacles();
    if (output.trim().length > 0) {
        console.log(output.trimEnd());
    }
    writeCiSummary();
}

export function initObstacleLog(): void {
    process.on('exit', () => {
        printObstacleLog();
    });

    process.on('SIGTERM', () => {
        printObstacleLog();
        process.exit(0);
    });

    process.on('SIGINT', () => {
        printObstacleLog();
        process.exit(0);
    });
}
