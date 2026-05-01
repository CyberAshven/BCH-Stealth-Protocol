#!/usr/bin/env node
/**
 * Chipnet E2E placeholder test for CI.
 *
 * Behavior:
 * - If required CHIPNET_* secrets are missing, exits 0 (skip) so CI doesn't fail.
 * - If secrets are present, performs basic format validation and exits 0.
 *
 * Replace this with a full network E2E flow when ready.
 */

function has(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

const sender = process.env.CHIPNET_SENDER_PRIV || '';
const scan = process.env.CHIPNET_SCAN_PRIV || '';
const spend = process.env.CHIPNET_SPEND_PRIV || '';
const fulcrum = process.env.CHIPNET_FULCRUM || '';

if (!has(sender) || !has(scan) || !has(spend)) {
  console.log('Chipnet E2E: skipped (missing CHIPNET_* secrets).');
  process.exit(0);
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;
if (!HEX_64.test(scan)) {
  console.error('CHIPNET_SCAN_PRIV must be 64 hex chars');
  process.exit(1);
}
if (!HEX_64.test(spend)) {
  console.error('CHIPNET_SPEND_PRIV must be 64 hex chars');
  process.exit(1);
}
if (!has(fulcrum)) {
  console.error('CHIPNET_FULCRUM is required when running E2E');
  process.exit(1);
}

console.log('Chipnet E2E: secrets present, basic validation passed.');
console.log('Endpoint:', fulcrum);
process.exit(0);
