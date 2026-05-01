const _state = {};
const _listeners = {};
const _globalListeners = /* @__PURE__ */ new Set();
function get(key) {
  return _state[key];
}
function getAll() {
  return { ..._state };
}
function set(key, value) {
  const prev = _state[key];
  _state[key] = value;
  if (_listeners[key]) {
    for (const cb of _listeners[key]) {
      try {
        cb(value, prev, key);
      } catch (e) {
        console.error("[state]", key, e);
      }
    }
  }
  for (const cb of _globalListeners) {
    try {
      cb(key, value, prev);
    } catch (e) {
      console.error("[state:global]", e);
    }
  }
}
function merge(key, partial) {
  const current = _state[key] || {};
  set(key, { ...current, ...partial });
}
function subscribe(key, callback) {
  if (!_listeners[key]) _listeners[key] = /* @__PURE__ */ new Set();
  _listeners[key].add(callback);
  return () => _listeners[key].delete(callback);
}
function subscribeAll(callback) {
  _globalListeners.add(callback);
  return () => _globalListeners.delete(callback);
}
function hydrate(key, localStorageKey, parser = JSON.parse) {
  try {
    const raw = localStorage.getItem(localStorageKey);
    if (raw !== null) {
      _state[key] = parser(raw);
    }
  } catch {
  }
}
function persist(key, localStorageKey, serializer = JSON.stringify) {
  subscribe(key, (val) => {
    try {
      if (val === void 0 || val === null) localStorage.removeItem(localStorageKey);
      else localStorage.setItem(localStorageKey, serializer(val));
    } catch {
    }
  });
}
function init() {
  hydrate("balances", "00_balances");
  hydrate("prices", "00_dash_prices");
  hydrate("stealthUtxos", "00stealth_utxos");
  hydrate("fusionHistory", "00_fusion_history");
  hydrate("theme", "00_theme", (v) => v);
  hydrate("lang", "00_lang", (v) => v);
  hydrate("autoStealth", "00_auto_stealth", (v) => v === "1" || v === "true");
  hydrate("relayMode", "00_onion_relay_mode", (v) => v === "1" || v === "true");
  hydrate("sidebarCollapsed", "00_sidebar_collapsed", (v) => v === "1");
  if (!_state.balances) _state.balances = {};
  if (!_state.prices) _state.prices = {};
  if (!_state.stealthUtxos) _state.stealthUtxos = [];
  if (!_state.fusionHistory) _state.fusionHistory = [];
  _state.activeMix = null;
  _state.activeView = "dashboard";
  _state.nostrConnected = false;
  _state.fulcrumConnected = { bch: false, btc: false };
  _state.joinerRelays = [];
  _state.utxos = [];
  persist("balances", "00_balances");
  persist("prices", "00_dash_prices");
  persist("stealthUtxos", "00stealth_utxos");
  persist("fusionHistory", "00_fusion_history");
  persist("theme", "00_theme", (v) => String(v));
  persist("lang", "00_lang", (v) => String(v));
  persist("autoStealth", "00_auto_stealth", (v) => v ? "1" : "0");
  persist("relayMode", "00_onion_relay_mode", (v) => v ? "1" : "0");
  persist("sidebarCollapsed", "00_sidebar_collapsed", (v) => v ? "1" : "0");
}
export {
  get,
  getAll,
  hydrate,
  init,
  merge,
  persist,
  set,
  subscribe,
  subscribeAll
};
