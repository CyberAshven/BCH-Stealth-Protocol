# -*- coding: utf-8 -*-
#
# BCH RPA Plugin — BIP47-style derivation helper
#
# Routes `derive_pubkeys(0, 0)` / `derive_pubkeys(0, 1)` in the upstream
# Electron Cash RPA code through an isolated BIP47 branch of the wallet
# seed instead of the wallet's main receiving chain.
#
# Paths used (00 Protocol agreement):
#   m/47'/145'/0'/0'/0   — spend key
#   m/47'/145'/0'/1'/0   — scan key
#
# This keeps the RPA scan/spend material separate from the BIP44 spending
# tree, mirroring the m/352' layout used by the Stealth plugin in this
# same repo.
#
# Copyright (C) 2026 0penw0rld / 00 Protocol — MIT License

import hashlib
import hmac
import threading
from typing import Optional, Tuple

from electroncash import bitcoin, keystore
from electroncash.address import Base58

# secp256k1 curve order
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141

_cache_lock = threading.Lock()
_cache: dict = {}


def _hmac_sha512(key: bytes, data: bytes) -> bytes:
    return hmac.new(key, data, hashlib.sha512).digest()


def _ckd_priv(parent_priv: bytes, parent_chain: bytes, index: int, hardened: bool) -> Tuple[bytes, bytes]:
    i = index + 0x80000000 if hardened else index
    if hardened:
        data = b'\x00' + parent_priv + i.to_bytes(4, 'big')
    else:
        parent_pub = bytes.fromhex(bitcoin.public_key_from_private_key(parent_priv.hex(), True))
        data = parent_pub + i.to_bytes(4, 'big')
    I = _hmac_sha512(parent_chain, data)
    IL, IR = I[:32], I[32:]
    child_int = (int.from_bytes(IL, 'big') + int.from_bytes(parent_priv, 'big')) % _N
    return child_int.to_bytes(32, 'big'), IR


def _master_from_seed(seed_phrase: str, seed_type: str = 'bip39',
                      passphrase: str = '') -> Tuple[bytes, bytes]:
    """Mnemonic → BIP32 master (priv, chain), matching EC's conventions.

    seed_type 'bip39' → PBKDF2(HMAC-SHA512, "mnemonic" + passphrase).
    seed_type 'electrum' / 'standard' → EC's own PBKDF2 salt "electrum" + passphrase.
    """
    # Use EC's own helpers so this exactly matches how the wallet
    # derives its own BIP32 root.
    try:
        from electroncash.mnemonic import Mnemonic, Mnemonic_Electrum
    except Exception:
        Mnemonic = None
        Mnemonic_Electrum = None

    if seed_type in ('electrum', 'standard') and Mnemonic_Electrum is not None:
        bip32_seed = Mnemonic_Electrum.mnemonic_to_seed(seed_phrase, passphrase)
    elif Mnemonic is not None:
        bip32_seed = Mnemonic.mnemonic_to_seed(seed_phrase, passphrase)
    else:
        # Plain BIP39 fallback
        bip32_seed = hashlib.pbkdf2_hmac(
            'sha512', seed_phrase.encode('utf-8'),
            ('mnemonic' + (passphrase or '')).encode('utf-8'), 2048, 64)

    I = hmac.new(b'Bitcoin seed', bip32_seed, hashlib.sha512).digest()
    return I[:32], I[32:]


def _derive_rpa_keys(master_priv: bytes, master_chain: bytes) -> dict:
    """Walk m/47'/145'/0'/{0'|1'}/0 and return scan/spend pub+priv hex."""
    priv, chain = master_priv, master_chain
    for idx, hard in [(47, True), (145, True), (0, True)]:
        priv, chain = _ckd_priv(priv, chain, idx, hard)
    # spend branch: /0'/0
    sp_priv, sp_chain = _ckd_priv(priv, chain, 0, True)
    spend_priv, _ = _ckd_priv(sp_priv, sp_chain, 0, False)
    # scan branch:  /1'/0
    sc_priv, sc_chain = _ckd_priv(priv, chain, 1, True)
    scan_priv, _ = _ckd_priv(sc_priv, sc_chain, 0, False)
    spend_pub = bitcoin.public_key_from_private_key(spend_priv.hex(), True)
    scan_pub = bitcoin.public_key_from_private_key(scan_priv.hex(), True)
    return {
        'scan_priv': scan_priv.hex(),
        'scan_pub': scan_pub,
        'spend_priv': spend_priv.hex(),
        'spend_pub': spend_pub,
    }


