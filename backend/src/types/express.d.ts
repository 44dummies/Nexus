import type { RequestAuth } from '../lib/authMiddleware';

declare global {
    namespace Express {
        interface Request {
            auth?: RequestAuth;
            requestId?: string;
        }
    }
}

export {};
