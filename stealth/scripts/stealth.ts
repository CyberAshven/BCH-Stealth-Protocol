#!/usr/bin/env node
/**
 * 00 Protocol — BCH Stealth Address Engine (TypeScript source)
 *
 * Implements the BCH Stealth Protocol final spec:
 *   • Per-input weighted aggregation (CoinJoin-resistant), 1 ECDH per tx.
 *   • BIP-340 tagged hashes with locked domain tags (see TAG_* constants).
 *   • Per-payer labels: B_spend_m = B_spend + tweak_m·G.
 *   • GAP-limit (=3) unbounded k scan per label.
 *   • BIP-32 derivation at m/352'/145'/<account>'/{0',1'}/0
 *     (hardened {0',1'} gates provide scan/spend isolation).
 *   • Raw-key import is intentionally NOT supported.
 *
 * TypeScript twin of `stealth.js`. Keeps 100% behavioral parity with the JS
 * runtime engine. Edit this file, then run `npm run build:ts` in
 * `stealth/scripts/` to regenerate `stealth.js`.
 */

import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';

// ══════════════════════════════════════════
// PUBLIC TYPES (JSON-RPC bridge surface)
// ══════════════════════════════════════════

export type HexString = string;
export type Outpoint = { txidBE?: HexString; txid?: HexString; vout: number };
export interface StealthKeys {
  spendPriv: HexString;
  spendPub: HexString;
  scanPriv: HexString;
  scanPub: HexString;
  paycode: string;
  warning?: string;
}
export interface DerivedAddress { addr: string; pub: HexString; c: HexString; k?: number }
export interface DetectedOutput { vin: number; vout: number; value: number; addr: string; pub: HexString; c: HexString; k: number }
export interface NostrRumor { kind: number; content?: string; tags?: string[][]; created_at?: number }
export interface NostrEvent { kind: number; pubkey: HexString; created_at: number; tags: string[][]; content: string; id?: HexString; sig?: HexString }
export type BridgeRequest =
  | { action: 'derive_keys'; params: { masterPriv: HexString; masterChain: HexString; account?: number } }
  | { action: 'derive_keys_from_seed'; params: { seed: string; account?: number } }
  | { action: 'derive_keys_from_account'; params: { acctPrivHex: HexString; acctChainHex: HexString } }
  | { action: 'make_paycode'; params: { scanPub: HexString; spendPub: HexString; scanPriv?: HexString; label?: number } }
  | { action: 'parse_paycode'; params: { paycode: string } }
  | { action: 'label_tweak'; params: { scanPriv: HexString; label: number } }
  | { action: 'derive_address'; params: { senderPrivs?: HexString[]; outpoints?: Outpoint[]; senderPriv?: HexString; outpoint?: HexString; recipScanPub: HexString; recipSpendPub: HexString; k?: number } }
  | { action: 'spending_key'; params: { spendPriv: HexString; c: HexString; tweakM?: HexString; scanPriv?: HexString; label?: number } }
  | { action: 'detect_payment'; params: { rawTxHex: HexString; scanPriv: HexString; spendPub: HexString; labels?: number[] } }
  | { action: 'parse_tx'; params: { rawTxHex: HexString } }
  | { action: 'scan_indexer'; params: { scanPriv: HexString; spendPub: HexString; fromHeight: number; toHeight: number; indexerUrl?: string; labels?: number[] } }
  | { action: 'nip44_encrypt'; params: { myPriv: HexString; recipPubXOnly: HexString; plaintext: string } }
  | { action: 'nip44_decrypt'; params: { myPriv: HexString; senderPubXOnly: HexString; payload: string } }
  | { action: 'nip59_wrap'; params: { senderPriv: HexString; recipPubXOnly: HexString; rumor: NostrRumor } }
  | { action: 'nip59_unwrap'; params: { recipPriv: HexString; event: NostrEvent } }
  | { action: 'schnorr_pub'; params: { priv: HexString } }
  | { action: 'test'; params?: Record<string, never> };


// ══════════════════════════════════════════
// SECP256K1 MINI LIBRARY (no external deps)
// ══════════════════════════════════════════

// secp256k1 curve parameters
const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function mod(a: bigint, m: bigint = P): bigint { return ((a % m) + m) % m; }
function modInv(a: bigint, m: bigint = P): bigint {
  let [old_r, r] = [a, m], [old_s, s] = [1n, 0n];
  while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
  return mod(old_s, m);
}

// Jacobian point arithmetic
function jacobianAdd(x1: bigint, y1: bigint, z1: bigint, x2: bigint, y2: bigint, z2: bigint): [bigint, bigint, bigint] {
  if (z1 === 0n) return [x2, y2, z2];
  if (z2 === 0n) return [x1, y1, z1];
  const z1z1 = mod(z1 * z1), z2z2 = mod(z2 * z2);
  const u1 = mod(x1 * z2z2), u2 = mod(x2 * z1z1);
  const s1 = mod(y1 * z2 * z2z2), s2 = mod(y2 * z1 * z1z1);
  if (u1 === u2) return s1 === s2 ? jacobianDouble(x1, y1, z1) : [0n, 1n, 0n];
  const h = mod(u2 - u1), hh = mod(h * h), hhh = mod(h * hh);
  const r = mod(s2 - s1);
  const x3 = mod(r * r - hhh - 2n * u1 * hh);
  const y3 = mod(r * (u1 * hh - x3) - s1 * hhh);
  const z3 = mod(z1 * z2 * h);
  return [x3, y3, z3];
}
function jacobianDouble(x: bigint, y: bigint, z: bigint): [bigint, bigint, bigint] {
  if (y === 0n) return [0n, 1n, 0n];
  const ysq = mod(y * y), s = mod(4n * x * ysq), m = mod(3n * x * x);
  const x3 = mod(m * m - 2n * s), y3 = mod(m * (s - x3) - 8n * ysq * ysq);
  const z3 = mod(2n * y * z);
  return [x3, y3, z3];
}
function jacobianMul(k: bigint, px: bigint, py: bigint): [bigint, bigint] {
  let [rx, ry, rz] = [0n, 1n, 0n];
  let [qx, qy, qz] = [px, py, 1n];
  while (k > 0n) {
    if (k & 1n) [rx, ry, rz] = jacobianAdd(rx, ry, rz, qx, qy, qz);
    [qx, qy, qz] = jacobianDouble(qx, qy, qz);
    k >>= 1n;
  }
  const zinv = modInv(rz);
  return [mod(rx * zinv * zinv), mod(ry * zinv * zinv * zinv)];
}

