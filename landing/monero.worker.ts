declare function importScripts(...urls: string[]): void;
// BCH Stealth Wallet â€” Monero Web Worker bootstrap
// The full Monero WASM worker is pre-built at lib/monero.worker.js
// This file is loaded via importScripts from xmr-scanner.ts when needed
// at runtime using: importScripts(location.origin + '/lib/monero.worker.js')
importScripts('./lib/monero.worker.js');
