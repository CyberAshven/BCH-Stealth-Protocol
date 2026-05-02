import * as state from "../core/state.js";
import * as auth from "../core/auth.js";
import { navigate } from "../router.js";
const id = "dashboard";
const title = "00 Protocol";
const icon = "\u2302";
let _container = null;
let _unsubs = [];
async function _connectWalletConnectFromDashboard() {
  const statusEl = document.getElementById("dash-ext-status");
  const showStatus = (m) => {
    if (statusEl) statusEl.textContent = m;
  };
  try {
    showStatus("Loading WalletConnect...");
    let modal = document.getElementById("dash-wc-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dash-wc-modal";
      modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999";
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
      document.getElementById("dash-wc-close")?.addEventListener("click", () => {
        modal.style.display = "none";
      });
      document.getElementById("dash-wc-copy")?.addEventListener("click", async () => {
        const u = document.getElementById("dash-wc-uri")?.textContent || "";
        if (!u) return;
        try {
          await navigator.clipboard.writeText(u);
        } catch {
        }
      });
    } else {
      modal.style.display = "flex";
    }
    const { connectWalletConnect, connectWalletConnectWithUri } = await import("../core/auth.js");
    const finishConnected = async () => {
      try {
        const bs = await import("../services/balance-service.js");
        bs.start(auth.getKeys());
      } catch {
      }
      showStatus("WalletConnect connected");
      const m = document.getElementById("dash-wc-modal");
      if (m) m.style.display = "none";
    };
    document.getElementById("dash-wc-start").onclick = async () => {
      try {
        await connectWalletConnect(
          async (uri) => {
            showStatus("Scan WalletConnect QR...");
            const uriEl = document.getElementById("dash-wc-uri");
            if (uriEl) uriEl.textContent = uri;
            try {
              const QRCode = (await import("../lib/qrcode.js")).default;
              await QRCode.toCanvas(document.getElementById("dash-wc-qr"), uri, { width: 240, margin: 2 });
            } catch {
            }
          },
          (msg) => showStatus(msg)
        );
        await finishConnected();
      } catch (e) {
        showStatus("WalletConnect error: " + (e?.message || "unknown"));
      }
    };
    document.getElementById("dash-wc-connect-uri").onclick = async () => {
      const input = document.getElementById("dash-wc-uri-input");
      const uri = input?.value?.trim() || "";
      if (!uri) {
        showStatus("Paste a wc: URI first");
        return;
      }
      try {
        showStatus("Connecting with URI...");
        await connectWalletConnectWithUri(uri, (msg) => showStatus(msg));
        await finishConnected();
      } catch (e) {
        showStatus("WalletConnect URI error: " + (e?.message || "unknown"));
      }
    };
  } catch (e) {
    showStatus("WalletConnect error: " + (e?.message || "unknown"));
  }
}
async function _openWizardDappMode() {
  const statusEl = document.getElementById("dash-ext-status");
  const WC = window.WizardConnect;
  if (!WC) {
    if (statusEl) statusEl.textContent = "WizardConnect module not loaded";
    return;
  }
  let modal = document.getElementById("dash-wiz-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "dash-wiz-modal";
    modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999";
    modal.innerHTML = `<div style="background:#fff;border-radius:16px;padding:20px;max-width:420px;width:92%">
      <h3 style="margin:0 0 8px">WizardConnect</h3>
      <p style="font-size:12px;color:#64748b;margin:0 0 10px">Paste a wiz:// URI from the external wallet.</p>
      <input id="dash-wiz-uri" placeholder="wiz://?p=...&s=..." style="width:100%;padding:10px;border-radius:8px;border:1px solid #e2e8f0;font-size:12px;font-family:monospace;box-sizing:border-box" />
      <div id="dash-wiz-status" style="font-size:12px;min-height:18px;margin-top:8px;color:#334155"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        <button id="dash-wiz-close" style="padding:8px 14px;border:1px solid #e2e8f0;border-radius:8px;background:transparent;cursor:pointer">Close</button>
        <button id="dash-wiz-connect" style="padding:8px 14px;border:none;border-radius:8px;background:#0AC18E;color:#fff;cursor:pointer">Connect</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    document.getElementById("dash-wiz-close")?.addEventListener("click", () => {
      modal.style.display = "none";
    });
    document.getElementById("dash-wiz-connect")?.addEventListener("click", () => {
      const uri = document.getElementById("dash-wiz-uri")?.value?.trim();
      const s = document.getElementById("dash-wiz-status");
      if (!uri) {
        if (s) s.textContent = "Paste a wiz:// URI first";
        return;
      }
      try {
        const dapp = new WC.DappManager("00 Wallet", "");
        dapp.onConnect((walletName, walletIcon, paths) => {
          if (s) s.textContent = "Connected to " + (walletName || "wallet") + " (" + (paths?.length || 0) + " paths)";
          localStorage.setItem("00_wiz_paths", JSON.stringify(paths || []));
          if (statusEl) statusEl.textContent = "WizardConnect connected";
        });
        dapp.onDisconnect((reason) => {
          if (s) s.textContent = "Disconnected: " + reason;
        });
        dapp.connect(uri);
        if (s) s.textContent = "Connecting...";
      } catch (e) {
        if (s) s.textContent = "Error: " + (e?.message || "unknown");
      }
    });
  } else {
    modal.style.display = "flex";
  }
  if (statusEl) statusEl.textContent = "WizardConnect ready";
}
const CHAINS = [
  { id: "bch", chain: "BITCOIN CASH", name: "Bitcoin Cash", ticker: "BCH", dec: 8, color: "#0AC18E", icon: "icons/bch.png", iconType: "img", type: "chain" },
  { id: "sbch", chain: "STEALTH BITCOIN CASH", name: "Stealth Bitcoin Cash", ticker: "BCH", dec: 8, color: "#BF5AF2", icon: "\u20BF", iconType: "span", type: "chain", stealth: true },
  { id: "btc", chain: "BITCOIN", name: "Bitcoin", ticker: "BTC", dec: 8, color: "#F7931A", icon: "icons/btc.png", iconType: "img", type: "chain" },
  { id: "eth", chain: "ETHEREUM", name: "Ethereum", ticker: "ETH", dec: 18, color: "#627EEA", icon: "icons/eth.png", iconType: "img", type: "chain" },
  { id: "usdc", chain: "", name: "USDC", ticker: "USDC", dec: 6, color: "#2775CA", icon: "icons/usdc.png", iconType: "img", type: "token" },
  { id: "usdt", chain: "", name: "USDT", ticker: "USDT", dec: 6, color: "#26A17B", icon: "icons/usdt.png", iconType: "img", type: "token" },
  { id: "xmr", chain: "MONERO", name: "Monero", ticker: "XMR", dec: 12, color: "#FF6600", icon: "icons/xmr.png", iconType: "img", type: "chain" },
  { id: "ltc", chain: "LITECOIN", name: "Litecoin", ticker: "LTC", dec: 8, color: "#BFBBBB", icon: "icons/ltc.png", iconType: "img", type: "chain" },
  { id: "bnb", chain: "BNB SMART CHAIN", name: "BNB", ticker: "BNB", dec: 18, color: "#F0B90B", icon: "icons/bnb.png", iconType: "img", type: "chain" },
  { id: "usdc_bsc", chain: "", name: "USDC", ticker: "USDC", dec: 6, color: "#2775CA", icon: "icons/usdc.png", iconType: "img", type: "token" },
  { id: "usdt_bsc", chain: "", name: "USDT", ticker: "USDT", dec: 6, color: "#26A17B", icon: "icons/usdt.png", iconType: "img", type: "token" },
  { id: "avax", chain: "AVALANCHE", name: "Avalanche", ticker: "AVAX", dec: 18, color: "#E84142", icon: "icons/avax.png", iconType: "img", type: "chain" },
  { id: "usdc_avax", chain: "", name: "USDC", ticker: "USDC", dec: 6, color: "#2775CA", icon: "icons/usdc.png", iconType: "img", type: "token" },
  { id: "usdt_avax", chain: "", name: "USDT", ticker: "USDT", dec: 6, color: "#26A17B", icon: "icons/usdt.png", iconType: "img", type: "token" },
  { id: "matic", chain: "POLYGON", name: "Polygon", ticker: "POL", dec: 18, color: "#8247E5", icon: "https://assets.coingecko.com/coins/images/4713/small/polygon.png", iconType: "img", type: "chain" },
  { id: "usdc_polygon", chain: "", name: "USDC", ticker: "USDC", dec: 6, color: "#2775CA", icon: "icons/usdc.png", iconType: "img", type: "token" },
  { id: "usdce_polygon", chain: "", name: "USDC.e", ticker: "USDC.e", dec: 6, color: "#2775CA", icon: "icons/usdc.png", iconType: "img", type: "token" },
  { id: "sol", chain: "SOLANA", name: "Solana", ticker: "SOL", dec: 9, color: "#9945FF", icon: "icons/sol.png", iconType: "img", type: "chain" },
  { id: "usdc_sol", chain: "", name: "USDC", ticker: "USDC", dec: 6, color: "#2775CA", icon: "icons/usdc.png", iconType: "img", type: "token" },
  { id: "usdt_sol", chain: "", name: "USDT", ticker: "USDT", dec: 6, color: "#26A17B", icon: "icons/usdt.png", iconType: "img", type: "token" },
  { id: "trx", chain: "TRON", name: "TRON", ticker: "TRX", dec: 6, color: "#FF0013", icon: "icons/trx.png", iconType: "img", type: "chain" },
  { id: "usdt_trx", chain: "", name: "USDT", ticker: "USDT", dec: 6, color: "#26A17B", icon: "icons/usdt.png", iconType: "img", type: "token" },
  { id: "xrp", chain: "XRP", name: "XRP", ticker: "XRP", dec: 6, color: "#0085C0", icon: "icons/xrp.png", iconType: "img", type: "chain" },
  { id: "rlusd_xrp", chain: "", name: "RLUSD", ticker: "RLUSD", dec: 6, color: "#0085C0", icon: "icons/xrp.png", iconType: "img", type: "token" },
  { id: "xlm", chain: "STELLAR", name: "Stellar", ticker: "XLM", dec: 7, color: "#14B6E7", icon: "icons/xlm.png", iconType: "img", type: "chain" }
];
const PRICE_CHAINS = ["bch", "btc", "eth", "xmr", "ltc", "bnb", "matic", "avax", "sol", "trx", "xrp", "xlm"];
const PRICE_DOTS = { bch: "#0AC18E", btc: "#F7931A", eth: "#627EEA", xmr: "#FF6600", ltc: "#345D9D", bnb: "#F3BA2F", matic: "#8247E5", avax: "#E84142", sol: "#9945FF", trx: "#FF0013", xrp: "#23292F", xlm: "#14B6E7" };
function fmtBal(raw, dec, ticker) {
  if (raw === void 0 || raw === null) return "0 " + ticker;
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  if (isNaN(n)) return "0 " + ticker;
  const val = n / Math.pow(10, dec);
  if (val === 0) return "0 " + ticker;
  return val.toFixed(dec > 6 ? 8 : Math.min(dec, 4)) + " " + ticker;
}
function fmtFiat(raw, dec, price) {
  if (!price || raw === void 0 || raw === null) return "$0.00";
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  if (isNaN(n)) return "$0.00";
  const v = n / Math.pow(10, dec) * price;
  return "$" + v.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPrice(p) {
  if (!p) return "$\u2014";
  return "$" + p.toLocaleString("en", { maximumFractionDigits: 2 });
}
function render() {
  if (!_container) return;
  const balances = state.get("balances") || {};
  const prices = state.get("prices") || {};
  let total = 0;
  for (const c of CHAINS) {
    const bal = balances[c.id];
    let priceKey = c.id;
    if (c.id === "sbch") priceKey = "bch";
    else if (c.id === "usdce_polygon") priceKey = "usdc";
    else if (c.id.startsWith("usdc")) priceKey = "usdc";
    else if (c.id.startsWith("usdt")) priceKey = "usdt";
    else if (c.id.startsWith("rlusd")) priceKey = "usdc";
    const p = prices[priceKey]?.price || 0;
    if (bal !== void 0 && p) {
      const n = typeof bal === "string" ? parseFloat(bal) : bal;
      if (!isNaN(n)) total += n / Math.pow(10, c.dec) * p;
    }
  }
  const priceBar = PRICE_CHAINS.map((id2) => {
    const p = prices[id2]?.price;
    return `<span class="wd-ov-price"><span class="wd-ov-dot" style="background:${PRICE_DOTS[id2]}"></span>${id2.toUpperCase()} <span>${fmtPrice(p)}</span></span>`;
  }).join("");
  const cards = CHAINS.map((c) => {
    const bal = balances[c.id];
    let priceKey = c.id;
    if (c.id === "sbch") priceKey = "bch";
    else if (c.id === "usdce_polygon") priceKey = "usdc";
    else if (c.id.startsWith("usdc")) priceKey = "usdc";
    else if (c.id.startsWith("usdt")) priceKey = "usdt";
    else if (c.id.startsWith("rlusd")) priceKey = "usdc";
    const p = prices[priceKey]?.price || 0;
    const balTyped = bal;
    const balStr = fmtBal(balTyped, c.dec, c.ticker);
    const fiatStr = fmtFiat(balTyped, c.dec, p);
    if (c.type === "token") {
      return `
      <div class="wd-token" onclick="window.location.hash='#/wallet/${c.id}'" style="cursor:pointer">
        <div class="wd-acc-left">
          <span class="wd-token-indent">\u2514</span>
          <img class="wd-acc-icon wd-token-icon" src="${c.icon}" alt="${c.ticker}">
          <div><div class="wd-acc-name">${c.name}</div></div>
        </div>
        <div class="wd-acc-right">
          <span class="wd-acc-balance">${balStr}</span>
          <span class="wd-acc-fiat">${fiatStr}</span>
        </div>
      </div>`;
    }
    const cls = c.stealth ? " stealth" : "";
    const iconHtml = c.iconType === "img" ? `<img class="wd-acc-icon" src="${c.icon}" alt="${c.ticker}">` : `<div class="wd-acc-icon" style="background:${c.color}"><span>${c.icon}</span></div>`;
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
  }).join("");
  _container.innerHTML = `
  <div style="padding:32px 40px">
    <div class="wd-overview">
      <div class="wd-ov-top">
        <div>
          <div class="wd-ov-label">Portfolio Value</div>
          <div class="wd-ov-total">${total > 0 ? "$" + total.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "$0.00"}</div>
        </div>
        <button class="wd-ov-refresh" onclick="import('./services/balance-service.js').then(m=>m.refreshNow())" title="Refresh balances">\u21BB</button>
      </div>
      <div class="wd-ov-prices">${priceBar}</div>
    </div>
    <div style="margin-top:12px;background:var(--dt-surface,#fff);border:1px solid var(--dt-border,#e2e8f0);border-radius:14px;padding:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-size:12px;color:var(--dt-text-secondary,#64748b)">External Wallets</div>
          <div style="font-size:14px;font-weight:600;color:var(--dt-text,#1a1a2e)">Connect after login</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="dash-connect-wc" style="padding:8px 12px;border:1px solid #3b82f633;border-radius:8px;background:transparent;color:#2563eb;cursor:pointer;font-weight:600">WalletConnect</button>
          <button id="dash-connect-wiz" style="padding:8px 12px;border:1px solid #7c3aed33;border-radius:8px;background:transparent;color:#7c3aed;cursor:pointer;font-weight:600">WizardConnect</button>
          <button id="dash-open-chat" onclick="window.location.hash='#/chat'" style="padding:8px 12px;border:1px solid #0AC18E33;border-radius:8px;background:transparent;color:#0AC18E;cursor:pointer;font-weight:600">\u{1F4AC} Chat</button>
        </div>
      </div>
      <div id="dash-ext-status" style="margin-top:8px;font-size:12px;color:var(--dt-text-secondary,#64748b)"></div>
    </div>
    <div class="wd-accounts">${cards}</div>
  </div>`;
  document.getElementById("dash-connect-wc")?.addEventListener("click", _connectWalletConnectFromDashboard);
  document.getElementById("dash-connect-wiz")?.addEventListener("click", _openWizardDappMode);
}
function mount(container) {
  _container = container;
  if (!auth.isUnlocked()) {
    navigate("auth");
    return;
  }
  render();
  _unsubs.push(state.subscribe("balances", render));
  _unsubs.push(state.subscribe("prices", render));
}
function unmount() {
  _unsubs.forEach((fn) => fn());
  _unsubs = [];
  if (_container) _container.innerHTML = "";
  _container = null;
}
export {
  icon,
  id,
  mount,
  title,
  unmount
};
