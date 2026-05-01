import { secp256k1 } from "./lib/noble-curves.js";
import { ed25519 } from "./lib/noble-curves.js";
import { sha256 } from "./lib/noble-hashes.js";
const N_SECP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const P_FIELD = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const L_ED = 0x1000000000000000000000000000000014DEF9DEA2F79CD65812631A5CF5D3EDn;
const N_MIN = L_ED < N_SECP ? L_ED : N_SECP;
const G_ED = ed25519.ExtendedPoint.BASE;
const G_SECP = secp256k1.ProjectivePoint.BASE;
function modPow(base, exp, m) {
  let result = 1n;
  base = (base % m + m) % m;
  while (exp > 0n) {
    if (exp & 1n) result = result * base % m;
    exp >>= 1n;
    base = base * base % m;
  }
  return result;
}
function hasJacobi1(point) {
  const y = point.y;
  return modPow(y, (P_FIELD - 1n) / 2n, P_FIELD) === 1n;
}
function b2h(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function h2b(hex) {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.substr(i * 2, 2), 16);
  return u;
}
function concat(...arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const r = new Uint8Array(len);
  let p = 0;
  for (const a of arrays) {
    r.set(a, p);
    p += a.length;
  }
  return r;
}
function rand(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}
function utf8(s) {
  return new TextEncoder().encode(s);
}
function bytesToBigInt(b) {
  let n = 0n;
  for (let i = 0; i < b.length; i++) n = n << 8n | BigInt(b[i]);
  return n;
}
function bigIntToBytes32BE(n) {
  return h2b(n.toString(16).padStart(64, "0"));
}
function bigIntToBytes32LE(n) {
  const be = bigIntToBytes32BE(n);
  return be.reverse();
}
function mod(a, m) {
  const r = a % m;
  return r < 0n ? r + m : r;
}
function modInv(a, m) {
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return mod(old_s, m);
}
const KECCAK_ROUNDS = 24;
const KECCAK_RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808An,
  0x8000000080008000n,
  0x000000000000808Bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008An,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000An,
  0x000000008000808Bn,
  0x800000000000008Bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800An,
  0x800000008000000An,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n
];
const KECCAK_ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const KECCAK_PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const MASK64 = 0xFFFFFFFFFFFFFFFFn;
function rotl64(x, n) {
  return (x << BigInt(n) | x >> BigInt(64 - n)) & MASK64;
}
function keccakF1600(state) {
  for (let round = 0; round < KECCAK_ROUNDS; round++) {
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) state[x + y] = (state[x + y] ^ D) & MASK64;
    }
    let t = state[1];
    for (let i = 0; i < 24; i++) {
      const j = KECCAK_PILN[i];
      const tmp = state[j];
      state[j] = rotl64(t, KECCAK_ROTC[i]);
      t = tmp;
    }
    for (let y = 0; y < 25; y += 5) {
      const t0 = state[y], t1 = state[y + 1], t2 = state[y + 2], t3 = state[y + 3], t4 = state[y + 4];
      state[y] = (t0 ^ ~t1 & MASK64 & t2) & MASK64;
      state[y + 1] = (t1 ^ ~t2 & MASK64 & t3) & MASK64;
      state[y + 2] = (t2 ^ ~t3 & MASK64 & t4) & MASK64;
      state[y + 3] = (t3 ^ ~t4 & MASK64 & t0) & MASK64;
      state[y + 4] = (t4 ^ ~t0 & MASK64 & t1) & MASK64;
    }
    state[0] = (state[0] ^ KECCAK_RC[round]) & MASK64;
  }
}
function keccak256(input) {
  const rate = 136;
  const state = new Array(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] = 1;
  padded[padded.length - 1] |= 128;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = 0n;
      for (let b = 0; b < 8; b++) v |= BigInt(padded[off + i * 8 + b]) << BigInt(b * 8);
      state[i] = (state[i] ^ v) & MASK64;
    }
    keccakF1600(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const v = state[i];
    for (let b = 0; b < 8; b++) out[i * 8 + b] = Number(v >> BigInt(b * 8) & 0xFFn);
  }
  return out;
}
function scReduce32(scalar32) {
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = n << 8n | BigInt(scalar32[i]);
  n = mod(n, L_ED);
  return bigIntToBytes32LE(n);
}
function generateXmrPrivateKey() {
  const raw = rand(32);
  return scReduce32(raw);
}
function xmrPubFromPriv(privLE) {
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = n << 8n | BigInt(privLE[i]);
  const point = G_ED.multiply(n);
  return new Uint8Array(point.toRawBytes());
}
function xmrViewKeyFromSpend(spendPriv) {
  const hash = keccak256(spendPriv);
  return scReduce32(hash);
}
const XMR_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const XMR_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
function xmrBase58Encode(data) {
  let result = "";
  const fullBlocks = Math.floor(data.length / 8);
  for (let i = 0; i < fullBlocks; i++) {
    const block = data.slice(i * 8, i * 8 + 8);
    result += encodeBlock(block, 11);
  }
  const lastBlock = data.slice(fullBlocks * 8);
  if (lastBlock.length > 0) {
    result += encodeBlock(lastBlock, XMR_BLOCK_SIZES[lastBlock.length]);
  }
  return result;
}
function encodeBlock(data, targetLen) {
  let num = 0n;
  for (let i = 0; i < data.length; i++) num = num << 8n | BigInt(data[i]);
  let encoded = "";
  for (let i = 0; i < targetLen; i++) {
    encoded = XMR_ALPHABET[Number(num % 58n)] + encoded;
    num = num / 58n;
  }
  return encoded;
}
function xmrAddress(pubSpend, pubView, network = 18) {
  const prefix = new Uint8Array([network]);
  const data = concat(prefix, pubSpend, pubView);
  const checksum = keccak256(data).slice(0, 4);
  return xmrBase58Encode(concat(data, checksum));
}
function adaptorSign(privKey, adaptorPoint, msgHash) {
  const x = bytesToBigInt(privKey);
  const z = bytesToBigInt(msgHash);
  const T = secp256k1.ProjectivePoint.fromHex(adaptorPoint);
  const k = generateNonce(privKey, msgHash);
  const kInv = modInv(k, N_SECP);
  const Rprime = G_SECP.multiply(k);
  const R = Rprime.add(T);
  const r = mod(R.x, N_SECP);
  if (r === 0n) throw new Error("invalid nonce");
  const s_hat = mod(kInv * (z + r * x), N_SECP);
  if (s_hat === 0n) throw new Error("invalid s_hat");
  const proof = dleqProveSecp(k, Rprime);
  return {
    Rprime: Rprime.toRawBytes(true),
    // 33 bytes compressed
    R: R.toRawBytes(true),
    // 33 bytes compressed
    s_hat,
    r,
    proof
  };
}
function adaptorVerify(pubKey, adaptorPoint, msgHash, adaptorSig) {
  try {
    const P = secp256k1.ProjectivePoint.fromHex(pubKey);
    const T = secp256k1.ProjectivePoint.fromHex(adaptorPoint);
    const z = bytesToBigInt(msgHash);
    const { Rprime, R, s_hat, r, proof } = adaptorSig;
    const RprimePoint = secp256k1.ProjectivePoint.fromHex(Rprime);
    const RPoint = secp256k1.ProjectivePoint.fromHex(R);
    const expectedR = RprimePoint.add(T);
    if (expectedR.x !== RPoint.x || expectedR.y !== RPoint.y) return false;
    if (mod(RPoint.x, N_SECP) !== r) return false;
    const lhs = RprimePoint.multiply(s_hat);
    const rhs = G_SECP.multiply(z).add(P.multiply(r));
    if (lhs.x !== rhs.x || lhs.y !== rhs.y) return false;
    if (!dleqVerifySecp(RprimePoint, proof)) return false;
    return true;
  } catch {
    return false;
  }
}
function adaptorDecrypt(adaptorSig, adaptorSecret) {
  const t = bytesToBigInt(adaptorSecret);
  const { s_hat, r } = adaptorSig;
  const s = mod(s_hat - t, N_SECP);
  if (s === 0n) throw new Error("invalid decrypted signature");
  const sNorm = s > N_SECP / 2n ? N_SECP - s : s;
  return { r, s: sNorm };
}
function adaptorRecover(adaptorSig, realSig) {
  const { s_hat } = adaptorSig;
  let { s } = realSig;
  let t = mod(s_hat - s, N_SECP);
  const T = secp256k1.ProjectivePoint.fromHex(adaptorSig.R);
  const Rprime = secp256k1.ProjectivePoint.fromHex(adaptorSig.Rprime);
  const expectedT = T.subtract(Rprime);
  const recoveredT = G_SECP.multiply(t);
  if (recoveredT.x !== expectedT.x || recoveredT.y !== expectedT.y) {
    t = mod(s_hat + s, N_SECP);
  }
  return bigIntToBytes32BE(t);
}
function generateNonce(privKey, msgHash, counter = 0) {
  const base = concat(privKey, msgHash, utf8("adaptor-nonce"));
  let data = base;
  if (counter > 0) {
    const ctr = new Uint8Array(4);
    new DataView(ctr.buffer).setUint32(0, counter, false);
    data = concat(base, ctr);
  }
  const hash = sha256(sha256(data));
  let k = bytesToBigInt(hash);
  k = mod(k, N_SECP - 1n) + 1n;
  return k;
}
function dleqProveSecp(k, Q) {
  const r = bytesToBigInt(rand(32));
  const rMod = mod(r, N_SECP - 1n) + 1n;
  const A = G_SECP.multiply(rMod);
  const e = bytesToBigInt(sha256(concat(
    G_SECP.toRawBytes(true),
    Q.toRawBytes(true),
    A.toRawBytes(true)
  )));
  const eMod = mod(e, N_SECP);
  const z = mod(rMod + eMod * k, N_SECP);
  return { A: A.toRawBytes(true), z };
}
function dleqVerifySecp(Q, proof) {
  try {
    const { A, z } = proof;
    const APoint = secp256k1.ProjectivePoint.fromHex(A);
    const e = bytesToBigInt(sha256(concat(
      G_SECP.toRawBytes(true),
      Q.toRawBytes(true),
      APoint.toRawBytes(true)
    )));
    const eMod = mod(e, N_SECP);
    const lhs = G_SECP.multiply(z);
    const rhs = APoint.add(Q.multiply(eMod));
    return lhs.x === rhs.x && lhs.y === rhs.y;
  } catch {
    return false;
  }
}
function bchSchnorrChallenge(Rx, PCompressed, msg) {
  return mod(bytesToBigInt(sha256(concat(
    bigIntToBytes32BE(Rx),
    // 32-byte R.x (big-endian)
    PCompressed,
    // 33-byte compressed pubkey
    sha256(msg)
    // SHA256(msg) — BCH OP_CHECKDATASIG hashes the message
  ))), N_SECP);
}
function schnorrAdaptorSign(privKey, adaptorPoint, msg) {
  const x = bytesToBigInt(privKey);
  const P = G_SECP.multiply(x);
  const T = secp256k1.ProjectivePoint.fromHex(adaptorPoint);
  for (let counter = 0; counter < 128; counter++) {
    const k = generateNonce(privKey, msg, counter);
    const R = G_SECP.multiply(k);
    const Rprime = R.add(T);
    if (!hasJacobi1(Rprime)) continue;
    const e = bchSchnorrChallenge(Rprime.x, P.toRawBytes(true), msg);
    const s_hat = mod(k + e * x, N_SECP);
    return {
      R: R.toRawBytes(true),
      // 33 bytes, the "hidden" nonce
      Rprime: Rprime.toRawBytes(true),
      // 33 bytes, the "public" nonce (R + T)
      s_hat,
      // pre-signature scalar
      e
      // challenge
    };
  }
  throw new Error("schnorrAdaptorSign: could not find nonce with valid Jacobi");
}
function schnorrAdaptorVerify(pubKey, adaptorPoint, msg, adaptorSig) {
  try {
    const P = secp256k1.ProjectivePoint.fromHex(pubKey);
    const T = secp256k1.ProjectivePoint.fromHex(adaptorPoint);
    const { R, Rprime, s_hat, e } = adaptorSig;
    const RPoint = secp256k1.ProjectivePoint.fromHex(R);
    const RprimePoint = secp256k1.ProjectivePoint.fromHex(Rprime);
    const expectedRprime = RPoint.add(T);
    if (expectedRprime.x !== RprimePoint.x) {
      console.warn("[SCHNORR] Rprime check failed:", expectedRprime.x.toString(16).slice(0, 16), "!=", RprimePoint.x.toString(16).slice(0, 16));
      return false;
    }
    const eCheck = bchSchnorrChallenge(RprimePoint.x, P.toRawBytes(true), msg);
    if (eCheck !== e) {
      console.warn("[SCHNORR] challenge mismatch: eCheck=", eCheck.toString(16).slice(0, 16), "e=", e.toString(16).slice(0, 16));
      return false;
    }
    const negE = mod(N_SECP - e, N_SECP);
    const lhs = G_SECP.multiply(s_hat).add(P.multiply(negE));
    if (lhs.x !== RPoint.x || lhs.y !== RPoint.y) {
      console.warn("[SCHNORR] verify eq failed: lhs.x=", lhs.x.toString(16).slice(0, 16), "R.x=", RPoint.x.toString(16).slice(0, 16));
      return false;
    }
    return true;
  } catch (err) {
    console.error("[SCHNORR] adaptorVerify exception:", err);
    return false;
  }
}
function schnorrAdaptorDecrypt(adaptorSig, adaptorSecret) {
  const t = bytesToBigInt(adaptorSecret);
  const { Rprime, s_hat, e } = adaptorSig;
  const s = mod(s_hat + t, N_SECP);
  return {
    R: Rprime,
    // The real nonce is R' = R + T
    s,
    e
  };
}
function schnorrAdaptorRecover(adaptorSig, realSig) {
  const { s_hat } = adaptorSig;
  const { s } = realSig;
  const t = mod(s - s_hat, N_SECP);
  return bigIntToBytes32BE(t);
}
function schnorrVerify(pubKey, msg, sig) {
  try {
    const P = secp256k1.ProjectivePoint.fromHex(pubKey);
    const RPoint = secp256k1.ProjectivePoint.fromHex(sig.R);
    const { s, e } = sig;
    const eCheck = bchSchnorrChallenge(RPoint.x, P.toRawBytes(true), msg);
    if (eCheck !== e) return false;
    const negE = mod(N_SECP - e, N_SECP);
    const lhs = G_SECP.multiply(s).add(P.multiply(negE));
    if (lhs.x !== RPoint.x || lhs.y !== RPoint.y) return false;
    if (!hasJacobi1(lhs)) return false;
    return true;
  } catch {
    return false;
  }
}
const NUM_BITS = 252;
function crossCurveDLEQProve(x, P_secp, P_ed) {
  if (x >= 1n << BigInt(NUM_BITS)) throw new Error("secret too large for cross-curve DLEQ");
  let k;
  do {
    k = bytesToBigInt(rand(32));
    k = mod(k, N_MIN - 1n) + 1n;
  } while (k >= N_MIN);
  const A_secp = G_SECP.multiply(k);
  const A_ed = G_ED.multiply(k);
  const e = mod(bytesToBigInt(sha256(concat(
    G_SECP.toRawBytes(true),
    P_secp.toRawBytes(true),
    A_secp.toRawBytes(true),
    new Uint8Array(P_ed.toRawBytes()),
    new Uint8Array(A_ed.toRawBytes())
  ))), N_MIN);
  const z = k + e * x;
  return {
    A_secp: A_secp.toRawBytes(true),
    A_ed: new Uint8Array(A_ed.toRawBytes()),
    e,
    z
  };
}
function crossCurveDLEQVerify(P_secp_bytes, P_ed_bytes, proof) {
  try {
    const P_secp = secp256k1.ProjectivePoint.fromHex(P_secp_bytes);
    const P_ed = ed25519.ExtendedPoint.fromHex(P_ed_bytes);
    const A_secp = secp256k1.ProjectivePoint.fromHex(proof.A_secp);
    const A_ed = ed25519.ExtendedPoint.fromHex(proof.A_ed);
    const { e, z } = proof;
    const eCheck = mod(bytesToBigInt(sha256(concat(
      G_SECP.toRawBytes(true),
      P_secp.toRawBytes(true),
      A_secp.toRawBytes(true),
      new Uint8Array(P_ed.toRawBytes()),
      new Uint8Array(A_ed.toRawBytes())
    ))), N_MIN);
    if (eCheck !== e) return false;
    const z_secp = mod(z, N_SECP);
    const e_secp = mod(e, N_SECP);
    const lhs_secp = G_SECP.multiply(z_secp);
    const rhs_secp = A_secp.add(P_secp.multiply(e_secp));
    if (lhs_secp.x !== rhs_secp.x || lhs_secp.y !== rhs_secp.y) return false;
    const z_ed = mod(z, L_ED);
    const e_ed = mod(e, L_ED);
    const lhs_ed = G_ED.multiply(z_ed);
    const rhs_ed = A_ed.add(P_ed.multiply(e_ed));
    if (!lhs_ed.equals(rhs_ed)) return false;
    return true;
  } catch (err) {
    console.error("DLEQ verify error:", err);
    return false;
  }
}
function secpKeyToEdKey(secpPriv) {
  const be = new Uint8Array(secpPriv);
  const le = new Uint8Array(be).reverse();
  return le;
}
function edKeyToSecpKey(edPriv) {
  const le = new Uint8Array(edPriv);
  const be = new Uint8Array(le).reverse();
  return be;
}
function generateCrossCurveKeypair() {
  let x;
  do {
    x = bytesToBigInt(rand(32));
    x = mod(x, N_MIN - 1n) + 1n;
  } while (x >= N_MIN || x === 0n);
  const secpPriv = bigIntToBytes32BE(x);
  const P_secp = G_SECP.multiply(x);
  const secpPub = P_secp.toRawBytes(true);
  const P_ed = G_ED.multiply(x);
  const edPub = new Uint8Array(P_ed.toRawBytes());
  const proof = crossCurveDLEQProve(x, P_secp, P_ed);
  return {
    secret: x,
    secp: { priv: secpPriv, pub: secpPub },
    ed: { pub: edPub },
    dleqProof: proof
  };
}
function serializeAdaptorSig(sig) {
  return JSON.stringify({
    R: b2h(sig.R),
    Rprime: b2h(sig.Rprime),
    s_hat: sig.s_hat.toString(16),
    e: sig.e.toString(16)
  });
}
function deserializeAdaptorSig(json) {
  const o = JSON.parse(json);
  return {
    R: h2b(o.R),
    Rprime: h2b(o.Rprime),
    s_hat: BigInt("0x" + o.s_hat),
    e: BigInt("0x" + o.e)
  };
}
function serializeDLEQProof(proof) {
  return JSON.stringify({
    A_secp: b2h(proof.A_secp),
    A_ed: b2h(proof.A_ed),
    e: proof.e.toString(16),
    z: proof.z.toString(16)
  });
}
function deserializeDLEQProof(json) {
  const o = JSON.parse(json);
  return {
    A_secp: h2b(o.A_secp),
    A_ed: h2b(o.A_ed),
    e: BigInt("0x" + o.e),
    z: BigInt("0x" + o.z)
  };
}
function serializeCrossCurveKeys(keys) {
  return JSON.stringify({
    secpPub: b2h(keys.secp.pub),
    edPub: b2h(keys.ed.pub),
    dleqProof: serializeDLEQProof(keys.dleqProof)
  });
}
function deserializeCrossCurveKeys(json) {
  const o = JSON.parse(json);
  return {
    secp: { pub: h2b(o.secpPub) },
    ed: { pub: h2b(o.edPub) },
    dleqProof: deserializeDLEQProof(o.dleqProof)
  };
}
export {
  L_ED,
  NUM_BITS,
  N_MIN,
  N_SECP,
  b2h,
  bigIntToBytes32BE,
  bigIntToBytes32LE,
  bytesToBigInt,
  concat,
  crossCurveDLEQProve,
  crossCurveDLEQVerify,
  deserializeAdaptorSig,
  deserializeCrossCurveKeys,
  deserializeDLEQProof,
  edKeyToSecpKey,
  generateCrossCurveKeypair,
  generateXmrPrivateKey,
  h2b,
  keccak256,
  mod,
  modInv,
  rand,
  scReduce32,
  schnorrAdaptorDecrypt,
  schnorrAdaptorRecover,
  schnorrAdaptorSign,
  schnorrAdaptorVerify,
  schnorrVerify,
  secpKeyToEdKey,
  serializeAdaptorSig,
  serializeCrossCurveKeys,
  serializeDLEQProof,
  sha256,
  utf8,
  xmrAddress,
  xmrBase58Encode,
  xmrPubFromPriv,
  xmrViewKeyFromSpend
};
