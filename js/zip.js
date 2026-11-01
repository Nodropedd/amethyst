// Small ZIP reader/writer for the browser.
//
// Reader: random access through Blob.slice, so huge archives are never loaded
// into memory at once. Supports stored + deflate entries, ZIP64, archives with
// leading data (self-extracting .exe ZIPs) and legacy (Shift-JIS, ...) file
// names, which are very common for RPG Maker 2000/2003 games.
//
// Writer: "stored" (uncompressed) archives, used to export save games.

import { crc32, detectEncoding, isAscii, toUint8 } from './util.js';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

async function readBytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

let nativeRawInflate = null;
function hasNativeRawInflate() {
  if (nativeRawInflate === null) {
    try {
      new DecompressionStream('deflate-raw');
      nativeRawInflate = true;
    } catch {
      nativeRawInflate = false;
    }
  }
  return nativeRawInflate;
}

function fflateLib() {
  const lib = globalThis.fflate;
  if (!lib) throw new Error('Decompression library failed to load. Reload the page and try again.');
  return lib;
}

/** Decompress raw DEFLATE data held in a Blob. */
export async function inflateRaw(blob, expectedSize) {
  if (hasNativeRawInflate()) {
    try {
      const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      console.warn('Native inflate failed, retrying with fflate', err);
    }
  }
  const input = new Uint8Array(await blob.arrayBuffer());
  const opts = expectedSize > 0 ? { out: new Uint8Array(expectedSize) } : undefined;
  return fflateLib().inflateSync(input, opts);
}

/** Decompress zlib-wrapped data (used by the XYZ image format). */
export async function inflateZlib(bytes) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return fflateLib().unzlibSync(toUint8(bytes));
  }
}

