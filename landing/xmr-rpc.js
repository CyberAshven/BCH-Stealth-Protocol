import {
  b2h,
  h2b,
  concat,
  mod,
  keccak256,
  scReduce32,
  bigIntToBytes32LE,
  L_ED
} from "./xmr-swap-crypto.js";
import { ed25519 } from "./lib/noble-curves.js";
const G_ED = ed25519.ExtendedPoint.BASE;
const XMR_NODES = [
  // Our CORS proxy (primary)
  { url: "/xmr-rpc", name: "00-proxy", cors: true },
  // Public nodes (need CORS proxy)
  { url: "https://node.moneroworld.com:18089", name: "moneroworld", cors: false },
  { url: "https://xmr-node.cakewallet.com:18081", name: "cakewallet", cors: false },
  { url: "https://nodes.hashvault.pro:18081", name: "hashvault", cors: false }
];
let _activeNode = XMR_NODES[0];
let _connected = false;
async function daemonRpc(method, params = {}) {
  const url = _activeNode.url + "/json_rpc";
  const body = {
    jsonrpc: "2.0",
    id: "0",
    method,
    params
  };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3e4);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: ac.signal
  });
  clearTimeout(t);
  if (!resp.ok) throw new Error(`XMR RPC error: ${resp.status} ${resp.statusText}`);
  const json = await resp.json();
  if (json.error) throw new Error(`XMR RPC: ${json.error.message}`);
  return json.result;
}
async function daemonOther(endpoint, params = {}) {
  const url = _activeNode.url + "/" + endpoint;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 45e3);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: ac.signal
  });
  clearTimeout(t);
  if (!resp.ok) throw new Error(`XMR RPC error: ${resp.status}`);
  return resp.json();
}
async function getInfo() {
  return daemonRpc("get_info");
}
async function getBlockCount() {
  const r = await daemonRpc("get_block_count");
  return r.count;
}
async function getBlockHeaderByHeight(height) {
  const r = await daemonRpc("get_block_header_by_height", { height });
  return r.block_header;
}
async function getBlock(height) {
  const r = await daemonRpc("get_block", { height });
  return r;
}
async function getBlockByHash(hash) {
  const r = await daemonRpc("get_block", { hash });
  return r;
}
async function getTransactions(txHashes, decodeAsJson = true) {
  return daemonOther("get_transactions", {
    txs_hashes: txHashes,
    decode_as_json: decodeAsJson
  });
}
async function getTransactionPool() {
  return daemonOther("get_transaction_pool", {});
}
async function isKeyImageSpent(keyImages) {
  return daemonOther("is_key_image_spent", { key_images: keyImages });
}
async function getOutputDistribution(amounts = [0], fromHeight = 0) {
  return daemonRpc("get_output_distribution", {
    amounts,
    from_height: fromHeight,
    cumulative: true
  });
}
function hashToScalar(data) {
  const hash = keccak256(data);
  return scReduce32(hash);
}
function derivationToScalar(sharedSecret, outputIndex) {
  const viBytes = varintEncode(outputIndex);
  const data = concat(sharedSecret, viBytes);
  return hashToScalar(data);
}
function deriveOutputPubKey(sharedSecret, outputIndex, spendPub) {
  const scalar = derivationToScalar(sharedSecret, outputIndex);
  let sN = 0n;
  for (let i = 31; i >= 0; i--) sN = sN << 8n | BigInt(scalar[i]);
  const hPoint = G_ED.multiply(sN);
  const B = ed25519.ExtendedPoint.fromHex(spendPub);
  const P = hPoint.add(B);
  return new Uint8Array(P.toRawBytes());
}
function deriveOutputPrivKey(sharedSecret, outputIndex, spendPriv) {
  const scalar = derivationToScalar(sharedSecret, outputIndex);
  let sN = 0n;
  for (let i = 31; i >= 0; i--) sN = sN << 8n | BigInt(scalar[i]);
  const x = mod(sN + spendPriv, L_ED);
  return bigIntToBytes32LE(x);
}
function computeSharedSecret(viewPriv, txPubKey) {
  const R = ed25519.ExtendedPoint.fromHex(txPubKey);
  let a = viewPriv;
  if (viewPriv instanceof Uint8Array || Array.isArray(viewPriv)) {
    a = 0n;
    for (let i = 31; i >= 0; i--) a = a << 8n | BigInt(viewPriv[i]);
  }
  const shared = R.multiply(a).multiply(8n);
  return new Uint8Array(shared.toRawBytes());
}
function computeKeyImage(outputPrivKey, outputPubKey) {
  const hp = hashToPoint(outputPubKey);
  let xN = 0n;
  for (let i = 31; i >= 0; i--) xN = xN << 8n | BigInt(outputPrivKey[i]);
  const I = hp.multiply(xN);
  return new Uint8Array(I.toRawBytes());
}
function hashToPoint(data) {
  let counter = 0;
  while (counter < 256) {
    const hash = keccak256(concat(data, new Uint8Array([counter])));
    try {
      const p = ed25519.ExtendedPoint.fromHex(hash);
      return p.multiply(8n);
    } catch (e) {
      counter++;
    }
  }
  throw new Error("hashToPoint: failed to find valid point");
}
function decryptAmount(encryptedAmount, sharedSecret, outputIndex) {
  const derivScalar = derivationToScalar(sharedSecret, outputIndex);
  const amountKey = keccak256(concat(new TextEncoder().encode("amount"), derivScalar));
  const decrypted = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    decrypted[i] = encryptedAmount[i] ^ amountKey[i];
  }
  let amount = 0n;
  for (let i = 7; i >= 0; i--) amount = amount << 8n | BigInt(decrypted[i]);
  return amount;
}
function parseTxExtra(extra) {
  let txPubKey = null;
  const additionalPubKeys = [];
  let i = 0;
  while (i < extra.length) {
    const tag = extra[i++];
    if (tag === 1) {
      if (i + 32 <= extra.length) {
        txPubKey = extra.slice(i, i + 32);
        i += 32;
      } else break;
    } else if (tag === 2) {
      if (i >= extra.length) break;
      const len = extra[i++];
      i += len;
    } else if (tag === 4) {
      if (i >= extra.length) break;
      const count = extra[i++];
      for (let j = 0; j < count && i + 32 <= extra.length; j++) {
        additionalPubKeys.push(extra.slice(i, i + 32));
        i += 32;
      }
    } else {
      if (i + 32 <= extra.length) {
        i += 32;
      } else break;
    }
  }
  return { txPubKey, additionalPubKeys };
}
function scanTransaction(txJson, viewPriv, spendPub) {
  const found = [];
  const extraBytes = new Uint8Array(txJson.extra || []);
  const { txPubKey, additionalPubKeys } = parseTxExtra(extraBytes);
  if (!txPubKey) return { outputs: found };
  let sharedSecret;
  try {
    sharedSecret = computeSharedSecret(viewPriv, txPubKey);
  } catch (e) {
    return { outputs: found };
  }
  const outputs = txJson.vout || [];
  const ecdhInfo = txJson.rct_signatures ? txJson.rct_signatures.ecdhInfo : null;
  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    const outputKey = h2b(out.target && out.target.tagged_key ? out.target.tagged_key.key : out.target && out.target.key ? out.target.key : "");
    if (outputKey.length !== 32) continue;
    let ss = sharedSecret;
    if (additionalPubKeys.length > i) {
      try {
        ss = computeSharedSecret(viewPriv, additionalPubKeys[i]);
      } catch (e) {
        continue;
      }
    }
    const expectedKey = deriveOutputPubKey(ss, i, spendPub);
    if (b2h(expectedKey) === b2h(outputKey)) {
      let amount = 0n;
      if (ecdhInfo && ecdhInfo[i]) {
        const encAmount = h2b(ecdhInfo[i].amount || "0000000000000000");
        if (encAmount.length >= 8) {
          amount = decryptAmount(encAmount.slice(0, 8), ss, i);
        }
      }
      if (amount === 0n && out.amount) {
        amount = BigInt(out.amount);
      }
      found.push({
        index: i,
        amount,
        outputKey: b2h(outputKey),
        txPubKey: b2h(txPubKey)
      });
    }
  }
  return { outputs: found };
}
async function scanBlocks(viewPriv, spendPub, fromHeight, toHeight, onProgress) {
  const allFound = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let bh = fromHeight; bh <= toHeight; bh++) {
    let txHashes = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const block = await getBlock(bh);
        const blockJson = JSON.parse(block.json);
        txHashes = blockJson.tx_hashes || [];
        break;
      } catch (e) {
        if (attempt < 2) await delay(1e3);
        else console.warn("[XMR] block", bh, "failed:", e.message);
      }
    }
    for (let ti = 0; ti < txHashes.length; ti += 10) {
      const chunk = txHashes.slice(ti, ti + 10);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const txData = await getTransactions(chunk);
          if (txData.txs) {
            for (const tx of txData.txs) {
              if (!tx.as_json) continue;
              try {
                const txJson = JSON.parse(tx.as_json);
                const result = scanTransaction(txJson, viewPriv, spendPub);
                for (const out of result.outputs) {
                  allFound.push({ ...out, txHash: tx.tx_hash, blockHeight: bh, confirmations: toHeight - bh });
                }
              } catch (e) {
              }
            }
          }
          break;
        } catch (e) {
          if (attempt < 2) await delay(500);
          else console.warn("[XMR] TXs block", bh, "chunk", ti, "failed:", e.message);
        }
      }
    }
    if (onProgress) onProgress(bh - fromHeight, toHeight - fromHeight);
  }
  return allFound;
}
async function scanSingleTx(txHash, viewPriv, spendPub) {
  const txData = await getTransactions([txHash]);
  if (!txData.txs || txData.txs.length === 0) {
    return { found: false, outputs: [], confirmations: 0 };
  }
  const tx = txData.txs[0];
  const confirmations = tx.block_height ? await getBlockCount() - tx.block_height : 0;
  if (!tx.as_json) return { found: false, outputs: [], confirmations };
  const txJson = JSON.parse(tx.as_json);
  const result = scanTransaction(txJson, viewPriv, spendPub);
  return {
    found: result.outputs.length > 0,
    outputs: result.outputs,
    confirmations,
    blockHeight: tx.block_height || null,
    inPool: !tx.block_height
  };
}
async function verifyXmrLock(txHash, viewPriv, spendPub, expectedAmount, minConfirmations = 10) {
  try {
    const result = await scanSingleTx(txHash, viewPriv, spendPub);
    if (!result.found) {
      return { verified: false, amount: 0n, confirmations: 0, reason: "no matching outputs" };
    }
    let totalAmount = 0n;
    for (const out of result.outputs) {
      totalAmount += out.amount;
    }
    if (totalAmount < expectedAmount) {
      return {
        verified: false,
        amount: totalAmount,
        confirmations: result.confirmations,
        reason: `insufficient amount: ${totalAmount} < ${expectedAmount}`
      };
    }
    if (result.confirmations < minConfirmations) {
      return {
        verified: false,
        amount: totalAmount,
        confirmations: result.confirmations,
        reason: `need ${minConfirmations} confirmations, have ${result.confirmations}`
      };
    }
    return {
      verified: true,
      amount: totalAmount,
      confirmations: result.confirmations,
      blockHeight: result.blockHeight,
      outputs: result.outputs,
      reason: "ok"
    };
  } catch (e) {
    return { verified: false, amount: 0n, confirmations: 0, reason: e.message };
  }
}
async function pollXmrLock(txHash, viewPriv, spendPub, expectedAmount, minConfirmations = 10, timeoutMs = 36e5, onStatus) {
  const start = Date.now();
  let lastConf = -1;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await verifyXmrLock(txHash, viewPriv, spendPub, expectedAmount, minConfirmations);
      if (result.verified) {
        if (onStatus) onStatus({ state: "verified", ...result });
        return result;
      }
      if (result.confirmations !== lastConf) {
        lastConf = result.confirmations;
        if (onStatus) onStatus({ state: "waiting", ...result });
      }
    } catch (e) {
      if (onStatus) onStatus({ state: "error", reason: e.message });
    }
    await new Promise((r) => setTimeout(r, 3e4));
  }
  return { verified: false, reason: "timeout" };
}
async function scanMempool(viewPriv, spendPub) {
  const pool = await getTransactionPool();
  const found = [];
  if (!pool.transactions) return found;
  for (const tx of pool.transactions) {
    if (!tx.tx_json) continue;
    try {
      const txJson = JSON.parse(tx.tx_json);
      const result = scanTransaction(txJson, viewPriv, spendPub);
      for (const out of result.outputs) {
        found.push({
          ...out,
          txHash: tx.id_hash,
          blockHeight: null,
          confirmations: 0,
          inPool: true
        });
      }
    } catch (e) {
    }
  }
  return found;
}
async function testConnection() {
  try {
    const info = await getInfo();
    _connected = true;
    return {
      connected: true,
      height: info.height,
      name: _activeNode.name,
      version: info.version,
      network: info.mainnet ? "mainnet" : info.stagenet ? "stagenet" : info.testnet ? "testnet" : "unknown"
    };
  } catch (e) {
    _connected = false;
    return { connected: false, height: 0, name: _activeNode.name, error: e.message };
  }
}
async function autoConnect() {
  for (const node of XMR_NODES) {
    _activeNode = node;
    const result = await testConnection();
    if (result.connected) {
      console.log("[XMR] connected to", node.name, "height:", result.height);
      return result;
    }
  }
  console.warn("[XMR] no node available");
  return { connected: false };
}
function setNode(url, name) {
  _activeNode = { url, name, cors: true };
  _connected = false;
}
function varintEncode(n) {
  const bytes = [];
  while (n >= 128) {
    bytes.push(n & 127 | 128);
    n = Math.floor(n / 128);
  }
  bytes.push(n & 127);
  return new Uint8Array(bytes);
}
function varintDecode(bytes, offset = 0) {
  let n = 0, shift = 0;
  let i = offset;
  while (i < bytes.length) {
    const b = bytes[i++];
    n |= (b & 127) << shift;
    if ((b & 128) === 0) break;
    shift += 7;
  }
  return { value: n, length: i - offset };
}
export {
  autoConnect,
  computeKeyImage,
  computeSharedSecret,
  decryptAmount,
  derivationToScalar,
  deriveOutputPrivKey,
  deriveOutputPubKey,
  getBlock,
  getBlockCount,
  getBlockHeaderByHeight,
  getInfo,
  getTransactionPool,
  getTransactions,
  hashToPoint,
  hashToScalar,
  isKeyImageSpent,
  parseTxExtra,
  pollXmrLock,
  scanBlocks,
  scanMempool,
  scanSingleTx,
  scanTransaction,
  setNode,
  testConnection,
  varintDecode,
  varintEncode,
  verifyXmrLock
};
