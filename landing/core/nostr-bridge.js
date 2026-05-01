let _mode = null;
let _worker = null, _port = null;
let _clientSubId = 0;
const _pendingSubs = /* @__PURE__ */ new Map();
const _activeSubs = /* @__PURE__ */ new Map();
const _statusListeners = /* @__PURE__ */ new Set();
const _okCallbacks = /* @__PURE__ */ new Map();
let _lastStatus = { connected: false, relays: [], relayCount: 0 };
let _fbRelays = {};
let _fbRelayUrls = [];
let _fbSubId = 0;
const _fbSubs = /* @__PURE__ */ new Map();
const _fbSeen = /* @__PURE__ */ new Set();
function _fbConnect(url) {
  const existing = _fbRelays[url];
  if (existing?.ws && (existing.ws.readyState === 0 || existing.ws.readyState === 1)) return;
  const r = { ws: null, connected: false };
  _fbRelays[url] = r;
  try {
    const ws = new WebSocket(url);
    r.ws = ws;
    ws.onopen = () => {
      r.connected = true;
      _fbBroadcastStatus();
      for (const [subId, sub] of _fbSubs) {
        ws.send(JSON.stringify(["REQ", subId, ...sub.filters]));
      }
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg[0] === "EVENT" && msg[2]) {
          const ev = msg[2], sid = msg[1];
          const dedupKey = ev.id + ":" + sid;
          if (_fbSeen.has(dedupKey)) return;
          _fbSeen.add(dedupKey);
          if (_fbSeen.size > 5e3) {
            const a = [..._fbSeen];
            _fbSeen.clear();
            for (let i = a.length - 2500; i < a.length; i++) _fbSeen.add(a[i]);
          }
          const sub = _fbSubs.get(sid);
          if (sub?.callback) {
            try {
              sub.callback(ev, sid);
            } catch {
            }
          }
        } else if (msg[0] === "OK" && msg[1]) {
          const cb = _okCallbacks.get(msg[1]);
          if (cb) {
            _okCallbacks.delete(msg[1]);
            cb(msg[2], msg[3]);
          }
        }
      } catch {
      }
    };
    ws.onclose = () => {
      r.connected = false;
      r.ws = null;
      _fbBroadcastStatus();
      setTimeout(() => _fbConnect(url), 5e3);
    };
    ws.onerror = () => {
    };
  } catch {
  }
}
function _fbBroadcastStatus() {
  const relays = _fbRelayUrls.map((url) => ({ url, connected: !!_fbRelays[url]?.connected }));
  _lastStatus = { connected: relays.some((r) => r.connected), relays, relayCount: relays.filter((r) => r.connected).length };
  for (const cb of _statusListeners) {
    try {
      cb(_lastStatus);
    } catch {
    }
  }
}
function _fbInit(relays) {
  _fbRelayUrls = relays;
  for (const url of relays) _fbConnect(url);
}
function _fbSubscribe(filters, callback) {
  const subId = "nsub_" + ++_fbSubId;
  _fbSubs.set(subId, { filters, callback });
  for (const url of _fbRelayUrls) {
    const r = _fbRelays[url];
    if (r?.ws?.readyState === 1) r.ws.send(JSON.stringify(["REQ", subId, ...filters]));
  }
  return subId;
}
function _fbUnsubscribe(subId) {
  _fbSubs.delete(subId);
  for (const url of _fbRelayUrls) {
    const r = _fbRelays[url];
    if (r?.ws?.readyState === 1) try {
      r.ws.send(JSON.stringify(["CLOSE", subId]));
    } catch {
    }
  }
}
function _fbPublish(event) {
  const msg = JSON.stringify(["EVENT", event]);
  for (const url of _fbRelayUrls) {
    const r = _fbRelays[url];
    if (r?.ws?.readyState === 1) try {
      r.ws.send(msg);
    } catch {
    }
  }
}
function _swHandleMessage(ev) {
  const msg = ev.data;
  if (msg.type === "status") {
    _lastStatus = msg;
    for (const cb of _statusListeners) {
      try {
        cb(msg);
      } catch {
      }
    }
  } else if (msg.type === "subscribed") {
    const pending = _pendingSubs.get(msg.clientSubId);
    if (pending) {
      _pendingSubs.delete(msg.clientSubId);
      _activeSubs.set(msg.subId, pending.callback);
      pending.resolve(msg.subId);
    }
  } else if (msg.type === "event") {
    const cb = _activeSubs.get(msg.subId);
    if (cb) {
      try {
        cb(msg.event, msg.subId);
      } catch {
      }
    }
  } else if (msg.type === "ok") {
    const cb = _okCallbacks.get(msg.eventId);
    if (cb) {
      _okCallbacks.delete(msg.eventId);
      cb(msg.success, msg.message);
    }
  }
}
function nostrInit(relays) {
  if (_mode === "fallback" && _lastStatus.connected) return;
  if (!relays || !relays.length) {
    console.warn("[nostr] No relays provided, using defaults");
    relays = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
  }
  _mode = "fallback";
  _fbInit(relays);
  console.log("[nostr] Relay pool initialized \u2713 (" + relays.length + " relays)");
}
function nostrSubscribe(filters, callback) {
  if (_mode === "fallback") {
    const subId = _fbSubscribe(filters, callback);
    return Promise.resolve(subId);
  }
  if (_mode === "worker") {
    const clientSubId = ++_clientSubId;
    return new Promise((resolve) => {
      _pendingSubs.set(clientSubId, { resolve, callback });
      _port.postMessage({ type: "subscribe", filters, clientSubId });
    });
  }
  return Promise.resolve(null);
}
function nostrUnsubscribe(subId) {
  if (!subId) return;
  if (_mode === "fallback") {
    _fbUnsubscribe(subId);
    return;
  }
  if (_mode === "worker") {
    _activeSubs.delete(subId);
    _port.postMessage({ type: "unsubscribe", subId });
  }
}
function nostrPublish(event, onOk) {
  if (onOk && event.id) _okCallbacks.set(event.id, onOk);
  if (_mode === "fallback") {
    _fbPublish(event);
    return;
  }
  if (_mode === "worker") {
    _port.postMessage({ type: "publish", event });
  }
}
function nostrOnStatus(callback) {
  _statusListeners.add(callback);
  callback(_lastStatus);
  return () => _statusListeners.delete(callback);
}
function nostrStatus() {
  return _lastStatus;
}
function nostrUpdateRelays(relays) {
  if (_mode === "fallback") {
    for (const url of _fbRelayUrls) {
      const r = _fbRelays[url];
      if (r?.ws) try {
        r.ws.close();
      } catch {
      }
    }
    _fbRelays = {};
    _fbRelayUrls = [];
    _fbInit(relays);
    return;
  }
  if (_mode === "worker") {
    _port.postMessage({ type: "updateRelays", relays });
  }
}
function nostrIsConnected() {
  return _lastStatus.connected;
}
function nostrMode() {
  return _mode;
}
if (typeof window !== "undefined") {
  window._nostrInit = nostrInit;
  window._nostrPublish = nostrPublish;
  window._nostrSubscribe = nostrSubscribe;
  window._nostrUnsubscribe = nostrUnsubscribe;
  window._nostrOnStatus = nostrOnStatus;
  window._nostrStatus = nostrStatus;
  window._nostrUpdateRelays = nostrUpdateRelays;
  window._nostrIsConnected = nostrIsConnected;
}
export {
  nostrInit,
  nostrIsConnected,
  nostrMode,
  nostrOnStatus,
  nostrPublish,
  nostrStatus,
  nostrSubscribe,
  nostrUnsubscribe,
  nostrUpdateRelays
};
