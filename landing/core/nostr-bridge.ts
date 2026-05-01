/* ══════════════════════════════════════════
   00 Wallet — Nostr Bridge (SharedWorker + Fallback)
   ══════════════════════════════════════════
   Tries SharedWorker first. Falls back to main-thread
   relay pool if SharedWorker not available.

   API:
     nostrInit(relays)                         → connect to relays
     nostrSubscribe(filters, callback)         → Promise<subId>
     nostrUnsubscribe(subId)                   → void
     nostrPublish(event)                       → void
     nostrOnStatus(callback)                   → unsubscribe fn
     nostrStatus()                             → {connected, relays[], relayCount}
   ══════════════════════════════════════════ */

type NostrEvent = Record<string, unknown>;
type SubCallback = (event: NostrEvent, subId: string) => void;
type StatusCallback = (status: { connected: boolean; relays: Array<{ url: string; connected: boolean }>; relayCount: number }) => void;
type OkCallback = (success: boolean, message: string) => void;

let _mode: 'worker' | 'fallback' | null = null;
let _worker: SharedWorker | null = null, _port: MessagePort | null = null;
let _clientSubId = 0;

const _pendingSubs = new Map<number, { resolve: (subId: string) => void; callback: SubCallback }>();
const _activeSubs = new Map<string, SubCallback>();
const _statusListeners = new Set<StatusCallback>();
const _okCallbacks = new Map<string, OkCallback>();
let _lastStatus: { connected: boolean; relays: Array<{ url: string; connected: boolean }>; relayCount: number } = { connected: false, relays: [], relayCount: 0 };

/* ══════════════════════════════════════════
   FALLBACK: Main-thread relay pool
   ══════════════════════════════════════════ */
type RelayEntry = { ws: WebSocket | null; connected: boolean };
let _fbRelays: Record<string, RelayEntry> = {};
let _fbRelayUrls: string[] = [];
let _fbSubId = 0;
const _fbSubs = new Map<string, { filters: unknown[]; callback: SubCallback }>();
const _fbSeen = new Set<string>();

function _fbConnect(url: string): void {
  const existing = _fbRelays[url];
  if (existing?.ws && (existing.ws.readyState === 0 || existing.ws.readyState === 1)) return; // connecting or open
  const r = { ws: null, connected: false };
  _fbRelays[url] = r;
  try {
    const ws = new WebSocket(url);
    r.ws = ws;
    ws.onopen = () => {
      r.connected = true;
      _fbBroadcastStatus();
      // Re-send all subscriptions
      for (const [subId, sub] of _fbSubs) {
        ws.send(JSON.stringify(['REQ', subId, ...sub.filters]));
      }
    };
    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg[0] === 'EVENT' && msg[2]) {
          const ev = msg[2], sid = msg[1];
          // Dedup per sub+event (not global) to allow same event in multiple subs
          const dedupKey = ev.id + ':' + sid;
          if (_fbSeen.has(dedupKey)) return;
          _fbSeen.add(dedupKey);
          if (_fbSeen.size > 5000) { const a = [..._fbSeen]; _fbSeen.clear(); for (let i = a.length - 2500; i < a.length; i++) _fbSeen.add(a[i]); }
          // Route to matching subscription
          const sub = _fbSubs.get(sid);
          if (sub?.callback) { try { sub.callback(ev, sid); } catch {} }
        }
        else if (msg[0] === 'OK' && msg[1]) {
          const cb = _okCallbacks.get(msg[1]);
          if (cb) { _okCallbacks.delete(msg[1]); cb(msg[2], msg[3]); }
        }
      } catch {}
    };
    ws.onclose = () => { r.connected = false; r.ws = null; _fbBroadcastStatus(); setTimeout(() => _fbConnect(url), 5000); };
    ws.onerror = () => {};
  } catch {}
}

function _fbBroadcastStatus(): void {
  const relays = _fbRelayUrls.map(url => ({ url, connected: !!_fbRelays[url]?.connected }));
  _lastStatus = { connected: relays.some(r => r.connected), relays, relayCount: relays.filter(r => r.connected).length };
  for (const cb of _statusListeners) { try { cb(_lastStatus); } catch {} }
}

function _fbInit(relays: string[]): void {
  _fbRelayUrls = relays;
  for (const url of relays) _fbConnect(url);
}

function _fbSubscribe(filters: unknown[], callback: SubCallback): string {
  const subId = 'nsub_' + (++_fbSubId);
  _fbSubs.set(subId, { filters, callback });
  for (const url of _fbRelayUrls) {
    const r = _fbRelays[url];
    if (r?.ws?.readyState === 1) r.ws.send(JSON.stringify(['REQ', subId, ...filters]));
  }
  return subId;
}

