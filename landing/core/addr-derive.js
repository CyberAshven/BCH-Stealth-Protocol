import { secp256k1 } from "../lib/noble-curves.js";
import { sha256 } from "../lib/noble-hashes.js";
import { ripemd160 } from "../lib/noble-hashes.js";
import { keccak_256 } from "../lib/noble-hashes.js";
import { ed25519 } from "../lib/noble-curves.js";
import { concat, b2h, h2b, utf8, dsha256 } from "./utils.js";
import { base58Check } from "./cashaddr.js";
function ethAddr(pubkey33) {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(pubkey33).toRawBytes(false).slice(1);
  const hash = keccak_256(uncompressed);
  const raw = hash.slice(12);
  const hexLower = b2h(raw);
  const hashHex = b2h(keccak_256(utf8(hexLower)));
  let cs = "0x";
  for (let i = 0; i < 40; i++) cs += parseInt(hashHex[i], 16) >= 8 ? hexLower[i].toUpperCase() : hexLower[i];
  return cs;
}
function btcAddr(pubkey33) {
  const hash = ripemd160(sha256(pubkey33));
  return base58Check(concat(new Uint8Array([0]), hash));
}
function ltcAddr(pubkey33) {
  const hash = ripemd160(sha256(pubkey33));
  return base58Check(concat(new Uint8Array([48]), hash));
}
function tronAddr(pubkey33) {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(pubkey33).toRawBytes(false).slice(1);
  const hash = keccak_256(uncompressed);
  const raw = hash.slice(12);
  return base58Check(concat(new Uint8Array([65]), raw));
}
const XRP_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
function xrpAddr(pubkey33) {
  const hash = ripemd160(sha256(pubkey33));
  const payload = concat(new Uint8Array([0]), hash);
  const input = concat(payload, dsha256(payload).slice(0, 4));
  let n = BigInt("0x" + b2h(input));
  let str = "";
  while (n > 0n) {
    str = XRP_ALPHABET[Number(n % 58n)] + str;
    n = n / 58n;
  }
  for (const b of input) {
    if (b === 0) str = XRP_ALPHABET[0] + str;
    else break;
  }
  return str;
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function solAddr(priv32) {
  const pubKey = ed25519.getPublicKey(priv32.slice(0, 32));
  let n = BigInt("0x" + b2h(pubKey));
  let str = "";
  while (n > 0n) {
    str = B58[Number(n % 58n)] + str;
    n = n / 58n;
  }
  for (const b of pubKey) {
    if (b === 0) str = "1" + str;
    else break;
  }
  return str;
}
const XLM_B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function _crc16xmodem(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) crc = crc & 32768 ? crc << 1 ^ 4129 : crc << 1;
    crc &= 65535;
  }
  return crc;
}
function _base32Encode(data) {
  let bits = 0, value = 0, out = "";
  for (let i = 0; i < data.length; i++) {
    value = value << 8 | data[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += XLM_B32[value >> bits & 31];
    }
  }
  if (bits > 0) out += XLM_B32[value << 5 - bits & 31];
  return out;
}
function xlmAddr(priv32) {
  const pubKey = ed25519.getPublicKey(priv32.slice(0, 32));
  const payload = concat(new Uint8Array([6 << 3]), pubKey);
  const crc = _crc16xmodem(payload);
  const full = concat(payload, new Uint8Array([crc & 255, crc >> 8 & 255]));
  return _base32Encode(full);
}
function deriveAllAddresses(keys) {
  const addrs = { bch: keys.bchAddr || "" };
  if (!keys.acctPriv || !keys.acctChain) return addrs;
  try {
    const acctPriv = keys.acctPriv;
    const acctChain = keys.acctChain;
    const btcPub = _childPub(acctPriv, acctChain, 3);
    if (btcPub) addrs.btc = btcAddr(btcPub);
    const ethPub = _childPub(acctPriv, acctChain, 4);
    if (ethPub) {
      const evmAddr = ethAddr(ethPub);
      addrs.eth = evmAddr;
      addrs.bnb = evmAddr;
      addrs.avax = evmAddr;
      addrs.matic = evmAddr;
      addrs.polygon = evmAddr;
      addrs.usdc_eth = evmAddr;
      addrs.usdt_eth = evmAddr;
      addrs.usdc_polygon = evmAddr;
      addrs.usdce_polygon = evmAddr;
      addrs.usdc_bsc = evmAddr;
      addrs.usdt_bsc = evmAddr;
      addrs.usdt_avax = evmAddr;
      addrs.usdc_avax = evmAddr;
    }
    const ltcPub = _childPub(acctPriv, acctChain, 6);
    if (ltcPub) addrs.ltc = ltcAddr(ltcPub);
    const xrpPriv = _childPriv(acctPriv, acctChain, 7);
    const xrpPub = xrpPriv ? secp256k1.getPublicKey(xrpPriv, true) : null;
    if (xrpPub) {
      addrs.xrp = xrpAddr(xrpPub);
      addrs.rlusd_xrp = addrs.xrp;
    }
    const solPriv = _childPriv(acctPriv, acctChain, 8);
    if (solPriv) {
      addrs.sol = solAddr(solPriv);
      addrs.usdc_sol = addrs.sol;
      addrs.usdt_sol = addrs.sol;
    }
    const trxPriv = _childPriv(acctPriv, acctChain, 9);
    const trxPub = trxPriv ? secp256k1.getPublicKey(trxPriv, true) : null;
    if (trxPub) {
      addrs.trx = tronAddr(trxPub);
      addrs.usdt_trx = addrs.trx;
    }
    const xlmPriv = _childPriv(acctPriv, acctChain, 10);
    if (xlmPriv) addrs.xlm = xlmAddr(xlmPriv);
    if (keys.xmrPrimaryAddress) addrs.xmr = keys.xmrPrimaryAddress;
    else if (keys.xmr?.addr) addrs.xmr = keys.xmr.addr;
    addrs.sbch = addrs.bch;
  } catch (e) {
    console.warn("[addr-derive] error:", e.message);
  }
  return addrs;
}
function deriveEvmPrivKey(keys) {
  if (!keys?.acctPriv || !keys?.acctChain) return null;
  try {
    const priv = _childPriv(keys.acctPriv, keys.acctChain, 4);
    return b2h(priv);
  } catch (e) {
    console.warn("[addr-derive] EVM key derivation error:", e.message);
    return null;
  }
}
function deriveTrxPrivKey(keys) {
  if (!keys?.acctPriv || !keys?.acctChain) return null;
  try {
    const priv = _childPriv(keys.acctPriv, keys.acctChain, 9);
    return b2h(priv);
  } catch {
    return null;
  }
}
function deriveXrpPrivKey(keys) {
  if (!keys?.acctPriv || !keys?.acctChain) return null;
  try {
    const priv = _childPriv(keys.acctPriv, keys.acctChain, 7);
    return priv;
  } catch {
    return null;
  }
}
function deriveSolPrivKey(keys) {
  if (!keys?.acctPriv || !keys?.acctChain) return null;
  try {
    return _childPriv(keys.acctPriv, keys.acctChain, 8);
  } catch {
    return null;
  }
}
function deriveXlmPrivKey(keys) {
  if (!keys?.acctPriv || !keys?.acctChain) return null;
  try {
    return _childPriv(keys.acctPriv, keys.acctChain, 10);
  } catch {
    return null;
  }
}
import { hmac } from "../lib/noble-hashes.js";
import { sha512 } from "../lib/noble-hashes.js";
const N_SECP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
function _bip32Child(priv, chain, idx, hard) {
  const ib = new Uint8Array([idx >>> 24, idx >>> 16 & 255, idx >>> 8 & 255, idx & 255]);
  const data = hard ? concat(new Uint8Array([0]), priv, ib) : concat(secp256k1.getPublicKey(priv, true), ib);
  const I = hmac(sha512, chain, data);
  const child = ((BigInt("0x" + b2h(I.slice(0, 32))) + BigInt("0x" + b2h(priv))) % N_SECP).toString(16).padStart(64, "0");
  return { priv: h2b(child), chain: I.slice(32) };
}
function _childPub(acctPriv, acctChain, branchIdx) {
  const branch = _bip32Child(acctPriv, acctChain, branchIdx, false);
  const node = _bip32Child(branch.priv, branch.chain, 0, false);
  return secp256k1.getPublicKey(node.priv, true);
}
function _childPriv(acctPriv, acctChain, branchIdx) {
  const branch = _bip32Child(acctPriv, acctChain, branchIdx, false);
  const node = _bip32Child(branch.priv, branch.chain, 0, false);
  return node.priv;
}
export {
  btcAddr,
  deriveAllAddresses,
  deriveEvmPrivKey,
  deriveSolPrivKey,
  deriveTrxPrivKey,
  deriveXlmPrivKey,
  deriveXrpPrivKey,
  ethAddr,
  ltcAddr,
  solAddr,
  tronAddr,
  xlmAddr,
  xrpAddr
};
