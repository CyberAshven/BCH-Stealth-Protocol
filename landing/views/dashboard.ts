/* ══════════════════════════════════════════
   00 Wallet — Dashboard View (SPA v2)
   ══════════════════════════════════════════
   Reuses exact same CSS classes from desktop.css
   as wallet.html v1 (wd-overview, wd-account, etc.)
   ══════════════════════════════════════════ */

import * as state from '../core/state.js';
import * as auth from '../core/auth.js';
import { navigate } from '../router.js';

export const id = 'dashboard';
export const title = '00 Protocol';
export const icon = '⌂';

let _container: HTMLElement | null = null;
let _unsubs: Array<() => void> = [];

// Persistent WizardConnect wallet-mode session
let _wizWalletMgr: any = null;
let _wizConnectedDapp: string | null = null;

function _reqSeq(req: any): number | string | null {
  if (!req) return null;
  return req.sequence ?? req.seq ?? null;
}

function _extractSignedTx(req: any): string {
  if (!req) return '';
  return req.signedTx || req.signedTransaction || req.tx || '';
}

async function _connectWalletConnectFromDashboard() {
  const statusEl = document.getElementById('dash-ext-status');
  const showStatus = (m: string) => { if (statusEl) statusEl.textContent = m; };
  try {
    showStatus('Loading WalletConnect...');

    let modal = document.getElementById('dash-wc-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'dash-wc-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999';
      modal.innerHTML = `<div style="background:#fff;border-radius:16px;padding:20px;max-width:420px;width:92%;text-align:center">
        <h3 style="margin:0 0 8px">WalletConnect</h3>
        <p style="margin:0 0 10px;font-size:12px;color:#64748b">Use QR scan or paste a wc: URI.</p>
        <canvas id="dash-wc-qr" style="max-width:240px"></canvas>
        <div id="dash-wc-uri" style="margin-top:10px;padding:8px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;font-size:11px;word-break:break-all;text-align:left;max-height:80px;overflow:auto"></div>
        <input id="dash-wc-uri-input" placeholder="Paste wc: URI" style="width:100%;margin-top:10px;padding:10px;border-radius:8px;border:1px solid #e2e8f0;font-size:12px;font-family:monospace;box-sizing:border-box" />
        <div style="display:flex;gap:8px;justify-content:center;margin-top:10px;flex-wrap:wrap">
          <button id="dash-wc-start" style="padding:8px 14px;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer">Show QR</button>
          <button id="dash-wc-connect-uri" style="padding:8px 14px;border:none;border-radius:8px;background:#0AC18E;color:#fff;cursor:pointer">Connect URI</button>
          <button id="dash-wc-copy" style="padding:8px 14px;border:1px solid #e2e8f0;border-radius:8px;background:transparent;cursor:pointer">Copy URI</button>
          <button id="dash-wc-close" style="padding:8px 14px;border:1px solid #e2e8f0;border-radius:8px;background:transparent;cursor:pointer">Close</button>
        </div>
      </div>`;
      document.body.appendChild(modal);
      document.getElementById('dash-wc-close')?.addEventListener('click', () => { modal!.style.display = 'none'; });
      document.getElementById('dash-wc-copy')?.addEventListener('click', async () => {
        const u = document.getElementById('dash-wc-uri')?.textContent || '';
        if (!u) return;
        try { await navigator.clipboard.writeText(u); } catch {}
      });
    } else {
      modal.style.display = 'flex';
    }

    const { connectWalletConnect, connectWalletConnectWithUri } = await import('../core/auth.js');
    const finishConnected = async () => {
      try { const bs = await import('../services/balance-service.js'); bs.start(auth.getKeys()); } catch {}
      showStatus('WalletConnect connected');
      _updateWcStatus();
      const m = document.getElementById('dash-wc-modal');
      if (m) m.style.display = 'none';
    };

    document.getElementById('dash-wc-start')!.onclick = async () => {
      try {
        await connectWalletConnect(
          async (uri: string) => {
            showStatus('Scan WalletConnect QR...');
            const uriEl = document.getElementById('dash-wc-uri');
            if (uriEl) uriEl.textContent = uri;
            try {
              const QRCode = (await import('../lib/qrcode.js')).default;
              await QRCode.toCanvas(document.getElementById('dash-wc-qr'), uri, { width: 240, margin: 2 });
            } catch {}
          },
          (msg: string) => showStatus(msg)
        );
        await finishConnected();
      } catch (e: any) {
        showStatus('WalletConnect error: ' + (e?.message || 'unknown'));
      }
    };

    document.getElementById('dash-wc-connect-uri')!.onclick = async () => {
      const input = document.getElementById('dash-wc-uri-input') as HTMLInputElement | null;
      const uri = input?.value?.trim() || '';
      if (!uri) {
        showStatus('Paste a wc: URI first');
        return;
      }
      try {
        showStatus('Connecting with URI...');
        await connectWalletConnectWithUri(uri, (msg: string) => showStatus(msg));
        await finishConnected();
      } catch (e: any) {
        showStatus('WalletConnect URI error: ' + (e?.message || 'unknown'));
      }
    };
  } catch (e: any) {
    showStatus('WalletConnect error: ' + (e?.message || 'unknown'));
  }
}