function cleanPath(name) {
  let p = name.replace(/\\/g, '/');
  while (p.startsWith('/')) p = p.slice(1);
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

/**
 * Open a ZIP archive.
 * @param {Blob} blob
 * @returns {Promise<{encoding: string, entries: Array<{path: string, size: number, read: () => Promise<Uint8Array>}>}>}
 */
export async function openZip(blob) {
  const size = blob.size;
  if (size < 22) throw new Error('This file is too small to be a ZIP archive.');

  const tailLen = Math.min(size, 22 + 0xffff + 20);
  const tailStart = size - tailLen;
  const tail = await readBytes(blob, tailStart, size);
  const tdv = new DataView(tail.buffer);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tdv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('This is not a ZIP archive (or it is damaged). RAR, 7z and LZH archives must be extracted first; then import the extracted folder.');
  }

  let count = tdv.getUint16(eocd + 10, true);
  let cdSize = tdv.getUint32(eocd + 12, true);
  let cdOffset = tdv.getUint32(eocd + 16, true);
  let base = 0;
  let zip64 = false;

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tdv.getUint32(loc, true) === SIG_EOCD64_LOC) {
      const recOffset = Number(tdv.getBigUint64(loc + 8, true));
      const rec = await readBytes(blob, recOffset, recOffset + 56);
      const rdv = new DataView(rec.buffer);
      if (rdv.getUint32(0, true) === SIG_EOCD64) {
        count = Number(rdv.getBigUint64(32, true));
        cdSize = Number(rdv.getBigUint64(40, true));
        cdOffset = Number(rdv.getBigUint64(48, true));
        zip64 = true;
      }
    }
  }

  if (!zip64) {
    // Data in front of the archive (self-extracting exe): offsets are shifted.
    const eocdAbs = tailStart + eocd;
    const expected = eocdAbs - cdSize;
    if (expected !== cdOffset && expected >= 0) base = expected - cdOffset;
  }

  const cd = await readBytes(blob, base + cdOffset, base + cdOffset + cdSize);
  const cdv = new DataView(cd.buffer);
  const raw = [];
  let p = 0;
  while (p + 46 <= cd.length && cdv.getUint32(p, true) === SIG_CENTRAL) {
    const flags = cdv.getUint16(p + 8, true);
    const method = cdv.getUint16(p + 10, true);
    let csize = cdv.getUint32(p + 20, true);
    let usize = cdv.getUint32(p + 24, true);
    const nameLen = cdv.getUint16(p + 28, true);
    const extraLen = cdv.getUint16(p + 30, true);
    const commentLen = cdv.getUint16(p + 32, true);
    let offset = cdv.getUint32(p + 42, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);

    let unicodeName = null;
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cdv.getUint16(x, true);
      const len = cdv.getUint16(x + 2, true);
      let q = x + 4;
      if (id === 0x0001) {
        if (usize === 0xffffffff && q + 8 <= x + 4 + len) { usize = Number(cdv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff && q + 8 <= x + 4 + len) { csize = Number(cdv.getBigUint64(q, true)); q += 8; }
        if (offset === 0xffffffff && q + 8 <= x + 4 + len) { offset = Number(cdv.getBigUint64(q, true)); q += 8; }
      } else if (id === 0x7075 && len > 5) {
        // Info-ZIP Unicode Path: version(1) crc32(4) utf8-name
        const nameCrc = cdv.getUint32(x + 5, true);
        if (nameCrc === crc32(nameBytes)) {
          try {
            unicodeName = new TextDecoder('utf-8', { fatal: true }).decode(cd.subarray(x + 9, x + 4 + len));
          } catch { /* ignore broken extra field */ }
        }
      }
      x += 4 + len;
    }

    raw.push({ flags, method, csize, usize, offset, nameBytes, unicodeName });
    p = xEnd + commentLen;
    if (raw.length >= count && count !== 0xffff) break;
  }

  if (raw.length === 0 && count > 0) throw new Error('The ZIP central directory is damaged.');

  // Decide one legacy encoding for all names that are not flagged as UTF-8.
  const legacy = raw.filter((e) => !(e.flags & 0x800) && !e.unicodeName && !isAscii(e.nameBytes));
  const encoding = legacy.length ? detectEncoding(legacy.map((e) => e.nameBytes)) : 'utf-8';
  const legacyDecoder = new TextDecoder(encoding);
  const utf8Decoder = new TextDecoder('utf-8');

  const entries = [];
  for (const e of raw) {
    let name;
    if (e.unicodeName) name = e.unicodeName;
    else if (e.flags & 0x800) name = utf8Decoder.decode(e.nameBytes);
    else name = legacyDecoder.decode(e.nameBytes);
    name = cleanPath(name);
    if (!name || name.endsWith('/')) continue; // directory entry

    const entry = e;
    const legacy = !(e.flags & 0x800) && !e.unicodeName && encoding !== 'utf-8' && !isAscii(e.nameBytes);
    entries.push({
      path: name,
      size: entry.usize,
      // Raw name bytes when the name was decoded with a guessed legacy encoding.
      // (Skipped for archives that use "\" as separator: byte 0x5C can be part of a Shift-JIS character.)
      legacyBytes: legacy && !legacyDecoder.decode(e.nameBytes).includes('\\') ? e.nameBytes : null,
      async read() {
        if (entry.flags & 0x1) {
          throw new Error(`"${name}" is password protected. Encrypted ZIP files are not supported; extract it first and import the folder.`);
        }
        const start = base + entry.offset;
        const lh = await readBytes(blob, start, start + 30);
        const ldv = new DataView(lh.buffer);
        if (lh.length < 30 || ldv.getUint32(0, true) !== SIG_LOCAL) {
          throw new Error(`The ZIP archive is damaged (bad local header for "${name}").`);
        }
        const dataStart = start + 30 + ldv.getUint16(26, true) + ldv.getUint16(28, true);
        const slice = blob.slice(dataStart, dataStart + entry.csize);
        if (entry.method === 0) return new Uint8Array(await slice.arrayBuffer());
        if (entry.method === 8) return inflateRaw(slice, entry.usize);
        throw new Error(`"${name}" uses an unsupported compression method (${entry.method}). Extract the archive and import the folder instead.`);
      },
    });
  }

  return { encoding, entries };
}

/**
 * Build an uncompressed ZIP file.
 * @param {Array<{path: string, data: Uint8Array, date?: Date}>} files
 * @returns {Blob}
 */
export function createZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff;
  const dosDate = (d) => (((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

  for (const f of files) {
    const name = enc.encode(f.path);
    const data = toUint8(f.data);
    const crc = crc32(data);
    const date = f.date instanceof Date && !isNaN(f.date) ? f.date : new Date();

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime(date), true);
    local.setUint16(12, dosDate(date), true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, data);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, SIG_CENTRAL, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, dosTime(date), true);
    c.setUint16(14, dosDate(date), true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, name);

    offset += 30 + name.length + data.length;
  }

  const cdSize = central.reduce((n, b) => n + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_EOCD, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
