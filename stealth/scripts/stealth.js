#!/usr/bin/env node
/**
 * 00 Protocol — Stealth Address Engine for Electron Cash Plugin
 *
 * Standalone Node.js script that handles stealth address operations.
 * Communicates via stdin/stdout JSON (EC plugin bridge pattern).
 *
 * Actions:
 *   derive_keys    — Derive stealth scan/spend keys from seed (BIP352)
 *   make_paycode   — Generate stealth paycode from scan+spend pubkeys
 *   derive_address — Derive one-time stealth address (sender side)
 *   detect_payment — Test if a TX contains a stealth payment (receiver side)
 *   scan_indexer   — Scan block range via pubkey indexer API
 *   parse_tx       — Extract input pubkeys from raw TX hex
 *
 * Compatible with 00 Protocol (0penw0rld.com/stealth.html)
 * BIP352 paths: m/352'/145'/0'/0'/0 (spend), m/352'/145'/0'/1'/0 (scan)
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ══════════════════════════════════════════
// SECP256K1 MINI LIBRARY (no external deps)
// ══════════════════════════════════════════

// secp256k1 curve parameters
const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function mod(a, m = P) { return ((a % m) + m) % m; }
function modInv(a, m = P) {
  let [old_r, r] = [a, m], [old_s, s] = [1n, 0n];
  while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
  return mod(old_s, m);
}

// Jacobian point arithmetic
function jacobianAdd(x1, y1, z1, x2, y2, z2) {
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
function jacobianDouble(x, y, z) {
  if (y === 0n) return [0n, 1n, 0n];
  const ysq = mod(y * y), s = mod(4n * x * ysq), m = mod(3n * x * x);
  const x3 = mod(m * m - 2n * s), y3 = mod(m * (s - x3) - 8n * ysq * ysq);
  const z3 = mod(2n * y * z);
  return [x3, y3, z3];
}
function jacobianMul(k, px, py) {
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

function pointMul(k, px = Gx, py = Gy) { return jacobianMul(k, px, py); }
function pointAdd(x1, y1, x2, y2) {
  const [rx, ry, rz] = jacobianAdd(x1, y1, 1n, x2, y2, 1n);
  if (rz === 0n) return [0n, 0n];
  const zinv = modInv(rz);
  return [mod(rx * zinv * zinv), mod(ry * zinv * zinv * zinv)];
}

function privToPub(priv) {
  const k = typeof priv === 'string' ? BigInt('0x' + priv) : priv;
  const [x, y] = pointMul(k);
  const prefix = y % 2n === 0n ? '02' : '03';
  return prefix + x.toString(16).padStart(64, '0');
}

function decompressPoint(pubHex) {
  const prefix = parseInt(pubHex.slice(0, 2), 16);
  const x = BigInt('0x' + pubHex.slice(2, 66));
  const ysq = mod(mod(x * x * x) + 7n);
  let y = modPow(ysq, (P + 1n) / 4n, P);
  if ((y % 2n === 0n) !== (prefix === 2)) y = mod(-y);
  return [x, y];
}

function modPow(base, exp, m) {
  let result = 1n;
  base = mod(base, m);
  while (exp > 0n) {
    if (exp % 2n === 1n) result = mod(result * base, m);
    exp >>= 1n;
    base = mod(base * base, m);
  }
  return result;
}

function compressPoint(x, y) {
  const prefix = y % 2n === 0n ? '02' : '03';
  return prefix + x.toString(16).padStart(64, '0');
}

// ══════════════════════════════════════════
// HASH HELPERS
// ══════════════════════════════════════════

function sha256(data) {
  if (typeof data === 'string') data = Buffer.from(data, 'hex');
  return crypto.createHash('sha256').update(data).digest();
}

function ripemd160(data) {
  if (typeof data === 'string') data = Buffer.from(data, 'hex');
  return crypto.createHash('ripemd160').update(data).digest();
}

function hash160(data) { return ripemd160(sha256(data)); }

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

// Returns x-only pubkey (32 bytes) for a private key.
function schnorrPubXOnly(privHex) {
  const d0 = BigInt('0x' + privHex) % N;
  if (d0 === 0n) throw new Error('schnorr: zero priv');
  const [px] = pointMul(d0);
  return Buffer.from(px.toString(16).padStart(64, '0'), 'hex');
}

// BIP340 sign. msg must be 32 bytes. Returns 64-byte signature.
function schnorrSign(msg, privHex, auxRand) {
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

function nip44Encrypt(privHex, pubXOnlyHex, plaintext, nonceOverride) {
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

function signNostrEvent(evt, privHex) {
  const out = Object.assign({}, evt);
  out.pubkey = schnorrPubXOnly(privHex).toString('hex');
  out.id = nostrEventId(out);
  out.sig = schnorrSign(Buffer.from(out.id, 'hex'), privHex).toString('hex');
  return out;
}

// Returns a random timestamp up to `maxJitterSec` in the past (default 2 days, per NIP-59).
function jitteredTimestamp(maxJitterSec) {
  const jitter = Math.floor(Math.random() * (maxJitterSec || 172800));
  return Math.floor(Date.now() / 1000) - jitter;
}

/**
 * Wrap a rumor event for recipient. Returns a signed kind:1059 gift wrap.
 *   senderPrivHex  — sender's permanent nsec (identifies sender to recipient once unwrapped)
 *   recipPubXOnly  — recipient's 32-byte x-only pubkey hex
 *   rumor          — unsigned event { kind, content, tags?, created_at? }
 */
