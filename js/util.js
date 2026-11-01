// Shared helpers. Plain ES module, usable in the browser and in Node (tools/).

/** Lowercase + Unicode NFKC, the same normalisation EasyRPG uses for file lookups. */
export function normalizeKey(name) {
  return name.toLowerCase().normalize('NFKC');
}

/** "Hero.png" -> "Hero" (only the last extension is removed, like EasyRPG's gencache). */
export function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? name : name.slice(0, i);
}

/** "Hero.png" -> "png" */
export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

export function basename(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function dirname(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Turn a game title into a short id that is safe in URLs and as a directory name. */
export function slugify(text) {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || 'game';
}

/** FNV-1a 32 bit hash of a byte array, as base36. Used to build stable game ids. */
export function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function isAscii(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return false;
  return true;
}

/**
 * Legacy encodings used by RPG Maker 2000/2003 games, in the order we try them.
 * Japanese first: by far the most common for file names and game data.
 */
export const LEGACY_ENCODINGS = ['shift_jis', 'euc-kr', 'gbk', 'big5', 'windows-1251', 'windows-1252'];

/** Encodings EasyRPG may pick for a game; used to create file name aliases. */
export const ALIAS_ENCODINGS = [
  'shift_jis', 'euc-kr', 'gbk', 'big5', 'windows-1250', 'windows-1251', 'windows-1252',
  'windows-1253', 'windows-1254', 'windows-1255', 'windows-1256', 'windows-1257', 'windows-874',
];

export function tryDecode(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Find one encoding that decodes every byte string without errors.
 * Returns 'utf-8' when everything is valid UTF-8 (or plain ASCII).
 */
export function detectEncoding(byteStrings) {
  const candidates = ['utf-8', ...LEGACY_ENCODINGS];
  for (const enc of candidates) {
    if (byteStrings.every((b) => tryDecode(b, enc) !== null)) return enc;
  }
  return 'windows-1252';
}

/** Decode text whose encoding is unknown (RPG_RT.ini, database strings). */
export function decodeUnknown(bytes, preferred) {
  const order = preferred && preferred !== 'utf-8'
    ? [preferred, 'utf-8', ...LEGACY_ENCODINGS]
    : ['utf-8', ...LEGACY_ENCODINGS];
  for (const enc of order) {
    const s = tryDecode(bytes, enc);
    if (s !== null) return s;
  }
  return new TextDecoder('windows-1252').decode(bytes);
}

/** All plausible decodings of a byte string, best guess first, without duplicates. */
export function decodeCandidates(bytes, preferred) {
  const out = [];
  const order = [preferred, 'utf-8', ...LEGACY_ENCODINGS].filter(Boolean);
  for (const enc of order) {
    const s = tryDecode(bytes, enc);
    if (s !== null && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Minimal INI reader (enough for RPG_RT.ini). Keys are lowercased. */
export function parseIni(text) {
  const out = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      out[section] = out[section] || {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[section] = out[section] || {};
    out[section][line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Expected binary data');
}

/** A standalone ArrayBuffer containing exactly the bytes of `data`. */
export function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  const u8 = toUint8(data);
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
