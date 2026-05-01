import * as state from "../core/state.js";
const GAP_LIMIT = 20;
const MAX_INDEX = 50;
const BATCH_SIZE = 10;
let _running = false;
let _hdAddresses = [];
let _changeAddr = null;
let _changePriv = null;
let _bip32Child = null;
let _secp = null;
let _sha256 = null;
let _ripemd160 = null;
let _cashAddrToHash20 = null;
let _pubHashToCashAddr = null;
let _hmacSha512 = null;
async function _loadCrypto() {
  if (_secp) return;
  const [curves, hashes, rip, hmacMod, ca] = await Promise.all([
    import("../lib/noble-curves.js"),
    import("../lib/noble-hashes.js"),
    import("../lib/noble-hashes.js"),
    import("../lib/noble-hashes.js"),
    import("../core/cashaddr.js")
  ]);
  const sha512 = await import("../lib/noble-hashes.js");
  _secp = curves.secp256k1;
  _sha256 = hashes.sha256;
  _ripemd160 = rip.ripemd160;
  _cashAddrToHash20 = ca.cashAddrToHash20;
  _pubHashToCashAddr = ca.pubHashToCashAddr;
  const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const b2h = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const h2b = (hex) => {
    const a = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) a[i / 2] = parseInt(hex.substr(i, 2), 16);
    return a;
  };
  const concat = (...arrs) => {
    const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
    let o = 0;
    for (const a of arrs) {
      out.set(a, o);
      o += a.length;
    }
    return out;
  };
  _bip32Child = (priv, chain, idx, hard) => {
    const ib = new Uint8Array([idx >>> 24, idx >>> 16 & 255, idx >>> 8 & 255, idx & 255]);
    const data = hard ? concat(new Uint8Array([0]), priv, ib) : concat(_secp.getPublicKey(priv, true), ib);
    const I = hmacMod.hmac(sha512.sha512, chain, data);
    const child = ((BigInt("0x" + b2h(I.slice(0, 32))) + BigInt("0x" + b2h(priv))) % N).toString(16).padStart(64, "0");
    return { priv: h2b(child), chain: I.slice(32) };
  };
}
function _addrToSH(addr) {
  const h = _cashAddrToHash20(addr);
  const script = new Uint8Array([118, 169, 20, ...h, 136, 172]);
  const hash = _sha256(script);
  return Array.from(hash).reverse().map((b) => b.toString(16).padStart(2, "0")).join("");
}
function _privToAddr(priv) {
  const pub = _secp.getPublicKey(priv, true);
  const h160 = _ripemd160(_sha256(pub));
  return { pub, addr: _pubHashToCashAddr(h160) };
}
async function scan(keys) {
  if (_running) return;
  if (!keys.acctPriv || !keys.acctChain) {
    return;
  }
  _running = true;
  _hdAddresses = [];
  await _loadCrypto();
  const acctPriv = keys.acctPriv;
  const acctChain = keys.acctChain;
  const mainChild = _bip32Child(_bip32Child(acctPriv, acctChain, 0, false).priv, _bip32Child(acctPriv, acctChain, 0, false).chain, 0, false);
  const main = _privToAddr(mainChild.priv);
  _hdAddresses.push({ priv: mainChild.priv, pub: main.pub, addr: main.addr, path: "0/0", branch: "receive" });
  for (const branchIdx of [0, 1]) {
    const branchNode = _bip32Child(acctPriv, acctChain, branchIdx, false);
    const branchName = branchIdx === 0 ? "receive" : "change";
    let gap = 0;
    for (let i = branchIdx === 0 ? 1 : 0; i < MAX_INDEX && gap < GAP_LIMIT; i += BATCH_SIZE) {
      const chunk = [];
      for (let j = i; j < Math.min(i + BATCH_SIZE, MAX_INDEX); j++) {
        const child = _bip32Child(branchNode.priv, branchNode.chain, j, false);
        const { pub, addr } = _privToAddr(child.priv);
        chunk.push({ priv: child.priv, pub, addr, path: branchIdx + "/" + j, branch: branchName });
      }
      const results = await Promise.all(chunk.map(async (d) => {
        if (!window._fvCall) return { ...d, hasActivity: false };
        try {
          const sh = _addrToSH(d.addr);
          const hist = await window._fvCall("blockchain.scripthash.get_history", [sh]) || [];
          return { ...d, scriptHash: sh, hasActivity: hist.length > 0 };
        } catch {
          return { ...d, hasActivity: false };
        }
      }));
      for (const r of results) {
        if (r.hasActivity) {
          _hdAddresses.push(r);
          gap = 0;
        } else {
          gap++;
        }
      }
    }
  }
  const chgBranch = _bip32Child(acctPriv, acctChain, 1, false);
  const usedChg = _hdAddresses.filter((a) => a.branch === "change");
  const nextIdx = usedChg.length > 0 ? Math.max(...usedChg.map((a) => parseInt(a.path.split("/")[1]))) + 1 : 0;
  const chgChild = _bip32Child(chgBranch.priv, chgBranch.chain, nextIdx, false);
  const chg = _privToAddr(chgChild.priv);
  _changeAddr = chg.addr;
  _changePriv = chgChild.priv;
  if (!_hdAddresses.some((a) => a.addr === chg.addr)) {
    _hdAddresses.push({ priv: chgChild.priv, pub: chg.pub, addr: chg.addr, path: "1/" + nextIdx, branch: "change" });
  }
  state.set("hdAddresses", _hdAddresses.map((a) => ({ addr: a.addr, path: a.path, branch: a.branch })));
  state.set("hdChangeAddr", _changeAddr);
  localStorage.setItem("00_hd_paths", JSON.stringify(_hdAddresses.map((a) => a.path)));
  _running = false;
  window._hdGetAllScriptHashes = getAllScriptHashes;
}
function getAddresses() {
  return _hdAddresses;
}
function getChangeAddr() {
  return _changeAddr;
}
function getChangePriv() {
  return _changePriv;
}
function isReceive(addr) {
  return _hdAddresses.some((a) => a.addr === addr && a.branch === "receive");
}
function isChange(addr) {
  return _hdAddresses.some((a) => a.addr === addr && a.branch === "change");
}
function getPrivForAddr(addr) {
  return _hdAddresses.find((a) => a.addr === addr)?.priv || null;
}
function getBranchForAddr(addr) {
  return _hdAddresses.find((a) => a.addr === addr)?.branch || null;
}
function getAllAddrs() {
  return _hdAddresses.map((a) => a.addr);
}
function getReceiveAddrs() {
  return _hdAddresses.filter((a) => a.branch === "receive").map((a) => a.addr);
}
function getChangeAddrs() {
  return _hdAddresses.filter((a) => a.branch === "change").map((a) => a.addr);
}
function getAllScriptHashes() {
  if (!_sha256 || !_cashAddrToHash20 || _hdAddresses.length === 0) return [];
  const b2h = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return _hdAddresses.map((a) => {
    try {
      const h = _cashAddrToHash20(a.addr);
      const script = new Uint8Array([118, 169, 20, ...h, 136, 172]);
      const hash = _sha256(script);
      return b2h(Array.from(hash).reverse());
    } catch {
      return null;
    }
  }).filter(Boolean);
}
export {
  getAddresses,
  getAllAddrs,
  getAllScriptHashes,
  getBranchForAddr,
  getChangeAddr,
  getChangeAddrs,
  getChangePriv,
  getPrivForAddr,
  getReceiveAddrs,
  isChange,
  isReceive,
  scan
};
