import { secp256k1 } from "../lib/noble-curves.js";
import { sha512 } from "../lib/noble-hashes.js";
import { sha256 } from "../lib/noble-hashes.js";
import { ripemd160 } from "../lib/noble-hashes.js";
const WS_URL = "wss://xrplcluster.com";
function b2h(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function h2b(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}
function concat(...arrs) {
  const len = arrs.reduce((s, a) => s + a.length, 0);
  const r = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    r.set(a, off);
    off += a.length;
  }
  return r;
}
const XRP_ALPHA = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
function xrpBase58Decode(addr) {
  let n = 0n;
  for (const c of addr) {
    const i = XRP_ALPHA.indexOf(c);
    if (i < 0) throw new Error("Invalid XRP address");
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let leading = 0;
  for (const c of addr) {
    if (c === XRP_ALPHA[0]) leading++;
    else break;
  }
  hex = "00".repeat(leading) + hex;
  return h2b(hex).slice(1, 21);
}
function halfSha512(...parts) {
  return sha512(concat(...parts)).slice(0, 32);
}
function fieldId(type, field) {
  if (type < 16 && field < 16) return new Uint8Array([type << 4 | field]);
  if (type >= 16 && field < 16) return new Uint8Array([field, type]);
  if (type < 16 && field >= 16) return new Uint8Array([type << 4, field]);
  return new Uint8Array([0, type, field]);
}
function encU16(type, field, v) {
  const b = new Uint8Array(2);
  b[0] = v >> 8;
  b[1] = v & 255;
  return concat(fieldId(type, field), b);
}
function encU32(type, field, v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return concat(fieldId(type, field), b);
}
function encAmount(type, field, drops) {
  const v = BigInt(drops);
  const hi = Number(v >> 32n & 0x3FFFFFFFn) | 1073741824;
  const lo = Number(v & 0xFFFFFFFFn);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setUint32(0, hi | 1073741824);
  new DataView(b.buffer).setUint32(4, lo);
  b[0] |= 64;
  const encoded = BigInt("0x4000000000000000") | v;
  new DataView(b.buffer).setUint32(0, Number(encoded >> 32n));
  new DataView(b.buffer).setUint32(4, Number(encoded & 0xFFFFFFFFn));
  return concat(fieldId(type, field), b);
}
function encVL(type, field, data) {
  const len = data.length;
  const lb = len < 192 ? new Uint8Array([len]) : new Uint8Array([193 + (len - 193 >> 8), len - 193 & 255]);
  return concat(fieldId(type, field), lb, data);
}
function encAcct(type, field, accountId20) {
  return encVL(type, field, accountId20);
}
function serializeForSigning({ srcAcctId, dstAcctId, amountDrops, feeDrops, sequence, lastLedgerSeq, pubKey33, destinationTag }) {
  const parts = [
    encU16(1, 2, 0),
    // TransactionType = Payment (0)
    encU32(2, 2, 2147483648),
    // Flags = tfFullyCanonicalSig
    encU32(2, 4, sequence)
    // Sequence
  ];
  if (destinationTag !== void 0 && destinationTag !== null && destinationTag !== "") {
    parts.push(encU32(2, 14, parseInt(String(destinationTag))));
  }
  parts.push(
    encU32(2, 27, lastLedgerSeq),
    // LastLedgerSequence
    encAmount(6, 1, amountDrops),
    // Amount
    encAmount(6, 8, feeDrops),
    // Fee
    encVL(7, 3, pubKey33),
    // SigningPubKey
    encAcct(8, 1, srcAcctId),
    // Account
    encAcct(8, 3, dstAcctId)
    // Destination
  );
  return concat(...parts);
}
async function sendXrp({ toAddress, amountDrops, privKey32, fromAddress, destinationTag }) {
  const pubKey33 = secp256k1.getPublicKey(privKey32, true);
  const srcAcctId = ripemd160(sha256(pubKey33));
  const dstAcctId = xrpBase58Decode(toAddress);
  const rpcUrl = window._00ep?.xrp_rpc || WS_URL;
  const acctInfo = await _wsCmd(rpcUrl, { command: "account_info", account: fromAddress, ledger_index: "current" });
  if (acctInfo.result?.error) throw new Error("XRP: " + (acctInfo.result.error_message || acctInfo.result.error));
  const sequence = acctInfo.result?.account_data?.Sequence;
  if (sequence === void 0) throw new Error("Could not get XRP account sequence");
  const ledgerResp = await _wsCmd(rpcUrl, { command: "ledger_current" });
  const currentLedger = ledgerResp.result?.ledger_current_index || 0;
  const feeDrops = 12;
  const lastLedgerSeq = currentLedger + 20;
  const serialized = serializeForSigning({ srcAcctId, dstAcctId, amountDrops, feeDrops, sequence, lastLedgerSeq, pubKey33, destinationTag });
  const STX = new Uint8Array([83, 84, 88, 0]);
  const hash = halfSha512(STX, serialized);
  const sig = secp256k1.sign(hash, privKey32);
  const derSig = sig.toDERRawBytes();
  const signedTx = concat(serialized, encVL(7, 4, derSig));
  const submitResult = await _wsCmd(rpcUrl, { command: "submit", tx_blob: b2h(signedTx).toUpperCase() });
  console.log("[xrp] submit:", JSON.stringify(submitResult).slice(0, 500));
  const er = submitResult.result?.engine_result;
  if (er === "tesSUCCESS" || er?.startsWith("tes") || er === "terQUEUED") {
    return { txid: submitResult.result?.tx_json?.hash || "submitted" };
  }
  throw new Error("XRP: " + (submitResult.result?.engine_result_message || er || submitResult.error_message || submitResult.error || JSON.stringify(submitResult).slice(0, 200)));
}
function _wsCmd(url, cmd) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("XRP timeout"));
    }, 15e3);
    ws.onopen = () => ws.send(JSON.stringify(cmd));
    ws.onmessage = (e) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(e.data));
      } catch {
        reject(new Error("Bad XRP response"));
      }
      ws.close();
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("XRP WS error"));
    };
  });
}
export {
  sendXrp
};
