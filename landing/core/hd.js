import { secp256k1 } from "../lib/noble-curves.js";
import { sha256 } from "../lib/noble-hashes.js";
import { sha512 } from "../lib/noble-hashes.js";
import { hmac } from "../lib/noble-hashes.js";
import { ripemd160 } from "../lib/noble-hashes.js";
import { concat, b2h, h2b, utf8, rand } from "./utils.js";
import { pubHashToCashAddr } from "./cashaddr.js";
const N_SECP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
function bip32Master(seed) {
  const I = hmac(sha512, utf8("Bitcoin seed"), seed);
  return { priv: I.slice(0, 32), chain: I.slice(32) };
}
function bip32Child(priv, chain, idx, hard) {
  const ib = new Uint8Array([idx >>> 24, idx >>> 16 & 255, idx >>> 8 & 255, idx & 255]);
  const data = hard ? concat(new Uint8Array([0]), priv, ib) : concat(secp256k1.getPublicKey(priv, true), ib);
  const I = hmac(sha512, chain, data);
  const child = ((BigInt("0x" + b2h(I.slice(0, 32))) + BigInt("0x" + b2h(priv))) % N_SECP).toString(16).padStart(64, "0");
  return { priv: h2b(child), chain: I.slice(32) };
}
function bip32ChildPub(parentPub, parentChain, index) {
  const ib = new Uint8Array([index >>> 24, index >>> 16 & 255, index >>> 8 & 255, index & 255]);
  const data = concat(parentPub, ib);
  const I = hmac(sha512, parentChain, data);
  const il = I.slice(0, 32);
  const childPoint = secp256k1.ProjectivePoint.fromHex(b2h(parentPub)).add(secp256k1.ProjectivePoint.BASE.multiply(BigInt("0x" + b2h(il))));
  return { pub: childPoint.toRawBytes(true), chain: I.slice(32) };
}
function deriveAccountNode(seed64) {
  let n = bip32Master(seed64);
  n = bip32Child(n.priv, n.chain, 2147483692, true);
  n = bip32Child(n.priv, n.chain, 2147483793, true);
  n = bip32Child(n.priv, n.chain, 2147483648, true);
  return n;
}
function deriveBip352Node(seed64) {
  let n = bip32Master(seed64);
  n = bip32Child(n.priv, n.chain, 2147484e3, true);
  n = bip32Child(n.priv, n.chain, 2147483793, true);
  n = bip32Child(n.priv, n.chain, 2147483648, true);
  return n;
}
function deriveBchPriv(seed64) {
  const acct = deriveAccountNode(seed64);
  let n = bip32Child(acct.priv, acct.chain, 0, false);
  n = bip32Child(n.priv, n.chain, 0, false);
  return { priv: n.priv, acctPriv: acct.priv, acctChain: acct.chain };
}
function deriveStealth(seed64) {
  const stealthNode = deriveBip352Node(seed64);
  const spend = bip32Child(stealthNode.priv, stealthNode.chain, 2147483648, true);
  const spendKey = bip32Child(spend.priv, spend.chain, 0, false);
  const scan = bip32Child(stealthNode.priv, stealthNode.chain, 2147483649, true);
  const scanKey = bip32Child(scan.priv, scan.chain, 0, false);
  return {
    spendPriv: spendKey.priv,
    spendPub: secp256k1.getPublicKey(spendKey.priv, true),
    scanPriv: scanKey.priv,
    scanPub: secp256k1.getPublicKey(scanKey.priv, true)
  };
}
const _B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function _base58check(payload) {
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = concat(payload, checksum);
  let n = 0n;
  for (const byte of full) n = n << 8n | BigInt(byte);
  let s = "";
  while (n > 0n) {
    s = _B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (let i = 0; i < full.length && full[i] === 0; i++) s = "1" + s;
  return s;
}
function _makeXpub(pub, chain, depth, childNum, parentFp) {
  const buf = new Uint8Array(78);
  buf[0] = 4;
  buf[1] = 136;
  buf[2] = 178;
  buf[3] = 30;
  buf[4] = depth;
  buf.set(parentFp.slice(0, 4), 5);
  buf[9] = childNum >>> 24 & 255;
  buf[10] = childNum >>> 16 & 255;
  buf[11] = childNum >>> 8 & 255;
  buf[12] = childNum & 255;
  buf.set(chain, 13);
  buf.set(pub, 45);
  return _base58check(buf);
}
function deriveStealthXpubs(seed64) {
  const bip352 = deriveBip352Node(seed64);
  const bip352Pub = secp256k1.getPublicKey(bip352.priv, true);
  const parentFp = ripemd160(sha256(bip352Pub));
  const spend = bip32Child(bip352.priv, bip352.chain, 2147483648, true);
  const scan = bip32Child(bip352.priv, bip352.chain, 2147483649, true);
  return {
    spendXpub: _makeXpub(secp256k1.getPublicKey(spend.priv, true), spend.chain, 4, 2147483648, parentFp),
    scanXpub: _makeXpub(secp256k1.getPublicKey(scan.priv, true), scan.chain, 4, 2147483649, parentFp)
  };
}
function privToBchAddr(priv32) {
  const pub = secp256k1.getPublicKey(priv32, true);
  return pubHashToCashAddr(ripemd160(sha256(pub)));
}
function pubToHash160(pub) {
  return ripemd160(sha256(pub));
}
let _bip39Words = null;
async function _loadBip39Wordlist() {
  if (_bip39Words) return _bip39Words;
  const resp = await fetch("https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt");
  const text = await resp.text();
  _bip39Words = text.trim().split("\n");
  if (_bip39Words.length !== 2048) throw new Error("BIP39 wordlist invalid");
  return _bip39Words;
}
async function generateMnemonic(strength = 128) {
  const words = await _loadBip39Wordlist();
  const entropy = rand(strength / 8);
  const hash = sha256(entropy);
  const checksumBits = strength / 32;
  let bits = "";
  for (const b of entropy) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i < checksumBits; i++) bits += (hash[0] >> 7 - i & 1).toString();
  const indices = [];
  for (let i = 0; i < bits.length; i += 11) indices.push(parseInt(bits.slice(i, i + 11), 2));
  return indices.map((i) => words[i]).join(" ");
}
async function mnemonicToSeed(words) {
  const normalized = words.trim().toLowerCase().replace(/\s+/g, " ");
  const key = await crypto.subtle.importKey("raw", utf8(normalized), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-512", salt: utf8("mnemonic"), iterations: 2048 },
    key,
    512
  );
  return new Uint8Array(bits);
}
async function validateMnemonic(words) {
  const wordList = await _loadBip39Wordlist();
  const parts = words.trim().toLowerCase().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(parts.length)) return false;
  return parts.every((w) => wordList.includes(w));
}
export {
  N_SECP,
  bip32Child,
  bip32ChildPub,
  bip32Master,
  deriveAccountNode,
  deriveBchPriv,
  deriveBip352Node,
  deriveStealth,
  deriveStealthXpubs,
  generateMnemonic,
  hmac,
  mnemonicToSeed,
  privToBchAddr,
  pubToHash160,
  ripemd160,
  secp256k1,
  sha256,
  validateMnemonic
};
