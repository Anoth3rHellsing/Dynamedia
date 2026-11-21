// Dynamedia — proceso principal
const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const adblocker = require('./adblocker');

const shellWindows = new Set();

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.flv', '.wmv', '.3gp', '.mpg', '.mpeg', '.ts']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico', '.tiff', '.heic']);

// Un window.open solo se acepta si en ese webContents hubo un clic o una tecla hace menos de esto.
const GESTURE_WINDOW_MS = 1000;
// Permisos que una web puede pedir; cada uno se pregunta al usuario por origen.
const PROMPTED_PERMISSIONS = {
  geolocation: 'conocer tu ubicación',
  notifications: 'mostrarte notificaciones',
  midi: 'usar dispositivos MIDI',
  'clipboard-read': 'leer tu portapapeles',
};

function classifyMedia(url) {
  let p = '';
  try { p = new URL(url).pathname.toLowerCase(); } catch { return null; }
  const ext = path.extname(p).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'videos';
  if (IMAGE_EXT.has(ext)) return 'photos';
  return null;
}

// Carpeta de destino: primero lo que dijo el escáner, luego el tipo MIME, luego la extensión.
function folderFor({ kind, mime, filename }) {
  if (kind === 'video') return 'Videos';
  if (kind === 'photo') return 'Fotos';
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('video/')) return 'Videos';
  if (m.startsWith('image/')) return 'Fotos';
  const ext = path.extname(filename || '').toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'Videos';
  if (IMAGE_EXT.has(ext)) return 'Fotos';
  return 'Otros';
}

function downloadsBase() {
  const base = path.join(app.getPath('downloads'), 'Dynamedia');
  for (const d of ['Fotos', 'Videos']) {
    fs.mkdirSync(path.join(base, d), { recursive: true });
  }
  return base;
}

