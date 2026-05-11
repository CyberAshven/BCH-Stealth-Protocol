# 00 Wallet

> Self-custody crypto wallet & privacy suite — no servers, no accounts, runs entirely in your browser.

**Live → [0penw0rld.com](https://0penw0rld.com)** · `v0.1.0-beta`

---

## What it is

00 Wallet is a browser-native PWA built without any framework or build step. Every key is generated locally, every cryptographic operation happens client-side. No analytics, no tracking, no KYC, no backend.

It ships a suite of privacy primitives on top of a standard HD wallet — stealth payments, P2P CoinJoin, onion-routed payments, encrypted chat, and atomic swaps — all coordinated peer-to-peer over Nostr.

---

## Features

| Feature | Description |
|---|---|
| **HD Wallet** | BIP44 multi-chain — BCH, BTC, ETH, XMR, USDT, USDC. Seed backup, UTXO coin control, Ledger hardware support |
| **Stealth Payments** | Beaconless ECDH stealth addresses on BCH. No OP_RETURN required — outputs are indistinguishable from standard P2PKH |
| **P2P CashFusion** | CoinJoin coordinated over Nostr with gift-wrapped messages (NIP-59). No central coordinator — peers self-elect via lowest ephemeral pubkey |
| **Onion Payments** | Multi-hop payments using HTLC contracts and onion-routed paths over Nostr |
| **Encrypted Chat** | Split-knowledge messaging — half on-chain (OP_RETURN), half via Nostr. Neither side can read the message alone |
| **Atomic Swaps** | On-chain HTLC swaps BCH ↔ BTC and BCH ↔ XMR. Peer-to-peer orderbook on Nostr |
| **DEX** | Cauldron DEX integration — on-chain BCH/token swaps |
| **Lending** | Moria Protocol — borrow MUSD against BCH collateral, fully on-chain |
| **Vault** | Stealth multisig using MuSig2 key aggregation, state synced over Nostr |
| **Identity** | Sovereign DID — Nostr keypair as identity, shareable profile with BCH address and stealth paycode |
| **Mesh** | Nostr social — posts, DMs, relay management |

---

## Privacy Architecture

### Stealth Payments (BIP352 aggregated ECDH)
Each payment derives a unique, unlinkable P2PKH address. The receiver performs **1 ECDH per TX** regardless of input count (5–10× faster than per-input scanning):

```
BCH Stealth Protocol — Final v2 Spec
═════════════════════════════════════

SCOPE
─────
BCH-native stealth payments using ECDH-derived one-time P2PKH outputs.
NOT wire-compatible with BIP-352 silent payments (BTC); BCH has no Taproot.
Cryptographic structure derived from BIP-352; output format native to BCH.

CONSTANTS
─────────
N             = secp256k1 group order
G             = secp256k1 generator
TAG_h         = "00proto/stealth/inputs"
TAG_t         = "00proto/stealth/shared"
TAG_label     = "00proto/stealth/label"
H_tag(tag,m)  = SHA256( SHA256(tag) || SHA256(tag) || m )    // BIP-340 tagged
GAP           = 3   // consecutive-miss gap-limit for output index scan

KEYS  (per account a, account-rotatable)
────────────────────────────────────────
b_scan        = m/352'/145'/a'/1'/0
B_scan        = b_scan · G
b_spend       = m/352'/145'/a'/0'/0
B_spend       = b_spend · G

PAYCODE  (wire format, identical for labeled and unlabeled)
───────────────────────────────────────────────────────────
"stealth:" || ser33(B_scan) || ser33(B_spend_m)

For unlabeled global paycode, m = 0:
  tweak_0   = 0
  B_spend_0 = B_spend

For labeled paycode, m ≥ 1:
  tweak_m   = H_tag(TAG_label, b_scan || ser32BE(m))   mod N
  B_spend_m = B_spend + tweak_m · G

No version tag on the wire. Receivers MAY trial both v1 (untagged hashes)
and v2 (tagged hashes) crypto during a deprecation window.

INPUT WEIGHTING  (sender and receiver, same rules)
──────────────────────────────────────────────────
op_min = byte-lex min{ outpoint_i }
         outpoint_i = txid_internal_LE(32) || vout_LE(4)
         over ALL tx inputs (including non-contributing peer inputs)

For each input i, contribution is:
  case P2PKH (33-byte compressed pubkey P_i in scriptSig):
    h_i  = H_tag(TAG_h, op_min || P_i)        mod N
    contributes scalar h_i · a_i and point h_i · P_i

  case P2SH-multisig (revealed redeemScript with compressed keys K_j):
    h_i_j = H_tag(TAG_h, op_min || K_j || ser32BE(j))   mod N
    contributes scalar Σ_j h_i_j · k_j  (using only the keys the
      signer holds; others contribute as h_i_j · K_j on the point side
      via signature-extracted pubkeys, which is consistent for receiver)
    contributes point Σ_j h_i_j · K_j

  case other:
    no contribution. Tx is still scan-eligible if ≥1 input contributes.

  Precondition for sender: own inputs MUST collectively contribute.

a_sum = Σ ( scalar contributions of sender's own inputs )   mod N
A_sum = Σ ( point  contributions of ALL contributing inputs )

SENDER
──────
  shared       = a_sum · B_scan                  // single ECDH
  sharedX      = x-coord(shared)
  For each stealth output k = 0,1,2,…:
    t_k        = H_tag(TAG_t, sharedX || ser32BE(k))   mod N
    output_k   = P2PKH( B_spend_m + t_k · G )

  Self-change outputs use the SAME path with own (B_scan, B_spend).

RECEIVER
────────
  Scan modes (decreasing privacy):
    A. Local BCHN / own indexer — leaks nothing.        (recommended)
    B. Full-block fetch via Fulcrum — leaks "scans chain"
       but NOT which paycode.                           (acceptable)
    C. Per-tx fetch against third-party Fulcrum —
       FORBIDDEN unless via Tor with rotating circuits.
  Optional NIP-59 gift-wrapped Nostr beacon hint may accompany A/B/C
  for latency; never authoritative.

  For each candidate tx:
    Recompute op_min, the contributing input set, A_sum.
    If A_sum is the identity (no contributing inputs), skip.
    shared       = b_scan · A_sum
    sharedX      = x-coord(shared)

    miss_streak = 0
    For k = 0, 1, 2, …:
      t_k        = H_tag(TAG_t, sharedX || ser32BE(k))   mod N
      matched_this_k = false
      For each m ∈ { 0 } ∪ stored_labels:
        P_out    = B_spend_m + t_k · G
        h160     = HASH160(ser33(P_out))
        if any tx output is P2PKH(h160):
          record { txid, vout, value, k, m }
          spendPriv = ( b_spend + tweak_m + t_k )   mod N
          matched_this_k = true
      if matched_this_k: miss_streak = 0
      else:              miss_streak += 1
      if miss_streak ≥ GAP: break

STORAGE
───────
  Stealth UTXO cache MUST NOT store privkeys in plaintext at rest.
  Either encrypt under the vault key, or store only
  { addr, k, m, txid, vout, value } and re-derive privkey on spend.

RECOMMENDED PRIVACY FLOW
────────────────────────
  payer ──stealth send──▶ recipient stealth UTXO
                            │
                            └─CashFusion──▶ multiple fresh stealth UTXOs
  Single stealth receive without subsequent fusion provides
  sender↔recipient unlinkability but not amount/timing unlinkability.
```

No OP_RETURN, or notification transaction. Outputs are indistinguishable from standard P2PKH.

**Paycode format:**
```
stealth:<scan_pubkey_hex_33bytes><spend_pubkey_hex_33bytes>
```

**Key paths (BIP352-style):**
```
m/352'/145'/0'/1'/0   ← scan key  (hardened, isolated tree)
m/352'/145'/0'/0'/0   ← spend key (hardened, isolated tree)
```

### P2P CashFusion
CoinJoin with zero central infrastructure:

1. Wallets broadcast a pool announcement (`kind:22230`) with an ephemeral pubkey on Nostr
2. After a random delay (0–180s), all participants sort ephemeral pubkeys → **lowest = round coordinator**
3. Coordinator sends `round_start` gift-wrapped (NIP-59) to each peer
4. Inputs are collected, outputs are routed via onion layers
5. Coordinator assembles the unsigned TX, collects partial signatures, broadcasts

Each output goes to a fresh stealth address. No coordinator server, no relay dependency.

---

## Tech Stack

- **Pure HTML/CSS/JS** — no framework, no build step, no bundler
- **PWA** — installable, offline-capable via Service Worker
- **[@noble/curves](https://github.com/paulmillr/noble-curves)** — secp256k1, X25519, Ed25519, Schnorr
- **[@noble/hashes](https://github.com/paulmillr/noble-hashes)** — SHA-256, RIPEMD-160, HMAC, PBKDF2, Keccak
- **[Fulcrum ElectrumX](https://github.com/cculianu/Fulcrum)** — blockchain queries over WebSocket
- **[Nostr](https://nostr.com)** — peer coordination, notifications, social
- **[monero-ts](https://github.com/monero-ecosystem/monero-ts)** — XMR wallet scanning & atomic swap support
- **[esm.sh](https://esm.sh)** — runtime ES module delivery, zero bundling

---

## Security

| Concern | Approach |
|---|---|
| Key generation | `crypto.getRandomValues()` — OS entropy |
| Key storage | AES-256-GCM, PBKDF2-SHA256 (200k iterations), unique salt + IV, stored in `localStorage` |
| BIP39 | 2,048 PBKDF2-SHA512 iterations → BIP32 master → BIP44 derivation |
| Sessions | 30-minute TTL — no persistent plaintext keys in memory |
| Stealth isolation | Hardened derivation — scan key compromise cannot expose spend key |
| No telemetry | Zero analytics, no third-party requests, no tracking |

---

## Run

```bash
# Option 1 — just open the live app
# https://0penw0rld.com

# Option 2 — serve locally
npx serve landing

# Option 3 — any static file server
cd landing && python3 -m http.server 8080
```

No build step, no `npm install` required.

---

## Structure

```
landing/
├── index.html              SPA shell (entry point)
├── v2.html                 SPA shell v2
├── app.js                  Boot, router, module loader
├── shell.js                Sidebar, nav, shared UI
├── desktop.css             Layout + CSS variables (light/dark)
├── chains.js               Multi-chain config (BCH/BTC/ETH/XMR...)
├── sw.js                   Service Worker (PWA/offline)
├── manifest.json           PWA manifest
│
├── core/                   Cryptographic primitives
│   ├── auth.js             Vault encryption, session management
│   ├── stealth.js          ECDH stealth derivation + scanning
│   ├── send-bch.js         BCH transaction builder
│   ├── addr-derive.js      HD address derivation
│   └── ...                 Multi-chain send, XMR keys, Polymarket
│
├── views/                  SPA views (lazy-loaded)
│   ├── wallet.js           Wallet — balances, TX history, UTXO
│   ├── fusion.js           P2P CashFusion (CoinJoin)
│   ├── onion.js            Onion-routed payments
│   ├── chat.js             Split-knowledge encrypted chat
│   ├── swap.js             Atomic swaps BCH ↔ BTC / XMR
│   ├── sub.js              Subscriptions
│   ├── bet.js              Prediction markets (Polymarket)
│   └── ...                 DEX, loan, vault, mesh, identity
│
├── services/               Background services
│   ├── balance-service.js  HD address scanner, live balance
│   ├── hd-scanner.js       Gap-limit HD derivation scanner
│   └── xmr-scanner.js      XMR subaddress scanner
│
├── lib/                    WASM bundles (Monero)
├── icons/                  PWA + coin icons
├── ws-bridge.js            Fulcrum WebSocket bridge
└── ws-shared.js            Shared WebSocket utilities
```

---

## Roadmap

- [ ] Atomic swap UX improvements
- [ ] Mobile layout
- [ ] v1.0.0-beta — full test coverage

---

## License

MIT
