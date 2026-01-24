/**
 * Structured Logger
 * Uses pino for high-performance structured logging
 */

import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    transport: isProduction
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
            },
        },
    base: {
        service: 'derivnexus-backend',
    },
});

// Child loggers for different modules
export const wsLogger = logger.child({ module: 'websocket' });
export const tradeLogger = logger.child({ module: 'trade' });
export const riskLogger = logger.child({ module: 'risk' });
export const botLogger = logger.child({ module: 'bot' });
export const tickLogger = logger.child({ module: 'tick' });
export const authLogger = logger.child({ module: 'auth' });

export default logger;
