// 0penw0rld SharedWorker — persistent Nostr relay connections
// Survives page navigations. One set of relay connections shared across all tabs/views.
// Pattern copied from ws-shared.js (proven Fulcrum SharedWorker).

type NostrFilter = { ids?: string[]; authors?: string[]; kinds?: number[]; since?: number; until?: number; [key: string]: unknown };

type RelayState = { ws: WebSocket | null; connected: boolean; reconnectTimer: ReturnType<typeof setTimeout> | undefined; connectTimer: ReturnType<typeof setTimeout> | undefined };
type SubState = { _portId: number; filters: NostrFilter[]; relaySubId: string };
type NostrEvent = Record<string, unknown>;

const relays: Record<string, RelayState> = {};
let relayUrls: string[] = [];
let _portId = 0;
const ports = new Map<number, MessagePort>();

const subscriptions = new Map<string, SubState>();
let subIdCounter = 0;

// Event dedup (capped ring buffer)
const seenEvents = new Set();
const SEEN_MAX = 5000;
const SEEN_PRUNE = 2500;

function addSeen(id: string): void {
  seenEvents.add(id);
  if (seenEvents.size > SEEN_MAX) {
    const arr = [...seenEvents];
    seenEvents.clear();
    for (let i = arr.length - SEEN_PRUNE; i < arr.length; i++) seenEvents.add(arr[i]);
  }
}

// ── Connect to a single relay ──
function connectRelay(url: string): void {
  if (relays[url] && relays[url].ws) return; // already connected/connecting

  const r: RelayState = relays[url] || { ws: null, connected: false, connectTimer: undefined, reconnectTimer: undefined };
  relays[url] = r;

  try {
    const ws = new WebSocket(url);
    r.ws = ws;

    r.connectTimer = setTimeout(() => {
      if (!r.connected) { try { ws.close(); } catch(e){} rotateRelay(url); }
    }, 10000);

    ws.onopen = () => {
      clearTimeout(r.connectTimer);
      r.connected = true;
      broadcastStatus();
      // Re-send all subscriptions to this relay
      resubscribeAll(url);
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      // EVENT: ["EVENT", subId, event]
      if (Array.isArray(msg) && msg[0] === 'EVENT' && msg.length >= 3) {
        const relaySubId = msg[1];
        const event = msg[2];
        if (!event || !event.id) return;
        // Dedup per-subscription (not global) — allow same event to reach multiple subs
        const dedupKey = event.id + ':' + relaySubId;
        if (seenEvents.has(dedupKey)) return;
        addSeen(dedupKey);
        // Route to matching subscription by relaySubId
        for (const [subId, sub] of subscriptions) {
          if (sub.relaySubId === relaySubId) {
            const port = ports.get(sub._portId);
            if (port) {
              try { port.postMessage({ type: 'event', subId, event }); }
              catch { ports.delete(sub._portId); }
            }
          }
        }
        return;
      }

      // EOSE: ["EOSE", subId]
      if (Array.isArray(msg) && msg[0] === 'EOSE') {
        const relaySubId = msg[1];
        for (const [subId, sub] of subscriptions) {
          if (sub.relaySubId === relaySubId) {
            const port = ports.get(sub._portId);
            if (port) {
              try { port.postMessage({ type: 'eose', subId }); }
              catch { ports.delete(sub._portId); }
            }
          }
        }
        return;
      }

      // OK: ["OK", eventId, success, message]
      if (Array.isArray(msg) && msg[0] === 'OK' && msg.length >= 3) {
        const eventId = msg[1];
        const success = msg[2];
        // Broadcast OK to all ports (any could have published)
        for (const [pid, port] of ports) {
          try { port.postMessage({ type: 'ok', eventId, success, message: msg[3] || '' }); }
          catch { ports.delete(pid); }
        }
        return;
      }

      // NOTICE: ["NOTICE", message]
      if (Array.isArray(msg) && msg[0] === 'NOTICE') {
        for (const [pid, port] of ports) {
          try { port.postMessage({ type: 'notice', relay: url, message: msg[1] }); }
          catch { ports.delete(pid); }
        }
      }
    };

    ws.onclose = () => {
      r.ws = null;
      r.connected = false;
      broadcastStatus();
      rotateRelay(url);
    };

    ws.onerror = () => { /* onclose fires */ };

  } catch {
    rotateRelay(url);
  }
}

function rotateRelay(url: string): void {
  const r = relays[url];
  if (!r) return;
  clearTimeout(r.reconnectTimer);
  r.reconnectTimer = setTimeout(() => connectRelay(url), 5000);
}

function broadcastStatus(): void {
  const status = relayUrls.map(url => ({
    url,
    connected: !!(relays[url] && relays[url].connected)
  }));
  const connected = status.some(r => r.connected);
  const msg = { type: 'status', connected, relays: status, relayCount: status.filter(r => r.connected).length };
  for (const [pid, port] of ports) {
    try { port.postMessage(msg); } catch { ports.delete(pid); }
  }
}