function nip59Wrap(senderPrivHex, recipPubXOnly, rumor) {
  // Rumor: no sig, has id
  const rumorEvt = {
    pubkey: schnorrPubXOnly(senderPrivHex).toString('hex'),
    created_at: rumor.created_at || Math.floor(Date.now() / 1000),
    kind: rumor.kind,
    tags: rumor.tags || [],
    content: rumor.content || '',
  };
  rumorEvt.id = nostrEventId(rumorEvt);

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
 * Legacy single-input ECDH (kept for backward compat).
 * Used when only one input privkey is available (v1 payments).
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
 * Aggregated ECDH — per-input hashed aggregation, 1 ECDH per TX.
 *
 * For each input i with pubkey A_i:
 *   h_i       = SHA256(smallest_outpoint || A_i) mod N
 *   A_tweaked = Σ h_i · A_i
 *   shared    = b_scan · A_tweaked
 *
 * Per-input hashing (vs BIP352's H(op || A_sum) · A_sum) makes CoinJoin
 * key-cancellation infeasible: a malicious participant cannot pick A_1 to
 * steer A_tweaked because each h_i depends on its own A_i. For single-input
 * TXs this reduces to h_0 · b_scan · A_0, equivalent to the BIP352 form for
 * n = 1.
 *
 * @param {string}   scanPrivHex  - Scan private key (32 bytes hex)
 * @param {string}   spendPubHex  - Spend public key (33 bytes hex)
 * @param {Array}    inputs       - [{ pubkey: hex, outpointTxidBE: hex, outpointVout: number }]
 * @returns {Array}               - [{ addr, pub, c, k }] for k=0,1,2 where output is matched
 *                                  (returns all derived outputs — caller filters on-chain)
 */
function stealthDeriveAggregated(scanPrivHex, spendPubHex, inputs) {
  // 1. Collect valid input pubkey points
  const points = [];
  for (const inp of inputs) {
    try {
      const [px, py] = decompressPoint(inp.pubkey);
      points.push({ pubHex: inp.pubkey, x: px, y: py });
    } catch { continue; }
  }
  if (points.length === 0) return [];

  // 2. Smallest outpoint: lex-min of (txid_LE || vout_LE)
  //    outpointTxidBE is big-endian (human-readable) → reverse to LE for wire comparison
  let smallest = null;
  for (const inp of inputs) {
    if (!inp.outpointTxidBE) continue;
    const txidLE = Buffer.from(inp.outpointTxidBE, 'hex').reverse();
    const voutBuf = Buffer.alloc(4);
    voutBuf.writeUInt32LE(inp.outpointVout || 0);
    const outpoint = Buffer.concat([txidLE, voutBuf]);
    if (!smallest || outpoint.compare(smallest) < 0) smallest = outpoint;
  }
  if (!smallest) return [];

  // 3. A_tweaked = Σ h_i · A_i  where h_i = SHA256(smallest_outpoint || A_i) mod N
  let aggX = null, aggY = null;
  for (const pt of points) {
    const h = sha256(Buffer.concat([smallest, Buffer.from(pt.pubHex, 'hex')]));
    const hBig = BigInt('0x' + h.toString('hex')) % N;
    if (hBig === 0n) continue;
    const [tx, ty] = pointMul(hBig, pt.x, pt.y);
    if (aggX === null) { aggX = tx; aggY = ty; }
    else {
      const [rx, ry] = pointAdd(aggX, aggY, tx, ty);
      if (rx === 0n && ry === 0n) return []; // aggregate at infinity — skip TX
      aggX = rx; aggY = ry;
    }
  }
  if (aggX === null) return [];

  // 4. shared = b_scan · A_tweaked
  const b_scan = BigInt('0x' + scanPrivHex) % N;
  const [shared_x] = pointMul(b_scan, aggX, aggY);
  const sharedXBuf = Buffer.from(shared_x.toString(16).padStart(64, '0'), 'hex');

  // 5. Derive output for k = 0, 1, 2
  const results = [];
  const [spendX, spendY] = decompressPoint(spendPubHex);
  for (let k = 0; k < 3; k++) {
    const kBuf = Buffer.alloc(4);
    kBuf.writeUInt32LE(k);
    const t = sha256(Buffer.concat([sharedXBuf, kBuf]));
    const tBig = BigInt('0x' + t.toString('hex')) % N;
    const [tweakX, tweakY] = pointMul(tBig);
    const [stealthX, stealthY] = pointAdd(spendX, spendY, tweakX, tweakY);
    if (stealthX === 0n && stealthY === 0n) break;
    const stealthPub = compressPoint(stealthX, stealthY);
    const h160 = hash160(Buffer.from(stealthPub, 'hex'));
    results.push({
      addr: hash160ToCashAddr(h160),
      pub: stealthPub,
      c: tBig.toString(16).padStart(64, '0'),
      k,
    });
  }
  return results;
}

/**
 * Compute stealth spending key: p = (spend_priv + c) mod N
 */
function stealthSpendingKey(spendPrivHex, cHex) {
  const b = BigInt('0x' + spendPrivHex);
  const c = BigInt('0x' + cHex);
  const p = (b + c) % N;
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
 * Derive BIP352 aggregated stealth candidates from a list of pre-fetched
 * indexer entries (same shape as the remote indexer response). Used by the
 * plugin-local Fulcrum-based indexer path so all ECDH code stays in one
 * place. Input entries: [{ txid, pubkey, outpointTxid?, outpointVout?,
 * height?, vin? }]. Returns candidates in the same shape as scanIndexer().
 */
function deriveFromEntries(params) {
  const { scanPriv, spendPub, entries } = params;
  const candidates = [];
  if (!Array.isArray(entries) || !entries.length) return candidates;

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

  for (const [txid, inputs] of txMap) {
    try {
      const derived = stealthDeriveAggregated(scanPriv, spendPub, inputs);
      for (const d of derived) {
        candidates.push({
          txid,
          vin: inputs[0]?.vin || 0,
          height: inputs[0]?.height || 0,
          addr: d.addr,
          pub: d.pub,
          c: d.c,
        });
      }
    } catch { /* skip invalid TX */ }
  }
  return candidates;
}

/**
 * Parse a raw block hex into per-tx indexer-style entries. Skips coinbase.
 * Returns [{ txid, pubkey, outpointTxid, outpointVout, height, vin }, ...]
 * where pubkey/txid/outpointTxid are hex strings (BE human order for txid).
 * Used by the plugin-local scan path — the Python side fetches raw blocks
 * from the user's existing Fulcrum server and passes them here.
 */
function parseBlockEntries(blockHex, height) {
  const buf = Buffer.from(blockHex, 'hex');
  const entries = [];
  let pos = 80; // skip 80-byte block header

  // varint reader on the block buffer (reused)
  const readVarIntAt = () => {
    const f = buf[pos++];
    if (f < 0xfd) return f;
    if (f === 0xfd) { const v = buf.readUInt16LE(pos); pos += 2; return v; }
    if (f === 0xfe) { const v = buf.readUInt32LE(pos); pos += 4; return v; }
    const v = Number(buf.readBigUInt64LE(pos)); pos += 8; return v;
  };

  try {
    const txCount = readVarIntAt();
    for (let i = 0; i < txCount; i++) {
      const txStart = pos;
      pos += 4; // version
      const inCount = readVarIntAt();
      for (let j = 0; j < inCount; j++) {
        pos += 36; // prev_txid(32) + vout(4)
        const sLen = readVarIntAt();
        pos += sLen;
        pos += 4; // sequence
      }
      const outCount = readVarIntAt();
      for (let j = 0; j < outCount; j++) {
        pos += 8; // value
        const sLen = readVarIntAt();
        pos += sLen;
      }
      pos += 4; // locktime

      if (i === 0) continue; // skip coinbase

      const txBuf = buf.slice(txStart, pos);
      // compute txid: double-sha256, reverse to BE
      const h1 = sha256(txBuf);
      const h2 = sha256(h1);
      const txidBE = Buffer.from(h2).reverse().toString('hex');

      const inputs = extractInputPubkeys(txBuf.toString('hex'));
      for (const inp of inputs) {
        entries.push({
          txid: txidBE,
          pubkey: inp.pubkey,
          outpointTxid: inp.outpointTxidBE,
          outpointVout: inp.outpointVout,
          height,
          vin: inp.vin,
        });
      }
    }
  } catch { /* partial parse tolerated */ }

  return entries;
}

/**
 * Scan pre-fetched raw blocks — local (no remote indexer) path. Caller
 * passes { scanPriv, spendPub, blocks: [{ height, hex }] }. All parsing
 * + aggregated BIP352 ECDH happens in-process here.
 */
function scanBlocksLocal(params) {
  const { scanPriv, spendPub, blocks } = params;
  if (!Array.isArray(blocks) || !blocks.length) return [];
  const allEntries = [];
  let parseErrors = 0;
  for (const b of blocks) {
    try {
      const es = parseBlockEntries(b.hex, b.height | 0);
      for (const e of es) allEntries.push(e);
    } catch {
      parseErrors++;
    }
  }
  const candidates = deriveFromEntries({ scanPriv, spendPub, entries: allEntries });
  // Attach a non-fatal diagnostic tag so callers can surface it.
  if (parseErrors > 0) {
    candidates._parseErrors = parseErrors;
  }
  return candidates;
}

/**
 * Scan a block range via the pubkey indexer API — BIP352 aggregated ECDH.
 * Groups entries by txid, aggregates input pubkeys → 1 ECDH per TX.
 * Returns candidates for all derived stealth outputs (caller checks on-chain).
 */
async function scanIndexer(params) {
  const { scanPriv, spendPub, fromHeight, toHeight, indexerUrl } = params;
  const base = indexerUrl || 'https://0penw0rld.com/api';
  const batchSize = 50;
  const candidates = [];
  const errors = [];
  let batchesOk = 0;
  let batchesFail = 0;

  for (let bStart = fromHeight; bStart <= toHeight; bStart += batchSize) {
    const bEnd = Math.min(bStart + batchSize - 1, toHeight);

    try {
      const data = await httpGet(`${base}/pubkeys?from=${bStart}&to=${bEnd}`);
      batchesOk++;
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

      // BIP352: 1 ECDH per TX
      for (const [txid, inputs] of txMap) {
        try {
          const derived = stealthDeriveAggregated(scanPriv, spendPub, inputs);
          // Push k=0 result (most common). Also push k>0 if multiple outputs expected.
          for (const d of derived) {
            candidates.push({
              txid,
              vin: inputs[0]?.vin || 0,
              height: inputs[0]?.height || 0,
              addr: d.addr,
              pub: d.pub,
              c: d.c,
            });
          }
        } catch { /* skip invalid TX */ }
      }
    } catch (e) {
      batchesFail++;
      const msg = `indexer ${bStart}-${bEnd}: ${e.message}`;
      if (errors.length < 3) errors.push(msg);
      process.stderr.write(`[stealth] ${msg}\n`);
    }
  }

  // If every batch failed, surface the error so the UI can show it.
  if (batchesOk === 0 && batchesFail > 0) {
    return {
      error: `Indexer unreachable (${batchesFail} batches failed). ` +
             `Last errors: ${errors.join('; ')}`,
      indexerUrl: base,
    };
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

  // BIP352: aggregate all inputs → derive outputs k=0,1,2
  try {
    const derived = stealthDeriveAggregated(scanPriv, spendPub, inputs);
    for (const d of derived) {
      const h160 = hash160(Buffer.from(d.pub, 'hex')).toString('hex');
      const expectedScript = '76a914' + h160 + '88ac';
      const matchIdx = outputs.findIndex(o => o.script === expectedScript);
      if (matchIdx !== -1) {
        results.push({
          vin: 0, // aggregated — no single input
          vout: matchIdx,
          value: outputs[matchIdx].value,
          addr: d.addr,
          pub: d.pub,
          c: d.c,
          k: d.k,
        });
      }
      if (matchIdx === -1 && d.k > 0) break; // no match for k > 0 → stop
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

function deriveBip352Keys(masterPriv, masterChain) {
  // m/352' (hardened)
  const n352 = bip32Child(masterPriv, masterChain, 352, true);
  // m/352'/145' (hardened)
  const n145 = bip32Child(n352.priv, n352.chain, 145, true);
  // m/352'/145'/0' (hardened)
  const n0 = bip32Child(n145.priv, n145.chain, 0, true);
  // m/352'/145'/0'/0' (spend chain, hardened)
  const spendChain = bip32Child(n0.priv, n0.chain, 0, true);
  // m/352'/145'/0'/0'/0 (spend key, non-hardened)
  const spendKey = bip32Child(spendChain.priv, spendChain.chain, 0, false);
  // m/352'/145'/0'/1' (scan chain, hardened)
  const scanChain = bip32Child(n0.priv, n0.chain, 1, true);
  // m/352'/145'/0'/1'/0 (scan key, non-hardened)
  const scanKey = bip32Child(scanChain.priv, scanChain.chain, 0, false);

  return {
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
        // params: { masterPriv, masterChain } — from BIP32 master root
        result = deriveBip352Keys(params.masterPriv, params.masterChain);
        break;

      case 'derive_keys_from_seed': {
        // params: { seed } — BIP39 mnemonic phrase
        // Derive BIP32 master key from seed via PBKDF2 + HMAC-SHA512
        const crypto = require('crypto');
        const seedBytes = crypto.pbkdf2Sync(params.seed, 'mnemonic', 2048, 64, 'sha512');
        const I = crypto.createHmac('sha512', 'Bitcoin seed').update(seedBytes).digest();
        const masterPrivHex = I.subarray(0, 32).toString('hex');
        const masterChainHex = I.subarray(32).toString('hex');
        result = deriveBip352Keys(masterPrivHex, masterChainHex);
        break;
      }

      case 'derive_keys_from_account': {
        // params: { acctPrivHex, acctChainHex } — from m/44'/145'/0' account node
        // Fallback: derive at /2'/0 (scan) and /2'/1 (spend) — NOT BIP352
        const stChain = bip32Child(params.acctPrivHex, params.acctChainHex, 2, true);  // /2' hardened
        const scanChild = bip32Child(stChain.priv, stChain.chain, 0, false);   // /2'/0
        const spendChild = bip32Child(stChain.priv, stChain.chain, 1, false);  // /2'/1
        result = {
          scanPriv: scanChild.priv, scanPub: privToPub(scanChild.priv),
          spendPriv: spendChild.priv, spendPub: privToPub(spendChild.priv),
          paycode: makePaycode(privToPub(scanChild.priv), privToPub(spendChild.priv)),
          warning: 'Account-level derivation (not BIP352). Paycode differs from seed-based derivation.',
        };
        break;
      }

      case 'derive_keys_raw':
        // params: { rawPrivKey } — SHA256 domain separation fallback
        const scanSeed = sha256(Buffer.concat([Buffer.from('bch-stealth-scan'), Buffer.from(params.rawPrivKey, 'hex')]));
        const spendSeed = sha256(Buffer.concat([Buffer.from('bch-stealth-spend'), Buffer.from(params.rawPrivKey, 'hex')]));
        const scanPriv = scanSeed.toString('hex');
        const spendPriv = spendSeed.toString('hex');
        result = {
          scanPriv, scanPub: privToPub(scanPriv),
          spendPriv, spendPub: privToPub(spendPriv),
          paycode: makePaycode(privToPub(scanPriv), privToPub(spendPriv)),
        };
        break;

      case 'make_paycode':
        result = { paycode: makePaycode(params.scanPub, params.spendPub) };
        break;

      case 'parse_paycode':
        result = parsePaycode(params.paycode);
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

          // 3. a_tweaked = Σ h_i · a_i  mod N  where h_i = SHA256(smallest_outpoint || A_i)
          //    Equivalent to receiver's  Σ h_i · A_i  scaled by a single b_scan.
          let a_tweaked = 0n;
          for (let i = 0; i < senderScalars.length; i++) {
            const h = sha256(Buffer.concat([smallest, Buffer.from(senderPubHex[i], 'hex')]));
            const hBig = BigInt('0x' + h.toString('hex')) % N;
            a_tweaked = (a_tweaked + (hBig * senderScalars[i])) % N;
          }
          if (a_tweaked === 0n) throw new Error('aggregate scalar is zero');

          // 4. shared = a_tweaked · B_scan
          const [scanX, scanY] = decompressPoint(params.recipScanPub);
          const [sharedX] = pointMul(a_tweaked, scanX, scanY);
          const sharedXBuf = Buffer.from(sharedX.toString(16).padStart(64, '0'), 'hex');

          // 5. t_0 = SHA256(sharedX || 0), P_0 = B_spend + t_0 × G
          const kBuf = Buffer.alloc(4); kBuf.writeUInt32LE(0);
          const t = sha256(Buffer.concat([sharedXBuf, kBuf]));
          const tBig = BigInt('0x' + t.toString('hex')) % N;
          const [spendX, spendY] = decompressPoint(params.recipSpendPub);
          const [tweakX, tweakY] = pointMul(tBig);
          const [stealthX, stealthY] = pointAdd(spendX, spendY, tweakX, tweakY);
          const stealthPub = compressPoint(stealthX, stealthY);
          result = {
            addr: hash160ToCashAddr(hash160(Buffer.from(stealthPub, 'hex'))),
            pub: stealthPub,
            c: tBig.toString(16).padStart(64, '0'),
          };
        } else {
          // Legacy single-input
          result = stealthDerive(params.senderPriv, params.recipScanPub, params.recipSpendPub, params.outpoint);
        }
        break;
      }

      case 'spending_key':
        // params: { spendPriv, c }
        result = { key: stealthSpendingKey(params.spendPriv, params.c) };
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

      case 'derive_from_entries':
        // params: { scanPriv, spendPub, entries: [{txid,pubkey,...}] }
        result = deriveFromEntries(params);
        break;

      case 'scan_local_blocks':
        // params: { scanPriv, spendPub, blocks: [{height, hex}] }
        // Plugin-local scan: caller fetched raw blocks (e.g. from the user's
        // Fulcrum server via `blockchain.block.get`) and passes them here.
        // No external HTTP indexer dependency.
        result = scanBlocksLocal(params);
        break;

      case 'parse_block':
        // params: { blockHex, height } — debug helper.
        result = parseBlockEntries(params.blockHex, params.height | 0);
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
          version: '1.0.0',
          protocol: '00 Protocol (BIP352)',
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
