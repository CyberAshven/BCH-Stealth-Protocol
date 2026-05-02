/* ══════════════════════════════════════════
   00 Wallet — Hash-based SPA Router
   ══════════════════════════════════════════
   Routes: #/wallet, #/fusion, #/onion, etc.
   Views are lazy-loaded ES modules with mount/unmount.
   ══════════════════════════════════════════ */

type ViewModule = {
  mount: (container: HTMLElement, subPath: string | null) => void;
  unmount?: () => void;
  onSubRoute?: (subPath: string | null) => void;
  title?: string;
};
type RouteLoader = () => Promise<ViewModule>;
type NavigateCallback = (path: string, mod: ViewModule) => void;

const _routes = new Map<string, RouteLoader>();
let _currentView: ViewModule | null = null;
let _currentPath = '';
let _container: HTMLElement | null = null;
let _onNavigate: NavigateCallback | null = null;

/* ── Register routes ── */
export function register(path: string, loader: RouteLoader): void {
  _routes.set(path, loader);
}

/* ── Set the container element ── */
export function setContainer(el: HTMLElement): void {
  _container = el;
}

/* ── Set navigation callback (for sidebar active state, etc.) ── */
export function onNavigate(cb: NavigateCallback): void {
  _onNavigate = cb;
}

/* ── Navigate programmatically ── */
export function navigate(path: string): void {
  window.location.hash = '#/' + path;
}

/* ── Get current path ── */
export function currentPath(): string {
  return _currentPath;
}

/* ── Render error state without innerHTML interpolation ── */
function _renderError(path: string, msg: string): void {
  if (!_container) return;
  _container.classList.remove('loading');
  _container.textContent = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:40px;text-align:center;color:var(--dt-text-secondary)';
  const icon = document.createElement('div');
  icon.style.cssText = 'font-size:24px;margin-bottom:12px';
  icon.textContent = '⚠';
  const pathEl = document.createElement('div');
  pathEl.textContent = 'Failed to load ' + path;
  const msgEl = document.createElement('div');
  msgEl.style.cssText = 'font-size:12px;margin-top:8px;opacity:.6';
  msgEl.textContent = msg;
  wrap.appendChild(icon);
  wrap.appendChild(pathEl);
  wrap.appendChild(msgEl);
  _container.appendChild(wrap);
}

/* ── Route handler ── */
async function handleRoute(): Promise<void> {
  const hash = window.location.hash || '#/';
  const fullPath = hash.slice(2) || 'dashboard'; // strip '#/'

  // Support sub-routes: 'wallet/bch' → base='wallet', sub='bch'
  const parts = fullPath.split('/');
  const basePath = parts[0];
  const subPath = parts.slice(1).join('/') || null;

  const loader = _routes.get(basePath);

  if (!loader) {
    navigate('dashboard');
    return;
  }

  // Same base route with sub-path change → let the view handle it internally
  if (basePath === _currentPath && _currentView && _currentView.onSubRoute) {
    _currentView.onSubRoute(subPath);
    return;
  }

  // Same exact path → skip
  if (fullPath === _currentPath && _currentView) return;
  const path = basePath;

  // Unmount current view
  if (_currentView && _currentView.unmount) {
    try { _currentView.unmount(); } catch (e) { console.error('[router] unmount error:', e); }
  }

  // Loading state
  if (_container) _container.classList.add('loading');

  try {
    // Lazy-load the view module
    const mod = await loader();

    // Mount new view
    _currentView = mod;
    _currentPath = path;

    if (_container) {
      _container.innerHTML = '';
      _container.classList.remove('loading');
      mod.mount(_container, subPath);
    }

    // Callback (update sidebar, page title, etc.)
    if (_onNavigate) _onNavigate(path, mod);

    // Update document title
    if (mod.title) document.title = mod.title;

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[router] failed to load view:', path, e);
    _renderError(path, msg);
  }
}

/* ── Initialize router ── */
export function init(): void {
  window.addEventListener('hashchange', handleRoute);
  // Handle initial load
  handleRoute();
}

/* ── Cleanup ── */
export function destroy(): void {
  window.removeEventListener('hashchange', handleRoute);
  if (_currentView && _currentView.unmount) {
    try { _currentView.unmount(); } catch (e) {}
  }
  _currentView = null;
  _currentPath = '';
}
