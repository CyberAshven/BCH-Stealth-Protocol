import { secp256k1 } from "../lib/noble-curves.js";
import { keccak_256 } from "../lib/noble-hashes.js";
import { b2h, h2b, concat } from "./utils.js";
const RPC = "/polygon-rpc/";
const CHAIN_ID = 137;
let _rpcId = 1;
async function rpc(method, params = []) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: _rpcId++ })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}
function toHex(n) {
  return "0x" + (typeof n === "bigint" ? n.toString(16) : Number(n).toString(16));
}
function padHex(hex, bytes) {
  return hex.replace("0x", "").padStart(bytes * 2, "0");
}
function rlpEncode(items) {
  if (items instanceof Uint8Array) {
    if (items.length === 1 && items[0] < 128) return items;
    if (items.length <= 55) return concat(new Uint8Array([128 + items.length]), items);
    const lenBytes = _intToBytes(items.length);
    return concat(new Uint8Array([183 + lenBytes.length]), lenBytes, items);
  }
  if (Array.isArray(items)) {
    const encoded = concat(...items.map((i) => rlpEncode(i)));
    if (encoded.length <= 55) return concat(new Uint8Array([192 + encoded.length]), encoded);
    const lenBytes = _intToBytes(encoded.length);
    return concat(new Uint8Array([247 + lenBytes.length]), lenBytes, encoded);
  }
  return rlpEncode(new Uint8Array(0));
}
function _intToBytes(n) {
  const hex = n.toString(16);
  const padded = hex.length % 2 ? "0" + hex : hex;
  return h2b(padded);
}
function _numToRlpBytes(n) {
  const big = BigInt(n);
  if (big === 0n) return new Uint8Array(0);
  const hex = big.toString(16);
  const padded = hex.length % 2 ? "0" + hex : hex;
  return h2b(padded);
}
function encodeApprove(spender, amount = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") {
  const selector = "095ea7b3";
  const addr = padHex(spender, 32);
  const amt = padHex(amount, 32);
  return "0x" + selector + addr + amt;
}
function encodeAllowance(owner, spender) {
  const selector = "dd62ed3e";
  return "0x" + selector + padHex(owner, 32) + padHex(spender, 32);
}
function encodeBalanceOf(addr) {
  const selector = "70a08231";
  return "0x" + selector + padHex(addr, 32);
}
function encodeSetApprovalForAll(operator, approved = true) {
  const selector = "a22cb465";
  return "0x" + selector + padHex(operator, 32) + padHex(approved ? "1" : "0", 32);
}
function encodeIsApprovedForAll(owner, operator) {
  const selector = "e985e9c5";
  return "0x" + selector + padHex(owner, 32) + padHex(operator, 32);
}
function encodeExactInputSingle(tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMin) {
  const selector = "414bf389";
  return "0x" + selector + padHex(tokenIn, 32) + padHex(tokenOut, 32) + padHex(toHex(fee), 32) + padHex(recipient, 32) + padHex(toHex(deadline), 32) + padHex(toHex(amountIn), 32) + padHex(toHex(amountOutMin), 32) + padHex("0", 32);
}
async function signAndSend(privKeyHex, to, data, value = "0x0", gasLimit = 2e5, opts = {}) {
  const chainId = opts.chainId || CHAIN_ID;
  const rpcUrl = opts.rpc || RPC;
  const _rpcFn = async (method, params = []) => {
    if (rpcUrl === RPC) return rpc(method, params);
    const r2 = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++_rpcId, method, params }) });
    const j = await r2.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  const from = getAddress(privKeyHex);
  const [nonceHex, gasPriceHex] = await Promise.all([
    _rpcFn("eth_getTransactionCount", [from, "pending"]),
    _rpcFn("eth_gasPrice")
  ]);
  const nonce = parseInt(nonceHex, 16);
  const gasPrice = Math.floor(parseInt(gasPriceHex, 16) * 1.5);
  const txFields = [
    _numToRlpBytes(nonce),
    _numToRlpBytes(gasPrice),
    _numToRlpBytes(gasLimit),
    h2b(to.replace("0x", "")),
    _numToRlpBytes(BigInt(value)),
    h2b(data.replace("0x", ""))
  ];
  const sigFields = [...txFields, _numToRlpBytes(chainId), new Uint8Array(0), new Uint8Array(0)];
  const encoded = rlpEncode(sigFields);
  const hash = keccak_256(encoded);
  const sig = secp256k1.sign(hash, h2b(privKeyHex));
  const r = sig.r;
  const s = sig.s;
  const v = sig.recovery + chainId * 2 + 35;
  const signedFields = [
    ...txFields,
    _numToRlpBytes(v),
    _numToRlpBytes(r),
    _numToRlpBytes(s)
  ];
  const rawTx = "0x" + b2h(rlpEncode(signedFields));
  const chainName = { 137: "polygon", 1: "eth", 56: "bnb", 43114: "avax" }[chainId] || chainId;
  console.log(`[evm-tx] broadcasting on ${chainName} from ${from}, nonce=${nonce}, gas=${gasLimit}`);
  const txHash = await _rpcFn("eth_sendRawTransaction", [rawTx]);
  console.log(`[evm-tx] tx sent: ${txHash}`);
  return txHash;
}
async function waitForTx(txHash, timeout = 6e4, opts = {}) {
  const rpcUrl = opts.rpc || RPC;
  const _rpcFn = async (method, params = []) => {
    if (rpcUrl === RPC) return rpc(method, params);
    const r = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++_rpcId, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const receipt = await _rpcFn("eth_getTransactionReceipt", [txHash]);
    if (receipt) {
      return { status: parseInt(receipt.status, 16), gasUsed: parseInt(receipt.gasUsed, 16) };
    }
    await new Promise((r) => setTimeout(r, 3e3));
  }
  throw new Error("TX confirmation timeout");
}
function getAddress(privKeyHex) {
  const pub = secp256k1.getPublicKey(h2b(privKeyHex), false).slice(1);
  const hash = keccak_256(pub);
  return "0x" + b2h(hash.slice(-20));
}
async function checkAllowance(token, owner, spender) {
  const data = encodeAllowance(owner, spender);
  const result = await rpc("eth_call", [{ to: token, data }, "latest"]);
  return BigInt(result || "0x0");
}
async function checkApprovalForAll(token, owner, operator) {
  const data = encodeIsApprovedForAll(owner, operator);
  const result = await rpc("eth_call", [{ to: token, data }, "latest"]);
  return BigInt(result || "0x0") > 0n;
}
async function checkBalance(token, owner) {
  const data = encodeBalanceOf(owner);
  const result = await rpc("eth_call", [{ to: token, data }, "latest"]);
  return BigInt(result || "0x0");
}
async function getPolBalance(addr) {
  const result = await rpc("eth_getBalance", [addr, "latest"]);
  return BigInt(result || "0x0");
}
const CONTRACTS = {
  USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  USDCE: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  CTF: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  EXCHANGE: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  NEG_RISK_EXCHANGE: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  NEG_RISK_ADAPTER: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  SWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564"
};
export {
  CONTRACTS,
  checkAllowance,
  checkApprovalForAll,
  checkBalance,
  encodeAllowance,
  encodeApprove,
  encodeBalanceOf,
  encodeExactInputSingle,
  encodeIsApprovedForAll,
  encodeSetApprovalForAll,
  getAddress,
  getPolBalance,
  rpc,
  signAndSend,
  waitForTx
};
