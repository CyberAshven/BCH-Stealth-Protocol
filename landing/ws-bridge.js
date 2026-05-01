(() => {
  (function() {
    if (typeof SharedWorker === "undefined") {
      window._wsSharedWorkerAvailable = false;
      return;
    }
    window._wsSharedWorkerAvailable = true;
    var _wsUrl = typeof location !== "undefined" ? new URL("ws-shared.js", location.href).href : "/ws-shared.js";
    var worker = new SharedWorker(_wsUrl, { name: "00-electrum" });
    var port = worker.port;
    port.start();
    var _pending = {};
    var _reqId = 0;
    var _subHandlers = {};
    var _statusHandlers = {};
    var _connected = { bch: false, btc: false };
    var _servers = { bch: "", btc: "" };
    var _connectWaiters = { bch: [], btc: [] };
    var _00ep = window._00ep || {};
    var bchServers = _00ep.fulcrum || (function() {
      try {
        return JSON.parse(localStorage.getItem("00_ep_fulcrum"));
      } catch (e) {
        return null;
      }
    })() || ["wss://bch.imaginary.cash:50004", "wss://bch.loping.net:50004", "wss://bch.soul-dev.com:50004", "wss://electron.jochen-hoenicke.de:51004"];
    var btcServers = _00ep.btc_electrum || (function() {
      try {
        return JSON.parse(localStorage.getItem("00_ep_btc_electrum"));
      } catch (e) {
        return null;
      }
    })() || ["wss://e2.keff.org:50004", "wss://fulcrum.grey.pw:50004", "wss://btc.electroncash.dk:50004", "wss://electrum.petrkr.net:50004", "wss://bitcoinserver.nl:50004", "wss://mempool.8333.mobi:50004"];
    port.postMessage({ type: "init", chain: "bch", servers: bchServers });
    port.postMessage({ type: "init", chain: "btc", servers: btcServers });
    port.onmessage = function(e) {
      var msg = e.data;
      if (msg.type === "result") {
        var p = _pending[msg.id];
        if (!p) return;
        delete _pending[msg.id];
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.type === "notification") {
        var key = msg.chain + ":" + msg.method + ":" + (msg.params && msg.params[0] !== void 0 ? msg.params[0] : "");
        var handlers = _subHandlers[key];
        if (handlers) for (var i = 0; i < handlers.length; i++) handlers[i](msg.params);
        var wkey = msg.chain + ":" + msg.method + ":*";
        var whandlers = _subHandlers[wkey];
        if (whandlers) for (var j = 0; j < whandlers.length; j++) whandlers[j](msg.params);
      } else if (msg.type === "status") {
        var wasConnected = _connected[msg.chain];
        _connected[msg.chain] = msg.connected;
        _servers[msg.chain] = msg.server || "";
        if (msg.connected && _connectWaiters[msg.chain]) {
          var waiters = _connectWaiters[msg.chain].splice(0);
          for (var k = 0; k < waiters.length; k++) waiters[k]();
        }
        var sh = _statusHandlers[msg.chain];
        if (sh) for (var s = 0; s < sh.length; s++) sh[s](msg.connected, msg.server);
      }
    };
    function makeCall(chain, method, params) {
      return new Promise(function(resolve, reject) {
        var id = ++_reqId;
        var timer = setTimeout(function() {
          delete _pending[id];
          reject(new Error("timeout"));
        }, 3e4);
        _pending[id] = { resolve, reject, timer };
        port.postMessage({ type: "call", chain, id, method, params: params || [] });
      });
    }
    function waitConnect(chain) {
      return new Promise(function(resolve) {
        if (_connected[chain]) {
          resolve();
          return;
        }
        _connectWaiters[chain].push(resolve);
      });
    }
    window._fvCall = function(method, params) {
      return makeCall("bch", method, params);
    };
    window._fvConnect = function() {
      return waitConnect("bch");
    };
    window.fulcrumCall = window._fvCall;
    window.fulcrumConnect = window._fvConnect;
    window.bchCall = window._fvCall;
    window._btcCall = function(method, params) {
      return makeCall("btc", method, params);
    };
    window._btcConnect = function() {
      return waitConnect("btc");
    };
    window.btcCall = window._btcCall;
    window._wsSubscribe = function(chain, method, params, callback) {
      var param0 = params && params[0] !== void 0 ? params[0] : "*";
      var key = chain + ":" + method + ":" + param0;
      if (!_subHandlers[key]) _subHandlers[key] = [];
      _subHandlers[key].push(callback);
      port.postMessage({ type: "subscribe", chain, method, params });
    };
    window._wsOnStatus = function(chain, callback) {
      if (!_statusHandlers[chain]) _statusHandlers[chain] = [];
      _statusHandlers[chain].push(callback);
      callback(_connected[chain], _servers[chain]);
    };
    window._wsUpdateServers = function(chain, servers) {
      port.postMessage({ type: "updateServers", chain, servers });
    };
    window._wsStatus = function(chain) {
      return { connected: _connected[chain], server: _servers[chain] };
    };
    window._wsWorker = worker;
    window._wsPort = port;
  })();
})();
