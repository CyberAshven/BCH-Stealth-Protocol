#!/usr/bin/env node
/**
 * Compile all .ts files in landing/ back to .js using esbuild.
 * Only compiles if .ts is newer than .js or .js is missing.
 * Run after editing any .ts source files.
 */

import { build } from 'esbuild';
import { readdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const DIRS = [
  join(root, 'landing'),
  join(root, 'landing', 'core'),
  join(root, 'landing', 'views'),
  join(root, 'landing', 'services'),
];

// Files that should NOT be compiled
const SKIP = new Set(['monero.worker.ts', 'sw.ts']);

let compiled = 0;
let skipped = 0;
const errors = [];

for (const dir of DIRS) {
  let files;
  try { files = readdirSync(dir); } catch { continue; }

  for (const file of files) {
    if (!file.endsWith('.ts')) continue;
    if (SKIP.has(file)) continue;

    const tsPath = join(dir, file);
    const jsPath = tsPath.replace(/\.ts$/, '.js');

    // Skip if .js is newer than .ts
    if (existsSync(jsPath)) {
      const tsMtime = statSync(tsPath).mtimeMs;
      const jsMtime = statSync(jsPath).mtimeMs;
      if (jsMtime >= tsMtime) { skipped++; continue; }
    }

    try {
      await build({
        entryPoints: [tsPath],
        outfile: jsPath,
        format: 'esm',
        platform: 'browser',
        target: 'es2020',
        bundle: false,
        loader: { '.ts': 'ts' },
        logLevel: 'silent',
      });
      compiled++;
      process.stdout.write(`✓ ${file.replace('.ts', '')}\n`);
    } catch (err) {
      errors.push({ file, err });
      process.stderr.write(`✗ ${file}: ${err.message?.split('\n')[0]}\n`);
    }
  }
}

console.log(`\nCompiled: ${compiled}, Skipped: ${skipped}, Errors: ${errors.length}`);
if (errors.length > 0) process.exit(1);