// Nombre libre en la carpeta: «foto.jpg», «foto (1).jpg», «foto (2).jpg»…
// `reserved` evita que dos descargas simultáneas elijan el mismo nombre.
const reservedPaths = new Set();
function uniquePath(dir, filename) {
  const safe = path.basename(filename || '') || 'descarga';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || 'descarga';
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, n === 0 ? safe : `${stem} (${n})${ext}`);
    if (!reservedPaths.has(candidate) && !fs.existsSync(candidate)) {
      reservedPaths.add(candidate);
      return candidate;
    }
  }
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

  // 2) Permisos: se deniega todo salvo lo que el usuario acepte, origen por origen.
  //    La respuesta se recuerda hasta cerrar la app. Así una web no lee el portapapeles
  //    ni la ubicación en silencio.
  const permissionDecisions = new Map(); // `${origin}|${permission}` -> boolean
  const pendingPrompts = new Map();      // misma clave -> Promise<boolean>
  function originOf(url) {
    try { return new URL(url).origin; } catch { return null; }
  }
  function askPermission(webContents, origin, permission) {
    const key = `${origin}|${permission}`;
    if (permissionDecisions.has(key)) return Promise.resolve(permissionDecisions.get(key));
    if (pendingPrompts.has(key)) return pendingPrompts.get(key);
    const owner = BrowserWindow.fromWebContents(webContents.hostWebContents || webContents);
    const opts = {
      type: 'question',
      buttons: ['Permitir', 'Bloquear'],
      defaultId: 1,
      cancelId: 1,
      title: 'Permiso solicitado',
      message: `${origin} quiere ${PROMPTED_PERMISSIONS[permission]}.`,
      detail: 'La decisión se recuerda para este sitio hasta que cierres Dynamedia.',
    };
    const p = (owner ? dialog.showMessageBox(owner, opts) : dialog.showMessageBox(opts))
      .then(({ response }) => response === 0)
      .catch(() => false)
      .then((allowed) => {
        permissionDecisions.set(key, allowed);
        pendingPrompts.delete(key);
        return allowed;
      });
    pendingPrompts.set(key, p);
    return p;
  }
  ses.setPermissionRequestHandler((webContents, permission, cb, details) => {
    const origin = originOf((details && details.requestingUrl) || webContents.getURL());
    if (!origin || origin === 'null' || !PROMPTED_PERMISSIONS[permission]) return cb(false);
    askPermission(webContents, origin, permission).then(cb, () => cb(false));
  });
  // Las comprobaciones síncronas (Notification.permission, navigator.permissions.query)
  // solo ven «concedido» si el usuario ya lo aceptó.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (!PROMPTED_PERMISSIONS[permission]) return true;
    const origin = originOf(requestingOrigin) || requestingOrigin;
    return permissionDecisions.get(`${origin}|${permission}`) === true;
  });

  // 3) Descargas separadas por tipo, sin sobrescribir archivos con el mismo nombre.
  const base = downloadsBase();
  const pendingMedia = new Map(); // url -> { kind, resolve }
  ses.on('will-download', (_event, item) => {
    const chain = item.getURLChain ? item.getURLChain() : [item.getURL()];
    const pendingUrl = [item.getURL(), ...chain].find((u) => pendingMedia.has(u));
    const pending = pendingUrl ? pendingMedia.get(pendingUrl) : null;
    if (pending) { pendingMedia.delete(pendingUrl); pending.started(); }

    const dir = path.join(base, folderFor({ kind: pending && pending.kind, mime: item.getMimeType(), filename: item.getFilename() }));
    fs.mkdirSync(dir, { recursive: true });
    const savePath = uniquePath(dir, item.getFilename());
    item.setSavePath(savePath);
    item.once('done', (_e, state) => {
      reservedPaths.delete(savePath);
      if (!pending) return;
      if (state === 'completed') pending.resolve({ ok: true, kind: pending.kind, path: savePath });
      else pending.resolve({ ok: false, error: state === 'cancelled' ? 'Descarga cancelada' : 'La descarga falló' });
    });
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

  // Último gesto del usuario (clic o tecla) por webContents. Electron no dice si un
  // window.open vino de un clic, así que lo deducimos: sin gesto reciente, es un popup.
  const lastGesture = new Map(); // webContents.id -> ms
  app.on('web-contents-created', (_e, contents) => {
    const id = contents.id;
    const mark = () => lastGesture.set(id, Date.now());
    contents.on('before-input-event', (_ev, input) => {
      if (input.type === 'keyDown') mark();
    });
    contents.on('input-event', (_ev, input) => {
      if (input.type === 'mouseDown' || input.type === 'mouseUp' || input.type === 'keyDown' || input.type === 'gestureTap') mark();
    });
    contents.once('destroyed', () => lastGesture.delete(id));

    // Ventanas emergentes: denegadas siempre como BrowserWindow suelta. Si hubo un gesto
    // reciente (clic en target=_blank, clic central, Ctrl+clic) se abre como una ventana
    // nueva de Dynamedia, con la misma shell y el mismo bloqueador.
    contents.setWindowOpenHandler(({ url }) => {
      if (!/^https?:/i.test(url)) return { action: 'deny' };
      const t = lastGesture.get(id);
      if (t !== undefined && Date.now() - t <= GESTURE_WINDOW_MS) {
        lastGesture.delete(id); // un gesto, una ventana
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

  ipcMain.handle('download-media', (_e, url, kind) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { return { ok: false, error: 'Dirección no válida' }; }
    const isData = parsed.protocol === 'data:' && /^data:image\//i.test(parsed.href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && !isData) {
      return { ok: false, error: 'Solo se descargan direcciones http(s) o imágenes data:' };
    }
    // El escáner ya sabe si es foto o vídeo; si no lo dice, se mira la extensión.
    let k = kind === 'photo' || kind === 'video' ? kind : null;
    if (!k) {
      const byExt = classifyMedia(parsed.href);
      k = byExt === 'videos' ? 'video' : byExt === 'photos' ? 'photo' : (isData ? 'photo' : null);
    }
    if (!k) return { ok: false, error: 'Tipo no reconocido (ni imagen ni video)' };
    const href = parsed.href;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingMedia.get(href) === entry) pendingMedia.delete(href);
        resolve({ ok: false, error: 'La descarga no empezó' });
      }, 30000);
      // El plazo solo cubre el arranque: una vez empezada, un vídeo grande puede tardar lo que haga falta.
      const entry = { kind: k, started: () => clearTimeout(timer), resolve: (r) => { clearTimeout(timer); resolve(r); } };
      pendingMedia.set(href, entry);
      ses.downloadURL(href);
    });
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
