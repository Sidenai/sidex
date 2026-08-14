import { existsSync, readdirSync, cpSync, copyFileSync } from 'fs';
import { join } from 'path';

const DIST_DIR = 'dist';
const ASSETS_DIR = join(DIST_DIR, 'assets');

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getFileSizes(dir, extension) {
  if (!existsSync(dir)) return { total: 0, files: [] };

  const files = readdirSync(dir)
    .filter(f => f.endsWith(extension))
    .map(f => ({
      name: f,
      size: Bun.file(join(dir, f)).size
    }))
    .sort((a, b) => b.size - a.size);

  return {
    total: files.reduce((sum, f) => sum + f.size, 0),
    files
  };
}

// Copy extensions
if (existsSync('extensions')) {
  cpSync('extensions', join(DIST_DIR, 'extensions'), { recursive: true, force: true });
}
if (existsSync('extensions-meta.json')) {
  copyFileSync('extensions-meta.json', join(DIST_DIR, 'extensions-meta.json'));
}
console.log('Post-build: copied extensions\n');

// Calculate bundle sizes
const js = getFileSizes(ASSETS_DIR, '.js');
const css = getFileSizes(ASSETS_DIR, '.css');
const wasm = getFileSizes(ASSETS_DIR, '.wasm');
const other = getFileSizes(ASSETS_DIR, '.ttf');

console.log('═══════════════════════════════════════════════════════════');
console.log('                    BUNDLE SIZE SUMMARY                     ');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  JavaScript:  ${formatSize(js.total).padStart(12)}`);
console.log(`  CSS:         ${formatSize(css.total).padStart(12)}`);
console.log(`  Fonts:       ${formatSize(other.total).padStart(12)}`);
console.log(`  WASM:        ${formatSize(wasm.total).padStart(12)}`);
console.log('───────────────────────────────────────────────────────────');
console.log(`  TOTAL:       ${formatSize(js.total + css.total + other.total + wasm.total).padStart(12)}`);
console.log('═══════════════════════════════════════════════════════════');

// Show top 5 largest JS files
console.log('\nTop 5 largest JS chunks:');
js.files.slice(0, 5).forEach((f, i) => {
  console.log(`  ${i + 1}. ${f.name.padEnd(50)} ${formatSize(f.size).padStart(10)}`);
});
console.log('');
