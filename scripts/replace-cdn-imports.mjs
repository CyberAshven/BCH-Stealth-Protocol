#!/usr/bin/env node
/**
 * Replace all https://esm.sh/ CDN imports with local lib files.
 * This makes the app work offline and in Electron without internet.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname, relative, posix } from 'path';
import { fileURLToPath } from 'url';


const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const libDir = join(root, 'landing', 'lib');

// Map from CDN module path → local lib file + exported names
const CDN_MAP = {
  'https://esm.sh/@noble/curves@1.8.1/secp256k1': 'noble-curves.js',
  'https://esm.sh/@noble/curves@1.8.1/ed25519':   'noble-curves.js',
  'https://esm.sh/@noble/hashes@1.7.1/sha256':    'noble-hashes.js',
  'https://esm.sh/@noble/hashes@1.7.1/sha512':    'noble-hashes.js',
  'https://esm.sh/@noble/hashes@1.7.1/ripemd160': 'noble-hashes.js',
  'https://esm.sh/@noble/hashes@1.7.1/hmac':      'noble-hashes.js',
  'https://esm.sh/@noble/hashes@1.7.1/sha3':      'noble-hashes.js',
  'https://esm.sh/@noble/hashes@1.7.1/hkdf':      'noble-hashes.js',
  'https://esm.sh/@noble/ciphers@1.2.1/chacha':   'noble-ciphers.js',
  'https://esm.sh/qrcode@1.5.4':                  'qrcode.js',
};

// Files to process
const TARGET_DIRS = [
  join(root, 'landing'),          // *.js at root
  join(root, 'landing', 'core'),  // core/*.js
  join(root, 'landing', 'views'), // views/*.js
  join(root, 'landing', 'services'), // services/*.js
];

import { readdirSync, statSync } from 'fs';

function getJsFiles(dir) {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.js') && !f.startsWith('_'))
      .map(f => join(dir, f));
  } catch { return []; }
}

let totalChanged = 0;

for (const dir of TARGET_DIRS) {
  for (const filePath of getJsFiles(dir)) {
    let content = readFileSync(filePath, 'utf8');
    if (!content.includes('esm.sh')) continue;

    const fileDir = dirname(filePath);
    let changed = false;

    for (const [cdnUrl, libFile] of Object.entries(CDN_MAP)) {
      if (!content.includes(cdnUrl)) continue;

      // Calculate relative path from file to lib
      const libPath = join(libDir, libFile);
      let rel = relative(fileDir, libPath).replace(/\\/g, '/');
      if (!rel.startsWith('.')) rel = './' + rel;

      // Replace both single and double quoted versions
      const escaped = cdnUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(['"])${escaped}\\1`, 'g');
      const newContent = content.replace(re, `'${rel}'`);
      if (newContent !== content) {
        content = newContent;
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(filePath, content, 'utf8');
      console.log(`✓ Updated: ${filePath.replace(root, '').replace(/\\/g, '/')}`);
      totalChanged++;
    }
  }
}

console.log(`\n✓ Updated ${totalChanged} files.`);
