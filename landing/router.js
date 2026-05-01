const _routes = /* @__PURE__ */ new Map();
let _currentView = null;
let _currentPath = "";
let _container = null;
let _onNavigate = null;
function register(path, loader) {
  _routes.set(path, loader);
}
function setContainer(el) {
  _container = el;
}
function onNavigate(cb) {
  _onNavigate = cb;
}
function navigate(path) {
  window.location.hash = "#/" + path;
}
function currentPath() {
  return _currentPath;
}
async function handleRoute() {
  const hash = window.location.hash || "#/";
  const fullPath = hash.slice(2) || "dashboard";
  const parts = fullPath.split("/");
  const basePath = parts[0];
  const subPath = parts.slice(1).join("/") || null;
  const loader = _routes.get(basePath);
  if (!loader) {
    navigate("dashboard");
    return;
  }
  if (basePath === _currentPath && _currentView && _currentView.onSubRoute) {
    _currentView.onSubRoute(subPath);
    return;
  }
  if (fullPath === _currentPath && _currentView) return;
  const path = basePath;
  if (_currentView && _currentView.unmount) {
    try {
      _currentView.unmount();
    } catch (e) {
      console.error("[router] unmount error:", e);
    }
  }
  if (_container) _container.classList.add("loading");
  try {
    const mod = await loader();
    _currentView = mod;
    _currentPath = path;
    if (_container) {
      _container.innerHTML = "";
      _container.classList.remove("loading");
      mod.mount(_container, subPath);
    }
    if (_onNavigate) _onNavigate(path, mod);
    if (mod.title) document.title = mod.title;
  } catch (e) {
    console.error("[router] failed to load view:", path, e);
    if (_container) {
      _container.classList.remove("loading");
      _container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--dt-text-secondary)">
        <div style="font-size:24px;margin-bottom:12px">\u26A0</div>
        <div>Failed to load ${path}</div>
        <div style="font-size:12px;margin-top:8px;opacity:.6">${e.message}</div>
      </div>`;
    }
  }
}
function init() {
  window.addEventListener("hashchange", handleRoute);
  handleRoute();
}
function destroy() {
  window.removeEventListener("hashchange", handleRoute);
  if (_currentView && _currentView.unmount) {
    try {
      _currentView.unmount();
    } catch (e) {
    }
  }
  _currentView = null;
  _currentPath = "";
}
export {
  currentPath,
  destroy,
  init,
  navigate,
  onNavigate,
  register,
  setContainer
};
