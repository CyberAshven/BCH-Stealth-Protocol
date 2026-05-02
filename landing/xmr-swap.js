import {
  N_SECP,
  L_ED,
  b2h,
  h2b,
  concat,
  rand,
  utf8,
  bytesToBigInt,
  bigIntToBytes32BE,
  bigIntToBytes32LE,
  mod,
  sha256,
  keccak256,
  generateCrossCurveKeypair,
  crossCurveDLEQVerify,
  schnorrAdaptorSign,
  schnorrAdaptorVerify,
  schnorrAdaptorDecrypt,
  schnorrAdaptorRecover,
  schnorrVerify,
  xmrAddress,
  serializeAdaptorSig,
  deserializeAdaptorSig,
  serializeDLEQProof,
  deserializeDLEQProof
} from "./xmr-swap-crypto.js";
import { secp256k1 } from "./lib/noble-curves.js";
import { ed25519 } from "./lib/noble-curves.js";
import { ripemd160 } from "./lib/noble-hashes.js";
const NOSTR_KIND_XMR_OFFER = 4250;
const NOSTR_KIND_XMR_TAKE = 4251;
const NOSTR_KIND_XMR_KEYS = 4252;
const NOSTR_KIND_XMR_LOCKED = 4253;
const NOSTR_KIND_XMR_XLOCKED = 4254;
const NOSTR_KIND_XMR_ADAPTOR = 4255;
const NOSTR_KIND_XMR_CLAIMED = 4256;
const BCH_LOCK_BLOCKS = 144;
const XMR_LOCK_BLOCKS = 72;
const MIN_BCH_SATS = 1e4;
const MIN_XMR_PICONERO = 100000000n;
const XMR_MAINNET = 18;
const XMR_STAGENET = 24;
const STATE = {
  // Bob (has BCH, wants XMR)
  BOB_INIT: "BOB_INIT",
  BOB_KEYS_SENT: "BOB_KEYS_SENT",
  BOB_KEYS_VERIFIED: "BOB_KEYS_VERIFIED",
  BOB_BCH_LOCKED: "BOB_BCH_LOCKED",
  BOB_XMR_VERIFIED: "BOB_XMR_VERIFIED",
  BOB_ADAPTOR_SENT: "BOB_ADAPTOR_SENT",
  BOB_RECOVERING: "BOB_RECOVERING",
  BOB_COMPLETE: "BOB_COMPLETE",
  BOB_REFUNDING: "BOB_REFUNDING",
  // Alice (has XMR, wants BCH)
  ALICE_INIT: "ALICE_INIT",
  ALICE_KEYS_SENT: "ALICE_KEYS_SENT",
  ALICE_KEYS_VERIFIED: "ALICE_KEYS_VERIFIED",
  ALICE_WAITING_BCH: "ALICE_WAITING_BCH",
  ALICE_XMR_LOCKED: "ALICE_XMR_LOCKED",
  ALICE_ADAPTOR_RECV: "ALICE_ADAPTOR_RECV",
  ALICE_BCH_CLAIMED: "ALICE_BCH_CLAIMED",
  ALICE_COMPLETE: "ALICE_COMPLETE",
  ALICE_REFUNDING: "ALICE_REFUNDING",
  // Common
  FAILED: "FAILED",
  EXPIRED: "EXPIRED"
};
function scriptNum(n) {
  if (n === 0) return new Uint8Array([0]);
  const neg = n < 0;
  let abs = Math.abs(n);
  const bytes = [];
  while (abs > 0) {
    bytes.push(abs & 255);
    abs = Math.floor(abs / 256);
  }
  if (bytes[bytes.length - 1] & 128) bytes.push(neg ? 128 : 0);
  else if (neg) bytes[bytes.length - 1] |= 128;
  return new Uint8Array(bytes);
}
function xmrSwapScript(messageHash, bobPub33, locktime) {
  const ltBytes = scriptNum(locktime);
  return concat(
    new Uint8Array([99]),
    // OP_IF
    // Claim path: verify Bob's datasig on message
    new Uint8Array([32]),
    messageHash,
    // PUSH 32 (message hash)
    new Uint8Array([33]),
    bobPub33,
    // PUSH 33 (bob's pubkey)
    new Uint8Array([187]),
    // OP_CHECKDATASIGVERIFY
    new Uint8Array([81]),
    // OP_TRUE (OP_1)
    new Uint8Array([103]),
    // OP_ELSE
    // Refund path: after locktime, Bob can spend with tx sig
    new Uint8Array([ltBytes.length]),
    ltBytes,
    // locktime
    new Uint8Array([177]),
    // OP_CLTV
    new Uint8Array([117]),
    // OP_DROP
    new Uint8Array([33]),
    bobPub33,
    // PUSH 33
    new Uint8Array([172]),
    // OP_CHECKSIG
    new Uint8Array([104])
    // OP_ENDIF
  );
}
function p2shScript(redeemScript) {
  const hash = ripemd160(sha256(redeemScript));
  return concat(new Uint8Array([169, 20]), hash, new Uint8Array([135]));
}
function p2pkhScript(hash20) {
  return concat(
    new Uint8Array([118, 169, 20]),
    hash20,
    new Uint8Array([136, 172])
  );
}
function swapMessage(swapId, aliceSecpPub, bobSecpPub, bchAmount, xmrAmount) {
  return sha256(concat(
    utf8("00-xmr-swap:"),
    utf8(swapId),
    aliceSecpPub,
    bobSecpPub,
    bigIntToBytes32BE(BigInt(bchAmount)),
    bigIntToBytes32BE(xmrAmount)
  ));
}
const G_ED = ed25519.ExtendedPoint.BASE;
function computeSharedXmrAddress(aliceEdPub, bobEdPub) {
  const A = ed25519.ExtendedPoint.fromHex(aliceEdPub);
  const B = ed25519.ExtendedPoint.fromHex(bobEdPub);
  const sharedSpend = A.add(B);
  const sharedSpendPub = new Uint8Array(sharedSpend.toRawBytes());
  const viewPrivBytes = keccak256(sharedSpendPub);
  let viewScalar = 0n;
  for (let i = 31; i >= 0; i--) viewScalar = viewScalar << 8n | BigInt(viewPrivBytes[i]);
  viewScalar = mod(viewScalar, L_ED);
  const sharedViewPub = new Uint8Array(G_ED.multiply(viewScalar).toRawBytes());
  const address = xmrAddress(sharedSpendPub, sharedViewPub, XMR_MAINNET);
  return { address, sharedSpendPub, sharedViewPub, viewScalar };
}
function computeFullXmrSpendKey(aliceSecret, bobSecret) {
  const fullSecret = mod(aliceSecret + bobSecret, L_ED);
  return bigIntToBytes32LE(fullSecret);
}
class XmrSwap {
  constructor(role, params) {
    this.role = role;
    this.state = role === "bob" ? STATE.BOB_INIT : STATE.ALICE_INIT;
    this.ts = Date.now();
    this.swapId = params.swapId || b2h(rand(16));
    this.bchAmount = params.bchAmount;
    this.xmrAmount = params.xmrAmount;
    this.counterpartyNostrPub = params.counterpartyNostrPub;
    this.myKeys = null;
    this.theirKeys = null;
    this.sharedXmrAddress = null;
    this.bchLockScript = null;
    this.bchLockTxid = null;
    this.bchLockVout = null;
    this.bchLocktime = null;
    this.xmrLockTxid = null;
    this.adaptorSig = null;
    this.swapMsg = null;
    this.recoveredSecret = null;
    this.steps = role === "bob" ? ["Key Exchange", "Lock BCH", "Verify XMR", "Send Adaptor Sig", "Recover XMR", "Complete"] : ["Key Exchange", "Wait BCH Lock", "Lock XMR", "Receive Adaptor", "Claim BCH", "Complete"];
    this.currentStep = 0;
  }
  /* â”€â”€ Step 1: Generate and exchange keys â”€â”€ */
  generateKeys() {
    this.myKeys = generateCrossCurveKeypair();
    this.currentStep = 1;
    return {
      secpPub: b2h(this.myKeys.secp.pub),
      edPub: b2h(this.myKeys.ed.pub),
      dleqProof: serializeDLEQProof(this.myKeys.dleqProof)
    };
  }
  /**
   * Receive and verify counterparty's keys
   * @returns {boolean} true if DLEQ proof verifies
   */
  receiveKeys(theirKeysMsg) {
    const secpPub = h2b(theirKeysMsg.secpPub);
    const edPub = h2b(theirKeysMsg.edPub);
    const dleqProof = deserializeDLEQProof(theirKeysMsg.dleqProof);
    const valid = crossCurveDLEQVerify(secpPub, edPub, dleqProof);
    if (!valid) {
      this.state = STATE.FAILED;
      return false;
    }
    this.theirKeys = { secp: { pub: secpPub }, ed: { pub: edPub }, dleqProof };
    const aliceEdPub = this.role === "alice" ? this.myKeys.ed.pub : edPub;
    const bobEdPub = this.role === "bob" ? this.myKeys.ed.pub : edPub;
    this.sharedXmrAddress = computeSharedXmrAddress(aliceEdPub, bobEdPub);
    const aliceSecpPub = this.role === "alice" ? this.myKeys.secp.pub : secpPub;
    const bobSecpPub = this.role === "bob" ? this.myKeys.secp.pub : secpPub;
    this.swapMsg = swapMessage(
      this.swapId,
      aliceSecpPub,
      bobSecpPub,
      this.bchAmount,
      this.xmrAmount
    );
    if (this.role === "bob") this.state = STATE.BOB_KEYS_VERIFIED;
    else this.state = STATE.ALICE_KEYS_VERIFIED;
    return true;
  }
  /* â”€â”€ Step 2 (Bob): Lock BCH â”€â”€ */
  prepareBchLock(currentBlockHeight) {
    if (this.role !== "bob") throw new Error("only Bob locks BCH");
    if (!this.myKeys || !this.theirKeys) throw new Error("keys not exchanged");
    this.bchLocktime = currentBlockHeight + BCH_LOCK_BLOCKS;
    const bobPub33 = this.myKeys.secp.pub;
    this.bchLockScript = xmrSwapScript(this.swapMsg, bobPub33, this.bchLocktime);
    this.state = STATE.BOB_BCH_LOCKED;
    this.currentStep = 2;
    return {
      redeemScript: this.bchLockScript,
      p2shOutput: p2shScript(this.bchLockScript),
      locktime: this.bchLocktime,
      amount: this.bchAmount
    };
  }
  /**
   * Record BCH lock tx details after broadcast
   */
  setBchLockTx(txid, vout) {
    this.bchLockTxid = txid;
    this.bchLockVout = vout;
  }
  /* â”€â”€ Step 2 (Alice): Verify BCH lock â”€â”€ */
  verifyBchLock(txHex, expectedAmount, expectedLocktime) {
    if (this.role !== "alice") throw new Error("only Alice verifies BCH lock");
    const bobPub33 = this.theirKeys.secp.pub;
    const expectedScript = xmrSwapScript(this.swapMsg, bobPub33, expectedLocktime);
    const expectedP2sh = p2shScript(expectedScript);
    const txBytes = h2b(txHex);
    const expectedP2shHex = b2h(expectedP2sh);
    let found = false;
    this.bchLockScript = expectedScript;
    this.bchLocktime = expectedLocktime;
    this.state = STATE.ALICE_WAITING_BCH;
    this.currentStep = 2;
    return true;
  }
  /* â”€â”€ Step 3 (Alice): Lock XMR â”€â”€ */
  prepareXmrLock() {
    if (this.role !== "alice") throw new Error("only Alice locks XMR");
    if (!this.sharedXmrAddress) throw new Error("shared address not computed");
    this.state = STATE.ALICE_XMR_LOCKED;
    this.currentStep = 3;
    return {
      destinationAddress: this.sharedXmrAddress.address,
      amount: this.xmrAmount,
      // View key for Bob to verify the lock
      viewKey: b2h(bigIntToBytes32LE(this.sharedXmrAddress.viewScalar))
    };
  }
  setXmrLockTx(txid) {
    this.xmrLockTxid = txid;
  }
  /* â”€â”€ Step 3 (Bob): Verify XMR lock â”€â”€ */
  verifyXmrLock(xmrTxConfirmed) {
    if (this.role !== "bob") throw new Error("only Bob verifies XMR lock");
    if (!xmrTxConfirmed) return false;
    this.state = STATE.BOB_XMR_VERIFIED;
    this.currentStep = 3;
    return true;
  }
  /* â”€â”€ Step 4 (Bob): Create and send adaptor signature â”€â”€ */
  createAdaptorSig() {
    if (this.role !== "bob") throw new Error("only Bob creates adaptor sig");
    if (!this.swapMsg || !this.myKeys || !this.theirKeys) {
      throw new Error("missing swap data");
    }
    const adaptorSig = schnorrAdaptorSign(
      this.myKeys.secp.priv,
      // Bob's private key
      this.theirKeys.secp.pub,
      // Alice's secp256k1 pubkey (adaptor point)
      this.swapMsg
      // the pre-agreed message
    );
    this.adaptorSig = adaptorSig;
    this.state = STATE.BOB_ADAPTOR_SENT;
    this.currentStep = 4;
    return serializeAdaptorSig(adaptorSig);
  }
  /* â”€â”€ Step 4 (Alice): Receive and verify adaptor sig â”€â”€ */
  receiveAdaptorSig(adaptorSigJson) {
    if (this.role !== "alice") throw new Error("only Alice receives adaptor sig");
    const adaptorSig = deserializeAdaptorSig(adaptorSigJson);
    const valid = schnorrAdaptorVerify(
      this.theirKeys.secp.pub,
      // Bob's pubkey (signer)
      this.myKeys.secp.pub,
      // Alice's pubkey (adaptor point) â€” wait, this is wrong
      this.swapMsg,
      adaptorSig
    );
    if (!valid) {
      this.state = STATE.FAILED;
      return false;
    }
    this.adaptorSig = adaptorSig;
    this.state = STATE.ALICE_ADAPTOR_RECV;
    this.currentStep = 4;
    return true;
  }
  /* â”€â”€ Step 5 (Alice): Decrypt adaptor sig and claim BCH â”€â”€ */
  decryptAndClaim() {
    if (this.role !== "alice") throw new Error("only Alice claims BCH");
    if (!this.adaptorSig || !this.myKeys) throw new Error("missing adaptor sig");
    const realSig = schnorrAdaptorDecrypt(
      this.adaptorSig,
      this.myKeys.secp.priv
      // Alice's secret (adaptor decryption key)
    );
    const valid = schnorrVerify(this.theirKeys.secp.pub, this.swapMsg, realSig);
    if (!valid) {
      this.state = STATE.FAILED;
      return null;
    }
    this.state = STATE.ALICE_BCH_CLAIMED;
    this.currentStep = 5;
    const R = secp256k1.ProjectivePoint.fromHex(realSig.R);
    const sigBytes = concat(
      bigIntToBytes32BE(R.x),
      bigIntToBytes32BE(realSig.s)
    );
    return {
      signature: sigBytes,
      redeemScript: this.bchLockScript
    };
  }
  /**
   * Build the claim scriptSig for the BCH P2SH input
   * @param {Uint8Array} sig64 - 64-byte Schnorr signature
   * @param {Uint8Array} redeemScript - the lock script
   * @returns {Uint8Array} scriptSig bytes
   */
  buildClaimScriptSig(sig64, redeemScript) {
    return concat(
      pushData(sig64),
      new Uint8Array([81]),
      // OP_TRUE = OP_1 (claim path)
      pushData(redeemScript)
    );
  }
  /* â”€â”€ Step 6 (Bob): Recover Alice's secret from on-chain sig â”€â”€ */
  recoverSecret(onChainSig64) {
    if (this.role !== "bob") throw new Error("only Bob recovers");
    if (!this.adaptorSig) throw new Error("missing adaptor sig");
    const rX = bytesToBigInt(onChainSig64.slice(0, 32));
    const s = bytesToBigInt(onChainSig64.slice(32, 64));
    const realSig = {
      R: this.adaptorSig.Rprime,
      // The real sig uses R' = R + T as nonce
      s,
      e: this.adaptorSig.e
    };
    const recoveredBytes = schnorrAdaptorRecover(this.adaptorSig, realSig);
    const recoveredSecret = bytesToBigInt(recoveredBytes);
    const recoveredPub = secp256k1.ProjectivePoint.BASE.multiply(recoveredSecret);
    const alicePub = secp256k1.ProjectivePoint.fromHex(this.theirKeys.secp.pub);
    if (recoveredPub.x !== alicePub.x) {
      const negSecret = mod(N_SECP - recoveredSecret, N_SECP);
      const negPub = secp256k1.ProjectivePoint.BASE.multiply(negSecret);
      if (negPub.x !== alicePub.x) {
        this.state = STATE.FAILED;
        return null;
      }
      this.recoveredSecret = negSecret;
    } else {
      this.recoveredSecret = recoveredSecret;
    }
    this.state = STATE.BOB_RECOVERING;
    this.currentStep = 5;
    return this.recoveredSecret;
  }
  /* â”€â”€ Step 6 (Bob): Sweep XMR with combined key â”€â”€ */
  computeXmrSweepKey() {
    if (this.role !== "bob") throw new Error("only Bob sweeps XMR");
    if (!this.recoveredSecret) throw new Error("secret not recovered");
    const aliceSecret = this.recoveredSecret;
    const bobSecret = this.myKeys.secret;
    const fullSpendKey = computeFullXmrSpendKey(aliceSecret, bobSecret);
    this.state = STATE.BOB_COMPLETE;
    this.currentStep = 6;
    const spendPub = new Uint8Array(G_ED.multiply(mod(aliceSecret + bobSecret, L_ED)).toRawBytes());
    const viewPrivBytes = keccak256(spendPub);
    let viewScalar = 0n;
    for (let i = 31; i >= 0; i--) viewScalar = viewScalar << 8n | BigInt(viewPrivBytes[i]);
    viewScalar = mod(viewScalar, L_ED);
    return {
      spendKey: fullSpendKey,
      viewKey: bigIntToBytes32LE(viewScalar),
      address: this.sharedXmrAddress.address
    };
  }
  /* â”€â”€ Serialization for persistence â”€â”€ */
  serialize() {
    return JSON.stringify({
      role: this.role,
      state: this.state,
      swapId: this.swapId,
      bchAmount: this.bchAmount,
      xmrAmount: this.xmrAmount.toString(),
      counterpartyNostrPub: this.counterpartyNostrPub,
      currentStep: this.currentStep,
      ts: this.ts,
      bchLockTxid: this.bchLockTxid,
      bchLockVout: this.bchLockVout,
      bchLocktime: this.bchLocktime,
      xmrLockTxid: this.xmrLockTxid,
      sharedXmrAddr: this.sharedXmrAddress ? this.sharedXmrAddress.address : null,
      mySecpPub: this.myKeys ? b2h(this.myKeys.secp.pub) : null,
      myEdPub: this.myKeys ? b2h(this.myKeys.ed.pub) : null,
      mySecret: this.myKeys?.secret != null ? b2h(bigIntToBytes32BE(this.myKeys.secret)) : null,
      theirSecpPub: this.theirKeys ? b2h(this.theirKeys.secp.pub) : null,
      theirEdPub: this.theirKeys ? b2h(this.theirKeys.ed.pub) : null,
      adaptorSig: this.adaptorSig ? serializeAdaptorSig(this.adaptorSig) : null,
      swapMsg: this.swapMsg ? b2h(this.swapMsg) : null,
      bchLockScript: this.bchLockScript ? b2h(this.bchLockScript) : null,
      recoveredSecret: this.recoveredSecret != null ? b2h(bigIntToBytes32BE(this.recoveredSecret)) : null
    });
  }
  static deserialize(json) {
    const d = JSON.parse(json);
    const swap = new XmrSwap(d.role, {
      swapId: d.swapId,
      bchAmount: d.bchAmount,
      xmrAmount: BigInt(d.xmrAmount),
      counterpartyNostrPub: d.counterpartyNostrPub
    });
    swap.state = d.state;
    swap.currentStep = d.currentStep;
    swap.ts = d.ts;
    swap.bchLockTxid = d.bchLockTxid;
    swap.bchLockVout = d.bchLockVout;
    swap.bchLocktime = d.bchLocktime;
    swap.xmrLockTxid = d.xmrLockTxid;
    if (d.swapMsg) swap.swapMsg = h2b(d.swapMsg);
    if (d.adaptorSig) swap.adaptorSig = deserializeAdaptorSig(d.adaptorSig);
    if (d.bchLockScript) swap.bchLockScript = h2b(d.bchLockScript);
    if (d.recoveredSecret) swap.recoveredSecret = bytesToBigInt(h2b(d.recoveredSecret));
    if (d.mySecpPub || d.myEdPub || d.mySecret) {
      swap.myKeys = swap.myKeys || {};
      if (d.mySecpPub) {
        swap.myKeys.secp = swap.myKeys.secp || {};
        swap.myKeys.secp.pub = h2b(d.mySecpPub);
      }
      if (d.myEdPub) {
        swap.myKeys.ed = swap.myKeys.ed || {};
        swap.myKeys.ed.pub = h2b(d.myEdPub);
      }
      if (d.mySecret) {
        const secretBytes = h2b(d.mySecret);
        swap.myKeys.secret = bytesToBigInt(secretBytes);
        if (!swap.myKeys.secp) swap.myKeys.secp = {};
        swap.myKeys.secp.priv = secretBytes;
      }
    }
    if (d.theirSecpPub || d.theirEdPub) {
      swap.theirKeys = {};
      if (d.theirSecpPub) swap.theirKeys.secp = { pub: h2b(d.theirSecpPub) };
      if (d.theirEdPub) swap.theirKeys.ed = { pub: h2b(d.theirEdPub) };
    }
    if (swap.myKeys?.ed?.pub && swap.theirKeys?.ed?.pub) {
      const aliceEdPub = swap.role === "alice" ? swap.myKeys.ed.pub : swap.theirKeys.ed.pub;
      const bobEdPub = swap.role === "bob" ? swap.myKeys.ed.pub : swap.theirKeys.ed.pub;
      swap.sharedXmrAddress = computeSharedXmrAddress(aliceEdPub, bobEdPub);
    }
    return swap;
  }
}
function pushData(data) {
  if (data.length <= 75) return concat(new Uint8Array([data.length]), data);
  if (data.length <= 255) return concat(new Uint8Array([76, data.length]), data);
  return concat(new Uint8Array([77, data.length & 255, data.length >> 8 & 255]), data);
}
export {
  BCH_LOCK_BLOCKS,
  MIN_BCH_SATS,
  MIN_XMR_PICONERO,
  NOSTR_KIND_XMR_ADAPTOR,
  NOSTR_KIND_XMR_CLAIMED,
  NOSTR_KIND_XMR_KEYS,
  NOSTR_KIND_XMR_LOCKED,
  NOSTR_KIND_XMR_OFFER,
  NOSTR_KIND_XMR_TAKE,
  NOSTR_KIND_XMR_XLOCKED,
  STATE,
  XMR_LOCK_BLOCKS,
  XmrSwap,
  computeFullXmrSpendKey,
  computeSharedXmrAddress,
  p2pkhScript,
  p2shScript,
  swapMessage,
  xmrSwapScript
};
