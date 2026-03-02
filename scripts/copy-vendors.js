import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const src = path.join(root, 'node_modules', 'mlkem-wasm', 'dist', 'mlkem.js');
const dsts = [
  path.join(root, 'portal', 'vendor', 'mlkem.js'),
  path.join(root, 'extension', 'vendor', 'mlkem.js')
];

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

try {
  if (!fs.existsSync(src)) {
    console.error('[copy-vendors] Expected file not found:', src);
    console.error('[copy-vendors] Did you run `npm install`?');
    process.exit(1);
  }

  for (const dst of dsts) {
    ensureDir(dst);
    fs.copyFileSync(src, dst);
    console.log('[copy-vendors] Copied', src, '->', dst);
  }
} catch (err) {
  console.error('[copy-vendors] Failed:', err);
  process.exit(1);
}
