const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const BUILD_MANIFEST = path.join(ROOT, '.next', 'build-manifest.json');
const BUDGET_BYTES = Number(process.env.BUNDLE_BUDGET_BYTES || 450 * 1024);

if (!fs.existsSync(BUILD_MANIFEST)) {
  console.error(`Missing build manifest: ${BUILD_MANIFEST}`);
  console.error('Run `npm run build` in frontend before checking bundle size.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(BUILD_MANIFEST, 'utf8'));
const files = [
  ...(manifest.polyfillFiles || []),
  ...(manifest.rootMainFiles || []),
];

let total = 0;
const rows = [];
for (const rel of files) {
  const abs = path.join(ROOT, '.next', rel);
  if (!fs.existsSync(abs)) continue;
  const size = fs.statSync(abs).size;
  total += size;
  rows.push({ file: rel, size });
}

rows.sort((a, b) => b.size - a.size);

console.log('Initial bundle files:');
for (const row of rows) {
  console.log(`- ${row.file}: ${row.size} bytes`);
}
console.log(`Total initial bytes: ${total}`);
console.log(`Budget bytes: ${BUDGET_BYTES}`);

if (total > BUDGET_BYTES) {
  console.error(`Bundle budget exceeded by ${total - BUDGET_BYTES} bytes.`);
  process.exit(1);
}

console.log('Bundle budget check passed.');