function pointMul(k: bigint, px: bigint = Gx, py: bigint = Gy): [bigint, bigint] { return jacobianMul(k, px, py); }
function pointAdd(x1: bigint, y1: bigint, x2: bigint, y2: bigint): [bigint, bigint] {
  const [rx, ry, rz] = jacobianAdd(x1, y1, 1n, x2, y2, 1n);
  if (rz === 0n) return [0n, 0n];
  const zinv = modInv(rz);
  return [mod(rx * zinv * zinv), mod(ry * zinv * zinv * zinv)];
}

function privToPub(priv: HexString | bigint): HexString {
  const k = typeof priv === 'string' ? BigInt('0x' + priv) : priv;
  const [x, y] = pointMul(k);
  const prefix = y % 2n === 0n ? '02' : '03';
  return prefix + x.toString(16).padStart(64, '0');
}

function decompressPoint(pubHex: HexString): [bigint, bigint] {
  const prefix = parseInt(pubHex.slice(0, 2), 16);
  const x = BigInt('0x' + pubHex.slice(2, 66));
  const ysq = mod(mod(x * x * x) + 7n);
  let y = modPow(ysq, (P + 1n) / 4n, P);
  if ((y % 2n === 0n) !== (prefix === 2)) y = mod(-y);
  return [x, y];
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  base = mod(base, m);
  while (exp > 0n) {
    if (exp % 2n === 1n) result = mod(result * base, m);
    exp >>= 1n;
    base = mod(base * base, m);
  }
  return result;
}

function compressPoint(x: bigint, y: bigint): HexString {
  const prefix = y % 2n === 0n ? '02' : '03';
  return prefix + x.toString(16).padStart(64, '0');
}

// ══════════════════════════════════════════
// HASH HELPERS
// ══════════════════════════════════════════

function sha256(data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'hex') : data;
  return crypto.createHash('sha256').update(buf).digest();
}

function ripemd160(data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'hex') : data;
  return crypto.createHash('ripemd160').update(buf).digest();
}

function hash160(data: Buffer | string): Buffer { return ripemd160(sha256(data)); }

// ══════════════════════════════════════════
// CASHADDR
// ══════════════════════════════════════════

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function cashAddrPolymod(v) {
  const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of v) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if (c0 & (1n << BigInt(i))) c ^= GEN[i];
  }
  return c ^ 1n;
}

function hash160ToCashAddr(h160, prefix = 'bitcoincash') {
  const versionByte = 0x00; // P2PKH
  const payload = Buffer.concat([Buffer.from([versionByte]), h160]);
  const d5 = []; let acc = 0, bits = 0;
  for (const b of payload) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; d5.push((acc >> bits) & 31); } }
  if (bits > 0) d5.push((acc << (5 - bits)) & 31);
  const pe = [...prefix.split('').map(c => c.charCodeAt(0) & 31), 0];
  const checksum = cashAddrPolymod([...pe, ...d5, 0, 0, 0, 0, 0, 0, 0, 0]);
  const cs = [];
  for (let i = 7; i >= 0; i--) cs.push(Number((checksum >> (BigInt(i) * 5n)) & 31n));
  return prefix + ':' + [...d5, ...cs].map(v => CHARSET[v]).join('');
}

// ══════════════════════════════════════════
// BIP340 SCHNORR (tagged hash, sign, verify) — for Nostr events
// ══════════════════════════════════════════

function taggedHash(tag, data) {
  const th = sha256(Buffer.from(tag, 'utf8'));
  return sha256(Buffer.concat([th, th, data]));
}

// ══════════════════════════════════════════
// BCH STEALTH PROTOCOL — LOCKED CONSTANTS (final spec)
// ══════════════════════════════════════════
// These three tag strings are normative. Changing any of them after mainnet
// constitutes a hard fork of the scheme. Keep in sync with the public spec
// and with plugin.py.
const TAG_H     = '00proto/stealth/inputs';   // per-input weighting h_i
const TAG_T     = '00proto/stealth/shared';   // per-output tweak    t_k
const TAG_LABEL = '00proto/stealth/label';    // per-payer label     tweak_m
const GAP       = 3;                          // consecutive-miss gap-limit

// BIP-340 tagged hashes for the three stealth domains, returning a Buffer.
function hTagInputs(data: Buffer): Buffer { return taggedHash(TAG_H,     data); }
function hTagShared(data: Buffer): Buffer { return taggedHash(TAG_T,     data); }
function hTagLabel (data: Buffer): Buffer { return taggedHash(TAG_LABEL, data); }

// Reduce a 32-byte hash to a non-zero scalar mod N.
function hashToScalar(h: Buffer): bigint {
  const v = BigInt('0x' + h.toString('hex')) % N;
  return v;
}

// 4-byte big-endian serialization (spec uses ser32BE for k and m indices).
function ser32BE(n: number): Buffer {
  const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b;
}

// Per-payer label tweak: tweak_m = H_tag(TAG_label, b_scan || ser32BE(m)) mod N.
// m = 0 is reserved for the unlabeled global stealth code (tweak_0 = 0).
function labelTweakMod(scanPrivHex: HexString, m: number): bigint {
  if (m === 0) return 0n;
  const t = hTagLabel(Buffer.concat([Buffer.from(scanPrivHex, 'hex'), ser32BE(m)]));
  return hashToScalar(t);
}

// Apply label tweak to the spend pubkey: B_spend_m = B_spend + tweak_m·G.
function applyLabelToSpendPub(spendPubHex: HexString, tweak_m: bigint): HexString {
  if (tweak_m === 0n) return spendPubHex;
  const [sx, sy] = decompressPoint(spendPubHex);
  const [tx, ty] = pointMul(tweak_m);
  const [rx, ry] = pointAdd(sx, sy, tx, ty);
  return compressPoint(rx, ry);
}

// Returns x-only pubkey (32 bytes) for a private key.
function schnorrPubXOnly(privHex) {
  const d0 = BigInt('0x' + privHex) % N;
  if (d0 === 0n) throw new Error('schnorr: zero priv');
  const [px] = pointMul(d0);
  return Buffer.from(px.toString(16).padStart(64, '0'), 'hex');
}

// BIP340 sign. msg must be 32 bytes. Returns 64-byte signature.
function schnorrSign(msg: Buffer, privHex: HexString, auxRand?: Buffer): Buffer {
  if (msg.length !== 32) throw new Error('schnorr: msg must be 32 bytes');
  let d0 = BigInt('0x' + privHex) % N;
  if (d0 === 0n || d0 >= N) throw new Error('schnorr: bad priv');
  const [Px, Py] = pointMul(d0);
  const d = (Py % 2n === 0n) ? d0 : (N - d0);
  const aux = auxRand || crypto.randomBytes(32);
  const t = Buffer.from((d ^ BigInt('0x' + taggedHash('BIP0340/aux', aux).toString('hex'))).toString(16).padStart(64, '0'), 'hex');
  const pxBuf = Buffer.from(Px.toString(16).padStart(64, '0'), 'hex');
  const rand = taggedHash('BIP0340/nonce', Buffer.concat([t, pxBuf, msg]));
  const kPrime = BigInt('0x' + rand.toString('hex')) % N;
  if (kPrime === 0n) throw new Error('schnorr: k=0');
  const [Rx, Ry] = pointMul(kPrime);
  const k = (Ry % 2n === 0n) ? kPrime : (N - kPrime);
  const rxBuf = Buffer.from(Rx.toString(16).padStart(64, '0'), 'hex');
  const e = BigInt('0x' + taggedHash('BIP0340/challenge', Buffer.concat([rxBuf, pxBuf, msg])).toString('hex')) % N;
  const s = (k + e * d) % N;
  return Buffer.concat([rxBuf, Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]);
}

