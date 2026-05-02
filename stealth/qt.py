#!/usr/bin/env python3
"""Stealth Addresses Plugin — Qt GUI."""

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QLineEdit, QProgressBar,
    QGroupBox, QTableWidget, QTableWidgetItem,
    QHeaderView, QSpinBox, QCheckBox, QComboBox,
)
from PyQt5.QtCore import QObject, pyqtSignal
from PyQt5.QtGui import QFont

from electroncash.plugins import hook
from electroncash.i18n import _

from .plugin import StealthPlugin


class Plugin(StealthPlugin, QObject):
    scan_progress = pyqtSignal(float, int, int)
    scan_complete = pyqtSignal(int)
    nostr_utxo_found = pyqtSignal()

    def __init__(self, parent, config, name):
        StealthPlugin.__init__(self, parent, config, name)
        QObject.__init__(self)
        self.windows = {}

    @hook
    def init_qt(self, gui):
        for window in gui.windows:
            try:
                self._add_stealth_tab(window)
            except Exception as exc:
                self.print_error(f'init_qt window error: {exc!r}')

    @hook
    def on_new_window(self, window):
        try:
            self._add_stealth_tab(window)
        except Exception as exc:
            self.print_error(f'on_new_window error: {exc!r}')

    @hook
    def on_close_window(self, window):
        self.windows.pop(window, None)
        try:
            idx = self._find_tab_index(window, 'Stealth')
            if idx >= 0:
                window.tabs.removeTab(idx)
        except Exception:
            pass

    def _find_tab_index(self, window, label):
        tabs = window.tabs
        for i in range(tabs.count()):
            if tabs.tabText(i) == label:
                return i
        return -1

    def _add_stealth_tab(self, window):
        if window in self.windows:
            return
        # Guard against a Stealth tab that survived a previous disable/enable
        # cycle (self.windows is reset on re-init but the QTabWidget keeps the
        # old tab). Dedupe by visible tab label.
        existing_idx = self._find_tab_index(window, 'Stealth')
        if existing_idx >= 0:
            self.windows[window] = window.tabs.widget(existing_idx)
            return
        if hasattr(window, 'wallet') and window.wallet:
            self.load_wallet(window.wallet, window)
        tab = self._create_stealth_tab(window)
        window.tabs.addTab(tab, 'Stealth')
        self.windows[window] = tab

    def _create_stealth_tab(self, window):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(16)

        wallet = window.wallet if hasattr(window, 'wallet') else None
        wallet_id = id(wallet) if wallet else None
        data = self.stealth_data.get(wallet_id) if wallet_id else None
        keys = data.get('keys') if data else None

        header = QLabel(_('Stealth Addresses'))
        header.setFont(QFont('', 16, QFont.Bold))
        layout.addWidget(header)

        if not keys:
            err_text = data.get('error') if isinstance(data, dict) else None
            if err_text:
                no_keys = QLabel(_('Stealth unavailable: ') + str(err_text))
            else:
                no_keys = QLabel(_('Stealth requires a BIP39 seed phrase wallet.\nThis wallet does not support stealth addresses.'))
            no_keys.setWordWrap(True)
            no_keys.setStyleSheet('color: #ff6b6b; font-size: 13px;')
            layout.addWidget(no_keys)
            layout.addStretch()
            return widget

        paycode_group = QGroupBox(_('Your Stealth Paycode'))
        paycode_layout = QVBoxLayout(paycode_group)
        paycode_layout.addWidget(QLabel(_('Share this paycode to receive stealth payments:')))
        paycode_text = QLineEdit(keys['paycode'])
        paycode_text.setReadOnly(True)
        paycode_text.setFont(QFont('Courier', 10))
        paycode_text.setStyleSheet('padding: 8px; background: #1c2128; color: #1DD9A5; border-radius: 4px;')
        paycode_layout.addWidget(paycode_text)
        copy_btn = QPushButton(_('Copy Paycode'))
        copy_btn.clicked.connect(lambda: window.app.clipboard().setText(keys['paycode']))
        paycode_layout.addWidget(copy_btn)
        layout.addWidget(paycode_group)

        balance_group = QGroupBox(_('Stealth Balance'))
        balance_layout = QHBoxLayout(balance_group)
        balance = self.get_stealth_balance(wallet)
        balance_label = QLabel(f'{balance / 1e8:.8f} BCH')
        balance_label.setFont(QFont('', 20, QFont.Bold))
        balance_layout.addWidget(balance_label)
        count_label = QLabel(f'({len(self.stealth_data.get(wallet_id, {}).get("utxos", []))} UTXOs)')
        count_label.setStyleSheet('color: #8b949e;')
        balance_layout.addWidget(count_label)
        balance_layout.addStretch()
        layout.addWidget(balance_group)

        utxo_group = QGroupBox(_('Stealth UTXOs'))
        utxo_layout = QVBoxLayout(utxo_group)
        table = QTableWidget()
        table.setColumnCount(5)
        table.setHorizontalHeaderLabels([_(''), _('TXID'), _('Address'), _('Amount'), _('Height')])
        table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Fixed)
        table.setColumnWidth(0, 30)
        table.setAlternatingRowColors(True)
        utxo_layout.addWidget(table)
        layout.addWidget(utxo_group)

        send_group = QGroupBox(_('Send Stealth Payment'))
        send_layout = QVBoxLayout(send_group)
        send_desc = QLabel(_('Send BCH to a stealth paycode. The recipient address is derived via ECDH.\nThe transaction looks like a normal P2PKH payment on-chain.'))
        send_desc.setWordWrap(True)
        send_layout.addWidget(send_desc)
        paycode_input = QLineEdit()
        paycode_input.setPlaceholderText(_('stealth:02abc...def (recipient paycode)'))
        paycode_input.setFont(QFont('Courier', 10))
        send_layout.addWidget(paycode_input)

        amount_layout = QHBoxLayout()
        amount_layout.addWidget(QLabel(_('Amount (BCH):')))
        amount_input = QLineEdit()
        amount_input.setPlaceholderText('0.001')
        amount_layout.addWidget(amount_input)
        max_btn = QPushButton(_('MAX'))
        max_btn.setFixedWidth(50)
        max_btn.setStyleSheet('font-weight: bold; font-size: 11px;')

        def selected_utxos():
            selected = []
            utxo_list = self.stealth_data.get(wallet_id, {}).get('utxos', [])
            for row in range(table.rowCount()):
                cb = table.cellWidget(row, 0)
                if cb and cb.isChecked() and row < len(utxo_list):
                    selected.append(utxo_list[row])
            return selected

        def set_max():
            total = sum(utxo.get('value', 0) for utxo in selected_utxos())
            fee = (150 * max(len(selected_utxos()), 1) + 34 + 10) * 2
            amount_input.setText(f'{max(0, total - fee) / 1e8:.8f}')

        max_btn.clicked.connect(set_max)
        amount_layout.addWidget(max_btn)
        send_layout.addLayout(amount_layout)

        change_layout = QHBoxLayout()
        change_layout.addWidget(QLabel(_('Change to:')))
        change_combo = QComboBox()
        change_combo.addItem(_('New stealth self-address (private)'), 'stealth')
        change_combo.addItem(_('My normal address (faster)'), 'normal')
        change_layout.addWidget(change_combo)
        send_layout.addLayout(change_layout)

        send_status = QLabel('')
        send_status.setStyleSheet('color: #8b949e; font-size: 11px;')
        send_layout.addWidget(send_status)
        send_btn = QPushButton(_('Send Stealth →'))
        send_btn.setStyleSheet('background: #1DD9A5; color: #000; font-weight: bold; padding: 8px;')

        def do_send():
            paycode_raw = paycode_input.text().strip()
            try:
                amount_sats = int(float(amount_input.text().strip()) * 1e8)
            except ValueError:
                send_status.setText(_('Invalid amount'))
                send_status.setStyleSheet('color: #ff6b6b; font-size: 11px;')
                return
            if amount_sats < 546:
                send_status.setText(_('Minimum 546 satoshis'))
                send_status.setStyleSheet('color: #ff6b6b; font-size: 11px;')
                return
            if not paycode_raw.startswith('stealth:') or len(paycode_raw.replace('stealth:', '')) != 132:
                send_status.setText(_('Invalid paycode (need stealth: + 132 hex chars)'))
                send_status.setStyleSheet('color: #ff6b6b; font-size: 11px;')
                return

            send_btn.setEnabled(False)
            send_btn.setText(_('Deriving address...'))
            send_status.setText('')
            chosen_utxos = selected_utxos()
            change_mode = change_combo.currentData()

            import threading

            def send_thread():
                try:
                    txid = self.send_stealth(wallet, paycode_raw, amount_sats, window,
                                            stealth_utxos=chosen_utxos, change_mode=change_mode)
                    from PyQt5.QtCore import QTimer
                    QTimer.singleShot(0, lambda: self._send_done(txid, send_btn, send_status, paycode_input, amount_input))
                except Exception as exc:
                    err_msg = str(exc)
                    from PyQt5.QtCore import QTimer
                    QTimer.singleShot(0, lambda: self._send_error(err_msg, send_btn, send_status))

            threading.Thread(target=send_thread, daemon=True).start()

        send_btn.clicked.connect(do_send)
        send_layout.addWidget(send_btn)
        layout.addWidget(send_group)

        scan_group = QGroupBox(_('Advanced Scan'))
        scan_layout = QVBoxLayout(scan_group)
        scan_desc = QLabel(_('Scan blocks for stealth payments. Local mode uses your own Fulcrum server (fully private, slower). Remote mode queries a public P2PKH pubkey indexer (faster, zero-knowledge but trusts the server is online).'))
        scan_desc.setWordWrap(True)
        scan_layout.addWidget(scan_desc)

        mode_row = QHBoxLayout()
        mode_row.addWidget(QLabel(_('Scan mode:')))
        mode_combo = QComboBox()
        mode_combo.addItem(_('Local (via your Fulcrum server)'), 'local')
        mode_combo.addItem(_('Remote indexer (HTTP API)'), 'remote')
        mode_row.addWidget(mode_combo, 1)
        scan_layout.addLayout(mode_row)

        indexer_row = QHBoxLayout()
        indexer_row.addWidget(QLabel(_('Indexer URL:')))
        indexer_edit = QLineEdit('https://0penw0rld.com/api')
        indexer_edit.setToolTip(_('Only used in Remote mode.'))
        indexer_row.addWidget(indexer_edit, 1)
        scan_layout.addLayout(indexer_row)

        def _sync_indexer_enabled(_i=None):
            indexer_edit.setEnabled(mode_combo.currentData() == 'remote')
        mode_combo.currentIndexChanged.connect(_sync_indexer_enabled)
        _sync_indexer_enabled()

        range_layout = QHBoxLayout()
        range_layout.addWidget(QLabel(_('From block:')))
        from_spin = QSpinBox()
        from_spin.setRange(1, 99999999)
        from_spin.setValue(943000)
        range_layout.addWidget(from_spin)
        range_layout.addWidget(QLabel(_('To block:')))
        to_spin = QSpinBox()
        to_spin.setRange(1, 99999999)
        to_spin.setValue(943400)
        range_layout.addWidget(to_spin)
        scan_layout.addLayout(range_layout)
        progress = QProgressBar()
        progress.setVisible(False)
        scan_layout.addWidget(progress)
        status_label = QLabel('')
        status_label.setStyleSheet('color: #8b949e; font-size: 11px;')
        scan_layout.addWidget(status_label)
        scan_btn = QPushButton(_('Start Scan'))

        def do_scan():
            mode = mode_combo.currentData() or 'local'
            indexer_url = indexer_edit.text().strip() or 'https://0penw0rld.com/api'
            from_h = from_spin.value()
            to_h = to_spin.value()
            total = max(1, to_h - from_h + 1)

            scan_btn.setEnabled(False)
            scan_btn.setText(_('Scanning...'))
            progress.setVisible(True)
            if mode == 'local':
                # Real progress: we know how many blocks we plan to fetch.
                progress.setRange(0, total)
                progress.setValue(0)
                status_label.setText(
                    _('Fetching blocks from your Fulcrum server…'))
            else:
                # Remote runs in one JS call — use busy mode.
                progress.setRange(0, 0)
                status_label.setText(_('Querying remote pubkey indexer…'))
            status_label.setStyleSheet('color: #8b949e; font-size: 11px;')

            import threading
            from PyQt5.QtCore import QTimer

            def _on_progress(done, tot):
                QTimer.singleShot(0, lambda: (
                    progress.setRange(0, tot),
                    progress.setValue(done),
                    status_label.setText(
                        _('Fetched {0} / {1} blocks').format(done, tot)),
                ))

            def scan_thread():
                try:
                    found = self.scan_blocks(
                        wallet, from_h, to_h,
                        mode=mode,
                        indexer_url=indexer_url,
                        progress_cb=_on_progress,
                    )
                    QTimer.singleShot(0, lambda: self._scan_done(window, found, scan_btn, progress, status_label, balance_label, count_label, table))
                except Exception as exc:
                    err_msg = str(exc)
                    QTimer.singleShot(0, lambda: self._scan_error(err_msg, scan_btn, progress, status_label))

            threading.Thread(target=scan_thread, daemon=True).start()

        scan_btn.clicked.connect(do_scan)
        scan_layout.addWidget(scan_btn)
        layout.addWidget(scan_group)

        def refresh_tab():
            utxos = self.stealth_data.get(id(wallet), {}).get('utxos', [])
            balance = sum(utxo.get('value', 0) for utxo in utxos)
            balance_label.setText(f'{balance / 1e8:.8f} BCH')
            count_label.setText(f'({len(utxos)} UTXOs)')
            table.setRowCount(len(utxos))
            for row, utxo in enumerate(utxos):
                cb = QCheckBox()
                cb.setChecked(True)
                table.setCellWidget(row, 0, cb)
                txid = utxo.get('txid', '')
                table.setItem(row, 1, QTableWidgetItem(txid[:12] + '...' + txid[-6:] if len(txid) > 18 else txid))
                table.setItem(row, 2, QTableWidgetItem(str(utxo.get('addr', ''))[:20] + '...'))
                table.setItem(row, 3, QTableWidgetItem(f'{utxo.get("value", 0) / 1e8:.8f}'))
                table.setItem(row, 4, QTableWidgetItem(str(utxo.get('height', 0))))

        refresh_tab()
        widget._refresh_cb = refresh_tab
        self.nostr_utxo_found.connect(refresh_tab)
        layout.addStretch()
        return widget

    def _scan_done(self, window, found, btn, progress, status, bal_label, count_label, table=None):
        btn.setEnabled(True)
        btn.setText(_('Start Scan'))
        progress.setRange(0, 100)
        progress.setValue(100)
        if found > 0:
            status.setText(f'Found {found} stealth UTXOs!')
            status.setStyleSheet('color: #1DD9A5; font-size: 11px;')
            wallet = window.wallet
            balance = self.get_stealth_balance(wallet)
            bal_label.setText(f'{balance / 1e8:.8f} BCH')
            utxos = self.stealth_data.get(id(wallet), {}).get('utxos', [])
            count_label.setText(f'({len(utxos)} UTXOs)')
            if table:
                table.setRowCount(len(utxos))
                for row, utxo in enumerate(utxos):
                    cb = QCheckBox()
                    cb.setChecked(True)
                    table.setCellWidget(row, 0, cb)
                    txid = utxo.get('txid', '')
                    table.setItem(row, 1, QTableWidgetItem(txid[:12] + '...' + txid[-6:] if len(txid) > 18 else txid))
                    table.setItem(row, 2, QTableWidgetItem(str(utxo.get('addr', ''))[:20] + '...'))
                    table.setItem(row, 3, QTableWidgetItem(f'{utxo.get("value", 0) / 1e8:.8f}'))
                    table.setItem(row, 4, QTableWidgetItem(str(utxo.get('height', 0))))
        else:
            status.setText(_('Scan complete — no new stealth UTXOs found'))
            status.setStyleSheet('color: #8b949e; font-size: 11px;')

    def _scan_error(self, error, btn, progress, status):
        btn.setEnabled(True)
        btn.setText(_('Start Scan'))
        progress.setRange(0, 100)
        progress.setValue(0)
        progress.setVisible(False)
        status.setText(f'Error: {error}')
        status.setStyleSheet('color: #ff6b6b; font-size: 11px;')

    def _send_done(self, txid, btn, status, paycode_input, amount_input):
        btn.setEnabled(True)
        btn.setText(_('Send Stealth →'))
        status.setText(f'Sent! TXID: {txid[:16]}...{txid[-8:]}')
        status.setStyleSheet('color: #1DD9A5; font-size: 11px;')
        paycode_input.clear()
        amount_input.clear()
        for _window, tab_widget in self.windows.items():
            if hasattr(tab_widget, '_refresh_cb') and tab_widget._refresh_cb:
                try:
                    tab_widget._refresh_cb()
                except Exception as exc:
                    self.print_error(f'refresh error: {exc}')

    def _send_error(self, error, btn, status):
        btn.setEnabled(True)
        btn.setText(_('Send Stealth →'))
        status.setText(f'Error: {error}')
        status.setStyleSheet('color: #ff6b6b; font-size: 11px;')