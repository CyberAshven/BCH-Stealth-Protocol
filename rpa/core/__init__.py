#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# -*- mode: python3 -*-
# This file (c) 2020 Calin Culianu
# Part of the Electron Cash SPV Wallet
# License: MIT

# Keep core/__init__ import-light: `paycode` pulls a lot of electroncash
# internals (multiprocessing, transaction, schnorr, ...). If any of those
# fails, importing this package would break plugin enable. Consumers
# should ``from rpa.core import paycode`` explicitly inside a try/except
# so they can surface a diagnostic instead of aborting enable.
from . import addr  # noqa: F401