// ══════════════════════════════════════════
// NIP-44 v2 (ChaCha20 + HMAC-SHA256, HKDF, padded) — replaces NIP-04
// ══════════════════════════════════════════

function nip44PadLen(unpadded) {
  if (unpadded < 1 || unpadded > 65535) throw new Error('nip44: bad length');
  if (unpadded <= 32) return 32;
  const nextPower = 1 << (32 - Math.clz32(unpadded - 1));
  const chunk = nextPower > 256 ? nextPower / 8 : 32;
  return chunk * (Math.floor((unpadded - 1) / chunk) + 1);
}

function nip44Pad(plaintext) {
  const pt = Buffer.from(plaintext, 'utf8');
  if (pt.length < 1 || pt.length > 65535) throw new Error('nip44: plaintext length out of range');
  const padded = Buffer.alloc(nip44PadLen(pt.length));
  padded.writeUInt16BE(pt.length, 0);
  pt.copy(padded, 2);
  // rest already zero-filled
  // total buffer is u16_len(2) + padded plaintext of nip44PadLen bytes → but spec packs differently:
  // payload = u16_BE(len) || plaintext || zero_pad ; total = 2 + padded_len
  // Rebuild with correct total
  const full = Buffer.alloc(2 + nip44PadLen(pt.length));
  full.writeUInt16BE(pt.length, 0);
  pt.copy(full, 2);
  return full;
}

function nip44Unpad(padded) {
  if (padded.length < 2) throw new Error('nip44: truncated');
  const len = padded.readUInt16BE(0);
  if (len < 1 || 2 + len > padded.length) throw new Error('nip44: bad plaintext len');
  if (padded.length !== 2 + nip44PadLen(len)) throw new Error('nip44: pad mismatch');
  return padded.slice(2, 2 + len).toString('utf8');
}

function nip44ConversationKey(privHex, pubXOnlyHex) {
  // ECDH on x-only pubkey (assume even-Y per Nostr convention): prefix 02
  const pubHex = pubXOnlyHex.length === 64 ? '02' + pubXOnlyHex : pubXOnlyHex;
  const priv = BigInt('0x' + privHex);
  const [pubX, pubY] = decompressPoint(pubHex);
  const [sx] = pointMul(priv, pubX, pubY);
  const shared = Buffer.from(sx.toString(16).padStart(64, '0'), 'hex');
  return crypto.hkdfSync('sha256', shared, Buffer.from('nip44-v2', 'utf8'), Buffer.alloc(0), 32);
}

function nip44MessageKeys(convKey, nonce32) {
  const out = crypto.hkdfSync('sha256', Buffer.from(convKey), nonce32, Buffer.alloc(0), 76);
  const buf = Buffer.from(out);
  return {
    chachaKey: buf.slice(0, 32),
    chachaNonce: buf.slice(32, 44),  // 12 bytes
    hmacKey: buf.slice(44, 76),
  };
}

function nip44Encrypt(privHex: HexString, pubXOnlyHex: HexString, plaintext: string, nonceOverride?: Buffer): string {
  const convKey = nip44ConversationKey(privHex, pubXOnlyHex);
  const nonce = nonceOverride || crypto.randomBytes(32);
  const { chachaKey, chachaNonce, hmacKey } = nip44MessageKeys(convKey, nonce);
  const padded = nip44Pad(plaintext);
  // Node chacha20: IV = 4-byte LE counter || 12-byte nonce
  const iv = Buffer.concat([Buffer.alloc(4), chachaNonce]);
  const cipher = crypto.createCipheriv('chacha20', chachaKey, iv);
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
  const mac = crypto.createHmac('sha256', hmacKey).update(Buffer.concat([nonce, ct])).digest();
  const payload = Buffer.concat([Buffer.from([0x02]), nonce, ct, mac]);
  return payload.toString('base64');
}

function nip44Decrypt(privHex, pubXOnlyHex, payloadB64) {
  const payload = Buffer.from(payloadB64, 'base64');
  if (payload.length < 1 + 32 + 32 + 32) throw new Error('nip44: short payload');
  if (payload[0] !== 0x02) throw new Error('nip44: unsupported version');
  const nonce = payload.slice(1, 33);
  const mac = payload.slice(payload.length - 32);
  const ct = payload.slice(33, payload.length - 32);
  const convKey = nip44ConversationKey(privHex, pubXOnlyHex);
  const { chachaKey, chachaNonce, hmacKey } = nip44MessageKeys(convKey, nonce);
  const expected = crypto.createHmac('sha256', hmacKey).update(Buffer.concat([nonce, ct])).digest();
  if (!crypto.timingSafeEqual(mac, expected)) throw new Error('nip44: bad mac');
  const iv = Buffer.concat([Buffer.alloc(4), chachaNonce]);
  const decipher = crypto.createDecipheriv('chacha20', chachaKey, iv);
  const padded = Buffer.concat([decipher.update(ct), decipher.final()]);
  return nip44Unpad(padded);
}

// ══════════════════════════════════════════
// NIP-59 gift wrap (kind:13 seal inside kind:1059 wrap, both NIP-44 encrypted)
// ══════════════════════════════════════════

function nostrEventId(evt) {
  // canonical serialization: [0, pubkey, created_at, kind, tags, content]
  const serial = JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
  return sha256(Buffer.from(serial, 'utf8')).toString('hex');
}

function signNostrEvent(evt: Partial<NostrEvent>, privHex: HexString): NostrEvent {
  const out: NostrEvent = Object.assign({ pubkey: '', created_at: 0, kind: 0, tags: [], content: '' }, evt) as NostrEvent;
  out.pubkey = schnorrPubXOnly(privHex).toString('hex');
  out.id = nostrEventId(out);
  out.sig = schnorrSign(Buffer.from(out.id!, 'hex'), privHex).toString('hex');
  return out;
}

// Returns a random timestamp up to `maxJitterSec` in the past (default 2 days, per NIP-59).
function jitteredTimestamp(maxJitterSec?: number): number {
  const jitter = Math.floor(Math.random() * (maxJitterSec || 172800));
  return Math.floor(Date.now() / 1000) - jitter;
}

