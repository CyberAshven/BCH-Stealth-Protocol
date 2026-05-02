#!/usr/bin/env python3
"""
BCH RPA (Reusable Payment Addresses) Plugin — Core Logic

Derives scan/spend keys from the wallet seed at BIP47 paths:
    m/47'/145'/0'/0'/0   — spend key
    m/47'/145'/0'/1'/0   — scan key

Uses the upstream Electron Cash RPA code (vendored under ``core/``) with the
``derive_pubkeys(0, 0|0, 1)`` call sites re-routed through
``core/bip47_derive.py``.
"""

import threading
from typing import Optional

from electroncash.plugins import BasePlugin, hook

from .core import bip47_derive


def _load_paycode_module():
    """Lazy import of rpa.core.paycode.

    Imports a large electroncash surface (multiprocessing, transaction,
    schnorr, bitcoin.*). Keep it out of plugin enable time so any import
    error is reported per-wallet instead of aborting the whole plugin.
    """
    from .core import paycode as rpa_paycode  # noqa: WPS433
    return rpa_paycode


class RpaPlugin(BasePlugin):
    """BCH RPA Plugin for Electron Cash."""

    def __init__(self, parent, config, name):
        try:
            super().__init__(parent, config, name)
        except Exception as exc:
            # Never let __init__ raise — EC turns that into the generic
            # "error occurred while enabling" dialog with no details.
            self.print_error(f'RpaPlugin.__init__ base error: {exc!r}')
        self.rpa_data = {}
        self.lock = threading.Lock()

    def fullname(self):
        return 'BCH RPA (Paycodes)'

    def description(self):
        return "Reusable Payment Addresses with isolated BIP47 derivation (m/47'/145'/0')"

    # ── Wallet lifecycle ─────────────────────────────────────────

    @hook
    def load_wallet(self, wallet, window=None):
        wid = id(wallet)
        # Never let any exception here bubble up — EC aborts the whole plugin
        # enable ("an error occurred while enabling") if a hook raises.
        try:
            password = None
            try:
                needs_pw = hasattr(wallet, 'has_password') and wallet.has_password()
            except Exception:
                needs_pw = False
            if needs_pw and window is not None and hasattr(window, 'password_dialog'):
                try:
                    try:
                        password = window.password_dialog(
                            msg='Enter wallet password to enable BCH RPA (Paycodes)'
                        )
                    except TypeError:
                        password = window.password_dialog()
                except Exception as exc:
                    self.print_error(f'Wallet {wid}: password_dialog error: {exc}')

            keys = None
            try:
                keys, reason = bip47_derive._rpa_keys_for_wallet_with_reason(
                    wallet, password=password)
            except Exception as exc:
                self.print_error(f'Wallet {wid}: key derivation failed: {exc!r}')
                with self.lock:
                    self.rpa_data[wid] = {'keys': None, 'paycode': None,
                                          'error': f'Key derivation failed: {exc}'}
                return

            if not keys:
                msg = reason or 'No BIP32 seed or xprv available for this wallet.'
                self.print_error(f'Wallet {wid}: {msg} — RPA disabled')
                with self.lock:
                    self.rpa_data[wid] = {'keys': None, 'paycode': None, 'error': msg}
                return

            self.print_error(
                f'Wallet {wid}: BIP47 scan_pub={keys["scan_pub"][:16]}… '
                f'spend_pub={keys["spend_pub"][:16]}…'
            )
            paycode = None
            pc_error = None
            try:
                rpa_paycode = _load_paycode_module()
                paycode = rpa_paycode.generate_paycode(wallet)
            except Exception as exc:
                pc_error = f'Paycode generation failed: {exc}'
                self.print_error(f'Wallet {wid}: {pc_error}')
            with self.lock:
                self.rpa_data[wid] = {
                    'keys': keys,
                    'paycode': paycode,
                    'error': pc_error,
                }
        except Exception as exc:
            # Last-resort guard — must never raise out of @hook
            self.print_error(f'Wallet {wid}: RPA load_wallet fatal error: {exc!r}')
            try:
                with self.lock:
                    self.rpa_data[wid] = {'keys': None, 'paycode': None,
                                          'error': f'RPA init error: {exc}'}
            except Exception:
                pass

    @hook
    def close_wallet(self, wallet):
        wid = id(wallet)
        with self.lock:
            self.rpa_data.pop(wid, None)
        bip47_derive.clear_cache(wallet)

    # ── Public API ───────────────────────────────────────────────

    def get_paycode(self, wallet) -> Optional[str]:
        """Return the wallet's paycode string, or None if RPA is unavailable."""
        with self.lock:
            entry = self.rpa_data.get(id(wallet))
        if entry:
            return entry['paycode']
        try:
            rpa_paycode = _load_paycode_module()
            return rpa_paycode.generate_paycode(wallet)
        except Exception:
            return None

    def get_keys(self, wallet) -> Optional[dict]:
        return bip47_derive.rpa_keys_for_wallet(wallet)
