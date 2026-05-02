#!/usr/bin/env python3
"""
Stealth Addresses Plugin — Core Logic (JS Bridge)

Uses stealth.js via Node.js subprocess for all crypto operations.
Compatible with 00 Protocol (0penw0rld.com/stealth.html)
BIP352 key derivation: m/352'/145'/0'/0'/0 (spend), m/352'/145'/0'/1'/0 (scan)
"""

import json
import os
import subprocess
import threading
import time
from typing import Optional

from electroncash.plugins import BasePlugin, hook


class StealthPlugin(BasePlugin):
    """Stealth Addresses Plugin for Electron Cash."""

    def __init__(self, parent, config, name):
        try:
            super().__init__(parent, config, name)
        except Exception as exc:
            # Never let __init__ raise — EC shows a generic "error
            # occurred while enabling" with no details when it does.
            try:
                self.print_error(f'StealthPlugin base init error: {exc!r}')
            except Exception:
                pass
        self.stealth_data = {}
        self.lock = threading.Lock()
        self._nostr_running = False
        try:
            self._node_path = self._find_node()
        except Exception as exc:
            self.print_error(f'node detection failed: {exc!r}')
            self._node_path = None

    def _find_node(self):
        for path in ['node', '/usr/bin/node', '/usr/local/bin/node']:
            try:
                result = subprocess.run([path, '--version'], capture_output=True, text=True, timeout=5)
                if result.returncode == 0:
                    self.print_error(f'Found Node.js: {path} ({result.stdout.strip()})')
                    return path
            except Exception:
                continue
        self.print_error('Node.js not found! Stealth plugin requires Node.js 18+')
        return None

    def _stealth_js_path(self):
        """Return a filesystem path to stealth.js.

        Electron Cash loads external plugins via ``zipimport``, so
        ``__file__`` points INSIDE the plugin zip (e.g.
        ``.../stealth-ec-plugin.zip/stealth/plugin.py``). Node cannot
        execute a zip-internal path, and ``os.path.exists`` on such a
        path returns False. Extract the script to a real filesystem
        cache on first use and return the cached path.
        """
        here = os.path.dirname(__file__)
        direct = os.path.join(here, 'scripts', 'stealth.js')
        if os.path.isfile(direct):
            return direct

        # Locate the zip file we were loaded from by walking up __file__.
        # zipimport paths look like /path/to/plugin.zip/stealth/plugin.py
        path = here
        zip_path = None
        while path and path != os.path.dirname(path):
            if path.lower().endswith('.zip') and os.path.isfile(path):
                zip_path = path
                break
            path = os.path.dirname(path)

        try:
            from electroncash.util import user_dir
            cache_root = os.path.join(user_dir(), 'stealth-plugin-cache')
        except Exception:
            cache_root = os.path.join(
                os.path.expanduser('~/.electron-cash'), 'stealth-plugin-cache'
            )
        os.makedirs(cache_root, exist_ok=True)
        cache_path = os.path.join(cache_root, 'stealth.js')

        data = None
        if zip_path is not None:
            try:
                import zipfile
                with zipfile.ZipFile(zip_path, 'r') as zf:
                    for candidate in ('stealth/scripts/stealth.js',
                                      'scripts/stealth.js'):
                        try:
                            data = zf.read(candidate)
                            break
                        except KeyError:
                            continue
            except Exception as exc:
                self.print_error(f'zip extract error: {exc}')

        if data is None:
            # Last-ditch: try pkgutil (works through zipimport)
            try:
                import pkgutil
                data = pkgutil.get_data(__package__, 'scripts/stealth.js')
            except Exception:
                data = None

        if data:
            try:
                with open(cache_path, 'wb') as fh:
                    fh.write(data)
            except Exception as exc:
                self.print_error(f'failed to write {cache_path}: {exc}')
                return direct  # fall through, load_wallet will report missing
            return cache_path
        return direct

    def _call_js(self, action: str, params: dict) -> dict:
        if not self._node_path:
            return {'error': 'Node.js not available'}

        js_path = self._stealth_js_path()
        if not os.path.exists(js_path):
            return {'error': f'stealth.js not found at {js_path}'}

        try:
            input_json = json.dumps({'action': action, 'params': params})
            result = subprocess.run(
                [self._node_path, js_path],
                input=input_json,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode != 0:
                return {'error': f'stealth.js error: {result.stderr}'}
            return json.loads(result.stdout)
        except subprocess.TimeoutExpired:
            return {'error': 'stealth.js timeout'}
        except json.JSONDecodeError:
            return {'error': f'Invalid JSON from stealth.js: {result.stdout[:200]}'}
        except Exception as exc:
            return {'error': str(exc)}

    def fullname(self):
        return 'Stealth Addresses'

    def description(self):
        return 'ECDH beaconless stealth addresses (BIP352, 00 Protocol compatible)'

    @hook
    def load_wallet(self, wallet, window=None):
        wallet_id = id(wallet)
        reason = None
        try:
            ks = wallet.get_keystore()
            from electroncash import keystore

            self.print_error(f'Wallet {wallet_id}: keystore type = {type(ks).__name__}')

            if isinstance(ks, keystore.BIP32_KeyStore):
                result = None
                seed = None
                xprv = None
                passwords = [None, '']
                # If the wallet is encrypted, prompt the user for the password
                # via the main window so BIP352 derivation can proceed.
                try:
                    needs_pw = hasattr(wallet, 'has_password') and wallet.has_password()
                except Exception:
                    needs_pw = False
                if needs_pw and window is not None and hasattr(window, 'password_dialog'):
                    try:
                        try:
                            pw = window.password_dialog(
                                msg='Enter wallet password to enable Stealth Addresses'
                            )
                        except TypeError:
                            pw = window.password_dialog()
                        if pw:
                            passwords.insert(0, pw)
                    except Exception as exc:
                        self.print_error(f'  password_dialog error: {exc}')

                if self._node_path is None:
                    reason = 'Node.js not found — install Node.js 18+ and restart Electron Cash'
                    self.print_error(f'Wallet {wallet_id}: {reason}')
                    with self.lock:
                        self.stealth_data[wallet_id] = {'keys': None, 'utxos': [], 'error': reason}
                    return

                js_path = self._stealth_js_path()
                if not os.path.exists(js_path):
                    reason = f'stealth.js missing at {js_path}'
                    self.print_error(f'Wallet {wallet_id}: {reason}')
                    with self.lock:
                        self.stealth_data[wallet_id] = {'keys': None, 'utxos': [], 'error': reason}
                    return

                for pwd in passwords:
                    try:
                        seed = ks.get_seed(pwd)
                        if seed:
                            try:
                                passphrase = ks.get_passphrase(pwd) or ''
                            except Exception:
                                passphrase = ''
                            break
                    except Exception:
                        pass

                if seed:
                    self.print_error('  Got seed phrase, deriving BIP32 master in Python...')
                    try:
                        from electroncash.mnemonic import (
                            Mnemonic, Mnemonic_Electrum,
                        )
                        import hashlib, hmac
                        seed_type = getattr(ks, 'seed_type', None) or 'bip39'
                        if seed_type in ('electrum', 'standard'):
                            bip32_seed = Mnemonic_Electrum.mnemonic_to_seed(seed, passphrase)
                        else:
                            bip32_seed = Mnemonic.mnemonic_to_seed(seed, passphrase)
                        I = hmac.new(b'Bitcoin seed', bip32_seed, hashlib.sha512).digest()
                        master_priv_hex = I[:32].hex()
                        master_chain_hex = I[32:].hex()
                        self.print_error(
                            f"  seed_type={seed_type} — deriving m/352'/145'/0'/* via JS"
                        )
                        result = self._call_js('derive_keys', {
                            'masterPriv': master_priv_hex,
                            'masterChain': master_chain_hex,
                        })
                    except Exception as exc:
                        reason = f'seed→master derivation failed: {exc}'
                        self.print_error(f'  {reason}')
                        with self.lock:
                            self.stealth_data[wallet_id] = {'keys': None, 'utxos': [], 'error': reason}
                        return
                else:
                    reason = (
                        "Canonical BIP352 derivation requires the wallet seed. "
                        "This wallet has no seed (watch-only / hardware / imported xprv)."
                    )
                    self.print_error(f'Wallet {wallet_id}: {reason}')
                    with self.lock:
                        self.stealth_data[wallet_id] = {'keys': None, 'utxos': [], 'error': reason}
                    return
            else:
                reason = (f'Unsupported keystore type: {type(ks).__name__}. '
                          f'Stealth requires a BIP32/BIP39 wallet.')
                self.print_error(f'Wallet {wallet_id}: {reason}')
                with self.lock:
                    self.stealth_data[wallet_id] = {'keys': None, 'utxos': [], 'error': reason}
                return

            if not result or (isinstance(result, dict) and 'error' in result):
                reason = (result.get('error', 'unknown')
                          if isinstance(result, dict) else 'no result from stealth.js')
                self.print_error(f'Wallet {wallet_id}: stealth error: {reason}')
                with self.lock:
                    self.stealth_data[wallet_id] = {'keys': None, 'utxos': [], 'error': str(reason)}
                return

            with self.lock:
                self.stealth_data[wallet_id] = {
                    'keys': result,
                    'utxos': self._load_utxos(wallet),
                }

            self.print_error(f'Wallet {wallet_id}: stealth keys derived')
            self.print_error(f'  Paycode: {result.get("paycode", "?")[:40]}...')

            try:
                self.start_nostr_listener(wallet)
            except Exception as exc:
                self.print_error(f'Nostr listener start error: {exc}')
        except Exception as exc:
            reason = f'Stealth init error: {exc}'
            self.print_error(f'Wallet {wallet_id}: {reason}')
            try:
                with self.lock:
                    self.stealth_data[wallet_id] = {'keys': None, 'utxos': [], 'error': reason}
            except Exception:
                pass

    @hook
    def close_wallet(self, wallet):
        self.stop_nostr_listener()
        with self.lock:
            self.stealth_data.pop(id(wallet), None)

    @hook
    def spendable_coin_filter(self, window, coins):
        data = self.stealth_data.get(id(window.wallet))
        if not data or not data.get('utxos'):
            return
        stealth_addrs = {utxo['addr'] for utxo in data['utxos']}
        coins[:] = [coin for coin in coins if coin.get('address') not in stealth_addrs]

    def get_paycode(self, wallet) -> Optional[str]:
        data = self.stealth_data.get(id(wallet))
        if data and data.get('keys'):
            return data['keys'].get('paycode')
        return None

    def get_stealth_balance(self, wallet) -> int:
        data = self.stealth_data.get(id(wallet))
        if not data:
            return 0
        return sum(utxo.get('value', 0) for utxo in data.get('utxos', []))

    def detect_payment(self, wallet, raw_tx_hex: str) -> list:
        data = self.stealth_data.get(id(wallet))
        if not data or not data.get('keys'):
            return []
        keys = data['keys']
        return self._call_js('detect_payment', {
            'rawTxHex': raw_tx_hex,
            'scanPriv': keys['scanPriv'],
            'spendPub': keys['spendPub'],
        })

    def _scan_blocks_local(self, wallet, keys, from_height, to_height,
                            progress_cb=None):
        """Plugin-local block scan: fetch raw blocks from the user's Fulcrum
        server via wallet.network and feed them to stealth.js for BIP352
        aggregated ECDH. No external HTTP indexer is contacted.

        Returns candidates list (same shape as scan_indexer) or an error dict.
        """
        network = getattr(wallet, 'network', None)
        if network is None:
            return {'error': 'No network attached to wallet (offline?).'}

        total = to_height - from_height + 1
        if total <= 0:
            return []

        candidates = []
        batch_size = 10  # fetch + parse N blocks per Node invocation
        fetched = 0
        fulcrum_errors = 0

        for chunk_start in range(from_height, to_height + 1, batch_size):
            chunk_end = min(chunk_start + batch_size - 1, to_height)
            blocks = []
            for h in range(chunk_start, chunk_end + 1):
                try:
                    hex_str = network.synchronous_get(
                        ('blockchain.block.get', [h]), timeout=30)
                except Exception as exc:
                    fulcrum_errors += 1
                    self.print_error(
                        f'local scan: block.get {h} failed: {exc!r}')
                    continue
                if not hex_str or not isinstance(hex_str, str):
                    fulcrum_errors += 1
                    continue
                blocks.append({'height': h, 'hex': hex_str})
                fetched += 1
                if progress_cb:
                    try:
                        progress_cb(fetched, total)
                    except Exception:
                        pass

            if not blocks:
                continue
            chunk_result = self._call_js('scan_local_blocks', {
                'scanPriv': keys['scanPriv'],
                'spendPub': keys['spendPub'],
                'blocks': blocks,
            })
            if isinstance(chunk_result, dict) and 'error' in chunk_result:
                self.print_error(
                    f'local scan: js error: {chunk_result["error"]}')
                continue
            if isinstance(chunk_result, list):
                candidates.extend(chunk_result)

        if fetched == 0:
            srv_hint = ''
            try:
                srv = network.get_parameters()  # may raise on old EC
                srv_hint = f' (server={srv})'
            except Exception:
                pass
            return {
                'error': (
                    'Local scan failed: could not fetch any blocks from '
                    'your Fulcrum server. Your Electrum server may not '
                    'support `blockchain.block.get` (Fulcrum does; '
                    'ElectrumX does not). Try a different server or '
                    'switch to "Remote indexer" mode.' + srv_hint
                ),
            }
        if fulcrum_errors > 0:
            self.print_error(
                f'local scan: {fulcrum_errors} block fetches failed '
                f'(out of {total})')
        return candidates

    def scan_blocks(self, wallet, from_height: int, to_height: int,
                    mode: str = 'local',
                    indexer_url: str = 'https://0penw0rld.com/api',
                    progress_cb=None) -> int:
        """Scan a block range for stealth payments.

        mode: 'local' — uses the user's Fulcrum server via wallet.network
              'remote' — queries HTTP P2PKH pubkey indexer at indexer_url
        progress_cb(done, total) invoked from the scanning thread.
        """
        data = self.stealth_data.get(id(wallet))
        if not data or not data.get('keys'):
            self.print_error('scan_blocks: no stealth keys')
            return 0
        keys = data['keys']

        if mode == 'remote':
            candidates = self._call_js('scan_indexer', {
                'scanPriv': keys['scanPriv'],
                'spendPub': keys['spendPub'],
                'fromHeight': from_height,
                'toHeight': to_height,
                'indexerUrl': indexer_url,
            })
        else:
            candidates = self._scan_blocks_local(
                wallet, keys, from_height, to_height, progress_cb)

        if isinstance(candidates, dict) and 'error' in candidates:
            err = candidates['error']
            self.print_error(f'scan_blocks error: {err}')
            raise RuntimeError(str(err))
        if not isinstance(candidates, list):
            self.print_error(f'scan_blocks: unexpected result type: {type(candidates)}')
            raise RuntimeError(
                f'Indexer returned unexpected data (type {type(candidates).__name__}).')

        found = 0
        existing_utxos = data.get('utxos', [])
        existing_txids = {(utxo['txid'], utxo.get('vout', 0)) for utxo in existing_utxos}
        for cand in candidates:
            txid = cand.get('txid', '')
            addr = cand.get('addr', '')
            if (txid, cand.get('vin', 0)) in existing_txids:
                continue
            try:
                from electroncash.address import Address
                addr_obj = Address.from_string(addr)
                scripthash = addr_obj.to_scripthash_hex()
                network = wallet.network
                if network:
                    result = network.synchronous_get(('blockchain.scripthash.listunspent', [scripthash]), timeout=10)
                    if result:
                        for utxo in result:
                            existing_utxos.append({
                                'txid': utxo.get('tx_hash', txid),
                                'vout': utxo.get('tx_pos', 0),
                                'value': utxo.get('value', 0),
                                'height': utxo.get('height', cand.get('height', 0)),
                                'addr': addr,
                                'pub': cand.get('pub', ''),
                                'c': cand.get('c', ''),
                                'from': 'indexer-scan',
                            })
                            found += 1
                else:
                    existing_utxos.append({
                        'txid': txid,
                        'vout': cand.get('vin', 0),
                        'value': 0,
                        'height': cand.get('height', 0),
                        'addr': addr,
                        'pub': cand.get('pub', ''),
                        'c': cand.get('c', ''),
                        'from': 'indexer-scan-unverified',
                    })
                    found += 1
            except Exception as exc:
                self.print_error(f'  Verify error for {addr[:20]}: {exc}')

        if found > 0:
            data['utxos'] = existing_utxos
            self._save_utxos(wallet)
        return found

    def _derive_sender_key_for_coin(self, wallet, coin, keys, stealth_utxos, password):
        if stealth_utxos:
            match = next((
                utxo for utxo in stealth_utxos
                if utxo['txid'] == coin['prevout_hash'] and utxo.get('vout', 0) == coin['prevout_n']
            ), None)
            if not match:
                raise Exception(f'missing stealth UTXO metadata for {coin["prevout_hash"][:12]}:{coin["prevout_n"]}')
            tweak_hex = match.get('c', '')
            if not tweak_hex:
                raise Exception(f'stealth UTXO {match["txid"][:12]} missing tweak')
            curve_n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
            spend_priv = int(keys['spendPriv'], 16)
            tweak = int(tweak_hex, 16)
            return format((spend_priv + tweak) % curve_n, '064x')

        from electroncash.bitcoin import deserialize_privkey
        privkeys = wallet.get_private_key(coin['address'], password)
        if not privkeys:
            raise Exception(f'Cannot get private key for {coin["prevout_hash"][:12]}:{coin["prevout_n"]}')
        _txin_type, privkey_bytes, _compressed = deserialize_privkey(privkeys[0])
        return privkey_bytes.hex()

    def _derive_address_for_outputs(self, wallet, coins, keys, recip_scan_pub, recip_spend_pub, stealth_utxos, password):
        sender_privs = []
        outpoints = []
        for coin in coins:
            sender_privs.append(self._derive_sender_key_for_coin(wallet, coin, keys, stealth_utxos, password))
            outpoints.append({'txidBE': coin['prevout_hash'], 'vout': coin['prevout_n']})

        if len(sender_privs) == 1:
            prev_txid_le = bytes.fromhex(outpoints[0]['txidBE'])[::-1].hex()
            outpoint = prev_txid_le + outpoints[0]['vout'].to_bytes(4, 'little').hex()
            return self._call_js('derive_address', {
                'senderPriv': sender_privs[0],
                'recipScanPub': recip_scan_pub,
                'recipSpendPub': recip_spend_pub,
                'outpoint': outpoint,
            })

        return self._call_js('derive_address', {
            'senderPrivs': sender_privs,
            'outpoints': outpoints,
            'recipScanPub': recip_scan_pub,
            'recipSpendPub': recip_spend_pub,
        })

    def send_stealth(self, wallet, paycode: str, amount_sats: int, window=None,
                     stealth_utxos=None, change_mode='normal') -> str:
        from electroncash.address import Address
        from electroncash.transaction import Transaction

        data = self.stealth_data.get(id(wallet))
        if not data or not data.get('keys'):
            raise Exception('Stealth keys not available')
        keys = data['keys']

        code_hex = paycode.replace('stealth:', '')
        if len(code_hex) != 132:
            raise Exception(f'Invalid paycode length: {len(code_hex)}')
        recip_scan_pub = code_hex[:66]
        recip_spend_pub = code_hex[66:]

        password = None
        if stealth_utxos:
            coins = []
            for utxo in stealth_utxos:
                addr_str = utxo.get('addr', '')
                if not addr_str:
                    continue
                coins.append({
                    'address': Address.from_string(addr_str),
                    'prevout_hash': utxo['txid'],
                    'prevout_n': utxo.get('vout', 0),
                    'value': utxo.get('value', 0),
                    'height': utxo.get('height', 0),
                    'coinbase': False,
                    'is_frozen_coin': False,
                })
        else:
            coins = wallet.get_spendable_coins(None, self.config)
        if not coins:
            raise Exception('No spendable coins')

        total_in = sum(coin.get('value', 0) for coin in coins)
        fee = (len(coins) * 150 + 2 * 34 + 10) * 2
        change_amount = total_in - amount_sats - fee
        if change_amount < 0:
            fee_no_change = (len(coins) * 150 + 34 + 10) * 2
            if total_in >= amount_sats + fee_no_change:
                change_amount = 0
            else:
                raise Exception(f'Insufficient funds: {total_in} sats < {amount_sats} + {fee_no_change} fee')

        derive_result = self._derive_address_for_outputs(
            wallet, coins, keys, recip_scan_pub, recip_spend_pub, stealth_utxos, password,
        )
        if isinstance(derive_result, dict) and 'error' in derive_result:
            raise Exception(f'Derivation error: {derive_result["error"]}')
        stealth_addr_str = derive_result.get('addr', '')
        if not stealth_addr_str:
            raise Exception('Derivation returned no address')
        outputs = [(0, Address.from_string(stealth_addr_str), amount_sats)]

        if change_amount > 0 and change_amount >= 546:
            if change_mode == 'stealth' and len(coins) == 1:
                sender_priv = self._derive_sender_key_for_coin(wallet, coins[0], keys, stealth_utxos, password)
                prev_txid_le = bytes.fromhex(coins[0]['prevout_hash'])[::-1].hex()
                change_outpoint = prev_txid_le + (coins[0]['prevout_n'] + 1).to_bytes(4, 'little').hex()
                change_result = self._call_js('derive_address', {
                    'senderPriv': sender_priv,
                    'recipScanPub': keys['scanPub'],
                    'recipSpendPub': keys['spendPub'],
                    'outpoint': change_outpoint,
                })
                if change_result and 'addr' in change_result:
                    outputs.append((0, Address.from_string(change_result['addr']), change_amount))
                else:
                    outputs.append((0, wallet.get_unused_address() or coins[0]['address'], change_amount))
            else:
                if change_mode == 'stealth' and len(coins) > 1:
                    self.print_error('send_stealth: multi-input aggregated send derives only k=0; using normal change')
                outputs.append((0, wallet.get_unused_address() or coins[0]['address'], change_amount))

        tx_inputs = []
        for coin in coins:
            tx_inputs.append({
                'prevout_hash': coin['prevout_hash'],
                'prevout_n': coin['prevout_n'],
                'value': coin.get('value', 0),
                'address': coin['address'],
                'type': 'p2pkh',
                'x_pubkeys': [],
                'pubkeys': [],
                'signatures': [None],
                'num_sig': 1,
                'sequence': 0xffffffff,
            })

        tx = Transaction.from_io(tx_inputs, outputs)
        if stealth_utxos:
            self._sign_stealth_tx(tx, stealth_utxos, keys)
        else:
            wallet.sign_transaction(tx, password)

        network = wallet.network
        if not network:
            raise Exception('No network connection')
        try:
            network.broadcast_transaction2(tx)
        except Exception as exc:
            raise Exception(f'Broadcast failed: {exc}')

        txid = tx.txid()
        if stealth_utxos:
            spent = {(utxo['txid'], utxo.get('vout', 0)) for utxo in stealth_utxos}
            data['utxos'] = [
                utxo for utxo in data.get('utxos', [])
                if (utxo['txid'], utxo.get('vout', 0)) not in spent
            ]
            self._save_utxos(wallet)

        try:
            rumor = {
                'kind': 14,
                'tags': [['type', 'stealth']],
                'content': json.dumps({'type': 'stealth', 'txid': txid}),
            }
            wrap_result = self._call_js('nip59_wrap', {
                'senderPriv': keys['scanPriv'],
                'recipPubXOnly': recip_scan_pub[2:],
                'rumor': rumor,
            })
            event = wrap_result.get('event') if isinstance(wrap_result, dict) else None
            if event:
                import ssl
                import websocket
                event_json = json.dumps(['EVENT', event])
                for relay_url in ['wss://relay.damus.io', 'wss://nos.lol']:
                    try:
                        ws = websocket.create_connection(relay_url, timeout=5, sslopt={'cert_reqs': ssl.CERT_NONE})
                        ws.send(event_json)
                        _resp = ws.recv()
                        ws.close()
                    except Exception as exc:
                        self.print_error(f'send_stealth: Nostr publish failed {relay_url}: {exc}')
        except Exception as exc:
            self.print_error(f'send_stealth: Nostr notify failed (non-critical): {exc}')

        if hasattr(self, 'nostr_utxo_found'):
            self.nostr_utxo_found.emit()
        return txid

    def _sign_stealth_tx(self, tx, stealth_utxos, keys):
        from electroncash.bitcoin import public_key_from_private_key
        curve_n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
        spend_priv = int(keys['spendPriv'], 16)
        keypairs = {}
        for utxo in stealth_utxos:
            tweak_hex = utxo.get('c', '')
            if not tweak_hex:
                raise Exception(f'Stealth UTXO {utxo["txid"][:12]} missing tweak')
            tweak = int(tweak_hex, 16)
            tweaked_priv = (spend_priv + tweak) % curve_n
            tweaked_priv_bytes = tweaked_priv.to_bytes(32, 'big')
            pubkey_hex = public_key_from_private_key(tweaked_priv_bytes, True)
            keypairs[pubkey_hex] = (tweaked_priv_bytes, True)

        for txin in tx.inputs():
            match = next((
                utxo for utxo in stealth_utxos
                if utxo['txid'] == txin['prevout_hash'] and utxo.get('vout', 0) == txin['prevout_n']
            ), None)
            if not match:
                continue
            tweak = int(match['c'], 16)
            tweaked_priv = (spend_priv + tweak) % curve_n
            tweaked_priv_bytes = tweaked_priv.to_bytes(32, 'big')
            pubkey_hex = public_key_from_private_key(tweaked_priv_bytes, True)
            txin['pubkeys'] = [pubkey_hex]
            txin['x_pubkeys'] = [pubkey_hex]
            txin['signatures'] = [None]
            txin['num_sig'] = 1

        tx.sign(keypairs)

    def _utxo_file(self, wallet) -> str:
        return wallet.storage.path + '.stealth_utxos'

    def _save_utxos(self, wallet):
        data = self.stealth_data.get(id(wallet))
        if not data:
            return
        try:
            with open(self._utxo_file(wallet), 'w') as file_obj:
                json.dump(data.get('utxos', []), file_obj)
        except Exception as exc:
            self.print_error(f'Save UTXOs error: {exc}')

    def _load_utxos(self, wallet) -> list:
        path = self._utxo_file(wallet)
        if not os.path.exists(path):
            return []
        try:
            with open(path) as file_obj:
                return json.load(file_obj)
        except Exception:
            return []

    def start_nostr_listener(self, wallet):
        data = self.stealth_data.get(id(wallet))
        if not data or not data.get('keys'):
            return
        nostr_pub = data['keys'].get('scanPub', '')
        if not nostr_pub or len(nostr_pub) < 66:
            return

        x_only = nostr_pub[2:] if len(nostr_pub) == 66 else nostr_pub
        self._nostr_running = True
        for relay_url in ['wss://relay.damus.io', 'wss://nos.lol']:
            thread = threading.Thread(target=self._nostr_loop, args=(wallet, x_only, relay_url), daemon=True)
            thread.start()

    def stop_nostr_listener(self):
        self._nostr_running = False

    def _nostr_loop(self, wallet, x_only_pub, relay_url):
        import ssl
        import websocket

        while self._nostr_running:
            try:
                ws = websocket.create_connection(relay_url, timeout=30, sslopt={'cert_reqs': ssl.CERT_NONE})
                sub = json.dumps(['REQ', 'stealth-giftwrap', {
                    'kinds': [1059],
                    '#p': [x_only_pub],
                    'since': int(time.time()) - 86400,
                }])
                ws.send(sub)
                while self._nostr_running:
                    try:
                        raw = ws.recv()
                        if not raw:
                            continue
                        msg = json.loads(raw)
                        if msg[0] == 'EVENT' and len(msg) > 2:
                            self._handle_nostr_event(wallet, msg[2])
                    except websocket.WebSocketTimeoutException:
                        continue
                    except Exception as exc:
                        self.print_error(f'Nostr recv error: {exc}')
                        break
                ws.close()
            except Exception as exc:
                self.print_error(f'Nostr connect error ({relay_url}): {exc}')
                time.sleep(5)

    def _handle_nostr_event(self, wallet, event):
        try:
            data = self.stealth_data.get(id(wallet))
            if not data or not data.get('keys'):
                return
            unwrap = self._call_js('nip59_unwrap', {
                'recipPriv': data['keys']['scanPriv'],
                'event': event,
            })
            if not unwrap or 'error' in unwrap:
                return
            rumor = unwrap.get('rumor', {})
            payload = json.loads(rumor.get('content', '{}'))
            if payload.get('type') != 'stealth':
                return
            txid = payload.get('txid', '')
            if not txid:
                return

            raw_hex = None
            for _attempt in range(5):
                try:
                    network = wallet.network
                    if network:
                        raw_hex = network.synchronous_get(('blockchain.transaction.get', [txid]))
                        if raw_hex:
                            break
                except Exception:
                    pass
                time.sleep(3)
            if not raw_hex:
                return

            detect_result = self._call_js('detect_payment', {
                'rawTxHex': raw_hex,
                'scanPriv': data['keys']['scanPriv'],
                'spendPub': data['keys']['spendPub'],
            })
            if not isinstance(detect_result, list) or not detect_result:
                return

            utxos = data.setdefault('utxos', [])
            added = 0
            for utxo in detect_result:
                utxo['txid'] = txid
                if any(existing.get('txid') == utxo.get('txid') and existing.get('vout') == utxo.get('vout') for existing in utxos):
                    continue
                utxos.append(utxo)
                added += 1

            if added > 0:
                self._save_utxos(wallet)
                if hasattr(self, 'nostr_utxo_found'):
                    self.nostr_utxo_found.emit()
        except Exception as exc:
            self.print_error(f'Nostr event error: {exc}')