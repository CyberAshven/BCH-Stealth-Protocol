import { secp256k1 } from "../lib/noble-curves.js";
import { sha256 } from "../lib/noble-hashes.js";
import { ripemd160 } from "../lib/noble-hashes.js";
import { concat, b2h, h2b } from "./utils.js";
import { pubHashToCashAddr } from "./cashaddr.js";
const N_SECP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
function _compareBytes(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function _u32LE(v) {
  return new Uint8Array([v & 255, v >> 8 & 255, v >> 16 & 255, v >> 24 & 255]);
}
function stealthDerive(senderPriv, recipScanPub, recipSpendPub, tweakData) {
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
function stealthScan(scanPriv, senderPub, spendPub, tweakData) {
  const sharedPoint = secp256k1.getSharedSecret(scanPriv, senderPub);
  const sharedX = sharedPoint.slice(1, 33);
  const c = sha256(concat(sha256(sharedX), tweakData));
  const cBig = BigInt("0x" + b2h(c)) % N_SECP;
  const spendPoint = secp256k1.ProjectivePoint.fromHex(spendPub);
  const tweakPoint = secp256k1.ProjectivePoint.BASE.multiply(cBig);
  const stealthPoint = spendPoint.add(tweakPoint);
  return { pub: stealthPoint.toRawBytes(true), cBig };
}
function stealthSpendingKey(spendPriv, cBig) {
  const bBig = BigInt("0x" + b2h(spendPriv));
  return h2b(((bBig + cBig) % N_SECP).toString(16).padStart(64, "0"));
}
function stealthPubToAddr(stealthPub) {
  const hash = ripemd160(sha256(stealthPub));
  return pubHashToCashAddr(hash);
}
function encodeStealthCode(scanPub, spendPub) {
  return "stealth:" + b2h(scanPub) + b2h(spendPub);
}
function decodeStealthCode(code) {
  const hex = code.replace(/^stealth:/, "");
  if (hex.length !== 132) throw new Error("invalid stealth code length");
  return {
    scanPub: h2b(hex.slice(0, 66)),
    spendPub: h2b(hex.slice(66, 132))
  };
}
function checkStealthMatch(scanPriv, spendPub, senderInputPub, outputHash160, tweakData) {
  const { pub } = stealthScan(scanPriv, senderInputPub, spendPub, tweakData);
  const expectedHash = ripemd160(sha256(pub));
  return b2h(expectedHash) === b2h(outputHash160);
}
function deriveSelfStealth(inputPriv, scanPub, spendPub, spendPriv, outpoint, outputIdx) {
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
function saveStealthUtxo(addr, priv, pub, source = "fusion") {
  const existing = JSON.parse(localStorage.getItem("00stealth_utxos") || "[]");
  if (existing.some((u) => u.addr === addr)) return;
  existing.push({
    addr,
    priv: priv instanceof Uint8Array ? b2h(priv) : priv,
    pub: pub instanceof Uint8Array ? b2h(pub) : pub,
    from: source,
    ts: Math.floor(Date.now() / 1e3)
  });
  localStorage.setItem("00stealth_utxos", JSON.stringify(existing));
}
function loadStealthUtxos() {
  return JSON.parse(localStorage.getItem("00stealth_utxos") || "[]");
}
function deriveStealthSendAddr(recipScanPub, recipSpendPub, senderPrivKeys, outpoints, outputIndex = 0) {
  let privKeysArr = Array.isArray(senderPrivKeys) ? senderPrivKeys : [senderPrivKeys];
  if (!outpoints || outpoints.length === 0) {
    const senderPrivKey = typeof privKeysArr[0] === "string" ? h2b(privKeysArr[0]) : privKeysArr[0];
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
  let a_sum = 0n;
  for (const priv of privKeysArr) {
    const privBytes = typeof priv === "string" ? h2b(priv) : priv;
    a_sum = (a_sum + BigInt("0x" + b2h(privBytes))) % N_SECP;
  }
  const a_sum_bytes = h2b(a_sum.toString(16).padStart(64, "0"));
  const A_sum = secp256k1.getPublicKey(a_sum_bytes, true);
  let smallest = null;
  for (const op of outpoints) {
    const txidHex = typeof op.txid === "string" ? op.txid : b2h(op.txid);
    const txidLE = h2b(txidHex).reverse();
    const vout = op.vout || 0;
    const outpoint = concat(txidLE, _u32LE(vout));
    if (!smallest || _compareBytes(outpoint, smallest) < 0) smallest = outpoint;
  }
  if (!smallest) throw new Error("No outpoints provided for stealth address computation");
  const input_hash = sha256(concat(smallest, A_sum));
  const input_hash_big = BigInt("0x" + b2h(input_hash)) % N_SECP;
  const tweaked_a = a_sum * input_hash_big % N_SECP;
  const tweaked_a_bytes = h2b(tweaked_a.toString(16).padStart(64, "0"));
  const shared = secp256k1.getSharedSecret(tweaked_a_bytes, recipScanPub);
  const sharedX = shared.slice(1, 33);
  const t = sha256(concat(sharedX, _u32LE(outputIndex)));
  const tBig = BigInt("0x" + b2h(t)) % N_SECP;
  const spendPoint = secp256k1.ProjectivePoint.fromHex(recipSpendPub);
  const stealthPoint = spendPoint.add(secp256k1.ProjectivePoint.BASE.multiply(tBig));
  const stealthPubBytes = stealthPoint.toRawBytes(true);
  const addr = pubHashToCashAddr(ripemd160(sha256(stealthPubBytes)));
  return { addr, pub: stealthPubBytes, A_sum };
}
async function scanForStealthPayments(keys, entries) {
  const scanPrivHex = keys.stealthScanPriv;
  const spendPubHex = keys.stealthSpendPub;
  if (!scanPrivHex || !spendPubHex) return [];
  const scanPriv = typeof scanPrivHex === "string" ? h2b(scanPrivHex) : scanPrivHex;
  const spendPub = typeof spendPubHex === "string" ? h2b(spendPubHex) : spendPubHex;
  const scanPrivBig = BigInt("0x" + b2h(scanPriv)) % N_SECP;
  const txMap = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (!e.pubkey || !e.txid) continue;
    if (!txMap.has(e.txid)) txMap.set(e.txid, []);
    txMap.get(e.txid).push(e);
  }
  const found = [];
  for (const [txid, inputs] of txMap) {
    const hasOutpoints = inputs.some((inp) => inp.outpointTxid != null);
    if (!hasOutpoints) {
      let rawHex2;
      try {
        rawHex2 = await window._fvCall("blockchain.transaction.get", [txid]);
      } catch {
        continue;
      }
      if (!rawHex2) continue;
      const seenPubs = /* @__PURE__ */ new Set();
      for (const inp of inputs) {
        const pubHex = typeof inp.pubkey === "string" ? inp.pubkey : b2h(inp.pubkey);
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
    let A_sum = null;
    for (const inp of inputs) {
      const pubHex = typeof inp.pubkey === "string" ? inp.pubkey : b2h(inp.pubkey);
      try {
        const pt = secp256k1.ProjectivePoint.fromHex(pubHex);
        A_sum = A_sum ? A_sum.add(pt) : pt;
      } catch {
        continue;
      }
    }
    if (!A_sum) continue;
    const A_sum_bytes = A_sum.toRawBytes(true);
    let smallest = null;
    for (const inp of inputs) {
      if (inp.outpointTxid == null) continue;
      const txidHex = typeof inp.outpointTxid === "string" ? inp.outpointTxid : b2h(inp.outpointTxid);
      const txidLE = h2b(txidHex).reverse();
      const outpoint = concat(txidLE, _u32LE(inp.outpointVout || 0));
      if (!smallest || _compareBytes(outpoint, smallest) < 0) smallest = outpoint;
    }
    if (!smallest) continue;
    const input_hash = sha256(concat(smallest, A_sum_bytes));
    const input_hash_big = BigInt("0x" + b2h(input_hash)) % N_SECP;
    const tweakedScanPrivBig = scanPrivBig * input_hash_big % N_SECP;
    const tweakedScanPriv = h2b(tweakedScanPrivBig.toString(16).padStart(64, "0"));
    const shared = secp256k1.getSharedSecret(tweakedScanPriv, A_sum_bytes);
    const sharedX = shared.slice(1, 33);
    let rawHex;
    try {
      rawHex = await window._fvCall("blockchain.transaction.get", [txid]);
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
function parseRawTxInputs(rawHex, txid) {
  const results = [];
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
function _matchOutputs(rawHex, targetHash160) {
  const matches = [];
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
function _readVarInt(buf, offset) {
  const first = buf[offset];
  if (first < 253) return { value: first, next: offset + 1 };
  if (first === 253) return { value: buf[offset + 1] | buf[offset + 2] << 8, next: offset + 3 };
  if (first === 254) return { value: buf[offset + 1] | buf[offset + 2] << 8 | buf[offset + 3] << 16 | buf[offset + 4] << 24, next: offset + 5 };
  return { value: 0, next: offset + 9 };
}
export {
  checkStealthMatch,
  decodeStealthCode,
  deriveSelfStealth,
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
