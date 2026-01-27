const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BLOCKED_BASENAMES = new Set(['.env.local']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build']);

const hits = [];

function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(path.join(dir, entry.name));
            continue;
        }
        if (BLOCKED_BASENAMES.has(entry.name)) {
            hits.push(path.join(dir, entry.name));
        }
    }
}

walk(ROOT);

if (hits.length > 0) {
    const rel = hits.map((p) => path.relative(ROOT, p));
    console.error('Secret files detected. Remove before starting:');
    for (const file of rel) {
        console.error(`- ${file}`);
    }
    process.exit(1);
}