// ── Filter matching (NIP-01) ──
function matchesFilters(event: NostrEvent, filters: NostrFilter[]): boolean {
  for (const f of filters) {
    let match = true;
    if (f.ids && !f.ids.some(id => (event.id as string).startsWith(id))) match = false;
    if (f.authors && !f.authors.some(a => (event.pubkey as string).startsWith(a))) match = false;
    if (f.kinds && !f.kinds.includes(event.kind as number)) match = false;
    if (f.since && (event.created_at as number) < f.since) match = false;
    if (f.until && (event.created_at as number) > f.until) match = false;
    // Tag filters (#e, #p, #t, etc.)
    for (const key of Object.keys(f)) {
      if (key.startsWith('#') && key.length === 2) {
        const tagName = key[1];
        const vals = f[key] as string[];
        const eventTags = ((event.tags as string[][] | undefined) || []).filter(t => t[0] === tagName).map(t => t[1]);
        if (!vals.some(v => eventTags.includes(v))) match = false;
      }
    }
    if (match) return true;
  }
  return false;
}

// ── Subscribe on a specific relay ──
function sendSubscription(url: string, relaySubId: string, filters: NostrFilter[]): void {
  const r = relays[url];
  if (!r || !r.ws || r.ws.readyState !== 1) return;
  r.ws.send(JSON.stringify(['REQ', relaySubId, ...filters]));
}

function sendUnsubscribe(url: string, relaySubId: string): void {
  const r = relays[url];
  if (!r || !r.ws || r.ws.readyState !== 1) return;
  r.ws.send(JSON.stringify(['CLOSE', relaySubId]));
}

function resubscribeAll(url: string): void {
  for (const [subId, sub] of subscriptions) {
    sendSubscription(url, sub.relaySubId, sub.filters);
  }
}

// ── Publish event to all connected relays ──
function publishEvent(event: NostrEvent): void {
  const msg = JSON.stringify(['EVENT', event]);
  for (const url of relayUrls) {
    const r = relays[url];
    if (r && r.ws && r.ws.readyState === 1) {
      r.ws.send(msg);
    }
  }
}

// ── Port management ──
(self as any).onconnect = function(e: MessageEvent) {
  const port = e.ports[0];
  const pid = ++_portId;
  ports.set(pid, port);

  port.onmessage = function(ev) {
    const msg = ev.data;

    if (msg.type === 'init') {
      // Set relay list and connect (only if we don't already have relays)
      if (msg.relays && msg.relays.length) {
        const newUrls = msg.relays.filter((u: string) => !relayUrls.includes(u));
        if (relayUrls.length === 0) {
          relayUrls = msg.relays;
          for (const url of relayUrls) connectRelay(url);
        } else if (newUrls.length > 0) {
          // Add new relays
          for (const url of newUrls) {
            relayUrls.push(url);
            connectRelay(url);
          }
        }
      }
      // Send current status
      broadcastStatus();
    }

    else if (msg.type === 'subscribe') {
      const subId = 'nsub_' + (++subIdCounter);
      const relaySubId = 'r' + subIdCounter;
      subscriptions.set(subId, { _portId: pid, filters: msg.filters, relaySubId });
      // Send REQ to all connected relays
      for (const url of relayUrls) sendSubscription(url, relaySubId, msg.filters);
      // Return subId to caller
      port.postMessage({ type: 'subscribed', subId, clientSubId: msg.clientSubId });
    }

    else if (msg.type === 'unsubscribe') {
      const sub = subscriptions.get(msg.subId);
      if (sub) {
        // CLOSE on all relays
        for (const url of relayUrls) sendUnsubscribe(url, sub.relaySubId);
        subscriptions.delete(msg.subId);
      }
    }

    else if (msg.type === 'publish') {
      publishEvent(msg.event);
    }

    else if (msg.type === 'status') {
      broadcastStatus();
    }

    else if (msg.type === 'updateRelays') {
      // Close old connections, reconnect with new list
      for (const url of relayUrls) {
        const r = relays[url];
        if (r && r.ws) { try { r.ws.close(); } catch(e){} }
        clearTimeout(r?.reconnectTimer);
        clearTimeout(r?.connectTimer);
      }
      relayUrls = msg.relays || [];
      for (const url of relayUrls) connectRelay(url);
    }
  };

  port.onmessageerror = function() { removePort(pid); };
};

function removePort(pid: number): void {
  ports.delete(pid);
  // Cleanup subscriptions from this port
  for (const [subId, sub] of subscriptions) {
    if (sub._portId === pid) {
      for (const url of relayUrls) sendUnsubscribe(url, sub.relaySubId);
      subscriptions.delete(subId);
    }
  }
}

