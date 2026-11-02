// Access to the save games EasyRPG Player writes. The player stores them with
// Emscripten's IDBFS in an IndexedDB database named "/easyrpg/<game id>/Save".
// Reading/writing that database directly lets the library export, import and
// delete saves without starting the game.

import { basename, toUint8 } from './util.js';
import { createZip, openZip } from './zip.js';

const IDBFS_VERSION = 21;
const STORE = 'FILE_DATA';
const FILE_MODE = 0o100666; // regular file, rw-rw-rw-

export function saveDbName(gameId) {
  return `/easyrpg/${gameId.toLowerCase()}/Save`;
}

async function databaseExists(name) {
  if (typeof indexedDB.databases !== 'function') return null;
  try {
    const list = await indexedDB.databases();
    return list.some((d) => d.name === name);
  } catch {
    return null;
  }
}

function openSaveDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, IDBFS_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.objectStoreNames.contains(STORE)
        ? req.transaction.objectStore(STORE)
        : db.createObjectStore(STORE);
      if (!store.indexNames.contains('timestamp')) store.createIndex('timestamp', 'timestamp', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @returns {Promise<Array<{name: string, key: string, size: number, date: Date, contents: Uint8Array}>>} */
export async function listSaves(gameId) {
  const name = saveDbName(gameId);
  if ((await databaseExists(name)) === false) return [];
  const db = await openSaveDb(name);
  try {
    const store = db.transaction(STORE).objectStore(STORE);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    const out = [];
    keys.forEach((key, i) => {
      const v = values[i];
      if (!v || !v.contents || typeof key !== 'string') return;
      const contents = toUint8(v.contents);
      out.push({
        key,
        name: key.startsWith(`${name}/`) ? key.slice(name.length + 1) : basename(key),
        size: contents.byteLength,
        date: v.timestamp instanceof Date ? v.timestamp : new Date(v.timestamp || 0),
        contents,
      });
    });
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } finally {
    db.close();
  }
}

export async function exportSaves(gameId) {
  const saves = await listSaves(gameId);
  if (!saves.length) return null;
  return createZip(saves.map((s) => ({ path: s.name, data: s.contents, date: s.date })));
}

function isSaveFile(bytes) {
  // LCF header: BER length (11) + "LcfSaveData"
  return bytes.length > 12 && bytes[0] === 11 && String.fromCharCode(...bytes.subarray(1, 12)) === 'LcfSaveData';
}

/**
 * Import .lsd files (or ZIPs containing them).
 * @param {string} gameId
 * @param {File[]} files
 * @returns {Promise<number>} number of imported save files
 */
export async function importSaves(gameId, files) {
  const collected = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      const zip = await openZip(file);
      for (const e of zip.entries) {
        if (!/\.lsd$/i.test(e.path)) continue;
        collected.push({ name: basename(e.path), data: await e.read() });
      }
    } else {
      collected.push({ name: basename(file.name), data: new Uint8Array(await file.arrayBuffer()) });
    }
  }
  const valid = collected.filter((f) => /^save\d+\.lsd$/i.test(f.name) && isSaveFile(f.data));
  if (!valid.length) {
    throw new Error('No valid save files found. Save files are named like Save01.lsd (a ZIP of them works too).');
  }

  const name = saveDbName(gameId);
  const db = await openSaveDb(name);
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const f of valid) {
      // EasyRPG writes "SaveXX.lsd" with a capital S and two digits.
      const num = parseInt(f.name.match(/\d+/)[0], 10);
      const fileName = `Save${String(num).padStart(2, '0')}.lsd`;
      store.put({ timestamp: new Date(), mode: FILE_MODE, contents: f.data }, `${name}/${fileName}`);
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  return valid.length;
}

export function deleteSaves(gameId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(saveDbName(gameId));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

// ======================================================================
// RPG Maker MV: saves live in localStorage. The game runs with a key
// prefix per game (see js/html5-shim.js). PC save files (www/save/*.rpgsave)
// contain exactly the same text as the localStorage values.

function mvPrefix(gameId) {
  return `amethyst:${gameId}:`;
}

function mvKeys(gameId) {
  const prefix = mvPrefix(gameId);
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) keys.push(k.slice(prefix.length));
  }
  return keys;
}

function mvFileName(key) {
  if (/bak$/.test(key)) return null; // automatic backups
  let m = key.match(/File(\d+)$/);
  if (m) return `file${parseInt(m[1], 10)}.rpgsave`;
  if (/Global$/.test(key)) return 'global.rpgsave';
  if (/Config$/.test(key)) return 'config.rpgsave';
  return null;
}

function listMvSaves(gameId) {
  const enc = new TextEncoder();
  const out = [];
  for (const key of mvKeys(gameId)) {
    const name = mvFileName(key);
    if (!name) continue;
    const contents = enc.encode(localStorage.getItem(mvPrefix(gameId) + key) || '');
    out.push({ key, name, size: contents.byteLength, date: null, contents });
  }
  return out;
}

function importMvSaves(gameId, files) {
  // Reuse the key pattern the game already uses (some plugins change "RPG File1").
  const existing = mvKeys(gameId);
  const template = (suffixRe, fallback) => {
    const hit = existing.find((k) => suffixRe.test(k) && !/bak$/.test(k));
    return hit ? hit.replace(suffixRe, '') : fallback;
  };
  const filePrefix = template(/File\d+$/, 'RPG ');
  const globalPrefix = template(/Global$/, 'RPG ');
  const configPrefix = template(/Config$/, 'RPG ');
  let n = 0;
  for (const f of files) {
    const text = new TextDecoder().decode(f.data).trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(text)) continue; // MV saves are LZString base64 text
    let key = null;
    const m = f.name.match(/^file(\d+)\.rpgsave$/i);
    if (m) key = `${filePrefix}File${parseInt(m[1], 10)}`;
    else if (/^global\.rpgsave$/i.test(f.name)) key = `${globalPrefix}Global`;
    else if (/^config\.rpgsave$/i.test(f.name)) key = `${configPrefix}Config`;
    if (!key) continue;
    localStorage.setItem(mvPrefix(gameId) + key, text);
    n++;
  }
  return n;
}

