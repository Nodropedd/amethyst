// Builds the "index.json" file EasyRPG Player's web version needs (the same
// format the official `gencache` tool produces, version 2) and resolves the
// file requests the player makes back to stored files.
//
// Optionally merges an RTP (RPG Maker Run Time Package) into the game, so games
// that rely on an installed RTP work too. RTP files are only used when the game
// does not ship a file with the same name. Thanks to EasyRPG's RTP name table,
// a game made with e.g. the Japanese RTP also works with the English RTP.

import { extOf, normalizeKey, stripExt } from './util.js';

const EXT_PRIORITY = [
  'png', 'bmp', 'xyz',
  'ogg', 'opus', 'wav', 'mp3', 'mid', 'midi', 'flac', 'mod', 'xm', 's3m', 'it',
  'avi', 'mpg', 'mpeg', 'mp4', 'webm',
];

function rank(name) {
  const i = EXT_PRIORITY.indexOf(extOf(name));
  return i === -1 ? EXT_PRIORITY.length : i;
}

/** Key of a file inside index.json (mirrors EasyRPG's gencache). */
function fileKey(name, atRoot) {
  const lower = normalizeKey(name);
  if (atRoot) return stripExt(lower) === 'exfont' ? 'exfont' : lower;
  if (lower.endsWith('.ini') || lower.endsWith('.po')) return lower;
  return stripExt(lower);
}

class DirNode {
  constructor(name) {
    this.name = name;
    this.dirs = new Map();
    this.files = new Map();
  }
}

/**
 * @param {object} opts
 * @param {Array<{path: string, source: any, aliases?: string[]}>} opts.gameFiles  files of the game, paths
 *        relative to the game folder; `aliases` are alternative names (other decodings of legacy names)
 * @param {{files: Array<{path: string, source: any}>, table?: Object<string, string[][]>}} [opts.rtp]
 * @param {any} [opts.soundfont]  source of a SoundFont used when the game has none
 * @returns {{index: object, json: string, resolve: (path: string) => any, rtpFiles: number}}
 */
export function buildGameFs({ gameFiles, rtp = null, soundfont = null }) {
  const root = new DirNode('');

  const dirFor = (segments) => {
    let node = root;
    for (const seg of segments) {
      const key = normalizeKey(seg);
      let child = node.dirs.get(key);
      if (!child) {
        child = new DirNode(seg);
        node.dirs.set(key, child);
      }
      node = child;
    }
    return node;
  };

  const insert = (path, source, onlyIfMissing) => {
    const segments = path.split('/').filter((s) => s && s !== '.');
    if (!segments.length || segments.includes('..')) return;
    const name = segments.pop();
    const node = dirFor(segments);
    const key = fileKey(name, node === root);
    if (!key || key === '_dirname') return;
    const existing = node.files.get(key);
    if (existing && (onlyIfMissing || rank(existing.name) <= rank(name))) return;
    node.files.set(key, { name, source });
  };

  for (const f of gameFiles) insert(f.path, f.source, false);
  for (const f of gameFiles) {
    if (f.aliases) for (const alias of f.aliases) insert(alias, f.source, true);
  }

  let rtpFiles = 0;
  if (rtp && rtp.files && rtp.files.length) {
    // category key -> (file key -> {name, source})
    const available = new Map();
    for (const f of rtp.files) {
      const segments = f.path.split('/').filter(Boolean);
      if (segments.length !== 2) continue;
      const [category, name] = segments;
      const key = fileKey(name, false);
      if (!key || key === '_dirname') continue;
      const catKey = normalizeKey(category);
      if (!available.has(catKey)) available.set(catKey, { name: category, files: new Map() });
      const files = available.get(catKey).files;
      const prev = files.get(key);
      if (!prev || rank(prev.name) > rank(name)) files.set(key, { name, source: f.source });
    }

    const add = (node, key, entry) => {
      if (node.files.has(key) || node.dirs.has(key)) return;
      node.files.set(key, entry);
      rtpFiles++;
    };

    for (const [catKey, cat] of available) {
      let node = root.dirs.get(catKey);
      if (!node) {
        node = new DirNode(cat.name);
        root.dirs.set(catKey, node);
      }
      for (const [key, entry] of cat.files) add(node, key, entry);
    }

    // Alternative names (e.g. Japanese RTP name -> file of the English RTP).
    for (const [category, rows] of Object.entries(rtp.table || {})) {
      const catKey = normalizeKey(category);
      const cat = available.get(catKey);
      if (!cat) continue;
      const node = root.dirs.get(catKey);
      for (const row of rows) {
        const keys = row.map(normalizeKey);
        const hitKey = keys.find((k) => cat.files.has(k));
        if (!hitKey) continue;
        const hit = cat.files.get(hitKey);
        const ext = extOf(hit.name);
        keys.forEach((k, i) => add(node, k, { name: ext ? `${row[i]}.${ext}` : row[i], source: hit.source }));
      }
    }
  }

  // Some features (e.g. Ineluki key patch scripts) request files in folders
  // *with* their extension; gencache only lists them without. Offer both.
  const addExtensionKeys = (node) => {
    for (const child of node.dirs.values()) addExtensionKeys(child);
    if (node === root) return;
    for (const [key, file] of [...node.files]) {
      const full = normalizeKey(file.name);
      if (full !== key && !node.files.has(full) && !node.dirs.has(full)) node.files.set(full, file);
    }
  };
  addExtensionKeys(root);

  if (soundfont && !root.files.has('easyrpg.soundfont')) {
    root.files.set('easyrpg.soundfont', { name: 'easyrpg.soundfont', source: soundfont });
  }

  // index.json + lookup table (virtual path -> source)
  const exact = new Map();
  const loose = new Map();
  const toJson = (node, prefix, isRoot) => {
    const obj = Object.create(null);
    if (!isRoot) obj._dirname = node.name;
    for (const [key, child] of node.dirs) {
      obj[key] = toJson(child, `${prefix}${child.name}/`, false);
    }
    for (const [key, file] of node.files) {
      if (key in obj) continue;
      obj[key] = file.name;
      const virtualPath = prefix + file.name;
      exact.set(virtualPath, file.source);
      const looseKey = normalizeKey(virtualPath);
      if (!loose.has(looseKey)) loose.set(looseKey, file.source);
    }
    return obj;
  };

  const cache = toJson(root, '', true);
  const index = {
    metadata: { version: 2, date: new Date().toISOString().slice(0, 10) },
    cache,
  };

  return {
    index,
    json: JSON.stringify(index),
    rtpFiles,
    resolve(path) {
      const p = path.replace(/^\.\//, '');
      if (exact.has(p)) return exact.get(p);
      return loose.get(normalizeKey(p)) ?? null;
    },
  };
}
