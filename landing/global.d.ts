/* ══════════════════════════════════════════
   global.d.ts — Window interface augmentations
   Declares all runtime globals attached to `window`
   by ws-bridge, chains, shell, nostr-bridge, etc.
   ══════════════════════════════════════════ */

type ElectrumCaller = (method: string, params: unknown[]) => Promise<unknown>;
type NostrFilter = Record<string, unknown>;
type NostrEvent = Record<string, unknown>;
type NostrSubId = string;
type NostrStatusResult = { connected: boolean; relay?: string } | null;

interface ChainMeta {
  name: string;
  ticker: string;
  decimals: number;
  color: string;
  icon: string;
  apiType: string;
  rpc?: string;
  contract?: string;
}

interface BalanceResult {
  balance: number | string;
  loaded: boolean;
  utxos?: unknown[];
}

interface PriceResult {
  price: number;
  change24h: number;
}

interface TxRecord {
  txid: string;
  chain: string;
  dir: 'in' | 'out';
  amount: number | string;
  height: number;
  timestamp: number;
  confirmations?: number;
}

interface EndpointConfig {
  relays?: string[];
  indexer?: string;
  eth_rpc?: string;
  bnb_rpc?: string;
  polygon_rpc?: string;
  trx_rpc?: string;
  xrp_rpc?: string;
  xlm_rpc?: string;
  ltc_rpc?: string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    /* ── Chain data ── */
    CHAINS: Readonly<Record<string, ChainMeta>>;
    chainsRefreshOne: (chain: string, addr: string) => Promise<BalanceResult>;
    chainsRefreshAll: (addresses: Record<string, string>) => Promise<Record<string, BalanceResult>>;
    chainsGetPrices: () => Promise<Record<string, PriceResult>>;
    chainsGetHistory: (chain: string, addr: string, limit?: number) => Promise<TxRecord[]>;
    chainsPersistHistory: (chain: string, txs: TxRecord[]) => void;
    chainsBlockHeight: (chain: string) => Promise<number>;
    chainsFormatAmount: (chain: string, rawAmount: number | string) => string;

    /* ── Electrum / SharedWorker callers ── */
    _fvCall: ElectrumCaller;
    _fvConnect: () => Promise<unknown>;
    fulcrumCall: ElectrumCaller;
    fulcrumConnect: () => Promise<unknown>;
    bchCall: ElectrumCaller;
    _btcCall: ElectrumCaller;
    _btcConnect: () => Promise<unknown>;
    btcCall: ElectrumCaller;
    _ltcCall: ElectrumCaller;
    _ltcTipHeight: number;

    /* ── WebSocket bridge ── */
    _wsSharedWorkerAvailable: boolean;
    _wsSubscribe: (chain: string, method: string, params: unknown[], callback: (data: unknown) => void) => void;
    _wsOnStatus: (chain: string, callback: (on: boolean, server?: string) => void) => void;
    _wsUpdateServers: (chain: string, servers: string[]) => void;
    _wsStatus: (chain: string) => { connected: boolean; server: string } | string;
    _wsWorker: SharedWorker | Worker;
    _wsPort: MessagePort;

    /* ── HD scanner ── */
    _hdGetAllScriptHashes: () => string[];

    /* ── Shell ── */
    _shellRefreshAuth: (btn?: HTMLElement | null) => void;
    _shellSetLang: (lang: string) => void;
    _shellDisconnect: () => void;
    _onLangChange: (lang: string) => void;
    _ledgerDevice: { close(): Promise<void> } | undefined;

    /* ── Nostr bridge ── */
    _nostrInit: (relays: string[]) => void;
    _nostrPublish: (event: NostrEvent) => void;
    _nostrSubscribe: (filters: NostrFilter[], onEvent?: (event: NostrEvent) => void) => Promise<NostrSubId>;
    _nostrUnsubscribe: (subId: NostrSubId) => void;
    _nostrStatus: () => NostrStatusResult;

    /* ── App config ── */
    _00ep: EndpointConfig;

    /* ── External wallet ── */
    Ledger?: unknown;
    WizardConnect?: any;
    wcDisconnect?: () => void;
    exportBackup?: () => void;
    importBackup?: (file?: File) => void;
    openExportKeys?: () => void;
  }
}

export {};
