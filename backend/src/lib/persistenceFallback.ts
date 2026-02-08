import fs from 'fs';
import path from 'path';
import { metrics } from './metrics';
import logger from './logger';
import { record as recordObstacle } from './obstacleLog';

const FALLBACK_ENABLED = (process.env.PERSIST_FALLBACK_ENABLED || 'false') === 'true';
const FALLBACK_PATH = process.env.PERSIST_FALLBACK_PATH || '/tmp/44dummies-persist-fallback.jsonl';
const FALLBACK_MAX_BYTES = Math.max(1024 * 1024, Number(process.env.PERSIST_FALLBACK_MAX_BYTES) || 10 * 1024 * 1024);

export async function writePersistenceFallback(entry: Record<string, unknown>): Promise<boolean> {
    if (!FALLBACK_ENABLED) return false;
    try {
        const dir = path.dirname(FALLBACK_PATH);
        if (dir && dir !== '.') {
            await fs.promises.mkdir(dir, { recursive: true });
        }
        try {
            const stats = await fs.promises.stat(FALLBACK_PATH);
            if (stats.size > FALLBACK_MAX_BYTES) {
                recordObstacle('database', 'Persistence fallback', 'Fallback file exceeds max size', 'medium', ['backend/src/lib/persistenceFallback.ts']);
                metrics.counter('persistence.fallback_skipped');
                return false;
            }
        } catch (error) {
            // ignore missing file
        }

        await fs.promises.appendFile(FALLBACK_PATH, JSON.stringify(entry) + '\n');
        metrics.counter('persistence.fallback_written');
        return true;
    } catch (error) {
        metrics.counter('persistence.fallback_error');
        logger.error({ error }, 'Failed to write persistence fallback file');
        return false;
    }
}
