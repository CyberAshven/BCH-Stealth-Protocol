// wizardconnect.js â€” WizardConnect protocol + WalletConnect v2 global bridge
// Loaded as a plain <script> in index.html (non-module).
// Provides window.WizardConnect with:
//   - Basic session stub (isConnected, onSession, _setSession)
//   - WalletManager: shows QR code for dapps to scan
//   - DappManager: connects to external wallet by pasting wiz:// URI
//
// Transport: Nostr relays (kind 24133, ephemeral events)
// Crypto: secp256k1 ECDH key exchange (noble-curves, lazy import) + AES-256-GCM (Web Crypto)
(function () {
  'use strict';

  /* â”€â”€ Relay list â”€â”€ */
  const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social'];
  const WIZ_KIND = 24133;

  /* â”€â”€ Byte helpers â”€â”€ */
  function _hex(b: Uint8Array) { return Array.from(b, (x: number) => x.toString(16).padStart(2, '0')).join(''); }
  function _h2b(h) { const a = new Uint8Array(h.length >> 1); for (let i = 0; i < h.length; i += 2) a[i >> 1] = parseInt(h.slice(i, i + 2), 16); return a; }
  function _rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }

  /* â”€â”€ SHA-256 via Web Crypto (no import needed) â”€â”€ */
  async function _sha256bytes(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return new Uint8Array(buf);
  }

  /* â”€â”€ Lazy noble-curves secp256k1 import â”€â”€ */
  let _secp256k1 = null;
  async function _secp() {
    if (!_secp256k1) {
      const m = await import('./lib/noble-curves.js');
      _secp256k1 = m.secp256k1;
    }
    return _secp256k1;
  }

  /* â”€â”€ Generate ephemeral keypair with even y (02 prefix) â”€â”€ */
  async function _genKeypair() {
    const secp = await _secp();
    let priv = _rand(32);
    let pub = secp.getPublicKey(priv, true);
    // Force even y for x-only Nostr key compatibility
    if (pub[0] === 0x03) {
      const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
      let p = 0n;
      for (const b of priv) p = (p << 8n) | BigInt(b);
      p = (N - p) % N;
      priv = _h2b(p.toString(16).padStart(64, '0'));
      pub = secp.getPublicKey(priv, true);
    }
    const xonly = pub.slice(1); // 32 bytes (x-coordinate only)
    return { priv, pub, xonly, xonlyHex: _hex(xonly), pubHex: _hex(pub) };
  }

  /* â”€â”€ ECDH shared secret (x-coordinate of point) â”€â”€ */
  async function _ecdh(myPriv, theirPub33Hex) {
    const secp = await _secp();
    return secp.getSharedSecret(myPriv, _h2b(theirPub33Hex)).slice(1); // 32 bytes
  }

  /* â”€â”€ AES-256-GCM encrypt/decrypt â”€â”€ */
  async function _aesKey(keyBytes) {
    return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  async function _encrypt(keyBytes, obj) {
    const key = await _aesKey(keyBytes);
    const iv = _rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
      new TextEncoder().encode(JSON.stringify(obj)));
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv); out.set(new Uint8Array(ct), 12);
    return btoa(String.fromCharCode(...out));
  }
  async function _decrypt(keyBytes, b64) {
    const key = await _aesKey(keyBytes);
    // Accept both base64 and base64url payloads from external WizardConnect peers.
    const normalized = String(b64 || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  /* â”€â”€ Build & sign a Nostr event (NIP-01) â”€â”€ */
  async function _makeNostrEvent(priv, xonlyHex, kind, tags, content) {
    const secp = await _secp();
    const created_at = Math.floor(Date.now() / 1000);
    const ser = JSON.stringify([0, xonlyHex, created_at, kind, tags, content]);
    const idBytes = await _sha256bytes(ser);
    const sig = secp.schnorr.sign(idBytes, priv);
    return { id: _hex(idBytes), pubkey: xonlyHex, created_at, kind, tags, content, sig: _hex(sig) };
  }

  /* â”€â”€ Simple Nostr relay WebSocket â”€â”€ */
  function _openRelay(url, onEvent, onOpen) {
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => onOpen?.(ws);
      ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m[0] === 'EVENT') onEvent?.(m[2]); } catch {} };
      ws.onerror = ws.onclose = () => {};
      return ws;
    } catch { return null; }
  }
  function _subscribe(ws, subId, filters) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(['REQ', subId, ...filters]));
  }
  function _publish(wsList, event) {
    for (const ws of wsList) { try { if (ws?.readyState === 1) ws.send(JSON.stringify(['EVENT', event])); } catch {} }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     WalletManager â€” shows QR code, receives sign requests
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
  class WalletManager {
    _priv: Uint8Array | null;
    _xonlyHex: string | null;
    _pubHex: string | null;
    _sessionId: string | null;
    _dappPubHex: string | null;
    _sharedKey: Uint8Array | null;
    _relays: WebSocket[];
    _subId: string | null;
    _dappName: string | null;
    _onConnect: ((name: string) => void) | null;
    _onSignReq: ((payload: any) => void) | null;
    _onDisconnect: (() => void) | null;
    _stealthSpendXpub: string | null;
    _stealthScanXpub: string | null;

    constructor() {
      this._priv = null; this._xonlyHex = null; this._pubHex = null;
      this._sessionId = null; this._dappPubHex = null; this._sharedKey = null;
      this._relays = []; this._subId = null; this._dappName = null;
      this._onConnect = null; this._onSignReq = null; this._onDisconnect = null;
      this._stealthSpendXpub = null; this._stealthScanXpub = null;
    }

    /** Set stealth xpubs for WizardConnect hdwalletv1 capability advertisement. Call after wallet unlock. */
    setStealthXpubs(spendXpub: string, scanXpub: string) {
      this._stealthSpendXpub = spendXpub; this._stealthScanXpub = scanXpub;
    }

    /** Generate a new wiz:// URI and QR code data. Call before startListening(). */
    async generateConnection() {
      const kp = await _genKeypair();
      this._priv = kp.priv; this._xonlyHex = kp.xonlyHex; this._pubHex = kp.pubHex;
      this._sessionId = _hex(_rand(16));
      const uri = `wiz://?p=${kp.pubHex}&s=${this._sessionId}&r=${encodeURIComponent(RELAYS[0])}`;
      return { uri, qrUri: uri };
    }

    /** Open relay connections and wait for a dapp to connect. */
    startListening() {
      if (!this._sessionId) return;
      const sid = this._sessionId;
      this._subId = 'wiz-' + _hex(_rand(8));

      const onEvent = async (ev) => {
        if (!ev?.content || !ev?.tags) return;
        if (!ev.tags.find(t => t[0] === 's' && t[1] === sid)) return;

        // First message: derive shared key from dapp's Nostr pubkey (xonly â†’ 02+xonly)
        if (!this._sharedKey) {
          if (!ev.pubkey || ev.pubkey.length !== 64) return;
          this._dappPubHex = '02' + ev.pubkey;
          try { this._sharedKey = await _ecdh(this._priv, this._dappPubHex); } catch { return; }
        }

        let payload;
        try { payload = await _decrypt(this._sharedKey, ev.content); } catch { return; }

        const isConnect = payload?.type === 'connect' || payload?.action === 'connect_request';
        const isSignReq = payload?.type === 'sign_req' || payload?.action === 'sign_transaction_request' || payload?.action === 'sign_request';
        const isDisconnect = payload?.type === 'disconnect' || payload?.action === 'disconnect_request' || payload?.action === 'disconnect';

        if (isConnect) {
          this._dappName = payload.name || 'Dapp';
          this._onConnect?.(this._dappName);
          // Build hdwalletv1 session with stealth capability advertisement if available
          const paths: any[] = [];
          const extensions: Record<string, unknown> = {};
          if (this._stealthSpendXpub && this._stealthScanXpub) {
            paths.push({ name: 'stealth_spend', xpub: this._stealthSpendXpub });
            paths.push({ name: 'stealth_scan',  xpub: this._stealthScanXpub });
            extensions['bch_stealth_bip352'] = {
              spend_path: "m/352'/145'/0'/0'",
              scan_path:  "m/352'/145'/0'/1'"
            };
          }
          const session = paths.length
            ? { hdwalletv1: { paths, ...(Object.keys(extensions).length ? { extensions } : {}) } }
            : undefined;
          const respPayload: any = {
            type: 'wallet_ready',
            action: 'wallet_ready',
            time: Math.floor(Date.now() / 1000),
            name: '00 Wallet',
            icon: ''
          };
          if (session) respPayload.session = session;
          const resp = await _encrypt(this._sharedKey, respPayload);
          const ev2 = await _makeNostrEvent(this._priv, this._xonlyHex, WIZ_KIND,
            [['s', sid], ['p', ev.pubkey]], resp);
          _publish(this._relays, ev2);
        } else if (isSignReq) {
          const norm = {
            ...payload,
            sequence: payload.sequence ?? payload.seq ?? null,
            seq: payload.seq ?? payload.sequence ?? null,
            signedTx: payload.signedTx || payload.signedTransaction || payload.tx || ''
          };
          this._onSignReq?.(norm);
        } else if (isDisconnect) {
          this._onDisconnect?.();
        }
      };

      for (const url of RELAYS) {
        const ws = _openRelay(url, onEvent, (ws) => {
          _subscribe(ws, this._subId, [{ kinds: [WIZ_KIND], '#s': [sid] }]);
        });
        if (ws) this._relays.push(ws);
      }
    }

    onConnect(cb) { this._onConnect = cb; }
    onSignRequest(cb) { this._onSignReq = cb; }
    onDisconnect(cb) { this._onDisconnect = cb; }
    getDappName() { return this._dappName; }

    async approveSign(seq, signedTx) {
      if (!this._sharedKey || !this._sessionId || !this._dappPubHex) return;
      const c = await _encrypt(this._sharedKey, {
        type: 'sign_resp',
        action: 'sign_transaction_response',
        time: Math.floor(Date.now() / 1000),
        seq,
        sequence: seq,
        status: 'ok',
        signed: signedTx,
        signedTransaction: signedTx
      });
      const ev = await _makeNostrEvent(this._priv, this._xonlyHex, WIZ_KIND,
        [['s', this._sessionId], ['p', this._dappPubHex.slice(2)]], c);
      _publish(this._relays, ev);
    }

    async rejectSign(seq, reason) {
      if (!this._sharedKey || !this._sessionId || !this._dappPubHex) return;
      const c = await _encrypt(this._sharedKey, {
        type: 'sign_resp',
        action: 'sign_transaction_response',
        time: Math.floor(Date.now() / 1000),
        seq,
        sequence: seq,
        status: 'rejected',
        reason: reason || 'Rejected'
      });
      const ev = await _makeNostrEvent(this._priv, this._xonlyHex, WIZ_KIND,
        [['s', this._sessionId], ['p', this._dappPubHex.slice(2)]], c);
      _publish(this._relays, ev);
    }

    destroy() { for (const ws of this._relays) try { ws.close(); } catch {} this._relays = []; }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     DappManager â€” scans/pastes wiz:// URI, initiates connection
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
  class DappManager {
    _name: string;
    _icon: string;
    _priv: Uint8Array | null;
    _xonlyHex: string | null;
    _walletPubHex: string | null;
    _sessionId: string | null;
    _sharedKey: Uint8Array | null;
    _relays: WebSocket[];
    _subId: string | null;
    _onConnect: ((walletName: string, walletIcon: string, paths: any[]) => void) | null;
    _onDisconnect: ((reason?: string) => void) | null;

    constructor(name, icon) {
      this._name = name || 'Dapp'; this._icon = icon || '';
      this._priv = null; this._xonlyHex = null;
      this._walletPubHex = null; this._sessionId = null; this._sharedKey = null;
      this._relays = []; this._subId = null;
      this._onConnect = null; this._onDisconnect = null;
    }

    onConnect(cb) { this._onConnect = cb; }
    onDisconnect(cb) { this._onDisconnect = cb; }

    /** Parse a wiz:// URI and connect to the wallet. */
    async connect(uri) {
      const rawUri = String(uri || '').trim();
      let wizUri = rawUri;
      if (!/^wiz:\/\//i.test(wizUri)) {
        try {
          const decoded = decodeURIComponent(wizUri);
          if (/^wiz:\/\//i.test(decoded)) wizUri = decoded;
        } catch {}
      }
      let params;
      try {
        params = new URL(wizUri.replace(/^wiz:\/\//i, 'https://wiz.local/')).searchParams;
      } catch { throw new Error('Invalid wiz:// URI'); }

      let walletPub = (params.get('p') || '').trim().replace(/^0x/i, '');
      const sessionId = params.get('s');
      const relayUrl = (params.get('r') || '').trim() || RELAYS[0];
      if (!walletPub || !sessionId) throw new Error('Missing p or s in wiz:// URI');
      if (walletPub.length === 64) walletPub = '02' + walletPub;
      if (walletPub.length !== 66) throw new Error('Invalid p in wiz:// URI');

      this._walletPubHex = walletPub;
      this._sessionId = sessionId;

      const kp = await _genKeypair();
      this._priv = kp.priv; this._xonlyHex = kp.xonlyHex;
      this._sharedKey = await _ecdh(kp.priv, walletPub);
      this._subId = 'wizd-' + _hex(_rand(8));

      const onEvent = async (ev) => {
        if (!ev?.content || !ev?.tags) return;
        if (!ev.tags.find(t => t[0] === 's' && t[1] === sessionId)) return;
        let payload;
        try { payload = await _decrypt(this._sharedKey, ev.content); } catch { return; }
        if (payload.type === 'connected' || payload.type === 'wallet_ready' || payload.action === 'wallet_ready') {
          this._onConnect?.(payload.name || 'Wallet', payload.icon || '', payload.session?.hdwalletv1?.paths || payload.paths || []);
        } else if (payload.type === 'disconnect' || payload.action === 'disconnect' || payload.action === 'disconnect_response') {
          this._onDisconnect?.(payload.reason || 'Disconnected');
        }
      };

      const relayList = [relayUrl, ...RELAYS.filter(r => r !== relayUrl)].slice(0, 3);
      for (const url of relayList) {
        const ws = _openRelay(url, onEvent, async (ws) => {
          _subscribe(ws, this._subId, [{ kinds: [WIZ_KIND], '#s': [sessionId] }]);
          // Send connect request
          const content = await _encrypt(this._sharedKey, {
            type: 'connect',
            action: 'connect_request',
            time: Math.floor(Date.now() / 1000),
            name: this._name,
            icon: this._icon
          });
          const walletXonly = walletPub.slice(2); // strip 02/03 prefix for Nostr p-tag
          const ev = await _makeNostrEvent(kp.priv, kp.xonlyHex, WIZ_KIND,
            [['s', sessionId], ['p', walletXonly]], content);
          if (ws.readyState === 1) ws.send(JSON.stringify(['EVENT', ev]));
        });
        if (ws) this._relays.push(ws);
      }
    }

    destroy() { for (const ws of this._relays) try { ws.close(); } catch {} this._relays = []; }
  }

  /* â”€â”€ Initialize or extend window.WizardConnect â”€â”€ */
  if (!window.WizardConnect) {
    window.WizardConnect = {
      version: '2.0',
      _session: null,
      _listeners: [],
      isConnected() { return !!this._session; },
      onSession(fn) { this._listeners.push(fn); },
      _setSession(s) { this._session = s; this._listeners.forEach(fn => { try { fn(s); } catch {} }); },
    };
  }
  window.WizardConnect.WalletManager = WalletManager;
  window.WizardConnect.DappManager = DappManager;
})();

