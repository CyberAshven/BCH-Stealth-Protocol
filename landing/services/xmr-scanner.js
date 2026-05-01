import { b2h } from "../core/xmr-keys.js";
let _spendPriv = null, _spendPub = null, _viewPriv = null, _viewPub = null, _addr = null;
let _balance = "0";
let _height = 0;
let _connected = false;
let _scanning = false;
let _scanTimer = null;
let _xmrWallet = null;
let _rpcModule = null;
function init(keys) {
  _spendPriv = keys.spendPriv;
  _spendPub = keys.spendPub;
  _viewPriv = keys.viewPriv;
  _viewPub = keys.viewPub;
  _addr = keys.addr;
  try {
    const cached = JSON.parse(localStorage.getItem("00_xmr_scan") || "null");
    if (cached && cached.addr === _addr) {
      _balance = cached.balance || "0";
      _height = cached.height || 0;
    }
  } catch {
  }
}
function getBalance() {
  return _balance;
}
function getBalanceXMR() {
  return (Number(BigInt(_balance)) / 1e12).toFixed(12);
}
function getOutputs() {
  return [];
}
function getHeight() {
  return _height;
}
function isConnected() {
  return _connected;
}
function getAddr() {
  return _addr;
}
async function _rpc() {
  if (!_rpcModule) _rpcModule = await import("../xmr-rpc.js");
  return _rpcModule;
}
async function connect() {
  const rpc = await _rpc();
  const conn = await rpc.autoConnect();
  if (!conn.connected) throw new Error("No XMR node available");
  _connected = true;
  _height = conn.height || 0;
  console.log("[xmr] connected to", conn.name, "height:", _height);
  return conn;
}
async function _ensureWallet(onStatus) {
  if (_xmrWallet) return _xmrWallet;
  onStatus?.("Loading WASM library...");
  const moneroMod = await import("../lib/monero-ts.js");
  const moneroTs = moneroMod.default || moneroMod;
  moneroTs.LibraryUtils.WORKER_LOADER = () => {
    const code = "importScripts('" + location.origin + "/monero.worker.js');";
    const blob = new Blob([code], { type: "application/javascript" });
    return new Worker(URL.createObjectURL(blob));
  };
  onStatus?.("Creating wallet...");
  const restoreH = _height > 200 ? _height - 200 : 0;
  _xmrWallet = await moneroTs.createWalletFull({
    password: "x",
    networkType: 0,
    // MAINNET
    primaryAddress: _addr,
    privateViewKey: b2h(_viewPriv),
    privateSpendKey: b2h(_spendPriv),
    restoreHeight: restoreH,
    server: { uri: location.origin },
    proxyToWorker: true
  });
  console.log("[xmr] WASM wallet created, restoreHeight:", restoreH);
  return _xmrWallet;
}
async function scan(onProgress) {
  if (_scanning || !_viewPriv || !_spendPub) return;
  _scanning = true;
  try {
    if (!_connected) await connect();
    onProgress?.("Loading WASM scanner...");
    const wallet = await _ensureWallet(onProgress);
    onProgress?.("Syncing...");
    console.log("[xmr] starting WASM sync...");
    await wallet.sync();
    const balBigInt = await wallet.getBalance();
    const unlockedBigInt = await wallet.getUnlockedBalance();
    _balance = balBigInt.toString();
    const unlocked = unlockedBigInt.toString();
    _height = await wallet.getHeight();
    console.log("[xmr] WASM sync done \u2014 balance:", (Number(balBigInt) / 1e12).toFixed(6), "XMR, unlocked:", (Number(unlockedBigInt) / 1e12).toFixed(6), "XMR, height:", _height);
    try {
      localStorage.setItem("00_xmr_scan", JSON.stringify({ addr: _addr, height: _height, balance: _balance }));
    } catch {
    }
    try {
      const txs = await wallet.getTxs();
      _persistTxHistory(txs);
    } catch (e) {
      console.warn("[xmr] getTxs error:", e.message);
    }
    onProgress?.("Done \u2014 " + (Number(balBigInt) / 1e12).toFixed(6) + " XMR");
  } catch (e) {
    console.warn("[xmr] WASM scan error:", e.message);
    onProgress?.("Scan error: " + e.message);
  } finally {
    _scanning = false;
  }
}
function _persistTxHistory(txs) {
  if (!txs || !txs.length) return;
  try {
    let hist = JSON.parse(localStorage.getItem("00_tx_history") || "[]");
    const existing = new Set(hist.filter((h) => h.chain === "xmr").map((h) => h.txid));
    for (const tx of txs) {
      const hash = tx.getHash();
      if (existing.has(hash)) continue;
      const isIn = tx.getIsIncoming();
      const amount = isIn ? tx.getIncomingAmount()?.toString() || "0" : tx.getOutgoingAmount()?.toString() || "0";
      hist.push({
        txid: hash,
        chain: "xmr",
        dir: isIn ? "in" : "out",
        amount,
        height: tx.getHeight() || 0,
        timestamp: Math.floor((tx.getTimestamp() || Date.now()) / 1e3)
      });
    }
    if (hist.length > 500) hist = hist.slice(-500);
    localStorage.setItem("00_tx_history", JSON.stringify(hist));
  } catch {
  }
}
async function sendXmr(recipientAddr, amountPiconeros, onStatus) {
  if (!_spendPriv || !_viewPriv || !_addr) throw new Error("XMR keys not initialized");
  const wallet = await _ensureWallet(onStatus);
  onStatus?.("Syncing...");
  await wallet.sync();
  onStatus?.("Building transaction...");
  const tx = await wallet.createTx({
    accountIndex: 0,
    address: recipientAddr,
    amount: amountPiconeros.toString(),
    relay: false
  });
  onStatus?.("Broadcasting...");
  await wallet.relayTx(tx);
  const txHash = tx.getHash();
  console.log("[xmr] sent:", txHash);
  _balance = (await wallet.getBalance()).toString();
  try {
    localStorage.setItem("00_xmr_scan", JSON.stringify({ addr: _addr, height: _height, balance: _balance }));
  } catch {
  }
  try {
    let hist = JSON.parse(localStorage.getItem("00_tx_history") || "[]");
    hist.push({ txid: txHash, chain: "xmr", dir: "out", amount: amountPiconeros.toString(), height: 0, timestamp: Math.floor(Date.now() / 1e3) });
    localStorage.setItem("00_tx_history", JSON.stringify(hist));
  } catch {
  }
  return txHash;
}
function startAutoScan(intervalMs = 12e4) {
  if (_scanTimer) return;
  setTimeout(() => scan().catch((e) => console.warn("[xmr] initial scan error:", e.message)), 3e3);
  _scanTimer = setInterval(() => {
    scan().catch((e) => console.warn("[xmr] periodic scan error:", e.message));
  }, intervalMs);
}
function stopAutoScan() {
  if (_scanTimer) {
    clearInterval(_scanTimer);
    _scanTimer = null;
  }
}
export {
  connect,
  getAddr,
  getBalance,
  getBalanceXMR,
  getHeight,
  getOutputs,
  init,
  isConnected,
  scan,
  sendXmr,
  startAutoScan,
  stopAutoScan
};
