#!/usr/bin/env node
/**
 * Bundle external npm packages into local lib files for the browser SPA.
 * This eliminates the need for CDN (esm.sh) imports, making the app work
 * offline and inside Electron without internet access.
 *
 * Outputs: landing/lib/noble-curves.js, noble-hashes.js, noble-ciphers.js, qrcode.js
 */

import { build } from 'esbuild';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'landing', 'lib');

mkdirSync(outDir, { recursive: true });

const bundles = [
  {
    name: 'noble-curves',
    entry: `
export { secp256k1, schnorr } from '@noble/curves/secp256k1';
export { ed25519, x25519 } from '@noble/curves/ed25519';
`,
  },
  {
    name: 'noble-hashes',
    entry: `
export { sha256 } from '@noble/hashes/sha256';
export { sha512 } from '@noble/hashes/sha512';
export { ripemd160 } from '@noble/hashes/ripemd160';
export { hmac } from '@noble/hashes/hmac';
export { keccak_256 } from '@noble/hashes/sha3';
export { extract as hkdfExtract, expand as hkdfExpand } from '@noble/hashes/hkdf';
`,
  },
  {
    name: 'noble-ciphers',
    entry: `
export { chacha20 } from '@noble/ciphers/chacha';
`,
  },
  {
    name: 'qrcode',
    entry: `
export { default } from 'qrcode';
`,
    platform: 'browser',
  },
];

for (const bundle of bundles) {
  const tmpFile = join(root, `_bundle_tmp_${bundle.name}.mjs`);
  writeFileSync(tmpFile, bundle.entry, 'utf8');

  try {
    await build({
      entryPoints: [tmpFile],
      bundle: true,
      format: 'esm',
      platform: bundle.platform || 'neutral',
      outfile: join(outDir, `${bundle.name}.js`),
      minify: true,
      target: 'es2020',
      treeShaking: true,
      logLevel: 'info',
    });
    console.log(`✓ Bundled ${bundle.name}.js`);
  } finally {
    unlinkSync(tmpFile);
  }
}

console.log('\n✓ All libs bundled to landing/lib/');