function _fbUnsubscribe(subId: string): void {
  _fbSubs.delete(subId);
  for (const url of _fbRelayUrls) {
    const r = _fbRelays[url];
    if (r?.ws?.readyState === 1) try { r.ws.send(JSON.stringify(['CLOSE', subId])); } catch {}
  }
}

function _fbPublish(event: NostrEvent): void {
  const msg = JSON.stringify(['EVENT', event]);
  for (const url of _fbRelayUrls) {
    const r = _fbRelays[url];
    if (r?.ws?.readyState === 1) try { r.ws.send(msg); } catch {}
  }
}

/* ══════════════════════════════════════════
   SHAREDWORKER MODE
   ══════════════════════════════════════════ */
function _swHandleMessage(ev: MessageEvent): void {
  const msg = ev.data;
  if (msg.type === 'status') {
    _lastStatus = msg;
    for (const cb of _statusListeners) { try { cb(msg); } catch {} }
  }
  else if (msg.type === 'subscribed') {
    const pending = _pendingSubs.get(msg.clientSubId as number);
    if (pending) { _pendingSubs.delete(msg.clientSubId as number); _activeSubs.set(msg.subId as string, pending.callback); pending.resolve(msg.subId as string); }
  }
  else if (msg.type === 'event') {
    const cb = _activeSubs.get(msg.subId);
    if (cb) { try { cb(msg.event, msg.subId); } catch {} }
  }
  else if (msg.type === 'ok') {
    const cb = _okCallbacks.get(msg.eventId);
    if (cb) { _okCallbacks.delete(msg.eventId); cb(msg.success, msg.message); }
  }
}

/* ══════════════════════════════════════════
   PUBLIC API
   ══════════════════════════════════════════ */
export function nostrInit(relays: string[]): void {
  // Allow re-init if not connected yet
  if (_mode === 'fallback' && _lastStatus.connected) return;

  if (!relays || !relays.length) {
    console.warn('[nostr] No relays provided, using defaults');
    relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
  }
  _mode = 'fallback';
  _fbInit(relays);
  console.log('[nostr] Relay pool initialized ✓ (' + relays.length + ' relays)');
}

export function nostrSubscribe(filters: unknown[], callback: SubCallback): Promise<string | null> {
  if (_mode === 'fallback') {
    const subId = _fbSubscribe(filters, callback);
    return Promise.resolve(subId);
  }
  if (_mode === 'worker') {
    const clientSubId = ++_clientSubId;
    return new Promise(resolve => {
      _pendingSubs.set(clientSubId, { resolve, callback });
      _port.postMessage({ type: 'subscribe', filters, clientSubId });
    });
  }
  return Promise.resolve(null);
}

export function nostrUnsubscribe(subId: string | null | undefined): void {
  if (!subId) return;
  if (_mode === 'fallback') { _fbUnsubscribe(subId); return; }
  if (_mode === 'worker') { _activeSubs.delete(subId); _port.postMessage({ type: 'unsubscribe', subId }); }
}

export function nostrPublish(event: NostrEvent, onOk?: OkCallback): void {
  if (onOk && event.id) _okCallbacks.set(event.id, onOk);
  if (_mode === 'fallback') { _fbPublish(event); return; }
  if (_mode === 'worker') { _port.postMessage({ type: 'publish', event }); }
}

export function nostrOnStatus(callback: StatusCallback): () => boolean {
  _statusListeners.add(callback);
  callback(_lastStatus);
  return () => _statusListeners.delete(callback);
}

export function nostrStatus(): typeof _lastStatus { return _lastStatus; }

export function nostrUpdateRelays(relays: string[]): void {
  if (_mode === 'fallback') {
    // Close old, connect new
    for (const url of _fbRelayUrls) { const r = _fbRelays[url]; if (r?.ws) try { r.ws.close(); } catch {} }
    _fbRelays = {}; _fbRelayUrls = [];
    _fbInit(relays);
    return;
  }
  if (_mode === 'worker') { _port.postMessage({ type: 'updateRelays', relays }); }
}

export function nostrIsConnected(): boolean { return _lastStatus.connected; }
export function nostrMode(): 'worker' | 'fallback' | null { return _mode; }

/* ── Legacy window.* API ── */
if (typeof window !== 'undefined') {
  (window as any)._nostrInit = nostrInit;
  (window as any)._nostrPublish = nostrPublish;
  (window as any)._nostrSubscribe = nostrSubscribe;
  (window as any)._nostrUnsubscribe = nostrUnsubscribe;
  (window as any)._nostrOnStatus = nostrOnStatus;
  (window as any)._nostrStatus = nostrStatus;
  (window as any)._nostrUpdateRelays = nostrUpdateRelays;
  (window as any)._nostrIsConnected = nostrIsConnected;
}