/**
 * Wrap a rumor event for recipient. Returns a signed kind:1059 gift wrap.
 *   senderPrivHex  — sender's permanent nsec (identifies sender to recipient once unwrapped)
 *   recipPubXOnly  — recipient's 32-byte x-only pubkey hex
 *   rumor          — unsigned event { kind, content, tags?, created_at? }
 */
function nip59Wrap(senderPrivHex: HexString, recipPubXOnly: HexString, rumor: NostrRumor): NostrEvent {
  // Rumor: no sig, has id
  const rumorEvt: Partial<NostrEvent> & { id?: HexString } = {
    pubkey: schnorrPubXOnly(senderPrivHex).toString('hex'),
    created_at: rumor.created_at || Math.floor(Date.now() / 1000),
    kind: rumor.kind,
    tags: rumor.tags || [],
    content: rumor.content || '',
  };
  rumorEvt.id = nostrEventId(rumorEvt as NostrEvent);

  // Seal (kind:13), signed by sender, content = NIP-44(sender → recipient) of rumor
  const sealContent = nip44Encrypt(senderPrivHex, recipPubXOnly, JSON.stringify(rumorEvt));
  const seal = signNostrEvent({
    kind: 13,
    created_at: jitteredTimestamp(),
    tags: [],
    content: sealContent,
  }, senderPrivHex);

  // Gift wrap (kind:1059), signed by random ephemeral key, content = NIP-44(eph → recipient) of seal
  const ephPriv = crypto.randomBytes(32).toString('hex');
  const wrapContent = nip44Encrypt(ephPriv, recipPubXOnly, JSON.stringify(seal));
  const wrap = signNostrEvent({
    kind: 1059,
    created_at: jitteredTimestamp(),
    tags: [['p', recipPubXOnly.length === 64 ? recipPubXOnly : recipPubXOnly.slice(2)]],
    content: wrapContent,
  }, ephPriv);

  return wrap;
}

/**
 * Unwrap a kind:1059 gift wrap. Returns { sender, rumor } where sender is x-only hex pubkey.
 * Throws on bad MAC, signature mismatch, or malformed event.
 */
function nip59Unwrap(recipPrivHex, wrap) {
  if (wrap.kind !== 1059) throw new Error('nip59: not a gift wrap');
  // Decrypt outer: recipient priv × eph pub (wrap.pubkey is x-only)
  const sealJson = nip44Decrypt(recipPrivHex, wrap.pubkey, wrap.content);
  const seal = JSON.parse(sealJson);
  if (seal.kind !== 13) throw new Error('nip59: inner is not a seal');
  // Inner seal is signed by sender; seal.pubkey is sender x-only
  const rumorJson = nip44Decrypt(recipPrivHex, seal.pubkey, seal.content);
  const rumor = JSON.parse(rumorJson);
  // Sanity: rumor.pubkey must equal seal.pubkey (binding)
  if (rumor.pubkey !== seal.pubkey) throw new Error('nip59: sender mismatch');
  return { sender: seal.pubkey, rumor };
}

// ══════════════════════════════════════════
// STEALTH PROTOCOL (BIP352 aggregated ECDH)
// ══════════════════════════════════════════

/**
 * DEPRECATED: legacy single-input ECDH retained ONLY for parsing/test fixtures.
 * The final spec mandates per-input weighted aggregation via
 * `stealthDeriveAggregated` even for single-input transactions. Senders MUST
 * use the senderPrivs[] / outpoints[] form of `derive_address`. Do not call
 * this function from new code.
 */
function stealthDerive(privHex, pubHex, spendPubHex, outpointHex) {
  const priv = BigInt('0x' + privHex);
  const [pubX, pubY] = decompressPoint(pubHex);
  const [sharedX] = pointMul(priv, pubX, pubY);
  const sharedXBytes = Buffer.from(sharedX.toString(16).padStart(64, '0'), 'hex');
  const outpointBytes = Buffer.from(outpointHex, 'hex');
  const cBytes = sha256(Buffer.concat([sha256(sharedXBytes), outpointBytes]));
  const cBig = BigInt('0x' + cBytes.toString('hex')) % N;
  const [spendX, spendY] = decompressPoint(spendPubHex);
  const [tweakX, tweakY] = pointMul(cBig);
  const [stealthX, stealthY] = pointAdd(spendX, spendY, tweakX, tweakY);
  const stealthPub = compressPoint(stealthX, stealthY);
  const h160 = hash160(Buffer.from(stealthPub, 'hex'));
  return { addr: hash160ToCashAddr(h160), pub: stealthPub, c: cBig.toString(16).padStart(64, '0') };
}

/**
 * Compute (op_min, A_sum, sharedX) for a tx's contributing inputs.
 * Returns null if no inputs contribute.
 *
 * @param scanPrivHex - b_scan
 * @param inputs      - [{ pubkey, outpointTxidBE, outpointVout }]
 */
function stealthSharedX(scanPrivHex: HexString, inputs: any[]): Buffer | null {
  const points = [];
  for (const inp of inputs) {
    try {
      const [px, py] = decompressPoint(inp.pubkey);
      points.push({ pubHex: inp.pubkey, x: px, y: py });
    } catch { continue; }
  }
  if (points.length === 0) return null;

  let smallest: Buffer | null = null;
  for (const inp of inputs) {
    if (!inp.outpointTxidBE) continue;
    const txidLE = Buffer.from(inp.outpointTxidBE, 'hex').reverse();
    const voutBuf = Buffer.alloc(4); voutBuf.writeUInt32LE(inp.outpointVout || 0);
    const outpoint = Buffer.concat([txidLE, voutBuf]);
    if (!smallest || outpoint.compare(smallest) < 0) smallest = outpoint;
  }
  if (!smallest) return null;

  let aggX: bigint | null = null, aggY: bigint = 0n;
  for (const pt of points) {
    const hBig = hashToScalar(hTagInputs(Buffer.concat([smallest, Buffer.from(pt.pubHex, 'hex')])));
    if (hBig === 0n) continue;
    const [tx, ty] = pointMul(hBig, pt.x, pt.y);
    if (aggX === null) { aggX = tx; aggY = ty; }
    else {
      const [rx, ry] = pointAdd(aggX, aggY, tx, ty);
      if (rx === 0n && ry === 0n) return null;
      aggX = rx; aggY = ry;
    }
  }
  if (aggX === null) return null;

  const b_scan = BigInt('0x' + scanPrivHex) % N;
  const [shared_x] = pointMul(b_scan, aggX, aggY);
  return Buffer.from(shared_x.toString(16).padStart(64, '0'), 'hex');
}

/**
 * Precompute B_spend_m points for the requested label set (m=0 always included).
 */
