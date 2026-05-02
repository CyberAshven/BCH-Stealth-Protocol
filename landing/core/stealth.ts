import { secp256k1 } from "../lib/noble-curves.js";
import { sha256 } from "../lib/noble-hashes.js";
import { ripemd160 } from "../lib/noble-hashes.js";
import { concat, b2h, h2b } from "./utils.js";
import { pubHashToCashAddr } from "./cashaddr.js";
const N_SECP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

/* ── Interfaces ── */
export interface StealthDeriveResult { pub: Uint8Array; cBig: bigint; }
export interface SelfStealthResult { addr: string; pub: Uint8Array; priv: Uint8Array; }
export interface StealthSendResult { addr: string; pub: Uint8Array; A_sum: Uint8Array; }
export interface StealthUtxo { addr: string; priv: string; pub: string; from: string; ts: number; }
export interface StealthKeys {
  stealthScanPriv: string | Uint8Array;
  stealthSpendPub: string | Uint8Array;
  stealthSpendPriv?: string | Uint8Array;
}
export interface IndexerEntry {
  txid: string;
  vin: number;
  pubkey: string | Uint8Array;
  height: number;
  outpointTxid?: string | Uint8Array;
  outpointVout?: number;
}
export interface StealthPayment {
  txid: string;
  height: number;
  value: number;
  outputIdx: number;
  addr: string;
  tBig: bigint;
}
export interface Outpoint { txid: string | Uint8Array; vout: number; }
export interface ParsedInputEntry {
  txid: string;
  vin: number;
  pubkey: string;
  outpointTxid: string;
  outpointVout: number;
  height: number;
}
interface OutputMatch { idx: number; value: number; }
interface VarIntResult { value: number; next: number; }

