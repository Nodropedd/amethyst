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
