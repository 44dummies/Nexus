import Redis from 'ioredis';
import { pino } from 'pino';

const logger = pino({
    name: 'redis-client',
    level: process.env.LOG_LEVEL || 'info',
});

const redisUrl = process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379';

let redisClient: Redis | null = null;

try {
    redisClient = new Redis(redisUrl, {
        lazyConnect: true, // Don't connect until needed (helps tests)
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
            const delay = Math.min(times * 50, 2000);
            return delay;
        },
        reconnectOnError(err) {
            const targetError = 'READONLY';
            if (err.message.includes(targetError)) {
                return true;
            }
            return false;
        },
    });

    redisClient.on('error', (err) => {
        logger.error({ err }, 'Redis client error');
    });

    redisClient.on('connect', () => {
        logger.info('Redis client connected');
    });

} catch (error) {
    logger.error({ error }, 'Failed to initialize Redis client');
}

export { redisClient };
