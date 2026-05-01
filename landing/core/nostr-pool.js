const relays = {};
let relayUrls = [];
let _portId = 0;
const ports = /* @__PURE__ */ new Map();
const subscriptions = /* @__PURE__ */ new Map();
let subIdCounter = 0;
const seenEvents = /* @__PURE__ */ new Set();
const SEEN_MAX = 5e3;
const SEEN_PRUNE = 2500;
function addSeen(id) {
  seenEvents.add(id);
  if (seenEvents.size > SEEN_MAX) {
    const arr = [...seenEvents];
    seenEvents.clear();
    for (let i = arr.length - SEEN_PRUNE; i < arr.length; i++) seenEvents.add(arr[i]);
  }
}
function connectRelay(url) {
  if (relays[url] && relays[url].ws) return;
  const r = relays[url] || { ws: null, connected: false, connectTimer: null, reconnectTimer: null };
  relays[url] = r;
  try {
    const ws = new WebSocket(url);
    r.ws = ws;
    r.connectTimer = setTimeout(() => {
      if (!r.connected) {
        try {
          ws.close();
        } catch (e) {
        }
        rotateRelay(url);
      }
    }, 1e4);
    ws.onopen = () => {
      clearTimeout(r.connectTimer);
      r.connected = true;
      broadcastStatus();
      resubscribeAll(url);
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (Array.isArray(msg) && msg[0] === "EVENT" && msg.length >= 3) {
        const relaySubId = msg[1];
        const event = msg[2];
        if (!event || !event.id) return;
        const dedupKey = event.id + ":" + relaySubId;
        if (seenEvents.has(dedupKey)) return;
        addSeen(dedupKey);
        for (const [subId, sub] of subscriptions) {
          if (sub.relaySubId === relaySubId) {
            const port = ports.get(sub._portId);
            if (port) {
              try {
                port.postMessage({ type: "event", subId, event });
              } catch {
                ports.delete(sub._portId);
              }
            }
          }
        }
        return;
      }
      if (Array.isArray(msg) && msg[0] === "EOSE") {
        const relaySubId = msg[1];
        for (const [subId, sub] of subscriptions) {
          if (sub.relaySubId === relaySubId) {
            const port = ports.get(sub._portId);
            if (port) {
              try {
                port.postMessage({ type: "eose", subId });
              } catch {
                ports.delete(sub._portId);
              }
            }
          }
        }
        return;
      }
      if (Array.isArray(msg) && msg[0] === "OK" && msg.length >= 3) {
        const eventId = msg[1];
        const success = msg[2];
        for (const [pid, port] of ports) {
          try {
            port.postMessage({ type: "ok", eventId, success, message: msg[3] || "" });
          } catch {
            ports.delete(pid);
          }
        }
        return;
      }
      if (Array.isArray(msg) && msg[0] === "NOTICE") {
        for (const [pid, port] of ports) {
          try {
            port.postMessage({ type: "notice", relay: url, message: msg[1] });
          } catch {
            ports.delete(pid);
          }
        }
      }
    };
    ws.onclose = () => {
      r.ws = null;
      r.connected = false;
      broadcastStatus();
      rotateRelay(url);
    };
    ws.onerror = () => {
    };
  } catch {
    rotateRelay(url);
  }
}
function rotateRelay(url) {
  const r = relays[url];
  if (!r) return;
  clearTimeout(r.reconnectTimer);
  r.reconnectTimer = setTimeout(() => connectRelay(url), 5e3);
}
function broadcastStatus() {
  const status = relayUrls.map((url) => ({
    url,
    connected: !!(relays[url] && relays[url].connected)
  }));
  const connected = status.some((r) => r.connected);
  const msg = { type: "status", connected, relays: status, relayCount: status.filter((r) => r.connected).length };
  for (const [pid, port] of ports) {
    try {
      port.postMessage(msg);
    } catch {
      ports.delete(pid);
    }
  }
}
function matchesFilters(event, filters) {
  for (const f of filters) {
    let match = true;
    if (f.ids && !f.ids.some((id) => event.id.startsWith(id))) match = false;
    if (f.authors && !f.authors.some((a) => event.pubkey.startsWith(a))) match = false;
    if (f.kinds && !f.kinds.includes(event.kind)) match = false;
    if (f.since && event.created_at < f.since) match = false;
    if (f.until && event.created_at > f.until) match = false;
    for (const key of Object.keys(f)) {
      if (key.startsWith("#") && key.length === 2) {
        const tagName = key[1];
        const vals = f[key];
        const eventTags = (event.tags || []).filter((t) => t[0] === tagName).map((t) => t[1]);
        if (!vals.some((v) => eventTags.includes(v))) match = false;
      }
    }
    if (match) return true;
  }
  return false;
}
function sendSubscription(url, relaySubId, filters) {
  const r = relays[url];
  if (!r || !r.ws || r.ws.readyState !== 1) return;
  r.ws.send(JSON.stringify(["REQ", relaySubId, ...filters]));
}
function sendUnsubscribe(url, relaySubId) {
  const r = relays[url];
  if (!r || !r.ws || r.ws.readyState !== 1) return;
  r.ws.send(JSON.stringify(["CLOSE", relaySubId]));
}
function resubscribeAll(url) {
  for (const [subId, sub] of subscriptions) {
    sendSubscription(url, sub.relaySubId, sub.filters);
  }
}
function publishEvent(event) {
  const msg = JSON.stringify(["EVENT", event]);
  for (const url of relayUrls) {
    const r = relays[url];
    if (r && r.ws && r.ws.readyState === 1) {
      r.ws.send(msg);
    }
  }
}
self.onconnect = function(e) {
  const port = e.ports[0];
  const pid = ++_portId;
  ports.set(pid, port);
  port.onmessage = function(ev) {
    const msg = ev.data;
    if (msg.type === "init") {
      if (msg.relays && msg.relays.length) {
        const newUrls = msg.relays.filter((u) => !relayUrls.includes(u));
        if (relayUrls.length === 0) {
          relayUrls = msg.relays;
          for (const url of relayUrls) connectRelay(url);
        } else if (newUrls.length > 0) {
          for (const url of newUrls) {
            relayUrls.push(url);
            connectRelay(url);
          }
        }
      }
      broadcastStatus();
    } else if (msg.type === "subscribe") {
      const subId = "nsub_" + ++subIdCounter;
      const relaySubId = "r" + subIdCounter;
      subscriptions.set(subId, { _portId: pid, filters: msg.filters, relaySubId });
      for (const url of relayUrls) sendSubscription(url, relaySubId, msg.filters);
      port.postMessage({ type: "subscribed", subId, clientSubId: msg.clientSubId });
    } else if (msg.type === "unsubscribe") {
      const sub = subscriptions.get(msg.subId);
      if (sub) {
        for (const url of relayUrls) sendUnsubscribe(url, sub.relaySubId);
        subscriptions.delete(msg.subId);
      }
    } else if (msg.type === "publish") {
      publishEvent(msg.event);
    } else if (msg.type === "status") {
      broadcastStatus();
    } else if (msg.type === "updateRelays") {
      for (const url of relayUrls) {
        const r = relays[url];
        if (r && r.ws) {
          try {
            r.ws.close();
          } catch (e2) {
          }
        }
        clearTimeout(r?.reconnectTimer);
        clearTimeout(r?.connectTimer);
      }
      relayUrls = msg.relays || [];
      for (const url of relayUrls) connectRelay(url);
    }
  };
  port.onmessageerror = function() {
    removePort(pid);
  };
};
function removePort(pid) {
  ports.delete(pid);
  for (const [subId, sub] of subscriptions) {
    if (sub._portId === pid) {
      for (const url of relayUrls) sendUnsubscribe(url, sub.relaySubId);
      subscriptions.delete(subId);
    }
  }
}
