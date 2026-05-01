#!/usr/bin/env node
/**
 * TypeScript migration script for landing/ browser files.
 *
 * What it does:
 *   1. Renames every .js file in landing/ (excluding lib/) to .ts
 *   2. Compiles each .ts back to .js using esbuild (no bundling, just TS→JS)
 *
 * The .ts files become the source of truth; .js files are compiled output.
 * Run this once to migrate, then use `npm run build:landing` for subsequent builds.
 */

import { build } from 'esbuild';
import { readdirSync, renameSync, statSync, existsSync } from 'fs';
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

// Files that should NOT be renamed (already have non-TS content or are outputs)
const SKIP = new Set(['monero.worker.js', 'sw.js']);

let renamed = 0;

for (const dir of DIRS) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    if (SKIP.has(file)) continue;

    const jsPath = join(dir, file);
    const tsPath = jsPath.replace(/\.js$/, '.ts');

    if (statSync(jsPath).isFile() && !existsSync(tsPath)) {
      renameSync(jsPath, tsPath);
      renamed++;
    }
  }
}

console.log(`Renamed ${renamed} .js files to .ts`);

// Now compile all .ts files back to .js using esbuild
const tsFiles = [];
for (const dir of DIRS) {
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.ts')) {
      tsFiles.push(join(dir, file));
    }
  }
}

console.log(`Compiling ${tsFiles.length} .ts files...`);

for (const tsFile of tsFiles) {
  const jsFile = tsFile.replace(/\.ts$/, '.js');
  await build({
    entryPoints: [tsFile],
    outfile: jsFile,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    bundle: false,
    loader: { '.ts': 'ts' },
    logLevel: 'silent',
  });
}

console.log('✓ TypeScript migration complete');
