import { secp256k1 } from "../lib/noble-curves.js";
import { keccak_256 } from "../lib/noble-hashes.js";
import { b2h, h2b, concat, rand } from "./utils.js";
const CLOB_BASE = "/clob-tor";
const CHAIN_ID = 137;
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const SIDE_BUY = 0;
const SIDE_SELL = 1;
const SIG_TYPE_EOA = 0;
const CREDS_KEY = "00_poly_api_creds";
function checksumAddress(addrHex) {
  const raw = addrHex.replace("0x", "").toLowerCase();
  const hashHex = b2h(keccak_256(new TextEncoder().encode(raw)));
  let cs = "0x";
  for (let i = 0; i < 40; i++) {
    cs += parseInt(hashHex[i], 16) >= 8 ? raw[i].toUpperCase() : raw[i];
  }
  return cs;
}
function addressFromPriv(privHex) {
  const pub = secp256k1.getPublicKey(h2b(privHex), false).slice(1);
  const hash = keccak_256(pub);
  return checksumAddress(b2h(hash.slice(-20)));
}
function pad32(hex) {
  return hex.replace("0x", "").padStart(64, "0");
}
function bigToBytes32(n) {
  const hex = n.toString(16).padStart(64, "0");
  return h2b(hex);
}
function randomSalt() {
  const bytes = rand(4);
  return (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
}
function abiEncodeField(type, value) {
  if (type === "address") {
    return h2b(pad32(value.replace("0x", "")));
  }
  if (type === "string") {
    return keccak_256(new TextEncoder().encode(value));
  }
  if (type === "bytes") {
    const raw = typeof value === "string" ? h2b(value.replace("0x", "")) : value;
    return keccak_256(raw);
  }
  if (type === "bool") {
    return bigToBytes32(value ? 1n : 0n);
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    return bigToBytes32(BigInt(value));
  }
  if (type.startsWith("bytes") && type.length > 5) {
    const raw = typeof value === "string" ? h2b(value.replace("0x", "")) : value;
    const out = new Uint8Array(32);
    out.set(raw);
    return out;
  }
  throw new Error(`EIP-712: unsupported type "${type}"`);
}
function typeHash(typeString) {
  return keccak_256(new TextEncoder().encode(typeString));
}
function hashStruct(typeStr, types, values) {
  const parts = [typeHash(typeStr)];
  for (let i = 0; i < types.length; i++) {
    parts.push(abiEncodeField(types[i], values[i]));
  }
  return keccak_256(concat(...parts));
}
function hashDomain(domain) {
  const dtypes = [];
  const dvals = [];
  const dfields = [];
  if (domain.name !== void 0) {
    dfields.push("string name");
    dtypes.push("string");
    dvals.push(domain.name);
  }
  if (domain.version !== void 0) {
    dfields.push("string version");
    dtypes.push("string");
    dvals.push(domain.version);
  }
  if (domain.chainId !== void 0) {
    dfields.push("uint256 chainId");
    dtypes.push("uint256");
    dvals.push(domain.chainId);
  }
  if (domain.verifyingContract !== void 0) {
    dfields.push("address verifyingContract");
    dtypes.push("address");
    dvals.push(domain.verifyingContract);
  }
  if (domain.salt !== void 0) {
    dfields.push("bytes32 salt");
    dtypes.push("bytes32");
    dvals.push(domain.salt);
  }
  const domainTypeStr = "EIP712Domain(" + dfields.join(",") + ")";
  return hashStruct(domainTypeStr, dtypes, dvals);
}
function signTypedData(domain, primaryTypeStr, types, values, privKeyBytes) {
  const domainSep = hashDomain(domain);
  const structHash = hashStruct(primaryTypeStr, types, values);
  const digest = keccak_256(concat(
    new Uint8Array([25, 1]),
    domainSep,
    structHash
  ));
  const sig = secp256k1.sign(digest, privKeyBytes);
  const rBytes = bigToBytes32(sig.r);
  const sBytes = bigToBytes32(sig.s);
  const v = sig.recovery + 27;
  const signature = concat(rBytes, sBytes, new Uint8Array([v]));
  return { signature: "0x" + b2h(signature), v, r: sig.r, s: sig.s };
}
const CLOB_AUTH_DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: CHAIN_ID
};
const CLOB_AUTH_TYPE_STR = "ClobAuth(address address,string timestamp,uint256 nonce,string message)";
const CLOB_AUTH_TYPES = ["address", "string", "uint256", "string"];
const MSG_TO_SIGN = "This message attests that I control the given wallet";
async function deriveApiKey(privKeyHex) {
  const privBytes = h2b(privKeyHex);
  const address = addressFromPriv(privKeyHex);
  const timestamp = String(Math.floor(Date.now() / 1e3));
  const nonce = 0n;
  const { signature } = signTypedData(
    CLOB_AUTH_DOMAIN,
    CLOB_AUTH_TYPE_STR,
    CLOB_AUTH_TYPES,
    [address, timestamp, nonce, MSG_TO_SIGN],
    privBytes
  );
  const l1Headers = {
    "POLY_ADDRESS": address,
    "POLY_SIGNATURE": signature,
    "POLY_TIMESTAMP": timestamp,
    "POLY_NONCE": "0"
  };
  try {
    const createResp = await fetch(`${CLOB_BASE}/auth/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...l1Headers }
    });
    if (createResp.ok) {
      const creds = await createResp.json();
      if (creds.apiKey) return creds;
    }
  } catch {
  }
  const deriveResp = await fetch(`${CLOB_BASE}/auth/derive-api-key`, {
    method: "GET",
    headers: l1Headers
  });
  if (!deriveResp.ok) {
    const text = await deriveResp.text();
    throw new Error(`CLOB auth failed (${deriveResp.status}): ${text}`);
  }
  return deriveResp.json();
}
async function buildHmacSignature(secret, timestamp, method, requestPath, body = "") {
  let message = String(timestamp) + String(method) + String(requestPath);
  if (body) message += body;
  const b64 = secret.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  const keyBytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_");
}
async function buildHeaders(method, path, body = "") {
  const creds = getApiCreds();
  if (!creds) throw new Error("CLOB: not initialized \u2014 call initClob() first");
  const address = _address || creds.address;
  if (!address) throw new Error("CLOB: no address \u2014 call initClob() first");
  const timestamp = String(Math.floor(Date.now() / 1e3));
  const signature = await buildHmacSignature(creds.secret, timestamp, method, path, body);
  return {
    "Content-Type": "application/json",
    "POLY_ADDRESS": address,
    "POLY_SIGNATURE": signature,
    "POLY_TIMESTAMP": timestamp,
    "POLY_API_KEY": creds.apiKey,
    "POLY_PASSPHRASE": creds.passphrase
  };
}
async function clobFetch(method, path, body = null) {
  const bodyStr = body ? JSON.stringify(body).replace(/\s+/g, "") : "";
  const headers = await buildHeaders(method, path, bodyStr);
  const resp = await fetch(`${CLOB_BASE}${path}`, {
    method,
    headers,
    body: bodyStr || void 0
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[clob] ${method} ${path} \u2192 ${resp.status}`, text);
    console.error(`[clob] request body:`, bodyStr);
    throw new Error(`CLOB ${method} ${path} failed (${resp.status}): ${text}`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return resp.json();
  return resp.text();
}
const ORDER_TYPE_STR = "Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)";
const ORDER_TYPES = [
  "uint256",
  // salt
  "address",
  // maker
  "address",
  // signer
  "address",
  // taker
  "uint256",
  // tokenId
  "uint256",
  // makerAmount
  "uint256",
  // takerAmount
  "uint256",
  // expiration
  "uint256",
  // nonce
  "uint256",
  // feeRateBps
  "uint8",
  // side
  "uint8"
  // signatureType
];
function orderDomain(exchangeAddr) {
  return {
    name: "Polymarket CTF Exchange",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: exchangeAddr
  };
}
function signOrder(params) {
  const {
    tokenId,
    makerAmount,
    takerAmount,
    side = SIDE_BUY,
    feeRateBps = 0,
    negRisk = true,
    expiration = 0
  } = params;
  if (!_privKey) throw new Error("CLOB: not initialized \u2014 call initClob() first");
  const exchange = negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE;
  const salt = randomSalt();
  const orderValues = [
    BigInt(salt),
    // salt (uint256 for signing)
    _address,
    // maker
    _address,
    // signer (same as maker for EOA)
    "0x0000000000000000000000000000000000000000",
    // taker (public order)
    BigInt(tokenId),
    // tokenId
    BigInt(makerAmount),
    // makerAmount
    BigInt(takerAmount),
    // takerAmount
    BigInt(expiration),
    // expiration
    0n,
    // nonce (0 for new orders)
    BigInt(feeRateBps),
    // feeRateBps
    BigInt(side),
    // side
    BigInt(SIG_TYPE_EOA)
    // signatureType
  ];
  const domSep = hashDomain(orderDomain(exchange));
  const structH = hashStruct(ORDER_TYPE_STR, ORDER_TYPES, orderValues);
  const typeH = keccak_256(new TextEncoder().encode(ORDER_TYPE_STR));
  const digest = keccak_256(concat(new Uint8Array([25, 1]), domSep, structH));
  const { signature } = signTypedData(
    orderDomain(exchange),
    ORDER_TYPE_STR,
    ORDER_TYPES,
    orderValues,
    _privKey
  );
  const order = {
    salt: Number(salt),
    // number, not string
    maker: _address,
    signer: _address,
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: tokenId.toString(),
    makerAmount: makerAmount.toString(),
    takerAmount: takerAmount.toString(),
    expiration: String(expiration),
    nonce: "0",
    feeRateBps: String(feeRateBps),
    side: side === SIDE_BUY ? "BUY" : "SELL",
    // string "BUY"/"SELL"
    signatureType: SIG_TYPE_EOA
    // number, not string
  };
  return { order, signature };
}
let _privKey = null;
let _address = null;
async function initClob(privKeyHex) {
  const cleanHex = privKeyHex.replace("0x", "");
  _privKey = h2b(cleanHex);
  _address = addressFromPriv(cleanHex);
  const existing = getApiCreds();
  if (existing) {
    if (!existing.address) {
      existing.address = _address;
      localStorage.setItem(CREDS_KEY, JSON.stringify(existing));
    }
    return existing;
  }
  const creds = await deriveApiKey(cleanHex);
  creds.address = _address;
  localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
  return creds;
}
async function placeOrder(params) {
  const {
    tokenId,
    makerAmount,
    takerAmount,
    side = SIDE_BUY,
    orderType = "GTC",
    feeRateBps = 0,
    negRisk = true,
    expiration = 0
  } = params;
  const { order, signature } = signOrder({
    tokenId,
    makerAmount: BigInt(makerAmount),
    takerAmount: BigInt(takerAmount),
    side,
    feeRateBps,
    negRisk,
    expiration
  });
  order.signature = signature;
  const creds = getApiCreds();
  const payload = {
    order,
    owner: creds?.apiKey || _address,
    // owner = API key
    orderType,
    postOnly: false
  };
  return clobFetch("POST", "/order", payload);
}
async function placeBuyOrder(tokenId, amount, price, opts = {}) {
  const {
    negRisk = true,
    feeRateBps = 1e3,
    // 10% maker fee (Polymarket default for crypto markets)
    orderType = "GTC"
  } = opts;
  const roundedPrice = Math.round(price * 100) / 100;
  const rawSize = Math.floor(amount / roundedPrice * 100) / 100;
  const rawMaker = rawSize * roundedPrice;
  const makerAmount = BigInt(Math.round(rawMaker * 1e6));
  const takerAmount = BigInt(Math.round(rawSize * 1e6));
  return placeOrder({
    tokenId,
    makerAmount,
    takerAmount,
    side: SIDE_BUY,
    orderType,
    feeRateBps,
    negRisk
  });
}
async function placeSellOrder(tokenId, amount, price, opts = {}) {
  const {
    negRisk = true,
    feeRateBps = 0,
    orderType = "GTC"
  } = opts;
  const makerAmount = BigInt(Math.round(amount * 1e6));
  const takerAmount = BigInt(Math.round(amount * price * 1e6));
  return placeOrder({
    tokenId,
    makerAmount,
    takerAmount,
    side: SIDE_SELL,
    orderType,
    feeRateBps,
    negRisk
  });
}
async function cancelOrder(orderId) {
  return clobFetch("DELETE", `/order/${orderId}`);
}
async function getOpenOrders() {
  return clobFetch("GET", "/data/orders");
}
async function getTrades() {
  return clobFetch("GET", "/trades");
}
async function getServerTime() {
  const resp = await fetch(`${CLOB_BASE}/data/time`);
  return resp.json();
}
function getApiCreds() {
  try {
    const raw = localStorage.getItem(CREDS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function clearCreds() {
  localStorage.removeItem(CREDS_KEY);
  _privKey = null;
  _address = null;
}
function getAddress() {
  return _address;
}
export {
  CHAIN_ID,
  CTF_EXCHANGE,
  NEG_RISK_ADAPTER,
  NEG_RISK_EXCHANGE,
  SIDE_BUY,
  SIDE_SELL,
  USDC_E,
  cancelOrder,
  clearCreds,
  getAddress,
  getApiCreds,
  getOpenOrders,
  getServerTime,
  getTrades,
  initClob,
  placeBuyOrder,
  placeOrder,
  placeSellOrder
};