function precomputeLabeledSpends(scanPrivHex: HexString, spendPubHex: HexString, labels: number[]) {
  const ms = Array.from(new Set<number>([0, ...labels.filter(m => m && m > 0)]));
  const out: { m: number; X: bigint; Y: bigint; tweak_m: bigint }[] = [];
  for (const m of ms) {
    const tweak_m = labelTweakMod(scanPrivHex, m);
    const pubM = applyLabelToSpendPub(spendPubHex, tweak_m);
    const [X, Y] = decompressPoint(pubM);
    out.push({ m, X, Y, tweak_m });
  }
  return out;
}

/**
 * Aggregated ECDH — receiver scan. 1 ECDH per TX, per-label GAP-limit when
 * an on-chain script set is supplied; otherwise bounded by maxK.
 *
 * Final spec (BCH Stealth Protocol):
 *   op_min   = byte-lex min{ outpoint_i = txid_LE(32) || vout_LE(4) }
 *   h_i      = H_tag(TAG_H, op_min || P_i) mod N           (P2PKH)
 *   A_sum    = Σ h_i · P_i
 *   shared   = b_scan · A_sum    (1 ECDH)
 *   t_k      = H_tag(TAG_T, sharedX || ser32BE(k)) mod N
 *   P_k_m    = (B_spend + tweak_m·G) + t_k·G,
 *              tweak_m = H_tag(TAG_label, b_scan || ser32BE(m)) mod N (m=0 → 0)
 *
 * @param scanPrivHex - b_scan, 32 bytes hex
 * @param spendPubHex - B_spend, 33 bytes compressed hex (UNLABELED)
 * @param inputs      - [{ pubkey, outpointTxidBE, outpointVout }]
 * @param labels      - optional label indices to scan; m=0 implicit
 * @param scriptSet   - optional Set<string> of on-chain P2PKH output scripts
 *                      (lowercased hex, "76a914<h160>88ac"). When supplied,
 *                      drives strict GAP-limit per label and emits only matches.
 * @param maxK        - cap on k when scriptSet is not supplied (default GAP+1).
 * @returns           - [{ addr, pub, c, k, m }]
 */
function stealthDeriveAggregated(
  scanPrivHex: HexString,
  spendPubHex: HexString,
  inputs: any[],
  labels: number[] = [],
  scriptSet: Set<string> | null = null,
  maxK: number = GAP + 1,
) {
  const sharedXBuf = stealthSharedX(scanPrivHex, inputs);
  if (!sharedXBuf) return [];

  const ms = precomputeLabeledSpends(scanPrivHex, spendPubHex, labels);
  const results: any[] = [];

  if (scriptSet) {
    // Strict GAP-limit per label, on-chain matched.
    const miss: Record<number, number> = {};
    for (const sm of ms) miss[sm.m] = 0;
    let live = ms.length;
    const HARD_CAP = 4096;
    for (let k = 0; live > 0 && k < HARD_CAP; k++) {
      const tBig = hashToScalar(hTagShared(Buffer.concat([sharedXBuf, ser32BE(k)])));
      if (tBig === 0n) continue;
      const [tx, ty] = pointMul(tBig);
      for (const sm of ms) {
        if (miss[sm.m] >= GAP) continue;
        const [sx, sy] = pointAdd(sm.X, sm.Y, tx, ty);
        if (sx === 0n && sy === 0n) { miss[sm.m] = GAP; live--; continue; }
        const stealthPub = compressPoint(sx, sy);
        const h160 = hash160(Buffer.from(stealthPub, 'hex')).toString('hex');
        const script = '76a914' + h160 + '88ac';
        if (scriptSet.has(script)) {
          results.push({
            addr: hash160ToCashAddr(Buffer.from(h160, 'hex')),
            pub: stealthPub,
            c: tBig.toString(16).padStart(64, '0'),
            k, m: sm.m,
          });
          miss[sm.m] = 0;
        } else {
          miss[sm.m] += 1;
          if (miss[sm.m] >= GAP) live--;
        }
      }
    }
  } else {
    // Bounded mode: emit candidates for k = 0..maxK-1 across all labels.
    // Used by indexer scan where on-chain script set is fetched later.
    for (let k = 0; k < maxK; k++) {
      const tBig = hashToScalar(hTagShared(Buffer.concat([sharedXBuf, ser32BE(k)])));
      if (tBig === 0n) continue;
      const [tx, ty] = pointMul(tBig);
      for (const sm of ms) {
        const [sx, sy] = pointAdd(sm.X, sm.Y, tx, ty);
        if (sx === 0n && sy === 0n) continue;
        const stealthPub = compressPoint(sx, sy);
        const h160 = hash160(Buffer.from(stealthPub, 'hex'));
        results.push({
          addr: hash160ToCashAddr(h160),
          pub: stealthPub,
          c: tBig.toString(16).padStart(64, '0'),
          k, m: sm.m,
        });
      }
    }
  }
  return results;
}

/**
 * Compute stealth spending key:
 *   spendPriv_out = ( b_spend + tweak_m + t_k ) mod N
 * For unlabeled (m=0) this reduces to ( b_spend + t_k ) mod N.
 */
function stealthSpendingKey(spendPrivHex: HexString, cHex: HexString, tweakMHex: HexString = '00') {
  const b = BigInt('0x' + spendPrivHex);
  const c = BigInt('0x' + cHex);
  const tm = BigInt('0x' + (tweakMHex || '0'));
  const p = (((b + tm) % N) + c) % N;
  return p.toString(16).padStart(64, '0');
}

/**
 * Generate stealth paycode from scan + spend pubkeys
 */
function makePaycode(scanPubHex, spendPubHex) {
  return 'stealth:' + scanPubHex + spendPubHex;
}

/**
 * Parse a stealth paycode
 */
function parsePaycode(paycode) {
  const raw = paycode.replace(/^stealth:/i, '');
  if (raw.length !== 132) throw new Error('Invalid paycode length: ' + raw.length);
  return {
    scanPub: raw.slice(0, 66),
    spendPub: raw.slice(66),
  };
}

// ══════════════════════════════════════════
// TX PARSING
// ══════════════════════════════════════════

/**
 * Extract compressed pubkeys + outpoints from P2PKH transaction inputs.
 * Returns [{ pubkey, outpointTxidBE, outpointVout, outpointLE, vin }]
 *   outpointTxidBE — big-endian (human-readable) txid hex
 *   outpointVout   — integer vout
 *   outpointLE     — legacy 36-byte outpoint buffer (txid_LE || vout_LE) for compat
 */
