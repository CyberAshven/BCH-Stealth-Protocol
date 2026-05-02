var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// desktop/main.ts
var path = __toESM(require("path"));
var fs = __toESM(require("fs"));
var import_electron = require("electron");
var appUserData = path.join(import_electron.app.getPath("appData"), "00-wallet-desktop");
var appCache = path.join(appUserData, "Cache");
try {
  fs.mkdirSync(appCache, { recursive: true });
} catch {
}
import_electron.app.setPath("userData", appUserData);
import_electron.app.setPath("sessionData", appUserData);
import_electron.app.setPath("cache", appCache);
import_electron.app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
function createWindow() {
  const win = new import_electron.BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });
  const candidates = [
    path.join(import_electron.app.getAppPath(), "landing", "v2.html"),
    path.join(process.cwd(), "landing", "v2.html"),
    path.join(__dirname, "..", "landing", "v2.html")
  ];
  const entry = candidates.find((p) => fs.existsSync(p));
  if (!entry) throw new Error("Unable to locate landing/v2.html");
  win.loadFile(entry);
  win.webContents.setWindowOpenHandler(({ url }) => {
    import_electron.shell.openExternal(url);
    return { action: "deny" };
  });
}
import_electron.app.whenReady().then(() => {
  createWindow();
  import_electron.app.on("activate", () => {
    if (import_electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
import_electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    import_electron.app.quit();
  }
});
