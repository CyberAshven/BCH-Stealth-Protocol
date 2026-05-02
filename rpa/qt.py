#!/usr/bin/env python3
"""
BCH RPA Plugin — Qt UI

Shows the wallet's paycode, lets the user copy it, and provides a simple
"scan for payments" button wired to the RPA manager.
"""

from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont
from PyQt5.QtWidgets import (QHBoxLayout, QLabel, QLineEdit, QPushButton,
                             QVBoxLayout, QWidget, QApplication, QMessageBox,
                             QDoubleSpinBox, QGroupBox, QPlainTextEdit,
                             QTableWidget, QTableWidgetItem, QHeaderView,
                             QAbstractItemView)

from electroncash.i18n import _
from electroncash.plugins import hook

from .plugin import RpaPlugin


class Plugin(RpaPlugin):
    """Qt-enabled wrapper."""

    @hook
    def on_new_window(self, window):
        try:
            wallet = window.wallet
            self.load_wallet(wallet, window)
            self._add_tab(window)
        except Exception as exc:
            self.print_error(f'on_new_window error: {exc!r}')

    @hook
    def init_qt(self, gui):
        # Handle windows that already existed when the plugin was enabled.
        try:
            for window in list(gui.windows):
                try:
                    self.load_wallet(window.wallet, window)
                    self._add_tab(window)
                except Exception as exc:
                    self.print_error(f'init_qt window error: {exc!r}')
        except Exception as exc:
            self.print_error(f'init_qt error: {exc!r}')

    @hook
    def on_close_window(self, window):
        try:
            self._remove_tab(window)
        except Exception as exc:
            self.print_error(f'on_close_window error: {exc!r}')

    def _find_tab_index(self, window, label):
        tabs = window.tabs
        for i in range(tabs.count()):
            if tabs.tabText(i) == label:
                return i
        return -1

    def _add_tab(self, window):
        tabs = window.tabs
        # Prevent duplicate tabs on disable/enable cycles
        if self._find_tab_index(window, _('RPA')) >= 0:
            return
        widget = self._build_widget(window)
        idx = tabs.addTab(widget, _('RPA'))
        tabs.setTabToolTip(idx, _('Reusable Payment Addresses'))

    def _remove_tab(self, window):
        try:
            idx = self._find_tab_index(window, _('RPA'))
            if idx >= 0:
                window.tabs.removeTab(idx)
        except Exception:
            pass

    def _build_widget(self, window) -> QWidget:
        wallet = window.wallet
        w = QWidget()
        layout = QVBoxLayout(w)

        title = QLabel(_('Your Paycode'))
        tf = QFont()
        tf.setBold(True)
        tf.setPointSize(12)
        title.setFont(tf)
        layout.addWidget(title)

        sub = QLabel(_("Derived at m/47'/145'/0' (BIP47 branch)"))
        sub.setStyleSheet('color: gray;')
        layout.addWidget(sub)

        # Show any error recorded by load_wallet
        entry = self.rpa_data.get(id(wallet), {}) if hasattr(self, 'rpa_data') else {}
        err_text = entry.get('error') if isinstance(entry, dict) else None
        if err_text:
            err_lbl = QLabel(_('RPA unavailable: ') + str(err_text))
            err_lbl.setWordWrap(True)
            err_lbl.setStyleSheet('color: #ff6b6b; font-size: 12px;')
            layout.addWidget(err_lbl)

        paycode = self.get_paycode(wallet) or _('(unavailable — watch-only or encrypted)')

        pc_edit = QLineEdit(paycode)
        pc_edit.setReadOnly(True)
        pc_edit.setCursorPosition(0)
        pc_edit.setStyleSheet('font-family: monospace; font-size: 11px;')
        layout.addWidget(pc_edit)

        row = QHBoxLayout()
        copy_btn = QPushButton(_('Copy'))
        copy_btn.clicked.connect(lambda: QApplication.clipboard().setText(paycode))
        row.addWidget(copy_btn)

        refresh_btn = QPushButton(_('Refresh'))
        def _refresh():
            from .core import bip47_derive
            bip47_derive.clear_cache(wallet)
            new_pc = self.get_paycode(wallet) or paycode
            pc_edit.setText(new_pc)
            pc_edit.setCursorPosition(0)
        refresh_btn.clicked.connect(_refresh)
        row.addWidget(refresh_btn)

        row.addStretch(1)
        layout.addLayout(row)

        # Key info block
        keys = self.get_keys(wallet)
        if keys:
            info = QLabel(
                _("Scan pubkey:  ") + keys['scan_pub'] + "\n" +
                _("Spend pubkey: ") + keys['spend_pub']
            )
            info.setStyleSheet('font-family: monospace; color: #888;')
            info.setTextInteractionFlags(Qt.TextSelectableByMouse)
            layout.addWidget(info)

        # ── Send section ────────────────────────────────────────
        send_group = QGroupBox(_('Send RPA Payment'))
        send_v = QVBoxLayout(send_group)
        send_desc = QLabel(_(
            'Send BCH to a paycode. A unique one-time destination address is '
            'derived via BIP47 ECDH — the paycode is never used on-chain.'))
        send_desc.setWordWrap(True)
        send_desc.setStyleSheet('color: gray;')
        send_v.addWidget(send_desc)

        pc_in = QLineEdit()
        pc_in.setPlaceholderText(_('paycode:q... (recipient paycode)'))
        pc_in.setStyleSheet('font-family: monospace; font-size: 11px;')
        send_v.addWidget(pc_in)

        amt_row = QHBoxLayout()
        amt_row.addWidget(QLabel(_('Amount (BCH):')))
        amt_spin = QDoubleSpinBox()
        amt_spin.setDecimals(8)
        amt_spin.setRange(0.0, 21_000_000.0)
        amt_spin.setSingleStep(0.001)
        amt_spin.setValue(0.001)
        amt_row.addWidget(amt_spin, 1)
        send_v.addLayout(amt_row)

        send_btn = QPushButton(_('Build && Preview Transaction →'))
        def _do_send():
            self._send_rpa_payment(window, pc_in.text().strip(),
                                   amt_spin.value(), send_btn)
        send_btn.clicked.connect(_do_send)
        send_v.addWidget(send_btn)

        send_status = QLabel('')
        send_status.setWordWrap(True)
        send_status.setStyleSheet('color: #ff6b6b;')
        send_v.addWidget(send_status)
        self._rpa_send_status = send_status
        layout.addWidget(send_group)

        # ── Transaction history ─────────────────────────────────
        hist_group = QGroupBox(_('Wallet Transactions'))
        hist_v = QVBoxLayout(hist_group)
        hist_desc = QLabel(_(
            'Recent wallet transactions. RPA-received payments appear here '
            'once the sender broadcasts and the wallet picks up the UTXO.'))
        hist_desc.setWordWrap(True)
        hist_desc.setStyleSheet('color: gray;')
        hist_v.addWidget(hist_desc)

        hist_table = QTableWidget(0, 4)
        hist_table.setHorizontalHeaderLabels(
            [_('Height'), _('Date'), _('Amount (BCH)'), _('TXID')])
        hist_table.verticalHeader().setVisible(False)
        hist_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        hist_table.setSelectionBehavior(QAbstractItemView.SelectRows)
        hh = hist_table.horizontalHeader()
        hh.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(3, QHeaderView.Stretch)
        hist_v.addWidget(hist_table)

        def _refresh_history():
            self._populate_rpa_history(window, hist_table)

        hrow = QHBoxLayout()
        hrefresh = QPushButton(_('Refresh History'))
        hrefresh.clicked.connect(_refresh_history)
        hrow.addWidget(hrefresh)
        hrow.addStretch(1)
        hist_v.addLayout(hrow)

        layout.addWidget(hist_group, 1)
        _refresh_history()

        layout.addStretch(1)
        return w

    # ── Send logic ──────────────────────────────────────────────

    def _send_rpa_payment(self, window, paycode_str: str, amount_bch: float,
                          btn: QPushButton):
        """Build an RPA transaction and hand it off to EC's signing UI."""
        self._rpa_send_status.setText('')
        if not paycode_str:
            self._rpa_send_status.setText(_('Enter a recipient paycode.'))
            return
        if amount_bch <= 0:
            self._rpa_send_status.setText(_('Enter an amount greater than 0.'))
            return

        wallet = window.wallet
        password = None
        try:
            needs_pw = hasattr(wallet, 'has_password') and wallet.has_password()
        except Exception:
            needs_pw = False
        if needs_pw:
            try:
                password = window.password_dialog(
                    msg=_('Enter wallet password to sign the RPA transaction'))
            except TypeError:
                password = window.password_dialog()
            if not password:
                self._rpa_send_status.setText(_('Password required — aborted.'))
                return

        btn.setEnabled(False)
        btn.setText(_('Building transaction...'))
        QApplication.processEvents()

        try:
            from .core import paycode as rpa_paycode
            tx = rpa_paycode.generate_transaction_from_paycode(
                wallet, window.config, amount_bch, paycode_str,
                password=password,
            )
            if tx is None:
                raise RuntimeError(_('Transaction builder returned None'))
            # Hand off to Electron Cash's usual transaction preview/broadcast
            # dialog — user can review inputs/outputs and click Broadcast.
            window.show_transaction(tx,
                                    tx_desc=_('RPA payment to ') + paycode_str[:24] + '…')
            self._rpa_send_status.setStyleSheet('color: #3ad29f;')
            self._rpa_send_status.setText(
                _('Transaction built. Review and Broadcast in the dialog.'))
        except Exception as exc:
            self.print_error(f'RPA send error: {exc!r}')
            self._rpa_send_status.setStyleSheet('color: #ff6b6b;')
            self._rpa_send_status.setText(_('Failed: ') + str(exc))
        finally:
            btn.setEnabled(True)
            btn.setText(_('Build && Preview Transaction →'))

    # ── History ─────────────────────────────────────────────────

    def _populate_rpa_history(self, window, table):
        """Populate table with the wallet's transaction history.

        Uses wallet.get_history() (same source EC's main History tab uses),
        so RPA-received payments show up as soon as the wallet detects
        the incoming UTXO.
        """
        try:
            from datetime import datetime
            wallet = window.wallet
            hist = []
            try:
                hist = list(wallet.get_history())
            except Exception as exc:
                self.print_error(f'get_history failed: {exc!r}')

            # Newest first
            hist.reverse()
            hist = hist[:200]

            table.setRowCount(len(hist))
            for row, item in enumerate(hist):
                # item is (tx_hash, height, conf, timestamp, value, balance)
                try:
                    tx_hash = item[0]
                    height = item[1]
                    timestamp = item[3] if len(item) > 3 else 0
                    value = item[4] if len(item) > 4 else 0
                except Exception:
                    continue

                height_item = QTableWidgetItem(
                    str(height) if height and height > 0 else _('unconf'))
                height_item.setTextAlignment(Qt.AlignCenter)

                if timestamp:
                    try:
                        date_s = datetime.fromtimestamp(int(timestamp)) \
                            .strftime('%Y-%m-%d %H:%M')
                    except Exception:
                        date_s = ''
                else:
                    date_s = ''
                date_item = QTableWidgetItem(date_s)

                try:
                    bch = float(value) / 1e8
                    amt_s = f'{bch:+.8f}'
                except Exception:
                    amt_s = str(value)
                amt_item = QTableWidgetItem(amt_s)
                amt_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                if isinstance(value, (int, float)) and value > 0:
                    amt_item.setForeground(Qt.darkGreen)

                txid_item = QTableWidgetItem(tx_hash)
                txid_item.setToolTip(tx_hash)
                f = QFont('monospace')
                txid_item.setFont(f)

                table.setItem(row, 0, height_item)
                table.setItem(row, 1, date_item)
                table.setItem(row, 2, amt_item)
                table.setItem(row, 3, txid_item)

            # Double-click → open EC's tx dialog
            def _open(r, _c):
                try:
                    it = table.item(r, 3)
                    if not it:
                        return
                    txid = it.text()
                    tx = wallet.transactions.get(txid)
                    if tx is not None:
                        window.show_transaction(tx)
                except Exception as exc:
                    self.print_error(f'open tx error: {exc!r}')

            try:
                table.cellDoubleClicked.disconnect()
            except Exception:
                pass
            table.cellDoubleClicked.connect(_open)
        except Exception as exc:
            self.print_error(f'_populate_rpa_history error: {exc!r}')
