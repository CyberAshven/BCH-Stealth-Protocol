// wizardconnect.js — WalletConnect v2 global bridge
// This file is loaded as a non-module script in index.html.
// It provides a window.WizardConnect stub so other code can check
// connectivity state before the auth module loads fully.
(function () {
  'use strict';
  if (window.WizardConnect) return; // already initialised

  window.WizardConnect = {
    version: '2.0',
    _session: null,
    _listeners: [],

    /** Returns true if a WalletConnect session is active */
    isConnected: function () {
      return !!this._session;
    },

    /** Register a listener for session changes */
    onSession: function (fn) {
      this._listeners.push(fn);
    },

    /** Called by auth.js after a successful pairing */
    _setSession: function (session) {
      this._session = session;
      this._listeners.forEach(function (fn) {
        try { fn(session); } catch (e) { /* ignore */ }
      });
    },
  };
})();