function _updateWizStatus() {
  const nameEl = document.getElementById('wiz-status-name');
  const dotEl = document.getElementById('wiz-status-dot');
  const secEl = document.getElementById('wiz-status-section');
  if (!secEl) return;
  if (_wizConnectedDapp) {
    if (dotEl) { dotEl.style.background = '#0AC18E'; dotEl.title = 'Connected'; }
    if (nameEl) nameEl.textContent = _wizConnectedDapp;
    secEl.style.borderColor = '#0AC18E44';
  } else {
    if (dotEl) { dotEl.style.background = '#94a3b8'; dotEl.title = 'Disconnected'; }
    if (nameEl) nameEl.textContent = 'No dapp connected';
    secEl.style.borderColor = 'var(--dt-border,#e2e8f0)';
  }
}

function _updateWcStatus() {
  const dotEl = document.getElementById('wc-status-dot');
  if (!dotEl) return;
  const connected = !!auth.isWalletConnect?.();
  dotEl.style.background = connected ? '#0AC18E' : '#94a3b8';
  dotEl.title = connected ? 'Connected' : 'Disconnected';
}

function _showWizSignModal(req: any, mgr: any) {
  document.getElementById('wiz-sign-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'wiz-sign-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:10000';

  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:16px;padding:24px;max-width:460px;width:92%';

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;font-size:16px;margin-bottom:4px';
  title.textContent = 'Sign Request';

  const from = document.createElement('div');
  from.style.cssText = 'font-size:12px;color:#64748b;margin-bottom:12px';
  from.textContent = 'From: ' + (_wizConnectedDapp || 'Dapp');

  const pre = document.createElement('pre');
  pre.style.cssText = 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;font-size:11px;overflow:auto;max-height:200px;white-space:pre-wrap;word-break:break-all;margin:0 0 8px';
  pre.textContent = JSON.stringify(req, null, 2);

  const timer = document.createElement('div');
  timer.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:12px';
  let countdown = 300;
  timer.textContent = 'Auto-rejects in 300s';
  const seq = _reqSeq(req);
  const interval = setInterval(() => {
    countdown--;
    timer.textContent = 'Auto-rejects in ' + countdown + 's';
    if (countdown <= 0) {
      clearInterval(interval);
      if (seq !== null) mgr.rejectSign(seq, 'Timeout');
      overlay.remove();
    }
  }, 1000);

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

  const rejectBtn = document.createElement('button');
  rejectBtn.style.cssText = 'padding:8px 16px;border:1px solid #ef4444;border-radius:8px;background:transparent;color:#ef4444;cursor:pointer;font-weight:600';
  rejectBtn.textContent = 'Reject';
  rejectBtn.onclick = () => {
    clearInterval(interval);
    if (seq !== null) mgr.rejectSign(seq, 'Rejected by user');
    overlay.remove();
  };

  const approveBtn = document.createElement('button');
  approveBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:8px;background:#0AC18E;color:#fff;cursor:pointer;font-weight:600';
  approveBtn.textContent = 'Approve';
  approveBtn.onclick = () => {
    clearInterval(interval);
    const signedTx = _extractSignedTx(req);
    if (seq === null) {
      overlay.remove();
      return;
    }
    if (!signedTx) {
      mgr.rejectSign(seq, 'No signed transaction payload provided');
      overlay.remove();
      return;
    }
    mgr.approveSign(seq, signedTx);
    overlay.remove();
  };

  btns.appendChild(rejectBtn);
  btns.appendChild(approveBtn);
  [title, from, pre, timer, btns].forEach(el => box.appendChild(el));
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

async function _openWizardDappMode() {
  const WC = (window as any).WizardConnect;
  if (!WC) {
    const s = document.getElementById('dash-ext-status');
    if (s) s.textContent = 'WizardConnect module not loaded';
    return;
  }

  const existing = document.getElementById('dash-wiz-modal');
  if (existing) { existing.style.display = 'flex'; return; }

  const modal = document.createElement('div');
  modal.id = 'dash-wiz-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999';

  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:16px;padding:20px;max-width:460px;width:92%';

  const h3 = document.createElement('h3');
  h3.style.cssText = 'margin:0 0 12px';
  h3.textContent = 'WizardConnect';

  // Tab bar
  const tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:4px;margin-bottom:16px;background:#f1f5f9;border-radius:8px;padding:4px';
  const makeTabBtn = (label: string, active: boolean) => {
    const btn = document.createElement('button');
    btn.style.cssText = 'flex:1;padding:6px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;transition:background .15s;'
      + (active ? 'background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)' : 'background:transparent;color:#64748b');
    btn.textContent = label;
    return btn;
  };
  const walletTabBtn = makeTabBtn('Wallet Mode', true);
  const dappTabBtn = makeTabBtn('Dapp Mode', false);
  tabBar.appendChild(walletTabBtn);
  tabBar.appendChild(dappTabBtn);

  // ── Wallet Mode panel ──
  const walletPanel = document.createElement('div');

  const walletDesc = document.createElement('p');
  walletDesc.style.cssText = 'font-size:12px;color:#64748b;margin:0 0 10px';
  walletDesc.textContent = 'Show QR for external dapps to connect to this wallet.';

  const qrCanvas = document.createElement('canvas');
  qrCanvas.id = 'wiz-qr-canvas';
  qrCanvas.style.cssText = 'display:block;margin:0 auto 10px;max-width:200px';

  const wizUriDiv = document.createElement('div');
  wizUriDiv.id = 'wiz-uri-display';
  wizUriDiv.style.cssText = 'font-size:11px;word-break:break-all;color:#334155;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px;max-height:56px;overflow:auto;margin-bottom:8px;display:none';

  const walletStatus = document.createElement('div');
  walletStatus.id = 'wiz-wallet-status';
  walletStatus.style.cssText = 'font-size:12px;color:#334155;min-height:18px;margin-bottom:8px';

  const walletBtns = document.createElement('div');
  walletBtns.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center';
  const genQrBtn = document.createElement('button');
  genQrBtn.id = 'wiz-gen-qr';
  genQrBtn.style.cssText = 'padding:8px 14px;border:none;border-radius:8px;background:#7c3aed;color:#fff;cursor:pointer;font-weight:600';
  genQrBtn.textContent = 'Generate QR';
  const copyUriBtn = document.createElement('button');
  copyUriBtn.style.cssText = 'padding:8px 14px;border:1px solid #e2e8f0;border-radius:8px;background:transparent;cursor:pointer';
  copyUriBtn.textContent = 'Copy URI';
  copyUriBtn.onclick = async () => {
    const uri = wizUriDiv.textContent || '';
    if (uri) try { await navigator.clipboard.writeText(uri); } catch {}
  };
  walletBtns.appendChild(genQrBtn);
  walletBtns.appendChild(copyUriBtn);

  [walletDesc, qrCanvas, wizUriDiv, walletStatus, walletBtns].forEach(el => walletPanel.appendChild(el));

  // ── Dapp Mode panel ──
  const dappPanel = document.createElement('div');
  dappPanel.style.display = 'none';

  const dappDesc = document.createElement('p');
  dappDesc.style.cssText = 'font-size:12px;color:#64748b;margin:0 0 10px';
  dappDesc.textContent = 'Paste a wiz:// URI from an external wallet to connect as a dapp.';

  const dappInput = document.createElement('input') as HTMLInputElement;
  dappInput.placeholder = 'wiz://?p=...&s=...';
  dappInput.style.cssText = 'width:100%;padding:10px;border-radius:8px;border:1px solid #e2e8f0;font-size:12px;font-family:monospace;box-sizing:border-box;margin-bottom:8px';

  const dappStatus = document.createElement('div');
  dappStatus.style.cssText = 'font-size:12px;color:#334155;min-height:18px;margin-bottom:8px';

  const dappConnectBtn = document.createElement('button');
  dappConnectBtn.style.cssText = 'padding:8px 14px;border:none;border-radius:8px;background:#0AC18E;color:#fff;cursor:pointer;font-weight:600;width:100%';
  dappConnectBtn.textContent = 'Connect';
  dappConnectBtn.onclick = () => {
    const uri = dappInput.value.trim();
    if (!uri) { dappStatus.textContent = 'Paste a wiz:// URI first'; return; }
    try {
      const dapp = new WC.DappManager('00 Wallet', '');
      dapp.onConnect((name: string, icon: string, paths: any[]) => {
        dappStatus.textContent = 'Connected to ' + (name || 'wallet') + ' (' + (paths?.length || 0) + ' paths)';
        localStorage.setItem('00_wiz_paths', JSON.stringify(paths || []));
      });
      dapp.onDisconnect((reason: string) => { dappStatus.textContent = 'Disconnected: ' + reason; });
      dapp.connect(uri);
      dappStatus.textContent = 'Connecting...';
    } catch (e: any) {
      dappStatus.textContent = 'Error: ' + (e?.message || 'unknown');
    }
  };

  [dappDesc, dappInput, dappStatus, dappConnectBtn].forEach(el => dappPanel.appendChild(el));

  // Footer
  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;justify-content:flex-end;margin-top:16px';
  const closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'padding:8px 14px;border:1px solid #e2e8f0;border-radius:8px;background:transparent;cursor:pointer';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => { modal.style.display = 'none'; };
  footer.appendChild(closeBtn);

  [h3, tabBar, walletPanel, dappPanel, footer].forEach(el => box.appendChild(el));
  modal.appendChild(box);
  document.body.appendChild(modal);

  // Tab switching
  const setTab = (wallet: boolean) => {
    walletPanel.style.display = wallet ? '' : 'none';
    dappPanel.style.display = wallet ? 'none' : '';
    walletTabBtn.style.background = wallet ? '#fff' : 'transparent';
    walletTabBtn.style.color = wallet ? '' : '#64748b';
    walletTabBtn.style.boxShadow = wallet ? '0 1px 3px rgba(0,0,0,.1)' : 'none';
    dappTabBtn.style.background = wallet ? 'transparent' : '#fff';
    dappTabBtn.style.color = wallet ? '#64748b' : '';
    dappTabBtn.style.boxShadow = wallet ? 'none' : '0 1px 3px rgba(0,0,0,.1)';
  };
  walletTabBtn.onclick = () => setTab(true);
  dappTabBtn.onclick = () => setTab(false);

  // Generate QR — wallet mode
  genQrBtn.onclick = async () => {
    if (_wizWalletMgr) { _wizWalletMgr.destroy(); _wizWalletMgr = null; }
    _wizWalletMgr = new WC.WalletManager();
    const keys = auth.getKeys() as any;
    if (keys?.stealthSpendXpub && keys?.stealthScanXpub) {
      _wizWalletMgr.setStealthXpubs(keys.stealthSpendXpub, keys.stealthScanXpub);
    }
    walletStatus.textContent = 'Generating...';
    const { uri } = await _wizWalletMgr.generateConnection();
    wizUriDiv.textContent = uri;
    wizUriDiv.style.display = '';
    try {
      const QRCode = (await import('../lib/qrcode.js')).default;
      await QRCode.toCanvas(qrCanvas, uri, { width: 200, margin: 2 });
    } catch {}
    walletStatus.textContent = 'Waiting for dapp to scan...';

    _wizWalletMgr.onConnect((name: string) => {
      _wizConnectedDapp = name;
      walletStatus.textContent = 'Connected: ' + name;
      _updateWizStatus();
    });
    _wizWalletMgr.onSignRequest((req: any) => { _showWizSignModal(req, _wizWalletMgr); });
    _wizWalletMgr.onDisconnect(() => { _wizConnectedDapp = null; walletStatus.textContent = 'Disconnected'; _updateWizStatus(); });
    _wizWalletMgr.startListening();
  };
}

/* ── Chain config (same order as wallet.html v1) ── */
/* type: 'chain' = main row, 'token' = indented sub-row (stablecoin) */
const CHAINS = [
  { id:'bch',  chain:'BITCOIN CASH',        name:'Bitcoin Cash',        ticker:'BCH',  dec:8,  color:'#0AC18E', icon:'icons/bch.png',  iconType:'img', type:'chain' },
  { id:'sbch', chain:'STEALTH BITCOIN CASH', name:'Stealth Bitcoin Cash',ticker:'BCH', dec:8,  color:'#BF5AF2', icon:'₿',             iconType:'span', type:'chain', stealth:true },
  { id:'btc',  chain:'BITCOIN',              name:'Bitcoin',             ticker:'BTC',  dec:8,  color:'#F7931A', icon:'icons/btc.png',  iconType:'img', type:'chain' },
  { id:'eth',  chain:'ETHEREUM',             name:'Ethereum',            ticker:'ETH',  dec:18, color:'#627EEA', icon:'icons/eth.png',  iconType:'img', type:'chain' },
  { id:'usdc', chain:'',                     name:'USDC',                ticker:'USDC', dec:6,  color:'#2775CA', icon:'icons/usdc.png', iconType:'img', type:'token' },
  { id:'usdt', chain:'',                     name:'USDT',                ticker:'USDT', dec:6,  color:'#26A17B', icon:'icons/usdt.png', iconType:'img', type:'token' },
  { id:'xmr',  chain:'MONERO',              name:'Monero',              ticker:'XMR',  dec:12, color:'#FF6600', icon:'icons/xmr.png',  iconType:'img', type:'chain' },
  { id:'ltc',  chain:'LITECOIN',            name:'Litecoin',            ticker:'LTC',  dec:8,  color:'#BFBBBB', icon:'icons/ltc.png',  iconType:'img', type:'chain' },
  { id:'bnb',  chain:'BNB SMART CHAIN',     name:'BNB',                 ticker:'BNB',  dec:18, color:'#F0B90B', icon:'icons/bnb.png',  iconType:'img', type:'chain' },
  { id:'usdc_bsc', chain:'',                name:'USDC',                ticker:'USDC', dec:6,  color:'#2775CA', icon:'icons/usdc.png', iconType:'img', type:'token' },
  { id:'usdt_bsc', chain:'',                name:'USDT',                ticker:'USDT', dec:6,  color:'#26A17B', icon:'icons/usdt.png', iconType:'img', type:'token' },
  { id:'avax', chain:'AVALANCHE',           name:'Avalanche',           ticker:'AVAX', dec:18, color:'#E84142', icon:'icons/avax.png', iconType:'img', type:'chain' },
  { id:'usdc_avax', chain:'',               name:'USDC',                ticker:'USDC', dec:6,  color:'#2775CA', icon:'icons/usdc.png', iconType:'img', type:'token' },
  { id:'usdt_avax', chain:'',               name:'USDT',                ticker:'USDT', dec:6,  color:'#26A17B', icon:'icons/usdt.png', iconType:'img', type:'token' },
  { id:'matic', chain:'POLYGON',            name:'Polygon',             ticker:'POL',  dec:18, color:'#8247E5', icon:'https://assets.coingecko.com/coins/images/4713/small/polygon.png',iconType:'img', type:'chain' },
  { id:'usdc_polygon', chain:'',          name:'USDC',                ticker:'USDC', dec:6,  color:'#2775CA', icon:'icons/usdc.png', iconType:'img', type:'token' },
  { id:'usdce_polygon', chain:'',         name:'USDC.e',              ticker:'USDC.e',dec:6, color:'#2775CA', icon:'icons/usdc.png', iconType:'img', type:'token' },
  { id:'sol',  chain:'SOLANA',              name:'Solana',              ticker:'SOL',  dec:9,  color:'#9945FF', icon:'icons/sol.png',  iconType:'img', type:'chain' },
  { id:'usdc_sol', chain:'',                name:'USDC',                ticker:'USDC', dec:6,  color:'#2775CA', icon:'icons/usdc.png', iconType:'img', type:'token' },
  { id:'usdt_sol', chain:'',                name:'USDT',                ticker:'USDT', dec:6,  color:'#26A17B', icon:'icons/usdt.png', iconType:'img', type:'token' },
  { id:'trx',  chain:'TRON',               name:'TRON',                ticker:'TRX',  dec:6,  color:'#FF0013', icon:'icons/trx.png',  iconType:'img', type:'chain' },
  { id:'usdt_trx', chain:'',               name:'USDT',                ticker:'USDT', dec:6,  color:'#26A17B', icon:'icons/usdt.png', iconType:'img', type:'token' },
  { id:'xrp',  chain:'XRP',                name:'XRP',                 ticker:'XRP',  dec:6,  color:'#0085C0', icon:'icons/xrp.png',  iconType:'img', type:'chain' },
  { id:'rlusd_xrp', chain:'',              name:'RLUSD',               ticker:'RLUSD',dec:6,  color:'#0085C0', icon:'icons/xrp.png',  iconType:'img', type:'token' },
  { id:'xlm',  chain:'STELLAR',            name:'Stellar',             ticker:'XLM',  dec:7,  color:'#14B6E7', icon:'icons/xlm.png',  iconType:'img', type:'chain' },
];

const PRICE_CHAINS = ['bch','btc','eth','xmr','ltc','bnb','matic','avax','sol','trx','xrp','xlm'];
const PRICE_DOTS: Record<string, string> = {bch:'#0AC18E',btc:'#F7931A',eth:'#627EEA',xmr:'#FF6600',ltc:'#345D9D',bnb:'#F3BA2F',matic:'#8247E5',avax:'#E84142',sol:'#9945FF',trx:'#FF0013',xrp:'#23292F',xlm:'#14B6E7'};

function fmtBal(raw: number | string | undefined | null, dec: number, ticker: string): string {
  if (raw === undefined || raw === null) return '0 ' + ticker;
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (isNaN(n)) return '0 ' + ticker;
  const val = n / Math.pow(10, dec);
  if (val === 0) return '0 ' + ticker;
  return val.toFixed(dec > 6 ? 8 : Math.min(dec, 4)) + ' ' + ticker;
}

function fmtFiat(raw: number | string | undefined | null, dec: number, price: number | undefined | null): string {
  if (!price || raw === undefined || raw === null) return '$0.00';
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (isNaN(n)) return '$0.00';
  const v = (n / Math.pow(10, dec)) * price;
  return '$' + v.toLocaleString('en', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function fmtPrice(p: number | undefined | null): string {
  if (!p) return '$—';
  return '$' + p.toLocaleString('en', {maximumFractionDigits:2});
}

/* ── Render ── */
function render() {
  if (!_container) return;
  const balances = (state.get('balances') || {}) as Record<string, unknown>;
  const prices = (state.get('prices') || {}) as Record<string, { price?: number }>;

  // Total portfolio
  let total = 0;
  for (const c of CHAINS) {
    const bal = balances[c.id];
    let priceKey = c.id;
    if (c.id === 'sbch') priceKey = 'bch';
    else if (c.id === 'usdce_polygon') priceKey = 'usdc';
    else if (c.id.startsWith('usdc')) priceKey = 'usdc';
    else if (c.id.startsWith('usdt')) priceKey = 'usdt';
    else if (c.id.startsWith('rlusd')) priceKey = 'usdc';
    const p = (prices[priceKey]?.price) || 0;
    if (bal !== undefined && p) {
      const n = typeof bal === 'string' ? parseFloat(bal as string) : (bal as number);
      if (!isNaN(n)) total += (n / Math.pow(10, c.dec)) * p;
    }
  }

  // Price bar
  const priceBar = PRICE_CHAINS.map(id => {
    const p = prices[id]?.price;
    return `<span class="wd-ov-price"><span class="wd-ov-dot" style="background:${PRICE_DOTS[id]}"></span>${id.toUpperCase()} <span>${fmtPrice(p)}</span></span>`;
  }).join('');

  // Account cards
  const cards = CHAINS.map(c => {
    const bal = balances[c.id];
    // Map price keys: stablecoins → usdc/usdt, stealth → bch
    let priceKey = c.id;
    if (c.id === 'sbch') priceKey = 'bch';
    else if (c.id === 'usdce_polygon') priceKey = 'usdc';
    else if (c.id.startsWith('usdc')) priceKey = 'usdc';
    else if (c.id.startsWith('usdt')) priceKey = 'usdt';
    else if (c.id.startsWith('rlusd')) priceKey = 'usdc'; // ~$1
    const p = prices[priceKey]?.price || 0;
    const balTyped = bal as number | string | undefined | null;
    const balStr = fmtBal(balTyped, c.dec, c.ticker);
    const fiatStr = fmtFiat(balTyped, c.dec, p);

    if (c.type === 'token') {
      // Token sub-row (stablecoin) — indented with └
      return `
      <div class="wd-token" onclick="window.location.hash='#/wallet/${c.id}'" style="cursor:pointer">
        <div class="wd-acc-left">
          <span class="wd-token-indent">└</span>
          <img class="wd-acc-icon wd-token-icon" src="${c.icon}" alt="${c.ticker}">
          <div><div class="wd-acc-name">${c.name}</div></div>
        </div>
        <div class="wd-acc-right">
          <span class="wd-acc-balance">${balStr}</span>
          <span class="wd-acc-fiat">${fiatStr}</span>
        </div>
      </div>`;
    }

    // Main chain row
    const cls = c.stealth ? ' stealth' : '';
    const iconHtml = c.iconType === 'img'
      ? `<img class="wd-acc-icon" src="${c.icon}" alt="${c.ticker}">`
      : `<div class="wd-acc-icon" style="background:${c.color}"><span>${c.icon}</span></div>`;

    return `
    <div class="wd-account${cls}" onclick="window.location.hash='#/wallet/${c.id}'" style="cursor:pointer">
      <div class="wd-acc-left">
        ${iconHtml}
        <div>
          <div class="wd-acc-chain">${c.chain}</div>
          <div class="wd-acc-name">${c.name}</div>
        </div>
      </div>
      <div class="wd-acc-right">
        <span class="wd-acc-balance">${balStr}</span>
        <span class="wd-acc-fiat">${fiatStr}</span>
      </div>
    </div>`;
  }).join('');

  _container.innerHTML = `
  <div style="padding:32px 40px">
    <div class="wd-overview">
      <div class="wd-ov-top">
        <div>
          <div class="wd-ov-label">Portfolio Value</div>
          <div class="wd-ov-total">${total > 0 ? '$' + total.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2}) : '$0.00'}</div>
        </div>
        <button class="wd-ov-refresh" onclick="import('./services/balance-service.js').then(m=>m.refreshNow())" title="Refresh balances">↻</button>
      </div>
      <div class="wd-ov-prices">${priceBar}</div>
    </div>
    <div id="wiz-status-section" style="margin-top:12px;background:var(--dt-surface,#fff);border:1px solid var(--dt-border,#e2e8f0);border-radius:14px;padding:14px;transition:border-color .3s">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-size:12px;color:var(--dt-text-secondary,#64748b);margin-bottom:6px">Connections</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:11px;font-weight:600;color:var(--dt-text-secondary,#64748b)">WalletConnect</span>
              <span id="wc-status-dot" style="width:8px;height:8px;border-radius:50%;background:#94a3b8;display:inline-block" title="Disconnected"></span>
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:11px;font-weight:600;color:var(--dt-text-secondary,#64748b)">WizardConnect</span>
              <span id="wiz-status-dot" style="width:8px;height:8px;border-radius:50%;background:#94a3b8;display:inline-block" title="Disconnected"></span>
              <span id="wiz-status-name" style="font-size:11px;color:var(--dt-text-secondary,#64748b)">No dapp connected</span>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="dash-connect-wc" style="padding:8px 12px;border:1px solid #3b82f633;border-radius:8px;background:transparent;color:#2563eb;cursor:pointer;font-weight:600;font-size:13px">WalletConnect</button>
          <button id="dash-connect-wiz" style="padding:8px 12px;border:1px solid #7c3aed33;border-radius:8px;background:transparent;color:#7c3aed;cursor:pointer;font-weight:600;font-size:13px">WizardConnect</button>
          <button id="dash-open-chat" onclick="window.location.hash='#/chat'" style="padding:8px 12px;border:1px solid #0AC18E33;border-radius:8px;background:transparent;color:#0AC18E;cursor:pointer;font-weight:600;font-size:13px">Chat</button>
        </div>
      </div>
      <div id="dash-ext-status" style="margin-top:8px;font-size:12px;color:var(--dt-text-secondary,#64748b)"></div>
    </div>
    <div class="wd-accounts">${cards}</div>
  </div>`;

  document.getElementById('dash-connect-wc')?.addEventListener('click', _connectWalletConnectFromDashboard);
  document.getElementById('dash-connect-wiz')?.addEventListener('click', _openWizardDappMode);
  _updateWcStatus();
  _updateWizStatus();
}

export function mount(container: HTMLElement) {
  _container = container;
  if (!auth.isUnlocked()) { navigate('auth'); return; }
  render();
  _unsubs.push(state.subscribe('balances', render));
  _unsubs.push(state.subscribe('prices', render));
}

export function unmount() {
  _unsubs.forEach(fn => fn());
  _unsubs = [];
  if (_container) _container.innerHTML = '';
  _container = null;
}