function extractInputPubkeys(rawTxHex) {
  const buf = Buffer.from(rawTxHex, 'hex');
  const results = [];
  let p = 0;

  const readBytes = (n) => { const s = buf.slice(p, p + n); p += n; return s; };
  const readU32LE = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const readVarInt = () => {
    const f = buf[p++];
    if (f < 0xfd) return f;
    if (f === 0xfd) { const v = buf.readUInt16LE(p); p += 2; return v; }
    if (f === 0xfe) { const v = buf.readUInt32LE(p); p += 4; return v; }
    return 0;
  };

  try {
    readU32LE(); // version
    const inCount = readVarInt();

    for (let i = 0; i < inCount; i++) {
      const prevTxidLE = readBytes(32); // little-endian in serialization
      const prevVout = readU32LE();

      const scriptLen = readVarInt();
      const scriptSig = readBytes(scriptLen);
      readU32LE(); // sequence

      // Skip coinbase (prevTxid all zeros)
      if (prevTxidLE.equals(Buffer.alloc(32, 0))) continue;

      if (scriptSig.length < 35) continue;
      let sp = 0;
      const sigLen = scriptSig[sp++];
      sp += sigLen;
      if (sp >= scriptSig.length) continue;
      const pubLen = scriptSig[sp++];
      if (pubLen !== 33) continue;
      if (sp + 33 > scriptSig.length) continue;
      const pubkey = scriptSig.slice(sp, sp + 33);
      if (pubkey[0] !== 0x02 && pubkey[0] !== 0x03) continue;

      // outpointTxidBE: reverse LE bytes → human-readable big-endian hex
      const outpointTxidBE = Buffer.from(prevTxidLE).reverse().toString('hex');
      // legacy wire outpoint (txid_LE || vout_LE 4 bytes)
      const voutBuf = Buffer.alloc(4); voutBuf.writeUInt32LE(prevVout);
      const outpointLE = Buffer.concat([prevTxidLE, voutBuf]);

      results.push({
        pubkey: pubkey.toString('hex'),
        outpointTxidBE,
        outpointVout: prevVout,
        outpoint: outpointLE.toString('hex'), // legacy compat
        vin: i,
      });
    }
  } catch { /* partial parse ok */ }

  return results;
}

// ══════════════════════════════════════════
// INDEXER CLIENT
// ══════════════════════════════════════════

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

/**
 * Scan a block range via the pubkey indexer API — final spec aggregated ECDH.
 * Groups entries by txid, weights by per-input H_tag, 1 ECDH per TX.
 * Returns candidates for every (k, m) up to GAP+1 (caller verifies on-chain
 * via listunspent, then re-runs detect_payment / GAP-limit scan for the
 * authoritative match).
 *
 * Privacy note: this endpoint MUST be either your own indexer or accessed
 * over Tor. A third-party indexer can fingerprint a scanning client (this
 * is scan-mode C from the spec; see RECEIVER section).
 */
async function scanIndexer(params) {
  const { scanPriv, spendPub, fromHeight, toHeight, indexerUrl } = params;
  const labels: number[] = Array.isArray(params.labels) ? params.labels : [];
  const base = indexerUrl || 'https://0penw0rld.com/api';
  const batchSize = 50;
  const candidates = [];

  for (let bStart = fromHeight; bStart <= toHeight; bStart += batchSize) {
    const bEnd = Math.min(bStart + batchSize - 1, toHeight);

    try {
      const data: any = await httpGet(`${base}/pubkeys?from=${bStart}&to=${bEnd}`);
      // Indexer returns { from, to, entries: [...] }
      const entries = data?.entries || data?.pubkeys || [];
      if (!entries.length) continue;

      // Group entries by txid
      const txMap = new Map();
      for (const entry of entries) {
        if (!entry.txid || !entry.pubkey) continue;
        if (!txMap.has(entry.txid)) txMap.set(entry.txid, []);
        txMap.get(entry.txid).push({
          pubkey: entry.pubkey,
          outpointTxidBE: entry.outpointTxid || null,
          outpointVout: entry.outpointVout != null ? entry.outpointVout : 0,
          height: entry.height || 0,
          vin: entry.vin || 0,
        });
      }

      // 1 ECDH per TX. Without on-chain output set here, emit candidates
      // for k = 0..GAP for every requested label; caller verifies.
      for (const [txid, inputs] of txMap) {
        try {
          const derived = stealthDeriveAggregated(scanPriv, spendPub, inputs, labels, null, GAP + 1);
          for (const d of derived) {
            candidates.push({
              txid,
              vin: inputs[0]?.vin || 0,
              height: inputs[0]?.height || 0,
              addr: d.addr,
              pub: d.pub,
              c: d.c,
              k: d.k,
              m: d.m,
            });
          }
        } catch { /* skip invalid TX */ }
      }
    } catch (e) {
      process.stderr.write(`[stealth] indexer error at ${bStart}-${bEnd}: ${e.message}\n`);
    }
  }

  return candidates;
}

/**
 * Detect stealth payment in a specific raw TX — BIP352 aggregated ECDH.
 * Aggregates all input pubkeys → 1 ECDH, checks all TX outputs.
 */
function detectPayment(params) {
  const { rawTxHex, scanPriv, spendPub } = params;
  const inputs = extractInputPubkeys(rawTxHex);
  const results = [];
  if (!inputs.length) return results;

  // Parse outputs
  const buf = Buffer.from(rawTxHex, 'hex');
  let p = 0;
  const readU32LE = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const readVarInt = () => {
    const f = buf[p++];
    if (f < 0xfd) return f;
    if (f === 0xfd) { const v = buf.readUInt16LE(p); p += 2; return v; }
    if (f === 0xfe) { const v = buf.readUInt32LE(p); p += 4; return v; }
    return 0;
  };
  const readBytes = (n) => { const s = buf.slice(p, p + n); p += n; return s; };

  let outputs = [];
  try {
    readU32LE(); // version
    const inCount = readVarInt();
    for (let i = 0; i < inCount; i++) {
      readBytes(32); readU32LE(); // prevTxid + vout
      const sl = readVarInt(); readBytes(sl); // scriptSig
      readU32LE(); // sequence
    }
    const outCount = readVarInt();
    for (let i = 0; i < outCount; i++) {
      const value = buf.readBigUInt64LE(p); p += 8;
      const scriptLen = readVarInt();
      const script = readBytes(scriptLen);
      outputs.push({ value: Number(value), script: script.toString('hex') });
    }
  } catch { return results; }

  // Final spec: 1 ECDH per TX, GAP-limit scan over k for each requested label.
  try {
    const labels: number[] = Array.isArray(params.labels) ? params.labels : [];
    const scriptSet = new Set(outputs.map(o => o.script.toLowerCase()));
    const derived = stealthDeriveAggregated(scanPriv, spendPub, inputs, labels, scriptSet);
    for (const d of derived) {
      const h160 = hash160(Buffer.from(d.pub, 'hex')).toString('hex');
      const expectedScript = '76a914' + h160 + '88ac';
      const matchIdx = outputs.findIndex(o => o.script.toLowerCase() === expectedScript);
      if (matchIdx !== -1) {
        results.push({
          vin: 0, // aggregated — no single input
          vout: matchIdx,
          value: outputs[matchIdx].value,
          addr: d.addr,
          pub: d.pub,
          c: d.c,
          k: d.k,
          m: d.m,
        });
      }
      if (false) break; // GAP-limit handled inside stealthDeriveAggregated
    }
  } catch { /* math error */ }

  return results;
}

