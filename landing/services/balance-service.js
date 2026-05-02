import * as state from "../core/state.js";
import { sha256 } from "../lib/noble-hashes.js";
import { b2h } from "../core/utils.js";
import { cashAddrToHash20, base58Decode } from "../core/cashaddr.js";
import { deriveAllAddresses } from "../core/addr-derive.js";
const BALANCE_INTERVAL = 15e3;
const PRICE_INTERVAL = 2e4;
const STEALTH_INTERVAL = 3e4;
let _balanceTimer = null;
let _priceTimer = null;
let _stealthTimer = null;
let _addresses = {};
let _keys = null;
let _running = false;
function _addrToScriptHash(cashAddr) {
  try {
    const hash20 = cashAddrToHash20(cashAddr);
    return _hash20ToScriptHash(hash20);
  } catch {
    return null;
  }
}
function _btcAddrToScriptHash(btcAddr) {
  try {
    const decoded = base58Decode(btcAddr);
    const hash20 = decoded.slice(1, 21);
    return _hash20ToScriptHash(hash20);
  } catch {
    return null;
  }
}
function _hash20ToScriptHash(hash20) {
  const script = new Uint8Array([118, 169, 20, ...hash20, 136, 172]);
  const hash = sha256(script);
  return b2h(hash.reverse());
}
let _cleanAddresses = {};
function _deriveAddresses(keys) {
  const derived = deriveAllAddresses(keys);
  _cleanAddresses = { ...derived };
  const addrs = {};
  for (const [chain, addr] of Object.entries(derived)) {
    if (chain === "bch" || chain === "sbch") {
      const sh = _addrToScriptHash(addr);
      if (sh) addrs[chain] = sh;
    } else if (chain === "btc") {
      const sh = _btcAddrToScriptHash(addr);
      if (sh) addrs[chain] = sh;
    } else {
      addrs[chain] = addr;
    }
  }
  return addrs;
}
function getAddresses() {
  return { ..._cleanAddresses };
}
function getAddress(chain) {
  return _cleanAddresses[chain] || null;
}
async function _refreshBalances() {
  if (!_running || !Object.keys(_addresses).length) return;
  try {
    if (window.chainsRefreshAll) {
      const results = await window.chainsRefreshAll(_addresses);
      const balances = {};
      for (const [chain, res] of Object.entries(results)) {
        if (res.loaded) {
          balances[chain] = res.balance;
          if (res.utxos) state.set("utxos", res.utxos);
        }
      }
      state.merge("balances", balances);
      _refreshElectrumHistoryAll();
    }
  } catch (e) {
    console.warn("[balance-service] refresh failed:", e.message);
  }
}
const _lastKnownTxCounts = {};
let _lastHistoryRefresh = 0;
async function _refreshElectrumHistoryAll() {
  if (Date.now() - _lastHistoryRefresh < 3e4) return;
  _lastHistoryRefresh = Date.now();
  if (_cleanAddresses.bch && window._fvCall) {
    const sh = _addrToScriptHash(_cleanAddresses.bch);
    if (sh) await _refreshElectrumHistory("bch", sh, window._fvCall);
  }
  if (_cleanAddresses.btc && window._btcCall) {
    const sh = _btcAddrToScriptHash(_cleanAddresses.btc);
    if (sh) await _refreshElectrumHistory("btc", sh, window._btcCall);
  }
  if (_cleanAddresses.ltc && window._ltcCall) {
    const sh = _ltcAddrToScriptHash(_cleanAddresses.ltc);
    if (sh) await _refreshElectrumHistory("ltc", sh, window._ltcCall);
  }
}
async function _refreshElectrumHistory(chain, scriptHash, caller) {
  try {
    const hist = await caller("blockchain.scripthash.get_history", [scriptHash]) || [];
    if (hist.length === (_lastKnownTxCounts[chain] || -1)) return;
    _lastKnownTxCounts[chain] = hist.length;
    let cached = [];
    try {
      cached = JSON.parse(localStorage.getItem("00_tx_history") || "[]");
    } catch {
    }
    const cachedIds = new Set(cached.filter((t) => t.chain === chain).map((t) => t.txid));
    const missing = hist.filter((h) => !cachedIds.has(h.tx_hash));
    if (!missing.length) return;
    const myScript = _buildP2PKHScript(chain);
    if (!myScript) return;
    const newTxs = [];
    for (const h of missing.slice(-10)) {
      try {
        const hex = await caller("blockchain.transaction.get", [h.tx_hash]);
        if (!hex) continue;
        const outputs = _parseTxOutputsSimple(hex);
        if (!outputs) continue;
        const myVal = outputs.filter((o) => o.script === myScript).reduce((s, o) => s + o.value, 0);
        const totalOut = outputs.reduce((s, o) => s + o.value, 0);
        const dir = myVal > 0 ? "in" : "out";
        const amount = dir === "in" ? myVal : totalOut - myVal;
        let timestamp = Math.floor(Date.now() / 1e3);
        if (h.height > 0) {
          try {
            const header = await caller("blockchain.block.header", [h.height]);
            if (header && header.length >= 152) {
              const tsHex = header.slice(136, 144);
              timestamp = parseInt(tsHex.slice(6, 8) + tsHex.slice(4, 6) + tsHex.slice(2, 4) + tsHex.slice(0, 2), 16);
            }
          } catch {
          }
        }
        newTxs.push({ txid: h.tx_hash, chain, dir, amount, height: h.height || 0, timestamp });
      } catch {
      }
    }
    if (newTxs.length) {
      cached = cached.concat(newTxs);
      localStorage.setItem("00_tx_history", JSON.stringify(cached.slice(-500)));
      state.set("newTxs", newTxs);
    }
  } catch {
  }
}
function _buildP2PKHScript(chain) {
  try {
    const addr = _cleanAddresses[chain];
    if (!addr) return null;
    let hash20;
    if (chain === "bch") {
      hash20 = cashAddrToHash20(addr);
    } else {
      const decoded = base58Decode(addr);
      hash20 = decoded.slice(1, 21);
    }
    return ["76", "a9", "14", ...Array.from(hash20, (b) => b.toString(16).padStart(2, "0")), "88", "ac"].join("");
  } catch {
    return null;
  }
}
function _ltcAddrToScriptHash(ltcAddr) {
  try {
    const decoded = base58Decode(ltcAddr);
    const hash20 = decoded.slice(1, 21);
    return _hash20ToScriptHash(hash20);
  } catch {
    return null;
  }
}
function _parseTxOutputsSimple(hex) {
  try {
    const b = [];
    for (let i = 0; i < hex.length; i += 2) b.push(parseInt(hex.substr(i, 2), 16));
    let p = 0;
    const rB = (n) => {
      p += n;
      return b.slice(p - n, p);
    };
    const rLE = (n) => {
      let r = 0;
      for (let i = 0; i < n; i++) r |= b[p + i] << i * 8;
      p += n;
      return r >>> 0;
    };
    const rVI = () => {
      const f = b[p++];
      if (f < 253) return f;
      if (f === 253) return rLE(2);
      return rLE(4);
    };
    const rLE8 = () => {
      let lo = rLE(4), hi = rLE(4);
      return hi * 4294967296 + lo;
    };
    rLE(4);
    const inCount = rVI();
    for (let i = 0; i < inCount; i++) {
      rB(32);
      rLE(4);
      rB(rVI());
      rLE(4);
    }
    const outCount = rVI();
    const outputs = [];
    for (let i = 0; i < outCount; i++) {
      const value = rLE8();
      const sLen = rVI();
      const script = b.slice(p, p + sLen).map((x) => x.toString(16).padStart(2, "0")).join("");
      p += sLen;
      outputs.push({ value, script });
    }
    return outputs;
  } catch {
    return null;
  }
}
async function _refreshPrices() {
  if (!_running) return;
  try {
    if (window.chainsGetPrices) {
      const prices = await window.chainsGetPrices();
      state.set("prices", prices);
    }
  } catch (e) {
    console.warn("[balance-service] price fetch failed:", e.message);
  }
}
async function _scanStealth() {
  if (!_running || !_keys || !_keys.stealthScanPriv) return;
  try {
    const indexerUrl = window._00ep && window._00ep.indexer || "https://0penw0rld.com";
    let tipHeight = 0;
    if (window._fvCall) {
      try {
        const h = await window._fvCall("blockchain.headers.subscribe", []);
        tipHeight = h?.height || 0;
      } catch {
      }
    }
    if (!tipHeight) return;
    const lastScan = state.get("stealthScanHeight") || tipHeight - 10;
    const from = Math.max(0, lastScan);
    const to = tipHeight;
    if (from >= to) return;
    const pubkeysRes = await fetch(`${indexerUrl}/api/pubkeys?from=${from}&to=${to}`);
    if (!pubkeysRes.ok) return;
    const data = await pubkeysRes.json();
    const pubkeys = data.pubkeys || data;
    if (pubkeys && pubkeys.length > 0) {
      try {
        const { scanForStealthPayments } = await import("../core/stealth.js");
        const found = await scanForStealthPayments(_keys, pubkeys);
        if (found.length > 0) {
          _updateStealthBalance();
        }
      } catch (e) {
        console.warn("[balance-service] stealth scan error:", e);
      }
      state.set("stealthScanHeight", to);
    }
  } catch (e) {
  }
}
async function _updateStealthBalance() {
  try {
    const { loadStealthUtxos } = await import("../core/stealth.js");
    const utxos = loadStealthUtxos();
    if (!utxos.length) return;
    let totalSats = 0;
    for (const u of utxos) {
      if (!u.addr || u.spent) continue;
      try {
        const h = cashAddrToHash20(u.addr);
        const script = new Uint8Array([118, 169, 20, ...h, 136, 172]);
        const hash = sha256(script);
        const sh = Array.from(hash).reverse().map((b) => b.toString(16).padStart(2, "0")).join("");
        const unspent = await window._fvCall("blockchain.scripthash.listunspent", [sh]) || [];
        for (const utxo of unspent) totalSats += utxo.value;
      } catch {
      }
    }
    state.set("balances", { ...state.get("balances"), sbch: totalSats });
  } catch (e) {
    console.warn("[balance-service] stealth balance error:", e);
  }
}
function start(keys) {
  if (_running) stop();
  _running = true;
  _keys = keys;
  _addresses = _deriveAddresses(keys);
  state.set("addresses", { ..._cleanAddresses });
  _refreshBalances();
  _refreshPrices();
  _balanceTimer = setInterval(_refreshBalances, BALANCE_INTERVAL);
  _priceTimer = setInterval(_refreshPrices, PRICE_INTERVAL);
  if (keys.stealthScanPriv) {
    _stealthTimer = setInterval(_scanStealth, STEALTH_INTERVAL);
    _scanStealth();
    _updateStealthBalance();
  }
}
function stop() {
  _running = false;
  clearInterval(_balanceTimer);
  clearInterval(_priceTimer);
  clearInterval(_stealthTimer);
  _balanceTimer = null;
  _priceTimer = null;
  _stealthTimer = null;
  _keys = null;
  _addresses = {};
}
function isRunning() {
  return _running;
}
async function refreshNow() {
  await Promise.all([_refreshBalances(), _refreshPrices(), _updateStealthBalance()]);
}
function setAddress(chain, addr) {
  _addresses[chain] = addr;
  try {
    const cached = JSON.parse(localStorage.getItem("00_chain_addrs") || "{}");
    cached[chain] = addr;
    localStorage.setItem("00_chain_addrs", JSON.stringify(cached));
  } catch {
  }
}
export {
  getAddress,
  getAddresses,
  isRunning,
  refreshNow,
  setAddress,
  start,
  stop
};
