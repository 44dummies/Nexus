import crypto from 'crypto';

const SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY;

function getKey() {
    if (!SESSION_ENCRYPTION_KEY) return null;
    const key = Buffer.from(SESSION_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) return null;
    return key;
}

export function encryptToken(token: string) {
    const key = getKey();
    if (!key) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
}

export function decryptToken(payload: { iv?: string; tag?: string; ciphertext?: string } | null | undefined) {
    const key = getKey();
    if (!key || !payload?.iv || !payload?.tag || !payload?.ciphertext) return null;
    try {
        const iv = Buffer.from(payload.iv, 'base64');
        const tag = Buffer.from(payload.tag, 'base64');
        const ciphertext = Buffer.from(payload.ciphertext, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted.toString('utf8');
    } catch {
        return null;
    }
}
