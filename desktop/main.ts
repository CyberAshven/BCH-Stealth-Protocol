import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, shell } from 'electron';

const appUserData = path.join(app.getPath('appData'), '00-wallet-desktop');
const appCache = path.join(appUserData, 'Cache');
try {
  fs.mkdirSync(appCache, { recursive: true });
} catch {}
app.setPath('userData', appUserData);
app.setPath('sessionData', appUserData);
app.setPath('cache', appCache);
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  const candidates = [
    path.join(app.getAppPath(), 'landing', 'v2.html'),
    path.join(process.cwd(), 'landing', 'v2.html'),
    path.join(__dirname, '..', 'landing', 'v2.html'),
  ];
  const entry = candidates.find((p) => fs.existsSync(p));
  if (!entry) throw new Error('Unable to locate landing/v2.html');
  win.loadFile(entry);

  win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    shell.openExternal(url);
    return { action: 'deny' as const };
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
