import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { IncomingMessage } from 'http';
import type { HelmetOptions } from 'helmet';

export type CspRequest = Request & { cspNonce?: string };

export function attachCspNonce(req: Request, _res: Response, next: NextFunction): void {
    (req as CspRequest).cspNonce = crypto.randomBytes(16).toString('base64');
    next();
}

export function buildHelmetSecurityOptions(): HelmetOptions {
    return {
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", (req: IncomingMessage) => `'nonce-${((req as CspRequest).cspNonce ?? '')}'`],
                styleSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                frameAncestors: ["'none'"],
            },
        },
    };
}