function _compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function _u32LE(v: number): Uint8Array {
  return new Uint8Array([v & 255, v >> 8 & 255, v >> 16 & 255, v >> 24 & 255]);
}
function _scalarFromBytes(bytes: Uint8Array): bigint {
  return BigInt('0x' + b2h(bytes));
}
function _scalarToBytes(scalar: bigint): Uint8Array {
  return h2b((scalar % N_SECP).toString(16).padStart(64, '0'));
}
function _getOutpointBytes(txid: string | Uint8Array, vout: number): Uint8Array {
  const txidHex = typeof txid === 'string' ? txid : b2h(txid);
  return concat(h2b(txidHex).reverse(), _u32LE(vout || 0));
}
function _findSmallestOutpoint(outpoints: Outpoint[]): Uint8Array | null {
  let smallest: Uint8Array | null = null;
  for (const op of outpoints) {
    const outpoint = _getOutpointBytes(op.txid, op.vout);
    if (!smallest || _compareBytes(outpoint, smallest) < 0) smallest = outpoint;
  }
  return smallest;
}
function _hashInputWeight(smallestOutpoint: Uint8Array, pubkey: Uint8Array): bigint {
  const inputHash = sha256(concat(smallestOutpoint, pubkey));
  return BigInt('0x' + b2h(inputHash)) % N_SECP;
}
function _aggregateWeightedSenderInputs(
  privKeys: Array<Uint8Array | string>,
  smallestOutpoint: Uint8Array,
): { scalar: bigint; pub: Uint8Array } {
  let weightedScalar = 0n;
  let weightedPub: ReturnType<typeof secp256k1.ProjectivePoint.fromHex> | null = null;
  for (const priv of privKeys) {
    const privBytes = typeof priv === 'string' ? h2b(priv) : priv;
    const pubBytes = secp256k1.getPublicKey(privBytes, true);
    const weight = _hashInputWeight(smallestOutpoint, pubBytes);
    weightedScalar = (weightedScalar + (weight * _scalarFromBytes(privBytes))) % N_SECP;
    const weightedPoint = secp256k1.ProjectivePoint.fromHex(pubBytes).multiply(weight);
    weightedPub = weightedPub ? weightedPub.add(weightedPoint) : weightedPoint;
  }
  if (!weightedPub || weightedScalar === 0n) throw new Error('Invalid weighted input aggregation');
  return { scalar: weightedScalar, pub: weightedPub.toRawBytes(true) };
}
function _aggregateWeightedObservedInputs(
  inputs: IndexerEntry[],
  smallestOutpoint: Uint8Array,
): Uint8Array | null {
  let weightedPub: ReturnType<typeof secp256k1.ProjectivePoint.fromHex> | null = null;
  for (const inp of inputs) {
    const pubHex = typeof inp.pubkey === 'string' ? inp.pubkey : b2h(inp.pubkey as Uint8Array);
    try {
      const pubBytes = h2b(pubHex);
      const weight = _hashInputWeight(smallestOutpoint, pubBytes);
      const weightedPoint = secp256k1.ProjectivePoint.fromHex(pubBytes).multiply(weight);
      weightedPub = weightedPub ? weightedPub.add(weightedPoint) : weightedPoint;
    } catch {
      continue;
    }
  }
  return weightedPub ? weightedPub.toRawBytes(true) : null;
}
function stealthDerive(senderPriv: Uint8Array, recipScanPub: Uint8Array, recipSpendPub: Uint8Array, tweakData: Uint8Array): StealthDeriveResult {
  const sharedPoint = secp256k1.getSharedSecret(senderPriv, recipScanPub);
  const sharedX = sharedPoint.slice(1, 33);
  const c = sha256(concat(sha256(sharedX), tweakData));
  const cBig = BigInt("0x" + b2h(c)) % N_SECP;
  const spendPoint = secp256k1.ProjectivePoint.fromHex(recipSpendPub);
  const tweakPoint = secp256k1.ProjectivePoint.BASE.multiply(cBig);
  const stealthPoint = spendPoint.add(tweakPoint);
  const stealthPub = stealthPoint.toRawBytes(true);
  return { pub: stealthPub, cBig };
}
function stealthScan(scanPriv: Uint8Array, senderPub: Uint8Array, spendPub: Uint8Array, tweakData: Uint8Array): StealthDeriveResult {
  const sharedPoint = secp256k1.getSharedSecret(scanPriv, senderPub);
  const sharedX = sharedPoint.slice(1, 33);
  const c = sha256(concat(sha256(sharedX), tweakData));
  const cBig = BigInt("0x" + b2h(c)) % N_SECP;
  const spendPoint = secp256k1.ProjectivePoint.fromHex(spendPub);
  const tweakPoint = secp256k1.ProjectivePoint.BASE.multiply(cBig);
  const stealthPoint = spendPoint.add(tweakPoint);
  return { pub: stealthPoint.toRawBytes(true), cBig };
}
function stealthSpendingKey(spendPriv: Uint8Array, cBig: bigint): Uint8Array {
  const bBig = BigInt("0x" + b2h(spendPriv));
  return h2b(((bBig + cBig) % N_SECP).toString(16).padStart(64, "0"));
}
function stealthPubToAddr(stealthPub: Uint8Array): string {
  const hash = ripemd160(sha256(stealthPub));
  return pubHashToCashAddr(hash);
}
function encodeStealthCode(scanPub: Uint8Array, spendPub: Uint8Array): string {
  return "stealth:" + b2h(scanPub) + b2h(spendPub);
}
function decodeStealthCode(code: string): { scanPub: Uint8Array; spendPub: Uint8Array } {
  const hex = code.replace(/^stealth:/, "");
  if (hex.length !== 132) throw new Error("invalid stealth code length");
  return {
    scanPub: h2b(hex.slice(0, 66)),
    spendPub: h2b(hex.slice(66, 132))
  };
}
function checkStealthMatch(scanPriv: Uint8Array, spendPub: Uint8Array, senderInputPub: Uint8Array, outputHash160: Uint8Array, tweakData: Uint8Array): boolean {
  const { pub } = stealthScan(scanPriv, senderInputPub, spendPub, tweakData);
  const expectedHash = ripemd160(sha256(pub));
  return b2h(expectedHash) === b2h(outputHash160);
}
function deriveSelfStealth(inputPriv: Uint8Array, scanPub: Uint8Array, spendPub: Uint8Array, spendPriv: Uint8Array, outpoint: Uint8Array, outputIdx: number): SelfStealthResult {
  const shared = secp256k1.getSharedSecret(inputPriv, scanPub);
  const sharedX = shared.slice(1, 33);
  const nonce = concat(outpoint, _u32LE(outputIdx));
  const c = sha256(concat(sha256(sharedX), nonce));
  const cBig = BigInt("0x" + b2h(c)) % N_SECP;
  const spendPoint = secp256k1.ProjectivePoint.fromHex(spendPub);
  const stealthPoint = spendPoint.add(secp256k1.ProjectivePoint.BASE.multiply(cBig));
  const stealthPubBytes = stealthPoint.toRawBytes(true);
  const addr = pubHashToCashAddr(ripemd160(sha256(stealthPubBytes)));
  const bBig = BigInt("0x" + b2h(spendPriv));
  const pBig = (bBig + cBig) % N_SECP;
  const privKey = h2b(pBig.toString(16).padStart(64, "0"));
  return { addr, pub: stealthPubBytes, priv: privKey };
}
function saveStealthUtxo(addr: string, priv: Uint8Array | string, pub: Uint8Array | string, source: string = "fusion"): void {
  const existing = JSON.parse(localStorage.getItem("00stealth_utxos") || "[]");
  if (existing.some((u: { addr: string }) => u.addr === addr)) return;
  existing.push({
    addr,
    priv: priv instanceof Uint8Array ? b2h(priv) : priv,
    pub: pub instanceof Uint8Array ? b2h(pub) : pub,
    from: source,
    ts: Math.floor(Date.now() / 1e3)
  });
  localStorage.setItem("00stealth_utxos", JSON.stringify(existing));
}
function loadStealthUtxos(): StealthUtxo[] {
  return JSON.parse(localStorage.getItem("00stealth_utxos") || "[]");
}
function deriveStealthSendAddr(
  recipScanPub: Uint8Array,
  recipSpendPub: Uint8Array,
  senderPrivKeys: Uint8Array | Uint8Array[] | string | string[],
  outpoints?: Outpoint[],
  outputIndex: number = 0
): StealthSendResult {
  // Normalize to array
  let privKeysArr: Array<Uint8Array | string> = Array.isArray(senderPrivKeys)
    ? (senderPrivKeys as Array<Uint8Array | string>)
    : [senderPrivKeys as Uint8Array | string];
  if (!outpoints || outpoints.length === 0) {
    const senderPrivKey = typeof privKeysArr[0] === "string" ? h2b(privKeysArr[0] as string) : privKeysArr[0] as Uint8Array;
    const senderPub = secp256k1.getPublicKey(senderPrivKey, true);
    const shared2 = secp256k1.getSharedSecret(senderPrivKey, recipScanPub);
    const sharedX2 = shared2.slice(1, 33);
    const c = sha256(concat(sha256(sharedX2), senderPub));
    const cBig = BigInt("0x" + b2h(c)) % N_SECP;
    const spendPoint2 = secp256k1.ProjectivePoint.fromHex(recipSpendPub);
    const stealthPoint2 = spendPoint2.add(secp256k1.ProjectivePoint.BASE.multiply(cBig));
    const stealthPubBytes2 = stealthPoint2.toRawBytes(true);
    return {
      addr: pubHashToCashAddr(ripemd160(sha256(stealthPubBytes2))),
      pub: stealthPubBytes2,
      A_sum: senderPub
    };
  }
  const smallest = _findSmallestOutpoint(outpoints);
  if (!smallest) throw new Error('No outpoints provided for stealth address computation');
  const { scalar: weightedScalar, pub: weightedPub } = _aggregateWeightedSenderInputs(privKeysArr, smallest);
  const shared = secp256k1.getSharedSecret(_scalarToBytes(weightedScalar), recipScanPub);
  const sharedX = shared.slice(1, 33);
  const t = sha256(concat(sharedX, _u32LE(outputIndex)));
  const tBig = BigInt("0x" + b2h(t)) % N_SECP;
  const spendPoint = secp256k1.ProjectivePoint.fromHex(recipSpendPub);
  const stealthPoint = spendPoint.add(secp256k1.ProjectivePoint.BASE.multiply(tBig));
  const stealthPubBytes = stealthPoint.toRawBytes(true);
  const addr = pubHashToCashAddr(ripemd160(sha256(stealthPubBytes)));
  return { addr, pub: stealthPubBytes, A_sum: weightedPub };
}
async function scanForStealthPayments(keys: StealthKeys, entries: IndexerEntry[]): Promise<StealthPayment[]> {
  const scanPrivHex = keys.stealthScanPriv;
  const spendPubHex = keys.stealthSpendPub;
  if (!scanPrivHex || !spendPubHex) return [];
  const scanPriv = typeof scanPrivHex === "string" ? h2b(scanPrivHex) : scanPrivHex;
  const spendPub = typeof spendPubHex === "string" ? h2b(spendPubHex) : spendPubHex;
  const txMap = new Map<string, IndexerEntry[]>();
  for (const e of entries) {
    if (!e.pubkey || !e.txid) continue;
    if (!txMap.has(e.txid)) txMap.set(e.txid, []);
    txMap.get(e.txid)!.push(e);
  }
  const found: StealthPayment[] = [];
  for (const [txid, inputs] of txMap) {
    const hasOutpoints = inputs.some((inp) => inp.outpointTxid != null);
    if (!hasOutpoints) {
      let rawHex2;
      try {
        rawHex2 = await (window as any)._fvCall("blockchain.transaction.get", [txid]);
      } catch {
        continue;
      }
      if (!rawHex2) continue;
      const seenPubs = new Set<string>();
      for (const inp of inputs) {
          const pubHex = typeof inp.pubkey === "string" ? inp.pubkey : b2h(inp.pubkey as Uint8Array);
        if (seenPubs.has(pubHex)) continue;
        seenPubs.add(pubHex);
        try {
          const senderPub = h2b(pubHex);
          const shared2 = secp256k1.getSharedSecret(scanPriv, senderPub);
          const sharedX2 = shared2.slice(1, 33);
          const c = sha256(concat(sha256(sharedX2), senderPub));
          const cBig = BigInt("0x" + b2h(c)) % N_SECP;
          const spendPoint = secp256k1.ProjectivePoint.fromHex(spendPub);
          const stealthPubBytes = spendPoint.add(secp256k1.ProjectivePoint.BASE.multiply(cBig)).toRawBytes(true);
          const expectedHash = b2h(ripemd160(sha256(stealthPubBytes)));
          const addr = pubHashToCashAddr(ripemd160(sha256(stealthPubBytes)));
          for (const m of _matchOutputs(rawHex2, expectedHash)) {
            found.push({ txid, height: inp.height, value: m.value, outputIdx: m.idx, addr, tBig: cBig });
            if (keys.stealthSpendPriv) {
              const spendPriv = typeof keys.stealthSpendPriv === "string" ? h2b(keys.stealthSpendPriv) : keys.stealthSpendPriv;
              saveStealthUtxo(addr, stealthSpendingKey(spendPriv, cBig), stealthPubBytes, "scan-legacy");
            }
          }
        } catch {
        }
      }
      continue;
    }
    const weightedOutpoints = inputs
      .filter((inp) => inp.outpointTxid != null)
      .map((inp) => ({ txid: inp.outpointTxid as string | Uint8Array, vout: inp.outpointVout || 0 }));
    const smallest = _findSmallestOutpoint(weightedOutpoints);
    if (!smallest) continue;
    const weightedPub = _aggregateWeightedObservedInputs(inputs, smallest);
    if (!weightedPub) continue;
    const shared = secp256k1.getSharedSecret(scanPriv, weightedPub);
    const sharedX = shared.slice(1, 33);
    let rawHex: string;
    try {
      rawHex = await (window as any)._fvCall("blockchain.transaction.get", [txid]);
    } catch {
      continue;
    }
    if (!rawHex) continue;
    for (let k = 0; k < 3; k++) {
      const t = sha256(concat(sharedX, _u32LE(k)));
      const tBig = BigInt("0x" + b2h(t)) % N_SECP;
      const spendPoint = secp256k1.ProjectivePoint.fromHex(spendPub);
      const stealthPubBytes = spendPoint.add(secp256k1.ProjectivePoint.BASE.multiply(tBig)).toRawBytes(true);
      const expectedHash = b2h(ripemd160(sha256(stealthPubBytes)));
      const addr = pubHashToCashAddr(ripemd160(sha256(stealthPubBytes)));
      const matches = _matchOutputs(rawHex, expectedHash);
      if (matches.length === 0) break;
      for (const m of matches) {
        found.push({
          txid,
          height: inputs[0]?.height,
          value: m.value,
          outputIdx: m.idx,
          addr,
          tBig
        });
        if (keys.stealthSpendPriv) {
          const spendPriv = typeof keys.stealthSpendPriv === "string" ? h2b(keys.stealthSpendPriv) : keys.stealthSpendPriv;
          saveStealthUtxo(addr, stealthSpendingKey(spendPriv, tBig), stealthPubBytes, "scan");
        }
      }
    }
  }
  return found;
}
function parseRawTxInputs(rawHex: string, txid?: string): ParsedInputEntry[] {
  const results: ParsedInputEntry[] = [];
  try {
    const raw = h2b(rawHex);
    if (!txid) {
      const h1 = sha256(raw);
      const h2 = sha256(h1);
      txid = b2h(new Uint8Array([...h2].reverse()));
    }
    let offset = 4;
    const inputCount = _readVarInt(raw, offset);
    offset = inputCount.next;
    for (let vin = 0; vin < inputCount.value; vin++) {
      const prevTxidLE = raw.slice(offset, offset + 32);
      offset += 32;
      const vout = raw[offset] | raw[offset + 1] << 8 | raw[offset + 2] << 16 | raw[offset + 3] << 24;
      offset += 4;
      const scriptLen = _readVarInt(raw, offset);
      offset = scriptLen.next;
      const script = raw.slice(offset, offset + scriptLen.value);
      offset += scriptLen.value;
      offset += 4;
      if (script.length >= 35) {
        const sigLen = script[0];
        if (sigLen >= 71 && sigLen <= 73 && script[sigLen + 1] === 33) {
          const pk = script.slice(sigLen + 2, sigLen + 2 + 33);
          if ((pk[0] === 2 || pk[0] === 3) && pk.length === 33) {
            const outpointTxid = b2h(new Uint8Array([...prevTxidLE].reverse()));
            results.push({
              txid,
              vin,
              pubkey: b2h(pk),
              outpointTxid,
              outpointVout: vout,
              height: 0
            });
          }
        }
      }
    }
  } catch {
  }
  return results;
}
function _matchOutputs(rawHex: string, targetHash160: string): OutputMatch[] {
  const matches: OutputMatch[] = [];
  try {
    const raw = h2b(rawHex);
    let offset = 4;
    let inputCount = raw[offset++];
    if (inputCount === 0) {
      offset++;
      inputCount = raw[offset++];
    }
    for (let i = 0; i < inputCount; i++) {
      offset += 32 + 4;
      const scriptLen = _readVarInt(raw, offset);
      offset = scriptLen.next + scriptLen.value + 4;
    }
    const outputCount = _readVarInt(raw, offset);
    offset = outputCount.next;
    for (let i = 0; i < outputCount.value; i++) {
      const valueLo = raw[offset] | raw[offset + 1] << 8 | raw[offset + 2] << 16 | raw[offset + 3] << 24;
      const valueHi = raw[offset + 4] | raw[offset + 5] << 8 | raw[offset + 6] << 16 | raw[offset + 7] << 24;
      const value = valueLo + valueHi * 4294967296;
      offset += 8;
      const scriptLen = _readVarInt(raw, offset);
      offset = scriptLen.next;
      const script = raw.slice(offset, offset + scriptLen.value);
      offset += scriptLen.value;
      if (script.length === 25 && script[0] === 118 && script[1] === 169 && script[2] === 20 && script[23] === 136 && script[24] === 172) {
        if (b2h(script.slice(3, 23)) === targetHash160) {
          matches.push({ idx: i, value });
        }
      }
    }
  } catch {
  }
  return matches;
}
function _readVarInt(buf: Uint8Array, offset: number): VarIntResult {
  const first = buf[offset];
  if (first < 253) return { value: first, next: offset + 1 };
  if (first === 253) return { value: buf[offset + 1] | buf[offset + 2] << 8, next: offset + 3 };
  if (first === 254) return { value: buf[offset + 1] | buf[offset + 2] << 8 | buf[offset + 3] << 16 | buf[offset + 4] << 24, next: offset + 5 };
  return { value: 0, next: offset + 9 };
}
/** Derive a one-time stealth change address for self (the sender keeps the change private).
 *  Uses the first input UTXO as the ECDH source so the result is unique per TX.
 *  The returned `priv` is the spending key — save it to 00stealth_utxos immediately.
 */
function deriveStealthChange(
  inputPriv: Uint8Array,
  ownKeys: { stealthScanPub: Uint8Array | null; stealthSpendPub: Uint8Array | null; stealthSpendPriv: Uint8Array | null },
  firstUtxo: { txid: string; vout: number },
  outputIndex: number = 1
): SelfStealthResult | null {
  if (!ownKeys.stealthScanPub || !ownKeys.stealthSpendPub || !ownKeys.stealthSpendPriv) return null;
  const outpointBytes = _getOutpointBytes(firstUtxo.txid, firstUtxo.vout);
  return deriveSelfStealth(
    inputPriv,
    ownKeys.stealthScanPub,
    ownKeys.stealthSpendPub,
    ownKeys.stealthSpendPriv,
    outpointBytes,
    outputIndex
  );
}

export {
  checkStealthMatch,
  decodeStealthCode,
  deriveSelfStealth,
  deriveStealthChange,
  deriveStealthSendAddr,
  encodeStealthCode,
  loadStealthUtxos,
  parseRawTxInputs,
  saveStealthUtxo,
  scanForStealthPayments,
  stealthDerive,
  stealthPubToAddr,
  stealthScan,
  stealthSpendingKey
};
