#!/usr/bin/env python3
#
# Electron Cash — BCH RPA (Reusable Payment Address) Plugin
#
# Paycode-based private receiving using the BIP47-style key layout
#   m/47'/145'/0'/0'/0   (spend key)
#   m/47'/145'/0'/1'/0   (scan key)
#
# Portable drop-in plugin built on Electron Cash's upstream `electroncash/rpa`
# module, with the scan/spend derivation rerouted through the BIP47 branch.
#
# Copyright (C) 2020 Jonald Fyookball (original RPA code)
# Copyright (C) 2026 0penw0rld / 00 Protocol (BIP47 adaptation)
# MIT License

# Electron Cash loads external plugins via ``zipimport`` and registers the
# package under ``electroncash_external_plugins.<name>`` (see
# electroncash/plugins.py::load_external_plugin). When our package has a
# *sub-package* (``rpa.core``), relative imports inside that sub-package
# resolve as ``electroncash_external_plugins.rpa.core``; Python then
# walks up the parent chain and raises ``ModuleNotFoundError: No module
# named 'electroncash_external_plugins'`` because EC never registers
# that top-level namespace. Pre-register a stub so relative imports
# inside nested sub-packages work.
import sys as _sys
import types as _types
if 'electroncash_external_plugins' not in _sys.modules:
    _stub = _types.ModuleType('electroncash_external_plugins')
    _stub.__path__ = []  # mark as namespace package
    _sys.modules['electroncash_external_plugins'] = _stub

from electroncash.i18n import _

fullname = _('BCH RPA (Paycodes)')
description = [
    _('Receive private payments via Reusable Payment Addresses (RPA).'),
    "\n\n",
    _('Give out one paycode and receive unlimited payments to unique addresses — '
      'your paycode is never re-used on-chain. Scanning happens locally against '
      'transactions with a matching scan-pubkey prefix.'),
    "\n\n",
    _('Keys are derived in an isolated BIP47 branch: '
      "m/47'/145'/0'/0'/0 for spend and m/47'/145'/0'/1'/0 for scan — "
      'separate from your regular BIP44 receiving tree.'),
]
description_delimiter = ''
available_for = ['qt', 'cmdline']
default_on = False