def rpa_keys_for_wallet(wallet, password: Optional[str] = None) -> Optional[dict]:
    """Return canonical BIP47 scan/spend keys.

    Always derives from the wallet's BIP32 master seed:
        m/47'/145'/0'/0'/0   (spend)
        m/47'/145'/0'/1'/0   (scan)

    Supports BIP39 and Electrum-native seed wallets. Returns None for
    watch-only / hardware / xprv-only / seedless wallets — we do NOT fall
    back to a non-canonical derivation, because the whole point of RPA
    paycodes is that a given wallet seed always produces the same paycode.
    """
    wid = id(wallet)
    with _cache_lock:
        if wid in _cache:
            return _cache[wid]

    try:
        ks = wallet.get_keystore()
    except Exception:
        return None
    if ks is None or not isinstance(ks, keystore.BIP32_KeyStore):
        return None
    if not (hasattr(ks, 'has_seed') and ks.has_seed()):
        return None

    seed = None
    for pwd in [password, None, '']:
        try:
            s = ks.get_seed(pwd)
            if s:
                seed = s
                # Also grab the BIP39 passphrase (if any) using same pwd.
                try:
                    pp = ks.get_passphrase(pwd) or ''
                except Exception:
                    pp = ''
                break
        except Exception:
            continue

    if not seed:
        return None

    seed_type = getattr(ks, 'seed_type', None) or 'bip39'
    try:
        mpriv, mchain = _master_from_seed(seed, seed_type=seed_type,
                                          passphrase=pp)
        keys = _derive_rpa_keys(mpriv, mchain)
        keys['source'] = f"m/47'/145'/0' (seed_type={seed_type})"
        with _cache_lock:
            _cache[wid] = keys
        return keys
    except Exception:
        return None


def _rpa_keys_for_wallet_with_reason(wallet, password):
    """Like rpa_keys_for_wallet but also returns a human-readable reason
    on failure. Used by plugin.py to show a precise error in the UI."""
    try:
        ks = wallet.get_keystore()
    except Exception as exc:
        return None, f'get_keystore() failed: {exc}'
    if ks is None:
        return None, 'Wallet has no keystore.'
    if not isinstance(ks, keystore.BIP32_KeyStore):
        kind = type(ks).__name__
        return None, f'Keystore is {kind}, not BIP32 (RPA needs a BIP32 wallet).'

    has_seed = bool(getattr(ks, 'has_seed', lambda: False)())
    if not has_seed:
        return None, (
            "This wallet has no seed (imported xprv / watch-only / hardware). "
            "Canonical RPA derivation requires the BIP32 master seed so that "
            "the same wallet always produces the same paycode."
        )

    k = rpa_keys_for_wallet(wallet, password=password)
    if k is not None:
        return k, None

    # has seed but couldn't decrypt it
    encrypted = False
    try:
        encrypted = ks.is_master_private_key_encrypted()
    except Exception:
        pass
    if encrypted and not password:
        return None, 'Wallet is encrypted — password required.'
    return None, 'Could not decrypt the wallet seed (wrong password?).'


def scan_pubkey(wallet, password: Optional[str] = None) -> Optional[str]:
    k = rpa_keys_for_wallet(wallet, password)
    return k['scan_pub'] if k else None


def spend_pubkey(wallet, password: Optional[str] = None) -> Optional[str]:
    k = rpa_keys_for_wallet(wallet, password)
    return k['spend_pub'] if k else None


def scan_privkey_wif(wallet, password: Optional[str] = None) -> Optional[str]:
    k = rpa_keys_for_wallet(wallet, password)
    if not k:
        return None
    return bitcoin.SecretToASecret(bytes.fromhex(k['scan_priv']), compressed=True)


def spend_privkey_wif(wallet, password: Optional[str] = None) -> Optional[str]:
    k = rpa_keys_for_wallet(wallet, password)
    if not k:
        return None
    return bitcoin.SecretToASecret(bytes.fromhex(k['spend_priv']), compressed=True)


def clear_cache(wallet=None):
    with _cache_lock:
        if wallet is None:
            _cache.clear()
        else:
            _cache.pop(id(wallet), None)
