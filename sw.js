// Service worker for RPG Maker MV / MZ games.
//
// MV and MZ games are HTML5 games: the browser loads their index.html,
// scripts, images and audio like a normal website. Games imported into the
// library are stored in IndexedDB, so this worker answers every request below
// "html5/<game id>/" from there. Nothing else is touched (EasyRPG games, the
// site itself and hosted games go to the network as usual).

const DB_NAME = 'easyrpg-web-library';
const DB_VERSION = 1;
const PREFIX = new URL('html5/', self.registration.scope).pathname;
const SHIM_URL = new URL('js/html5-shim.js', self.registration.scope).pathname;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      // Same schema as js/db.js (in case the worker opens the database first).
      const db = req.result;
      for (const name of ['games', 'files', 'settings', 'extra']) {
        if (!db.objectStoreNames.contains(name)) {
          if (name === 'games') db.createObjectStore(name, { keyPath: 'id' });
          else db.createObjectStore(name);
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getFile(id, path) {
  const db = await openDB();
  const data = await request(db.transaction('files').objectStore('files').get([id, path]));
  return data === undefined ? null : data;
}

// Windows is case-insensitive and macOS stores decomposed Unicode, so games
// often reference files with a different spelling than the stored name.
const looseIndexes = new Map(); // game id -> Promise<Map<looseKey, path>>
const looseKey = (p) => p.normalize('NFC').toLowerCase();

function looseIndex(id) {
  if (!looseIndexes.has(id)) {
    looseIndexes.set(id, (async () => {
      const db = await openDB();
      const range = IDBKeyRange.bound([id], [id, []]);
      const keys = await request(db.transaction('files').objectStore('files').getAllKeys(range));
      const map = new Map();
      for (const k of keys) {
        const lk = looseKey(k[1]);
        if (!map.has(lk)) map.set(lk, k[1]);
      }
      return map;
    })());
  }
  return looseIndexes.get(id);
}

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', css: 'text/css; charset=utf-8',
  txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', mid: 'audio/midi', midi: 'audio/midi',
  webm: 'video/webm', mp4: 'video/mp4',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  wasm: 'application/wasm',
};

function contentType(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

function textResponse(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** Load the shim (save-game separation etc.) before any game script. */
function injectShim(html, id) {
  const tag = `<script src="${SHIM_URL}" data-game-id="${id}"></script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}\n${tag}`);
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) return html.replace(htmlTag[0], `${htmlTag[0]}\n${tag}`);
  return tag + html;
}

async function serve(event, url) {
  const rest = url.pathname.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return textResponse(404, 'Not found');
  const id = decodeURIComponent(rest.slice(0, slash));
  let path = rest.slice(slash + 1);
  try {
    path = decodeURIComponent(path);
  } catch { /* keep as is */ }
  if (path === '' || path.endsWith('/')) path += 'index.html';

  const isEntry = path.toLowerCase() === 'index.html';
  if (isEntry) looseIndexes.delete(id); // a (re)started game gets a fresh index

  let data = await getFile(id, path);
  if (!data) {
    const actual = (await looseIndex(id)).get(looseKey(path));
    if (actual) data = await getFile(id, actual);
  }
  if (!data) {
    if (isEntry) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;color:#eee;background:#111;padding:2em">'
        + 'This game is not in the library of this browser. Go back to the library and import it again.',
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }
    return textResponse(404, `Not found: ${path}`);
  }

  const type = contentType(path);
  if (isEntry) {
    const html = injectShim(new TextDecoder().decode(data), id);
    return new Response(html, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  }

  const size = data.byteLength;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = event.request.headers.get('range');
  const m = range && range.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start;
    let end;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    return new Response(event.request.method === 'HEAD' ? null : data.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(event.request.method === 'HEAD' ? null : data, {
    headers: { ...headers, 'Content-Length': String(size) },
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  event.respondWith(serve(event, url).catch((err) => textResponse(500, `Could not read the game files: ${err && err.message}`)));
});
