const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BLOCKED_BASENAMES = new Set([
    '.env',
    '.env.local',
    '.env.production',
    '.env.development',
    '.env.test',
    'railway_vars_check.txt',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build']);

const hits = [];
const MAX_SCAN_BYTES = 512 * 1024;
const SECRET_PATTERNS = [
    {
        name: 'Supabase service role key',
        regex: /SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*["']?[A-Za-z0-9._-]{40,}/,
    },
    {
        name: 'Kill switch/admin token',
        regex: /(KILL_SWITCH_ADMIN_TOKEN|ADMIN_SECRET)\s*[=:]\s*["']?[A-Za-z0-9_\-+/=]{20,}/,
    },
    {
        name: 'Session encryption key',
        regex: /SESSION_ENCRYPTION_KEY\s*[=:]\s*["']?[A-Za-z0-9_\-+/=]{20,}/,
    },
    {
        name: 'JWT-like token',
        regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/,
    },
    {
        name: 'Private key material',
        regex: /-----BEGIN (RSA|EC|OPENSSH|PGP|DSA)?\s*PRIVATE KEY-----/,
    },
];

function normalizePath(filePath) {
    return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function shouldScanContents(filePath) {
    const basename = path.basename(filePath).toLowerCase();
    if (basename.startsWith('.env')) return true;
    if (basename.includes('secret') || basename.includes('token') || basename.includes('credential')) return true;
    if (basename.includes('railway') && basename.includes('var')) return true;
    const ext = path.extname(filePath).toLowerCase();
    return [
        '.js', '.cjs', '.mjs', '.ts', '.tsx', '.json', '.md', '.txt', '.yaml', '.yml', '.toml', '.conf',
    ].includes(ext);
}

function scanFile(filePath) {
    if (!shouldScanContents(filePath)) return;
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return;
    }

    const slice = content.length > MAX_SCAN_BYTES ? content.slice(0, MAX_SCAN_BYTES) : content;
    for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(slice)) {
            hits.push(`${normalizePath(filePath)} :: ${pattern.name}`);
        }
    }
}

function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(path.join(dir, entry.name));
            continue;
        }
        const filePath = path.join(dir, entry.name);
        if (BLOCKED_BASENAMES.has(entry.name.toLowerCase())) {
            hits.push(`${normalizePath(filePath)} :: blocked secret filename`);
        }
        scanFile(filePath);
    }
}

walk(ROOT);

if (hits.length > 0) {
    console.error('Secret files detected. Remove before starting:');
    for (const hit of hits) {
        console.error(`- ${hit}`);
    }
    process.exit(1);
}
