// Dynamedia — lógica de la ventana (shell).
// Va en un archivo aparte para que la CSP de index.html pueda prohibir los scripts inline:
// todo lo que llega de la página visitada (URLs, nombres) es texto no confiable y nunca se
// interpreta como HTML aquí.
const $ = (s) => document.querySelector(s);
const web = $('#web');
const list = $('#mediaList');

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch { return null; }
}

// URL de un medio detectado: solo http(s) o imágenes data:. Devuelve la forma serializada
// por el parser de URL (comillas y ángulos ya codificados) o null.
function safeMediaUrl(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    if (u.protocol === 'data:' && /^data:image\//i.test(u.href)) return u.href;
  } catch { /* no es una URL válida */ }
  return null;
}

function emptyMessage(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  list.replaceChildren(div);
}

$('#url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const u = normalizeUrl(e.target.value);
    if (u) web.loadURL(u);
  }
});
web.addEventListener('did-navigate', () => { $('#url').value = web.getURL(); });
web.addEventListener('dom-ready', () => { $('#url').value = web.getURL(); });
web.addEventListener('page-title-updated', (e) => { document.title = 'Dynamedia — ' + e.title; });
web.addEventListener('did-fail-load', (e) => {
  if (e.errorCode !== -3) console.error('Fallo al cargar:', e.errorCode, e.errorDescription, e.validatedURL);
});

$('#back').onclick = () => web.goBack();
$('#fwd').onclick = () => web.goForward();
$('#reload').onclick = () => web.reload();

if (window.dynamedia) {
  const setBlocked = (s) => { $('#stats').querySelector('b').textContent = String(Number(s && s.blocked) || 0); };
  dynamedia.onStats(setBlocked);
  dynamedia.getStats().then(setBlocked);
  dynamedia.onOpenUrl((url) => {
    const u = normalizeUrl(url);
    if (u) { web.loadURL(u); $('#url').value = u; }
  });
}

// Escaneo de medios (funcionalidad de la extensión Media-downloader)
$('#scan').onclick = async () => {
  emptyMessage('Escaneando…');
  try {
    const result = await web.executeJavaScript(`(() => {
      const found = [];
      const seen = new Set();
      const add = (url, kind, extra) => {
        if (!url || seen.has(url)) return;
        if (!/^https?:\\/\\//i.test(url)) return;
        seen.add(url);
        let name = 'media';
        try { name = decodeURIComponent(url.split('/').pop().split('?')[0] || 'media'); } catch {}
        const m = { url, kind, name };
        if (extra) Object.assign(m, extra);
        found.push(m);
      };
      document.querySelectorAll('img').forEach((img) => {
        const u = img.currentSrc || img.src;
        if (u) add(u, 'photo', { w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
      });
      document.querySelectorAll('video, video source').forEach((v) => {
        const u = v.src || v.currentSrc;
        if (u) add(u, 'video');
      });
      document.querySelectorAll('a[href]').forEach((a) => {
        const u = a.href;
        if (/\\.(jpe?g|png|gif|webp|bmp|avif|svg)([?#]|$)/i.test(u)) add(u, 'photo');
        else if (/\\.(mp4|webm|mkv|mov|m4v|avi|flv)([?#]|$)/i.test(u)) add(u, 'video');
      });
      document.querySelectorAll('[style*="background-image"]').forEach((el) => {
        const m = /url\\(["']?(.*?)["']?\\)/.exec(el.style.backgroundImage);
        if (!m) return;
        // Resolver con el parser de URL: deja la dirección serializada y no la cadena CSS en bruto.
        try { add(new URL(m[1], document.baseURI).href, 'photo'); } catch {}
      });
      return found;
    })()`);
    renderList(Array.isArray(result) ? result : []);
  } catch (err) {
    emptyMessage('No se pudo escanear esta página.');
  }
};

$('#clear').onclick = () => emptyMessage('Sin resultados.');

function renderList(items) {
  const clean = [];
  for (const m of items) {
    const url = safeMediaUrl(m && m.url);
    if (!url) continue;
    clean.push({
      url,
      kind: m.kind === 'video' ? 'video' : 'photo',
      name: typeof m.name === 'string' && m.name ? m.name : 'media',
      w: Number.isFinite(m.w) ? m.w : 0,
      h: Number.isFinite(m.h) ? m.h : 0,
    });
  }
  if (!clean.length) {
    emptyMessage('No se encontraron medios en esta página.');
    return;
  }
  list.replaceChildren();
  for (const m of clean) {
    const div = document.createElement('div');
    div.className = 'item';

    if (m.kind === 'photo') {
      const img = document.createElement('img');
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      img.setAttribute('src', m.url);
      div.appendChild(img);
    } else {
      const thumb = document.createElement('div');
      thumb.className = 'thumb-video';
      thumb.textContent = '\u{1F3A5}';
      div.appendChild(thumb);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.title = m.url;
    name.textContent = m.name;
    const kind = document.createElement('div');
    kind.className = 'kind';
    kind.textContent = (m.kind === 'photo' ? 'Foto' : 'Video') + (m.w && m.h ? ` · ${m.w}x${m.h}` : '');
    meta.append(name, kind);
    div.appendChild(meta);

    const btn = document.createElement('button');
    btn.title = 'Descargar';
    btn.textContent = '⇩';
    btn.onclick = () => download(m, btn);
    div.appendChild(btn);

    list.appendChild(div);
  }
}

async function download(m, btn) {
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const res = await dynamedia.downloadMedia(m.url, m.kind);
    btn.textContent = res.ok ? 'OK' : 'X';
    btn.title = res.ok ? 'Guardado en: ' + res.path : (res.error || 'Error');
  } catch {
    btn.textContent = 'X';
  } finally {
    btn.disabled = false;
  }
}
