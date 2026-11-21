// Dynamedia — proceso principal
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const adblocker = require('./adblocker');

const shellWindows = new Set();

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.flv', '.wmv', '.3gp', '.mpg', '.mpeg', '.ts']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico', '.tiff', '.heic']);

function classifyMedia(url) {
  let p = '';
  try { p = new URL(url).pathname.toLowerCase(); } catch { return null; }
  const ext = path.extname(p).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'videos';
  if (IMAGE_EXT.has(ext)) return 'photos';
  return null;
}

function downloadsBase() {
  const base = path.join(app.getPath('downloads'), 'Dynamedia');
  for (const d of ['Fotos', 'Videos']) {
    fs.mkdirSync(path.join(base, d), { recursive: true });
  }
  return base;
}

function isShellContents(contents) {
  return [...shellWindows].some((w) => !w.isDestroyed() && w.webContents === contents);
}

function createWindow(initialUrl) {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Dynamedia',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  shellWindows.add(w);
  w.on('closed', () => shellWindows.delete(w));
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (initialUrl) {
    w.webContents.once('did-finish-load', () => {
      w.webContents.send('open-url', initialUrl);
    });
  }
  return w;
}

// Difundir estadísticas de bloqueo a todas las ventanas
function broadcastStats(count) {
  for (const w of shellWindows) {
    if (!w.isDestroyed()) w.webContents.send('stats', { blocked: count });
  }
}

app.whenReady().then(() => {
  const ses = session.defaultSession;

  // 1) Bloqueador de anuncios
  adblocker.install(ses);
  adblocker.setOnStatsChange((count) => broadcastStats(count));

  // 2) Anti-redirecciones: bloquear window.open y navegaciones nuevas no iniciadas por el usuario
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['notifications', 'geolocation', 'midi', 'clipboard-read'].includes(permission));
  });

  // 3) Descargas separadas por tipo
  const base = downloadsBase();
  ses.on('will-download', (_event, item) => {
    const ext = path.extname(item.getFilename()).toLowerCase();
    let dir;
    if (VIDEO_EXT.has(ext)) dir = path.join(base, 'Videos');
    else if (IMAGE_EXT.has(ext)) dir = path.join(base, 'Fotos');
    else dir = path.join(base, 'Otros');
    fs.mkdirSync(dir, { recursive: true });
    item.setSavePath(path.join(dir, item.getFilename()));
  });

  // Dominios de redirección legítima (OAuth) que pueden navegar en ventanas emergentes.
  const REDIRECT_WHITELIST = new Set([
    'accounts.google.com',
    'login.microsoftonline.com',
    'github.com',
    'appleid.apple.com',
    'auth0.com',
  ]);
  function isWhitelistedRedirect(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      for (const domain of REDIRECT_WHITELIST) {
        if (host === domain || host.endsWith('.' + domain)) return true;
      }
    } catch { /* invalid URL */ }
    return false;
  }

  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url, disposition }) => {
      // Clic central / target=_blank / window.open -> nueva ventana de Dynamedia.
      // Redirecciones automáticas (popunder de anuncio) se deniegan, salvo whitelist.
      if (!/^https?:/i.test(url)) return { action: 'deny' };
      const isUserClick = disposition === 'new-window' || disposition === 'foreground-tab' || disposition === 'background-tab' || disposition === 'middle-click' || disposition === 'other';
      if (isUserClick || isWhitelistedRedirect(url)) {
        setImmediate(() => createWindow(url));
      }
      return { action: 'deny' };
    });

    // Webviews: solo la shell puede incrustarlos, y siempre con preferencias seguras.
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      if (!isShellContents(contents)) { event.preventDefault(); return; }
      delete webPreferences.preload;
      delete webPreferences.preloadURL;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;
      // Todos en la sesión por defecto, que es donde vive el bloqueador.
      delete params.partition;
      if (params.src && !/^https?:/i.test(params.src) && params.src !== 'about:blank') {
        event.preventDefault();
      }
    });

    // Bloquear navegaciones de contenidos emergentes (típica redirección de anuncio).
    // Se permite navegar a las ventanas de Dynamedia, a los webviews que hospedan,
    // y a dominios en la whitelist de redirecciones legítimas.
    contents.on('will-navigate', (e, url) => {
      const isInternal = url.startsWith('file://');
      if (isInternal) return;
      if (isWhitelistedRedirect(url)) return;
      const host = contents.hostWebContents;
      let allowed = false;
      if (host) {
        // El webview vive dentro de nuestro renderer (index.html)
        const hostUrl = host.getURL ? host.getURL() : '';
        allowed = hostUrl.startsWith('file://') && hostUrl.endsWith('renderer/index.html');
      } else {
        allowed = isShellContents(contents);
      }
      if (!allowed) e.preventDefault();
    });
  });

  ipcMain.on('navigate', (_e, url) => {
    for (const w of shellWindows) if (!w.isDestroyed()) w.webContents.send('navigate-url', url);
  });

  ipcMain.handle('download-media', (_e, url) => {
    const kind = classifyMedia(url);
    if (!kind) return { ok: false, error: 'Tipo no reconocido (ni imagen ni video)' };
    ses.downloadURL(url);
    return { ok: true, kind };
  });

  ipcMain.handle('get-stats', () => ({ blocked: adblocker.getBlockedCount() }));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