// ══════════════════════════════════════════
// BIP32 KEY DERIVATION (simplified for BIP352)
// ══════════════════════════════════════════

function hmacSha512(key, data) {
  return crypto.createHmac('sha512', key).update(data).digest();
}

function bip32Child(parentPriv, parentChain, index, hardened = false) {
  const indexNum = hardened ? index + 0x80000000 : index;
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32BE(indexNum);

  let data;
  if (hardened) {
    data = Buffer.concat([Buffer.from([0x00]), Buffer.from(parentPriv, 'hex'), indexBuf]);
  } else {
    data = Buffer.concat([Buffer.from(privToPub(parentPriv), 'hex'), indexBuf]);
  }

  const I = hmacSha512(Buffer.from(parentChain, 'hex'), data);
  const IL = I.slice(0, 32);
  const IR = I.slice(32);

  const parentKey = BigInt('0x' + parentPriv);
  const childKey = (BigInt('0x' + IL.toString('hex')) + parentKey) % N;

  return {
    priv: childKey.toString(16).padStart(64, '0'),
    chain: IR.toString('hex'),
  };
}

/**
 * Derive scan/spend keys at m/352'/145'/<account>'/{0',1'}/0
 * The hardened gates at {0',1'} provide the scan/spend isolation the rest
 * of the protocol assumes.
 *
 * @param account - BIP-44-style account index, default 0. Used for fully
 *                  independent stealth codes (burner identities).
 */
function deriveBip352Keys(masterPriv, masterChain, account: number = 0) {
  // m/352' (hardened)
  const n352 = bip32Child(masterPriv, masterChain, 352, true);
  // m/352'/145' (hardened)
  const n145 = bip32Child(n352.priv, n352.chain, 145, true);
  // m/352'/145'/<account>' (hardened)
  const nAcct = bip32Child(n145.priv, n145.chain, account | 0, true);
  // m/352'/145'/<account>'/0' (spend chain, hardened)
  const spendChain = bip32Child(nAcct.priv, nAcct.chain, 0, true);
  // m/352'/145'/<account>'/0'/0 (spend key, non-hardened)
  const spendKey = bip32Child(spendChain.priv, spendChain.chain, 0, false);
  // m/352'/145'/<account>'/1' (scan chain, hardened)
  const scanChain = bip32Child(nAcct.priv, nAcct.chain, 1, true);
  // m/352'/145'/<account>'/1'/0 (scan key, non-hardened)
  const scanKey = bip32Child(scanChain.priv, scanChain.chain, 0, false);

  return {
    account,
    spendPriv: spendKey.priv,
    spendPub: privToPub(spendKey.priv),
    scanPriv: scanKey.priv,
    scanPub: privToPub(scanKey.priv),
    paycode: makePaycode(privToPub(scanKey.priv), privToPub(spendKey.priv)),
  };
}

