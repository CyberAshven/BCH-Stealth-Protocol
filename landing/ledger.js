(function(G) {
  "use strict";
  const VENDOR = 11415;
  const PIDS = [
    1,
    4,
    5,
    // Nano S (classic), Nano X (classic), Nano S+
    4096,
    16384,
    20480,
    // Nano-S, Nano-X, Nano-S-Plus (new PIDs — ElectrumABC b03bd41)
    24576,
    28672,
    32768
    // Stax, Flex, Apex P
  ];
  const BCH_PATH = [2147483692, 2147483793, 2147483648, 0, 0];
  const ACCOUNT_PATH = [2147483692, 2147483793, 2147483648];
  function concat(...arrs) {
    const r = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
    let o = 0;
    for (const a of arrs) {
      r.set(a, o);
      o += a.length;
    }
    return r;
  }
  function le32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return b;
  }
  function le64(n) {
    const big = typeof n === "bigint" ? n : BigInt(n);
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, Number(big & 0xFFFFFFFFn) >>> 0, true);
    dv.setUint32(4, Number(big >> 32n & 0xFFFFFFFFn) >>> 0, true);
    return b;
  }
  function varint(n) {
    if (n < 253) return new Uint8Array([n]);
    if (n <= 65535) return new Uint8Array([253, n & 255, n >> 8 & 255]);
    return new Uint8Array([254, n & 255, n >> 8 & 255, n >> 16 & 255, n >> 24 & 255]);
  }
  function hexToBytes(hex) {
    const b = new Uint8Array(hex.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
    return b;
  }
  function bytesToHex(b) {
    return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  function encodePath(path) {
    const b = new Uint8Array(1 + path.length * 4);
    b[0] = path.length;
    const dv = new DataView(b.buffer);
    path.forEach((n, i) => dv.setUint32(1 + i * 4, n, false));
    return b;
  }
  function wrapAPDU(apdu2) {
    const pkts = [];
    let off = 0, seq = 0;
    while (true) {
      const pkt = new Uint8Array(64);
      pkt[0] = 1;
      pkt[1] = 1;
      pkt[2] = 5;
      pkt[3] = seq >> 8 & 255;
      pkt[4] = seq & 255;
      let ds = 5;
      if (seq === 0) {
        pkt[5] = apdu2.length >> 8 & 255;
        pkt[6] = apdu2.length & 255;
        ds = 7;
      }
      const chunk = apdu2.slice(off, off + (64 - ds));
      pkt.set(chunk, ds);
      pkts.push(pkt);
      off += chunk.length;
      seq++;
      if (off >= apdu2.length) break;
    }
    return pkts;
  }
  async function exchange(device, apduData) {
    for (const pkt of wrapAPDU(apduData)) await device.sendReport(0, pkt);
    return new Promise((resolve, reject) => {
      let resp = null, total = 0, received = 0;
      const tOut = setTimeout(() => {
        device.removeEventListener("inputreport", handler);
        reject(new Error("Ledger timeout \u2014 is the Bitcoin Cash app open and unlocked?"));
      }, 3e4);
      function handler(e) {
        const raw = new Uint8Array(e.data.buffer);
        if (raw[0] !== 1 || raw[1] !== 1 || raw[2] !== 5) return;
        const seqNum = raw[3] << 8 | raw[4];
        let ds = 5;
        if (seqNum === 0) {
          total = raw[5] << 8 | raw[6];
          resp = new Uint8Array(total);
          ds = 7;
        }
        if (!resp) return;
        const take = Math.min(raw.slice(ds).length, total - received);
        resp.set(raw.slice(ds, ds + take), received);
        received += take;
        if (received >= total) {
          device.removeEventListener("inputreport", handler);
          clearTimeout(tOut);
          const sw = resp[resp.length - 2] << 8 | resp[resp.length - 1];
          if (sw === 27013) {
            reject(new Error("Ledger: request denied on device"));
            return;
          }
          if (sw === 28160 || sw === 27904) {
            reject(new Error("Ledger: open the Bitcoin Cash app on your device"));
            return;
          }
          if (sw === 27404) {
            reject(new Error("Ledger: device is locked \u2014 enter PIN first"));
            return;
          }
          if (sw !== 36864) {
            reject(new Error(`Ledger error 0x${sw.toString(16)}`));
            return;
          }
          resolve(resp.slice(0, resp.length - 2));
        }
      }
      device.addEventListener("inputreport", handler);
    });
  }
  function apdu(ins, p1, p2, data = new Uint8Array(0)) {
    if (data.length > 255) throw new Error(`APDU data too large: ${data.length}`);
    return concat(new Uint8Array([224, ins, p1, p2, data.length]), data);
  }
  async function connectLedger() {
    if (!navigator.hid) throw new Error("WebHID not available \u2014 use Chrome or Edge");
    const filters = PIDS.map((pid) => ({ vendorId: VENDOR, productId: pid }));
    const devs = await navigator.hid.requestDevice({ filters });
    if (!devs.length) throw new Error("No Ledger device selected");
    const dev = devs[0];
    if (!dev.opened) await dev.open();
    return dev;
  }
  async function getLedgerPubKey(device, path = BCH_PATH) {
    const pathB = encodePath(path);
    const resp = await exchange(device, apdu(64, 0, 3, pathB));
    const pkLen = resp[0];
    const pubKey = resp.slice(1, 1 + pkLen);
    const addrLen = resp[1 + pkLen];
    const addrRaw = new TextDecoder().decode(resp.slice(2 + pkLen, 2 + pkLen + addrLen));
    const chainCode = resp.slice(2 + pkLen + addrLen, 2 + pkLen + addrLen + 32);
    return { pubKey, addrRaw, chainCode };
  }
  function buildInputData(utxo, scriptCode) {
    const hash = hexToBytes(utxo.txid).reverse();
    const idx = le32(utxo.vout);
    const val = le64(utxo.value);
    const seq = new Uint8Array([255, 255, 255, 255]);
    const sc = scriptCode || new Uint8Array(0);
    return concat(new Uint8Array([2]), hash, idx, val, varint(sc.length), sc, seq);
  }
  async function signLedgerTx(device, utxos, outputs, scriptPubKey, path = BCH_PATH) {
    const version = new Uint8Array([1, 0, 0, 0]);
    const getScript = Array.isArray(scriptPubKey) ? (i) => scriptPubKey[i] : () => scriptPubKey;
    const getPath = Array.isArray(path[0]) ? (i) => path[i] : () => path;
    const outBytes = concat(
      varint(outputs.length),
      ...outputs.map((o) => concat(le64(o.value), varint(o.script.length), o.script))
    );
    console.log(`[Ledger] sign: ${utxos.length} input(s), ${outputs.length} output(s), outBytes=${outBytes.length}`);
    outputs.forEach((o, i) => console.log(`[Ledger]   out[${i}] val=${o.value} scriptLen=${o.script.length} head=${bytesToHex(o.script.slice(0, 4))}`));
    const sigs = [];
    for (let sigIdx = 0; sigIdx < utxos.length; sigIdx++) {
      for (let j = 0; j < utxos.length; j++) {
        const sc = j === sigIdx ? getScript(sigIdx) : null;
        const inpData = buildInputData(utxos[j], sc);
        if (j === 0) {
          const first = concat(version, varint(utxos.length), inpData);
          console.log(`[Ledger] INPUT_START r${sigIdx} j=0 P2=02 len=${first.length} scLen=${sc ? sc.length : 0}`);
          try {
            await exchange(device, apdu(68, 0, 2, first));
          } catch (e) {
            throw new Error(`INPUT_START r${sigIdx} j=0: ${e.message}`);
          }
        } else {
          console.log(`[Ledger] INPUT_START r${sigIdx} j=${j} P1=80 len=${inpData.length} scLen=${sc ? sc.length : 0}`);
          try {
            await exchange(device, apdu(68, 128, 0, inpData));
          } catch (e) {
            throw new Error(`INPUT_START r${sigIdx} j=${j}: ${e.message}`);
          }
        }
      }
      let pos = 0;
      while (pos < outBytes.length) {
        const chunk = outBytes.slice(pos, pos + 255);
        pos += 255;
        const p1 = pos >= outBytes.length ? 128 : 0;
        console.log(`[Ledger] FINALIZE_FULL r${sigIdx} P1=${p1 === 128 ? "80" : "00"} chunk=${chunk.length}`);
        try {
          await exchange(device, apdu(74, p1, 0, chunk));
        } catch (e) {
          throw new Error(`FINALIZE_FULL r${sigIdx} @${pos}: ${e.message}`);
        }
      }
      const pathB = encodePath(getPath(sigIdx));
      const signData = concat(pathB, new Uint8Array([0, 0, 0, 0, 0, 65]));
      console.log(`[Ledger] HASH_SIGN r${sigIdx} path=[${getPath(sigIdx).map((x) => (x >>> 0).toString(16)).join("/")}]`);
      let sigResp;
      try {
        sigResp = await exchange(device, apdu(72, 0, 0, signData));
      } catch (e) {
        throw new Error(`HASH_SIGN r${sigIdx}: ${e.message}`);
      }
      const derStart = sigResp[0] === 48 ? 0 : 1;
      const der = sigResp.slice(derStart);
      sigs.push(concat(der, new Uint8Array([65])));
    }
    return sigs;
  }
  function buildLedgerTx(utxos, sigs, pubKey, outputs) {
    const getPub = Array.isArray(pubKey) ? (i) => pubKey[i] : () => pubKey;
    const inputBytes = utxos.map((u, i) => {
      const hash = hexToBytes(u.txid).reverse();
      const idx = le32(u.vout);
      const seq = new Uint8Array([255, 255, 255, 255]);
      const sig = sigs[i];
      const pk = getPub(i);
      const scriptSig = concat(new Uint8Array([sig.length]), sig, new Uint8Array([pk.length]), pk);
      return concat(hash, idx, varint(scriptSig.length), scriptSig, seq);
    });
    const outBytes = outputs.map((o) => concat(le64(o.value), varint(o.script.length), o.script));
    const raw = concat(
      new Uint8Array([1, 0, 0, 0]),
      // version 1 LE
      varint(utxos.length),
      ...inputBytes,
      varint(outputs.length),
      ...outBytes,
      new Uint8Array([0, 0, 0, 0])
      // locktime 0
    );
    return bytesToHex(raw);
  }
  G.Ledger = { BCH_PATH, ACCOUNT_PATH, connectLedger, getLedgerPubKey, signLedgerTx, buildLedgerTx };
})(window);
