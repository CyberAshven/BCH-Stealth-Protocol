import { ed25519 } from "../lib/noble-curves.js";
const RPC = "/sol-rpc/";
const SYSTEM_PROGRAM = new Uint8Array(32);
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
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58MAP = new Uint8Array(128);
for (let i = 0; i < B58.length; i++) B58MAP[B58.charCodeAt(i)] = i;
function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let str = "";
  while (n > 0n) {
    str = B58[Number(n % 58n)] + str;
    n = n / 58n;
  }
  for (const b of bytes) {
    if (b === 0) str = "1" + str;
    else break;
  }
  return str || "1";
}
function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58MAP[c.charCodeAt(0)];
    if (i === void 0) throw new Error("Invalid base58 character");
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16).padStart(2, "0");
  const raw = new Uint8Array(hex.length + 1 >> 1);
  for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.substr(i * 2, 2), 16);
  let leadingZeros = 0;
  for (const c of str) {
    if (c === "1") leadingZeros++;
    else break;
  }
  if (leadingZeros > 0) {
    const padded = new Uint8Array(leadingZeros + raw.length);
    padded.set(raw, leadingZeros);
    return padded;
  }
  return raw;
}
function encodeCompactU16(len) {
  if (len < 128) return new Uint8Array([len]);
  if (len < 16384) return new Uint8Array([
    len & 127 | 128,
    len >> 7 & 127
  ]);
  return new Uint8Array([
    len & 127 | 128,
    len >> 7 & 127 | 128,
    len >> 14 & 3
  ]);
}
function leU64(n) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  const bn = BigInt(n);
  view.setUint32(0, Number(bn & 0xFFFFFFFFn), true);
  view.setUint32(4, Number(bn >> 32n), true);
  return new Uint8Array(buf);
}
async function rpc(method, params = []) {
  const resp = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}
async function sendSol({ toAddress, amountLamports, privKey32 }) {
  const pubKey = ed25519.getPublicKey(privKey32.slice(0, 32));
  const toPubKey = base58Decode(toAddress);
  if (toPubKey.length !== 32) throw new Error("Invalid destination address");
  const bhResult = await rpc("getLatestBlockhash", [{ commitment: "finalized" }]);
  const blockhashB58 = bhResult.value.blockhash;
  const blockhashBytes = base58Decode(blockhashB58);
  const numRequiredSignatures = 1;
  const numReadonlySignedAccounts = 0;
  const numReadonlyUnsignedAccounts = 1;
  const header = new Uint8Array([numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts]);
  const accountKeys = concat(pubKey, toPubKey, SYSTEM_PROGRAM);
  const ixProgramIdIndex = new Uint8Array([2]);
  const ixAccountIndices = concat(encodeCompactU16(2), new Uint8Array([0, 1]));
  const transferIxType = new Uint8Array([2, 0, 0, 0]);
  const transferData = concat(transferIxType, leU64(amountLamports));
  const ixData = concat(encodeCompactU16(transferData.length), transferData);
  const instruction = concat(ixProgramIdIndex, ixAccountIndices, ixData);
  const message = concat(
    header,
    // 3 bytes
    encodeCompactU16(3),
    // num account keys = 3
    accountKeys,
    // 3 x 32 = 96 bytes
    blockhashBytes,
    // 32 bytes
    encodeCompactU16(1),
    // num instructions = 1
    instruction
    // the transfer instruction
  );
  const signature = ed25519.sign(message, privKey32.slice(0, 32));
  const tx = concat(
    encodeCompactU16(1),
    // num signatures = 1
    signature,
    // 64 bytes
    message
    // the message
  );
  const txBase64 = btoa(String.fromCharCode(...tx));
  const txid = await rpc("sendTransaction", [txBase64, { encoding: "base64", preflightCommitment: "confirmed" }]);
  return { txid };
}
export {
  sendSol
};