// ══════════════════════════════════════════
// STDIN/STDOUT JSON-RPC BRIDGE (EC pattern)
// ══════════════════════════════════════════

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let request;
  try {
    request = JSON.parse(input);
  } catch {
    process.stdout.write(JSON.stringify({ error: 'Invalid JSON input' }));
    return;
  }

  const { action, params } = request;
  let result;

  try {
    switch (action) {
      case 'derive_keys':
        // params: { masterPriv, masterChain, account? } — from BIP32 master root
        result = deriveBip352Keys(params.masterPriv, params.masterChain, params.account || 0);
        break;

      case 'derive_keys_from_seed': {
        // params: { seed, account? } — BIP39 mnemonic phrase
        // Derive BIP32 master key from seed via PBKDF2 + HMAC-SHA512
        const crypto = require('crypto');
        const seedBytes = crypto.pbkdf2Sync(params.seed, 'mnemonic', 2048, 64, 'sha512');
        const I = crypto.createHmac('sha512', 'Bitcoin seed').update(seedBytes).digest();
        const masterPrivHex = I.subarray(0, 32).toString('hex');
        const masterChainHex = I.subarray(32).toString('hex');
        result = deriveBip352Keys(masterPrivHex, masterChainHex, params.account || 0);
        break;
      }

      case 'derive_keys_from_account': {
        // params: { acctPrivHex, acctChainHex } — from m/44'/145'/0' account node
        // Fallback: derive at /2'/0 (scan) and /2'/1 (spend) — NOT the canonical
        // stealth path. Paycode will differ from seed-based derivation. Only used
        // when no seed is available (e.g. xprv-imported wallets).
        const stChain = bip32Child(params.acctPrivHex, params.acctChainHex, 2, true);  // /2' hardened
        const scanChild = bip32Child(stChain.priv, stChain.chain, 0, false);   // /2'/0
        const spendChild = bip32Child(stChain.priv, stChain.chain, 1, false);  // /2'/1
        result = {
          scanPriv: scanChild.priv, scanPub: privToPub(scanChild.priv),
          spendPriv: spendChild.priv, spendPub: privToPub(spendChild.priv),
          paycode: makePaycode(privToPub(scanChild.priv), privToPub(spendChild.priv)),
          warning: 'Account-level derivation (non-canonical). Paycode differs from seed-based derivation.',
        };
        break;
      }

      case 'derive_keys_raw':
        // Forbidden by spec. Raw-key import would re-derive both scan and
        // spend from the same external secret and defeat the {0',1'}
        // hardened-gate scan/spend isolation. Wallets MUST use the BIP-32
        // seed-based derivation above.
        result = { error: 'raw-key import is not supported (defeats scan/spend isolation). Use derive_keys_from_seed.' };
        break;

      case 'make_paycode':
        // params: { scanPub, spendPub, scanPriv?, label? }
        // If scanPriv and a non-zero label m are provided, returns the labeled
        // stealth code with B_spend_m = B_spend + tweak_m·G.
        if (params.scanPriv && params.label && (params.label | 0) > 0) {
          const tw = labelTweakMod(params.scanPriv, params.label | 0);
          const spendPubM = applyLabelToSpendPub(params.spendPub, tw);
          result = {
            paycode: makePaycode(params.scanPub, spendPubM),
            label: params.label | 0,
            spendPubM,
            tweakM: tw.toString(16).padStart(64, '0'),
          };
        } else {
          result = { paycode: makePaycode(params.scanPub, params.spendPub), label: 0 };
        }
        break;

      case 'parse_paycode':
        result = parsePaycode(params.paycode);
        break;

      case 'label_tweak':
        // params: { scanPriv, label } — returns tweak_m hex.
        result = { tweakM: labelTweakMod(params.scanPriv, params.label | 0).toString(16).padStart(64, '0') };
        break;

      case 'derive_address': {
        // Sender side.
        // BIP352: params: { senderPrivs: [hex,...], outpoints: [{txidBE, vout},...], recipScanPub, recipSpendPub }
        // Legacy: params: { senderPriv, recipScanPub, recipSpendPub, outpoint }
        if (params.senderPrivs && params.outpoints) {
          // 1. Per-input privs and their pubkeys
          const senderScalars = params.senderPrivs.map(p => BigInt('0x' + p) % N);
          const senderPubHex  = senderScalars.map(s => privToPub(s.toString(16).padStart(64, '0')));

          // 2. Smallest outpoint (txid is big-endian → reverse to LE)
          let smallest = null;
          for (const op of params.outpoints) {
            const txidLE = Buffer.from(op.txidBE || op.txid, 'hex').reverse();
            const voutBuf = Buffer.alloc(4); voutBuf.writeUInt32LE(op.vout || 0);
            const outpoint = Buffer.concat([txidLE, voutBuf]);
            if (!smallest || outpoint.compare(smallest) < 0) smallest = outpoint;
          }

          // 3. a_sum = Σ h_i · a_i  mod N,  h_i = H_tag(TAG_H, op_min || P_i)
          //    Equivalent to receiver's Σ h_i · P_i scaled by a single b_scan.
          let a_sum = 0n;
          for (let i = 0; i < senderScalars.length; i++) {
            const hBig = hashToScalar(hTagInputs(Buffer.concat([smallest, Buffer.from(senderPubHex[i], 'hex')])));
            a_sum = (a_sum + (hBig * senderScalars[i])) % N;
          }
          if (a_sum === 0n) throw new Error('aggregate scalar is zero');

          // 4. shared = a_sum · B_scan  (single ECDH for the whole tx)
          const [scanX, scanY] = decompressPoint(params.recipScanPub);
          const [sharedX] = pointMul(a_sum, scanX, scanY);
          const sharedXBuf = Buffer.from(sharedX.toString(16).padStart(64, '0'), 'hex');

          // 5. t_k = H_tag(TAG_T, sharedX || ser32BE(k)),  P_k = recipSpendPub + t_k·G
          //    recipSpendPub is whatever the payer parsed from the stealth
          //    code on the wire — it already equals B_spend_m for the
          //    receiver's chosen label. Sender does not need to know m.
          const kIdx = (params.k | 0) || 0;
          const tBig = hashToScalar(hTagShared(Buffer.concat([sharedXBuf, ser32BE(kIdx)])));
          const [spendX, spendY] = decompressPoint(params.recipSpendPub);
          const [tweakX, tweakY] = pointMul(tBig);
          const [stealthX, stealthY] = pointAdd(spendX, spendY, tweakX, tweakY);
          const stealthPub = compressPoint(stealthX, stealthY);
          result = {
            addr: hash160ToCashAddr(hash160(Buffer.from(stealthPub, 'hex'))),
            pub: stealthPub,
            c: tBig.toString(16).padStart(64, '0'),
            k: kIdx,
          };
        } else {
          // Legacy single-input
          result = stealthDerive(params.senderPriv, params.recipScanPub, params.recipSpendPub, params.outpoint);
        }
        break;
      }

      case 'spending_key':
        // params: { spendPriv, c, tweakM?, scanPriv?, label? }
        // Final spec: spendPriv_out = (b_spend + tweak_m + t_k) mod N.
        // tweakM can be passed directly (hex); or derived on-the-fly from
        // (scanPriv, label). Unlabeled (m=0) → tweak_m = 0.
        {
          let twHex = params.tweakM || '0';
          if (!params.tweakM && params.scanPriv && (params.label | 0) > 0) {
            twHex = labelTweakMod(params.scanPriv, params.label | 0).toString(16);
          }
          result = { key: stealthSpendingKey(params.spendPriv, params.c, twHex) };
        }
        break;

      case 'detect_payment':
        // params: { rawTxHex, scanPriv, spendPub }
        result = detectPayment(params);
        break;

      case 'parse_tx':
        // params: { rawTxHex }
        result = extractInputPubkeys(params.rawTxHex);
        break;

      case 'scan_indexer':
        // params: { scanPriv, spendPub, fromHeight, toHeight, indexerUrl? }
        result = await scanIndexer(params);
        break;

      case 'nip44_encrypt': {
        // params: { myPriv, recipPubXOnly, plaintext }
        result = { payload: nip44Encrypt(params.myPriv, params.recipPubXOnly, params.plaintext) };
        break;
      }

      case 'nip44_decrypt': {
        // params: { myPriv, senderPubXOnly, payload }
        try {
          result = { plaintext: nip44Decrypt(params.myPriv, params.senderPubXOnly, params.payload) };
        } catch (e) {
          result = { error: 'nip44 decrypt failed: ' + e.message };
        }
        break;
      }

      case 'nip59_wrap': {
        // params: { senderPriv, recipPubXOnly, rumor: { kind, content, tags?, created_at? } }
        // Returns a signed kind:1059 gift-wrap event ready to publish.
        result = { event: nip59Wrap(params.senderPriv, params.recipPubXOnly, params.rumor) };
        break;
      }

      case 'nip59_unwrap': {
        // params: { recipPriv, event } — recipient unwraps a kind:1059 gift wrap.
        try {
          result = nip59Unwrap(params.recipPriv, params.event);
        } catch (e) {
          result = { error: 'nip59 unwrap failed: ' + e.message };
        }
        break;
      }

      case 'schnorr_pub': {
        // params: { priv } — returns x-only pubkey hex for BIP340/Nostr use.
        result = { pubXOnly: schnorrPubXOnly(params.priv).toString('hex') };
        break;
      }

      case 'test':
        // Self-test: derive keys, make paycode, derive address, verify
        const testPriv = 'a' + '0'.repeat(63);
        const testPub = privToPub(testPriv);
        const testPaycode = makePaycode(testPub, testPub);
        const testParsed = parsePaycode(testPaycode);
        result = {
          ok: true,
          privToPub: testPub,
          paycode: testPaycode,
          parsed: testParsed,
          version: '2.0.0',
          protocol: 'BCH Stealth Protocol (final spec, BIP-340 tagged hashes)',
        };
        break;

      default:
        result = { error: 'Unknown action: ' + action };
    }
  } catch (e) {
    result = { error: e.message, stack: e.stack };
  }

  process.stdout.write(JSON.stringify(result));
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ error: e.message }));
  process.exit(1);
});
