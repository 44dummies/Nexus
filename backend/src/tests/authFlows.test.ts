/**
 * Authentication Flows Test
 * Tests for OAuth flow and session handling
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Mock session crypto
function generateIV(): Buffer {
    return crypto.randomBytes(16);
}

function encrypt(text: string, key: Buffer): { iv: string; encrypted: string } {
    const iv = generateIV();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    
    return {
        iv: iv.toString('hex'),
        encrypted: encrypted + ':' + authTag
    };
}

function decrypt(encryptedData: { iv: string; encrypted: string }, key: Buffer): string {
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const [encrypted, authTag] = encryptedData.encrypted.split(':');
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
}

// Test: Session encryption/decryption roundtrip
test('Session encryption roundtrip works correctly', () => {
    const key = crypto.randomBytes(32);
    const token = 'deriv_token_abc123xyz';
    
    const encrypted = encrypt(token, key);
    const decrypted = decrypt(encrypted, key);
    
    assert.equal(decrypted, token);
});

// Test: Encrypted values are different each time (due to random IV)
test('Encryption produces unique ciphertext per call', () => {
    const key = crypto.randomBytes(32);
    const token = 'deriv_token_abc123xyz';
    
    const encrypted1 = encrypt(token, key);
    const encrypted2 = encrypt(token, key);
    
    // IVs should be different
    assert.notEqual(encrypted1.iv, encrypted2.iv);
    
    // Ciphertexts should be different
    assert.notEqual(encrypted1.encrypted, encrypted2.encrypted);
    
    // But both should decrypt to same value
    assert.equal(decrypt(encrypted1, key), token);
    assert.equal(decrypt(encrypted2, key), token);
});

// Test: Decryption fails with wrong key
test('Decryption fails with wrong key', () => {
    const key1 = crypto.randomBytes(32);
    const key2 = crypto.randomBytes(32);
    const token = 'deriv_token_abc123xyz';
    
    const encrypted = encrypt(token, key1);
    
    assert.throws(() => {
        decrypt(encrypted, key2);
    });
});

// Test: Decryption fails with tampered ciphertext
test('Decryption fails with tampered ciphertext', () => {
    const key = crypto.randomBytes(32);
    const token = 'deriv_token_abc123xyz';
    
    const encrypted = encrypt(token, key);
    
    // Tamper with ciphertext
    const tamperedEncrypted = encrypted.encrypted.replace(
        encrypted.encrypted[0],
        encrypted.encrypted[0] === 'a' ? 'b' : 'a'
    );
    
    assert.throws(() => {
        decrypt({ iv: encrypted.iv, encrypted: tamperedEncrypted }, key);
    });
});

// OAuth state validation
test('OAuth state validation prevents CSRF', () => {
    const generateState = (): string => {
        return crypto.randomBytes(32).toString('hex');
    };
    
    const validateState = (provided: string | undefined, stored: string | undefined): boolean => {
        if (!provided || !stored) return false;
        if (provided.length !== stored.length) return false;
        return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(stored));
    };
    
    const state = generateState();
    
    // Valid state
    assert.equal(validateState(state, state), true);
    
    // Missing provided state
    assert.equal(validateState(undefined, state), false);
    
    // Missing stored state
    assert.equal(validateState(state, undefined), false);
    
    // Mismatched state
    const wrongState = generateState();
    assert.equal(validateState(wrongState, state), false);
});

// Token format validation
test('Token format validation', () => {
    const isValidDerivToken = (token: unknown): boolean => {
        if (typeof token !== 'string') return false;
        if (token.length < 10 || token.length > 200) return false;
        // Should only contain alphanumeric and some special chars
        return /^[a-zA-Z0-9_-]+$/.test(token);
    };
    
    assert.equal(isValidDerivToken('valid_token_12345'), true);
    assert.equal(isValidDerivToken('a1b2c3d4e5f6g7h8'), true);
    assert.equal(isValidDerivToken(''), false);
    assert.equal(isValidDerivToken('short'), false);
    assert.equal(isValidDerivToken(null), false);
    assert.equal(isValidDerivToken(123), false);
    assert.equal(isValidDerivToken('token with spaces'), false);
    assert.equal(isValidDerivToken('token<script>'), false);
});

// Cookie options validation
test('Auth cookie options are secure', () => {
    const getSecureCookieOptions = (isProduction: boolean) => ({
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax' as const,
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    
    const prodOptions = getSecureCookieOptions(true);
    assert.equal(prodOptions.httpOnly, true);
    assert.equal(prodOptions.secure, true);
    assert.equal(prodOptions.sameSite, 'lax');
    
    const devOptions = getSecureCookieOptions(false);
    assert.equal(devOptions.httpOnly, true);
    assert.equal(devOptions.secure, false);
});

// Account ID validation
test('Deriv account ID validation', () => {
    const isValidAccountId = (id: unknown): boolean => {
        if (typeof id !== 'string') return false;
        // Deriv account IDs are typically like CR12345, VRTC12345
        return /^[A-Z]{2,4}\d+$/.test(id);
    };
    
    assert.equal(isValidAccountId('CR12345'), true);
    assert.equal(isValidAccountId('VRTC123456'), true);
    assert.equal(isValidAccountId('MF12345'), true);
    assert.equal(isValidAccountId('12345'), false);
    assert.equal(isValidAccountId('CR'), false);
    assert.equal(isValidAccountId('cr12345'), false);
    assert.equal(isValidAccountId(''), false);
    assert.equal(isValidAccountId(null), false);
});

// Session expiry checking
test('Session expiry checking', () => {
    const isSessionExpired = (lastSeen: Date | string | null, maxAgeMs: number): boolean => {
        if (!lastSeen) return true;
        
        const lastSeenTime = typeof lastSeen === 'string' 
            ? new Date(lastSeen).getTime() 
            : lastSeen.getTime();
        
        if (isNaN(lastSeenTime)) return true;
        
        return Date.now() - lastSeenTime > maxAgeMs;
    };
    
    const ONE_DAY = 24 * 60 * 60 * 1000;
    
    // Recent session
    assert.equal(isSessionExpired(new Date(), ONE_DAY), false);
    
    // Old session
    assert.equal(isSessionExpired(new Date(Date.now() - 2 * ONE_DAY), ONE_DAY), true);
    
    // Null session
    assert.equal(isSessionExpired(null, ONE_DAY), true);
    
    // Invalid date string
    assert.equal(isSessionExpired('invalid', ONE_DAY), true);
    
    // Valid ISO string
    assert.equal(isSessionExpired(new Date().toISOString(), ONE_DAY), false);
});

// Token cache key generation
test('Token cache key is deterministic', () => {
    const getCacheKey = (token: string): string => {
        return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    };
    
    const token = 'my_secret_token';
    
    // Same input produces same key
    assert.equal(getCacheKey(token), getCacheKey(token));
    
    // Different input produces different key
    assert.notEqual(getCacheKey('token1'), getCacheKey('token2'));
});

// Multi-account handling
test('Multi-account token selection', () => {
    interface AccountToken {
        accountId: string;
        token: string;
        accountType: 'real' | 'demo';
    }
    
    const selectToken = (
        accounts: AccountToken[],
        preferredType: 'real' | 'demo' | null,
        preferredId: string | null
    ): AccountToken | null => {
        if (accounts.length === 0) return null;
        
        // Try to find by preferred ID
        if (preferredId) {
            const byId = accounts.find(a => a.accountId === preferredId);
            if (byId) return byId;
        }
        
        // Try to find by preferred type
        if (preferredType) {
            const byType = accounts.find(a => a.accountType === preferredType);
            if (byType) return byType;
        }
        
        // Return first account
        return accounts[0];
    };
    
    const accounts: AccountToken[] = [
        { accountId: 'CR123', token: 't1', accountType: 'real' },
        { accountId: 'VRTC456', token: 't2', accountType: 'demo' },
    ];
    
    // Prefer by ID
    assert.equal(selectToken(accounts, null, 'VRTC456')?.accountId, 'VRTC456');
    
    // Prefer by type
    assert.equal(selectToken(accounts, 'demo', null)?.accountType, 'demo');
    
    // No preference - first account
    assert.equal(selectToken(accounts, null, null)?.accountId, 'CR123');
    
    // Non-existent preference falls back
    assert.equal(selectToken(accounts, null, 'NONEXISTENT')?.accountId, 'CR123');
    
    // Empty accounts
    assert.equal(selectToken([], null, null), null);
});
