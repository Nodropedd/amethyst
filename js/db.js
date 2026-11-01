// IndexedDB storage for the game library.
//
//   games    : one record per imported game (metadata, thumbnail)
//   files    : file contents, key = [owner, path]; owner is a game id, "rtp-2000",
//              "rtp-2003" or "soundfont"
//   settings : small key/value records
//   extra    : per-game data that is only needed when playing (file name aliases)
//
// Save games are NOT stored here: EasyRPG keeps them itself in IndexedDB
// (see saves.js).

const DB_NAME = 'easyrpg-web-library';
const DB_VERSION = 1;

let dbPromise = null;

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis) || !indexedDB) {
      reject(new Error('This browser does not support IndexedDB (or it is disabled, e.g. in some private modes).'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      if (!db.objectStoreNames.contains('extra')) db.createObjectStore('extra');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('Could not open the browser database.'));
    req.onblocked = () => console.warn('Library database upgrade is waiting for other tabs to close.');
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function ownerRange(owner) {
  // Arrays sort after strings in IndexedDB, so [owner, []] is above every [owner, "path"].
  return IDBKeyRange.bound([owner], [owner, []]);
}

// ---------- games ----------

export async function listGames() {
  const db = await openDB();
  return promisify(db.transaction('games').objectStore('games').getAll());
}

export async function getGame(id) {
  const db = await openDB();
  return (await promisify(db.transaction('games').objectStore('games').get(id))) || null;
}

export async function putGame(game) {
  const db = await openDB();
  const tx = db.transaction('games', 'readwrite');
  tx.objectStore('games').put(game);
  return txDone(tx);
}

export async function updateGame(id, changes) {
  const db = await openDB();
  const tx = db.transaction('games', 'readwrite');
  const store = tx.objectStore('games');
  const game = await promisify(store.get(id));
  if (game) store.put({ ...game, ...changes });
  return txDone(tx);
}

/** Remove a game and all of its files. */
export async function deleteGame(id) {
  const db = await openDB();
  const tx = db.transaction(['games', 'files', 'extra'], 'readwrite');
  tx.objectStore('games').delete(id);
  tx.objectStore('files').delete(ownerRange(id));
  tx.objectStore('extra').delete(id);
  return txDone(tx);
}

export async function getExtra(id) {
  const db = await openDB();
  return (await promisify(db.transaction('extra').objectStore('extra').get(id))) || null;
}

export async function setExtra(id, value) {
  const db = await openDB();
  const tx = db.transaction('extra', 'readwrite');
  if (value) tx.objectStore('extra').put(value, id);
  else tx.objectStore('extra').delete(id);
  return txDone(tx);
}

// ---------- files ----------

/** Store many files in one transaction. `files` is an array of {path, data}. */
export async function putFiles(owner, files) {
  const db = await openDB();
  const tx = db.transaction('files', 'readwrite');
  const store = tx.objectStore('files');
  for (const f of files) store.put(f.data, [owner, f.path]);
  return txDone(tx);
}

export async function deleteFiles(owner) {
  const db = await openDB();
  const tx = db.transaction('files', 'readwrite');
  tx.objectStore('files').delete(ownerRange(owner));
  return txDone(tx);
}

/** All stored paths of one owner (no file contents are loaded). */
export async function listFilePaths(owner) {
  const db = await openDB();
  const keys = await promisify(db.transaction('files').objectStore('files').getAllKeys(ownerRange(owner)));
  return keys.map((k) => k[1]);
}

/** File contents (ArrayBuffer) or null. */
export async function getFile(owner, path) {
  const db = await openDB();
  const data = await promisify(db.transaction('files').objectStore('files').get([owner, path]));
  return data === undefined ? null : data;
}

// ---------- settings ----------

export async function getSetting(key, fallback = null) {
  const db = await openDB();
  const value = await promisify(db.transaction('settings').objectStore('settings').get(key));
  return value === undefined ? fallback : value;
}

export async function setSetting(key, value) {
  const db = await openDB();
  const tx = db.transaction('settings', 'readwrite');
  if (value === null || value === undefined) tx.objectStore('settings').delete(key);
  else tx.objectStore('settings').put(value, key);
  return txDone(tx);
}
