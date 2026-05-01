import { secp256k1 } from "../lib/noble-curves.js";
import { sha256 } from "../lib/noble-hashes.js";
import { keccak_256 } from "../lib/noble-hashes.js";
const API = "https://api.trongrid.io";
function b2h(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function h2b(hex) {
  hex = hex.replace(/^0x/, "");
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}
function getAddress(privKeyHex) {
  const pub = secp256k1.getPublicKey(h2b(privKeyHex), false).slice(1);
  const hash = keccak_256(pub);
  return "41" + b2h(hash.slice(12));
}
function base58Check(hexAddr) {
  const bytes = h2b(hexAddr);
  const checksum = sha256(sha256(bytes)).slice(0, 4);
  const full = new Uint8Array(bytes.length + 4);
  full.set(bytes);
  full.set(checksum, bytes.length);
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of full) n = n * 256n + BigInt(b);
  let str = "";
  while (n > 0n) {
    str = ALPHABET[Number(n % 58n)] + str;
    n /= 58n;
  }
  for (const b of full) {
    if (b === 0) str = ALPHABET[0] + str;
    else break;
  }
  return str;
}
function base58Decode(addr) {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of addr) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("Invalid base58");
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let leadingZeros = 0;
  for (const c of addr) {
    if (c === "1") leadingZeros++;
    else break;
  }
  hex = "00".repeat(leadingZeros) + hex;
  return hex.slice(0, -8);
}
async function sendTrx({ toAddress, amountSun, privKeyHex }) {
  const fromHex = getAddress(privKeyHex);
  const toHex = base58Decode(toAddress);
  const createResp = await fetch(`${API}/wallet/createtransaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner_address: fromHex,
      to_address: toHex,
      amount: amountSun,
      visible: false
    })
  });
  const tx = await createResp.json();
  if (tx.Error || !tx.txID) throw new Error(tx.Error || "Failed to create transaction");
  const txIdBytes = h2b(tx.txID);
  const sig = secp256k1.sign(txIdBytes, h2b(privKeyHex));
  const r = sig.r.toString(16).padStart(64, "0");
  const s = sig.s.toString(16).padStart(64, "0");
  const v = (sig.recovery + 27).toString(16).padStart(2, "0");
  const signature = r + s + v;
  const broadcastResp = await fetch(`${API}/wallet/broadcasttransaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...tx,
      signature: [signature]
    })
  });
  const result = await broadcastResp.json();
  if (result.result === true) {
    return { txid: tx.txID };
  }
  throw new Error(result.message ? hexToUtf8(result.message) : JSON.stringify(result));
}
async function sendTrc20({ toAddress, amount, contractAddress, privKeyHex, decimals = 6 }) {
  const fromHex = getAddress(privKeyHex);
  const toHex = base58Decode(toAddress);
  const contractHex = base58Decode(contractAddress);
  const selector = "a9059cbb";
  const toParam = toHex.replace(/^41/, "").padStart(64, "0");
  const amountParam = BigInt(amount).toString(16).padStart(64, "0");
  const data = selector + toParam + amountParam;
  const createResp = await fetch(`${API}/wallet/triggersmartcontract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner_address: fromHex,
      contract_address: contractHex,
      function_selector: "transfer(address,uint256)",
      parameter: toParam + amountParam,
      fee_limit: 1e8,
      // 100 TRX max fee
      call_value: 0,
      visible: false
    })
  });
  const resp = await createResp.json();
  if (!resp.transaction?.txID) throw new Error(resp.result?.message ? hexToUtf8(resp.result.message) : "Failed to create TRC-20 tx");
  const tx = resp.transaction;
  const txIdBytes = h2b(tx.txID);
  const sig = secp256k1.sign(txIdBytes, h2b(privKeyHex));
  const r = sig.r.toString(16).padStart(64, "0");
  const s = sig.s.toString(16).padStart(64, "0");
  const v = (sig.recovery + 27).toString(16).padStart(2, "0");
  const broadcastResp = await fetch(`${API}/wallet/broadcasttransaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...tx, signature: [r + s + v] })
  });
  const result = await broadcastResp.json();
  if (result.result === true) return { txid: tx.txID };
  throw new Error(result.message ? hexToUtf8(result.message) : JSON.stringify(result));
}
function hexToUtf8(hex) {
  try {
    return decodeURIComponent(hex.replace(/[0-9a-f]{2}/g, "%$&"));
  } catch {
    return hex;
  }
}
export {
  getAddress,
  sendTrc20,
  sendTrx
};