function deleteMvSaves(gameId) {
  for (const key of mvKeys(gameId)) localStorage.removeItem(mvPrefix(gameId) + key);
}

// ======================================================================
// RPG Maker MZ: saves live in IndexedDB through localforage (database
// "localforage", store "keyvaluepairs"), as "rmmzsave.<gameId>.<name>".
// PC save files (save/*.rmmzsave) hold the same string, UTF-8 encoded.

const FORAGE_DB = 'localforage';
const FORAGE_STORE = 'keyvaluepairs';

function openForage(create) {
  return new Promise((resolve, reject) => {
    const req = create ? indexedDB.open(FORAGE_DB, 1) : indexedDB.open(FORAGE_DB);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(FORAGE_STORE)) req.result.createObjectStore(FORAGE_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FORAGE_STORE)) {
        db.close();
        resolve(null);
      } else resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function withForage(create, fn) {
  if (!create && (await databaseExists(FORAGE_DB)) === false) return null;
  let db;
  try {
    db = await openForage(create);
  } catch (err) {
    if (create && err && err.name === 'VersionError') db = await openForage(false);
    else throw err;
  }
  if (!db) return null;
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function listMzSaves(mzGameId) {
  if (!mzGameId) return [];
  const prefix = `rmmzsave.${mzGameId}.`;
  const enc = new TextEncoder();
  const result = await withForage(false, async (db) => {
    const store = db.transaction(FORAGE_STORE).objectStore(FORAGE_STORE);
    const keys = await request(store.getAllKeys());
    const out = [];
    for (const key of keys) {
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
      const value = await request(db.transaction(FORAGE_STORE).objectStore(FORAGE_STORE).get(key));
      if (typeof value !== 'string') continue;
      const contents = enc.encode(value);
      out.push({ key, name: `${key.slice(prefix.length)}.rmmzsave`, size: contents.byteLength, date: null, contents });
    }
    return out;
  });
  return result || [];
}

async function importMzSaves(mzGameId, files) {
  const valid = files.filter((f) => /^(file\d+|global|config)\.rmmzsave$/i.test(f.name));
  if (!valid.length) return 0;
  await withForage(true, (db) => new Promise((resolve, reject) => {
    const tx = db.transaction(FORAGE_STORE, 'readwrite');
    const store = tx.objectStore(FORAGE_STORE);
    for (const f of valid) {
      const name = f.name.replace(/\.rmmzsave$/i, '').toLowerCase();
      store.put(new TextDecoder().decode(f.data), `rmmzsave.${mzGameId}.${name}`);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
  return valid.length;
}

async function deleteMzSaves(mzGameId) {
  if (!mzGameId) return;
  const prefix = `rmmzsave.${mzGameId}.`;
  await withForage(false, async (db) => {
    const keys = await request(db.transaction(FORAGE_STORE).objectStore(FORAGE_STORE).getAllKeys());
    const tx = db.transaction(FORAGE_STORE, 'readwrite');
    for (const k of keys) if (typeof k === 'string' && k.startsWith(prefix)) tx.objectStore(FORAGE_STORE).delete(k);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  });
}

// ======================================================================
// Engine independent entry points used by the library.

/** Saves of any game: [{name, size, date|null, contents}] */
export async function listGameSaves(game) {
  if (game.engine === 'mv') return listMvSaves(game.id);
  if (game.engine === 'mz') return listMzSaves(game.mzGameId);
  return listSaves(game.id);
}

export async function exportGameSaves(game) {
  const saves = await listGameSaves(game);
  if (!saves.length) return null;
  return createZip(saves.map((s) => ({ path: s.name, data: s.contents, date: s.date || new Date() })));
}

async function collectFiles(files, nameRe) {
  const out = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      const zip = await openZip(file);
      for (const e of zip.entries) if (nameRe.test(e.path)) out.push({ name: basename(e.path), data: await e.read() });
    } else if (nameRe.test(file.name)) {
      out.push({ name: basename(file.name), data: new Uint8Array(await file.arrayBuffer()) });
    }
  }
  return out;
}

/** @returns {Promise<number>} number of imported files */
export async function importGameSaves(game, files) {
  if (game.engine === 'mv') {
    const n = importMvSaves(game.id, await collectFiles(files, /\.rpgsave$/i));
    if (!n) throw new Error('No valid save files found. RPG Maker MV saves are named like file1.rpgsave (a ZIP of them works too).');
    return n;
  }
  if (game.engine === 'mz') {
    if (!game.mzGameId) throw new Error('This game has no game id in data/System.json, so its saves cannot be imported.');
    const n = await importMzSaves(game.mzGameId, await collectFiles(files, /\.rmmzsave$/i));
    if (!n) throw new Error('No valid save files found. RPG Maker MZ saves are named like file1.rmmzsave (a ZIP of them works too).');
    return n;
  }
  return importSaves(game.id, files);
}

export async function deleteGameSaves(game) {
  if (game.engine === 'mv') return deleteMvSaves(game.id);
  if (game.engine === 'mz') return deleteMzSaves(game.mzGameId);
  return deleteSaves(game.id);
}

export function saveFileHint(game) {
  if (game.engine === 'mv') return '.rpgsave,.zip';
  if (game.engine === 'mz') return '.rmmzsave,.zip';
  return '.lsd,.zip';
}
