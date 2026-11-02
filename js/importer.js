// Imports games (and RTP / SoundFont files) from ZIP archives, folders or
// drag & drop into the browser library. Everything stays on the user's device.

import * as db from './db.js';
import { openZip, inflateZlib } from './zip.js';
import { readDatabaseInfo } from './lcf.js';
import {
  ALIAS_ENCODINGS, basename, decodeCandidates, decodeUnknown, dirname, extOf, formatBytes, hashBytes,
  normalizeKey, parseIni, slugify, stripExt, toArrayBuffer, tryDecode,
} from './util.js';

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\.git)(\/|$)/i;
const RTP_CATEGORIES = new Set([
  'backdrop', 'battle', 'battle2', 'battlecharset', 'battleweapon', 'charset', 'chipset',
  'faceset', 'frame', 'gameover', 'monster', 'movie', 'music', 'panorama', 'picture',
  'sound', 'system', 'system2', 'title',
]);
const RTP_2003_ONLY = ['battle2', 'battlecharset', 'battleweapon', 'frame', 'system2'];

const BATCH_FILES = 64;
const BATCH_BYTES = 24 * 1024 * 1024;

// ---------------------------------------------------------------- sources

function fileEntry(file, path) {
  return {
    path,
    size: file.size,
    async read() {
      return new Uint8Array(await file.arrayBuffer());
    },
  };
}

/** Entries from an <input type="file" webkitdirectory> selection. */
export function entriesFromFileList(fileList) {
  return Array.from(fileList, (f) => fileEntry(f, (f.webkitRelativePath || f.name).replace(/\\/g, '/')));
}

function readAllDirEntries(dirEntry) {
  const reader = dirEntry.createReader();
  const all = [];
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) resolve(all);
      else {
        all.push(...batch);
        next();
      }
    }, reject);
    next();
  });
}

async function walkEntry(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push(fileEntry(file, entry.fullPath.replace(/^\/+/, '')));
  } else if (entry.isDirectory) {
    for (const child of await readAllDirEntries(entry)) await walkEntry(child, out);
  }
}

/**
 * Turn a drop event's DataTransfer into import jobs.
 * Must be called synchronously inside the drop handler.
 * @returns {Promise<Array<{label: string, file?: File, entries?: Array}>>}
 */
export function jobsFromDataTransfer(dt) {
  const items = Array.from(dt.items || []).filter((i) => i.kind === 'file');
  const fsEntries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const files = Array.from(dt.files || []);

  return (async () => {
    if (fsEntries.length && fsEntries.every(Boolean)) {
      const dirs = fsEntries.filter((e) => e.isDirectory);
      const loose = fsEntries.filter((e) => e.isFile);
      const jobs = [];
      if (dirs.length) {
        const entries = [];
        for (const d of dirs) await walkEntry(d, entries);
        jobs.push({ label: dirs.map((d) => d.name).join(', '), entries });
      }
      if (loose.length) {
        const looseFiles = [];
        for (const e of loose) looseFiles.push(await new Promise((res, rej) => e.file(res, rej)));
        jobs.push(...jobsFromFiles(looseFiles));
      }
      return jobs;
    }
    return jobsFromFiles(files);
  })();
}

/** Loose files: archives / SoundFonts become one job each, anything else one folder-like job. */
export function jobsFromFiles(files) {
  const jobs = [];
  const rest = [];
  for (const f of files) {
    const ext = extOf(f.name);
    if (ext === 'zip' || ext === 'exe' || ext === 'sf2' || ext === 'sf3') jobs.push({ label: f.name, file: f });
    else rest.push(f);
  }
  if (rest.length) jobs.push({ label: `${rest.length} files`, entries: rest.map((f) => fileEntry(f, f.name)) });
  return jobs;
}

// ---------------------------------------------------------------- import

class ImportError extends Error {}

/**
 * Run one import job.
 * @param {{label: string, file?: File, entries?: Array}} job
 * @param {{onProgress?: Function, confirmReplace?: (game) => Promise<boolean>|boolean}} options
 */
export async function runJob(job, options = {}) {
  if (job.file) {
    const ext = extOf(job.file.name);
    if (ext === 'sf2' || ext === 'sf3') return importSoundfont(fileEntry(job.file, job.file.name));
    options.onProgress?.({ phase: 'reading', label: job.label });
    let zip;
    try {
      zip = await openZip(job.file);
    } catch (err) {
      if (ext === 'exe') {
        throw new ImportError('This .exe is not a self-extracting ZIP archive. Run or extract it on your computer first, then import the game folder (the one that contains RPG_RT.ldb).');
      }
      throw err;
    }
    return importEntries(zip.entries, { ...options, name: stripExt(job.file.name), encoding: zip.encoding, depth: 0 });
  }
  return importEntries(job.entries, { ...options, name: job.label, encoding: null, depth: 0 });
}

async function importEntries(allEntries, ctx) {
  const entries = allEntries.filter((e) => !JUNK.test(e.path) && !e.path.split('/').includes('..'));
  if (!entries.length) throw new ImportError('There are no files to import.');

  const depthOf = (p) => p.split('/').length;
  const ldbs = entries
    .filter((e) => basename(e.path).toLowerCase() === 'rpg_rt.ldb')
    .sort((a, b) => depthOf(a.path) - depthOf(b.path));
  if (ldbs.length) return importGame(entries, dirname(ldbs[0].path), ctx);

  const html5 = detectHtml5(entries);
  if (html5) return importHtml5(entries, html5, ctx);

  const rtp = detectRtp(entries);
  if (rtp) return importRtp(entries, rtp, ctx);

  const soundfonts = entries.filter((e) => ['sf2', 'sf3'].includes(extOf(e.path)));
  if (soundfonts.length === 1 && entries.length <= 4) return importSoundfont(soundfonts[0]);

  const archives = entries.filter((e) => extOf(e.path) === 'zip');
  if (archives.length && ctx.depth < 2) {
    for (const a of archives) {
      try {
        const inner = await openZip(new Blob([await a.read()]));
        return await importEntries(inner.entries, { ...ctx, name: stripExt(basename(a.path)), encoding: inner.encoding, depth: ctx.depth + 1 });
      } catch (err) {
        if (!(err instanceof ImportError)) console.warn('Nested archive failed', a.path, err);
      }
    }
  }

  throw new ImportError(explainUnsupported(entries));
}

function explainUnsupported(entries) {
  const names = entries.map((e) => e.path.toLowerCase());
  const has = (re) => names.some((n) => re.test(n));
  if (has(/(^|\/)game\.(rgssad|rgss2a|rgss3a|rxproj|rvproj|rvproj2)$/) || has(/\.(rxdata|rvdata|rvdata2)$/)) {
    return 'This looks like an RPG Maker XP / VX / VX Ace game. Those engines are not supported; this site runs RPG Maker 2000, 2003, MV and MZ games.';
  }
  if (has(/(^|\/)js\/(rpg_core|rmmz_core)\.js$/)) {
    return 'This looks like an RPG Maker MV / MZ game, but its index.html is missing. Import the complete game folder (for MV usually the "www" folder).';
  }
  if (has(/(^|\/)rpg_rt\.exe$/)) {
    return 'Found RPG_RT.exe but no RPG_RT.ldb. The game data may be packed inside the .exe (common for encrypted releases). Look for an unpacked version of the game.';
  }
  return 'No RPG Maker game found. RPG Maker 2000/2003 games contain RPG_RT.ldb; MV/MZ games contain index.html and a js folder. You can also import an RTP folder or a .sf2 SoundFont here.';
}

async function writeFiles(owner, list, onProgress, onFile) {
  let batch = [];
  let batchBytes = 0;
  let done = 0;
  let bytes = 0;
  const total = list.length;
  const flush = async () => {
    if (!batch.length) return;
    await db.putFiles(owner, batch);
    batch = [];
    batchBytes = 0;
  };
  for (const item of list) {
    const data = await item.entry.read();
    onFile?.(item, data);
    batch.push({ path: item.rel, data: toArrayBuffer(data) });
    batchBytes += data.byteLength;
    bytes += data.byteLength;
    done++;
    if (batch.length >= BATCH_FILES || batchBytes >= BATCH_BYTES) await flush();
    onProgress?.({ phase: 'importing', done, total, bytes });
  }
  await flush();
  return bytes;
}

function friendlyStorageError(err) {
  if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) {
    return new ImportError('Not enough browser storage for this import. Delete some games from your library or free up disk space, then try again.');
  }
  return err;
}

async function importGame(entries, rootDir, ctx) {
  const prefix = rootDir ? `${rootDir}/` : '';
  const files = entries
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ entry: e, rel: e.path.slice(prefix.length) }))
    .filter((f) => f.rel);

  const find = (relLower) => files.find((f) => f.rel.toLowerCase() === relLower);
  const aliases = computeAliases(files, rootDir);
  ctx.onProgress?.({ phase: 'analyzing' });

  const ldbFile = find('rpg_rt.ldb');
  const ldbBytes = await ldbFile.entry.read();
  const info = readDatabaseInfo(ldbBytes);
  if (!info) throw new ImportError('RPG_RT.ldb is damaged or is not an RPG Maker 2000/2003 database.');
  if (!find('rpg_rt.lmt')) throw new ImportError('RPG_RT.lmt (the map tree) is missing from this game, so it cannot be started.');

  let iniTitle = '';
  let fullPackage = false;
  const iniFile = find('rpg_rt.ini');
  if (iniFile) {
    const ini = parseIni(decodeUnknown(await iniFile.entry.read(), ctx.encoding));
    const section = ini.rpg_rt || {};
    iniTitle = (section.gametitle || '').trim();
    fullPackage = section.fullpackageflag === '1';
  }

  const title = iniTitle || (rootDir ? basename(rootDir) : ctx.name) || 'Untitled game';
  const id = `${slugify(title)}-${hashBytes(new TextEncoder().encode(title))}`;

  const existing = await db.getGame(id);
  if (existing && ctx.confirmReplace && !(await ctx.confirmReplace(existing))) {
    return { type: 'cancelled' };
  }

  // Locate the title screen image for the library thumbnail.
  let titleRel = null;
  if (info.titleName && info.titleName.length) {
    const order = ['png', 'bmp', 'xyz'];
    const titleFiles = [];
    for (const f of files) {
      for (const name of [f.rel, ...(aliases[f.rel] || [])]) {
        if (name.includes('/') && normalizeKey(dirname(name)) === 'title' && order.includes(extOf(name))) {
          titleFiles.push({ rel: f.rel, key: normalizeKey(stripExt(basename(name))), rank: order.indexOf(extOf(name)) });
        }
      }
    }
    titleFiles.sort((a, b) => a.rank - b.rank);
    for (const name of decodeCandidates(info.titleName, ctx.encoding)) {
      const hit = titleFiles.find((t) => t.key === normalizeKey(name));
      if (hit) {
        titleRel = hit.rel;
        break;
      }
    }
  }

  let titleBytes = null;
  let size = 0;
  try {
    await db.deleteFiles(id);
    await db.setExtra(id, Object.keys(aliases).length ? { aliases } : null);
    size = await writeFiles(id, files, ctx.onProgress, (item, data) => {
      if (item.rel === titleRel) titleBytes = data;
    });
  } catch (err) {
    await db.deleteGame(id).catch(() => {});
    throw friendlyStorageError(err);
  }

  ctx.onProgress?.({ phase: 'finishing' });
  const thumbnail = titleBytes ? await makeThumbnail(titleBytes, extOf(titleRel)) : null;

  const game = {
    id,
    title,
    engine: info.engine,
    size,
    fileCount: files.length,
    fullPackage,
    encoding: ctx.encoding && ctx.encoding !== 'utf-8' ? ctx.encoding : null,
    thumbnail,
    addedAt: existing?.addedAt ?? Date.now(),
    updatedAt: Date.now(),
    lastPlayed: existing?.lastPlayed ?? null,
  };
  await db.putGame(game);
  return { type: 'game', game, replaced: !!existing };
}

/**
 * For file names that were decoded with a guessed legacy encoding, list how
 * they read in the other encodings EasyRPG might choose for the game. The
 * player looks files up by the names stored in the game database, decoded with
 * its own encoding guess, so offering every reading makes the lookup work
 * no matter which one it picks.
 */
function computeAliases(files, rootDir) {
  const rootDepth = rootDir ? rootDir.split('/').length : 0;
  const aliases = {};
  for (const f of files) {
    const bytes = f.entry.legacyBytes;
    if (!bytes) continue;
    const segments = [];
    let start = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i === bytes.length || bytes[i] === 0x2f) {
        const seg = bytes.subarray(start, i);
        if (seg.length && !(seg.length === 1 && seg[0] === 0x2e)) segments.push(seg);
        start = i + 1;
      }
    }
    const alts = new Set();
    for (const enc of ALIAS_ENCODINGS) {
      const decoded = segments.map((seg) => tryDecode(seg, enc));
      if (decoded.some((d) => d === null)) continue;
      const alt = decoded.slice(rootDepth).join('/');
      if (alt && alt !== f.rel) alts.add(alt);
    }
    if (alts.size) aliases[f.rel] = [...alts];
  }
  return aliases;
}

// ---------------------------------------------------------------- RPG Maker MV / MZ

function detectHtml5(entries) {
  const cores = entries
    .filter((e) => /(^|\/)js\/(rpg_core|rmmz_core)\.js$/i.test(e.path))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const core of cores) {
    const root = dirname(dirname(core.path));
    const index = (root ? `${root}/` : '') + 'index.html';
    if (entries.some((e) => e.path.toLowerCase() === index.toLowerCase())) {
      return { rootDir: root, engine: /rmmz_core/i.test(core.path) ? 'mz' : 'mv' };
    }
  }
  return null;
}

// NW.js runtime files next to an MZ game (and in some MV releases): not needed in a browser.
const NWJS_FILE = /^(game|nw|nwjc|notification_helper|chromedriver|payload|crashpad_handler)(\.exe)?$|\.(dll|pak|bin|exe|so|dylib)$|^icudtl\.dat$|^credits\.html$|^d3dcompiler/i;
const NWJS_DIR = /^(locales|swiftshader|pnacl|nwjs[^/]*)$/i;

function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** MV/MZ "encrypted" images: 16 byte header, then the PNG with its first 16 bytes XORed with the key. */
function decryptRpgImage(bytes, keyHex) {
  if (!keyHex || bytes.length < 32) return null;
  const key = (keyHex.match(/[0-9a-f]{2}/gi) || []).map((h) => parseInt(h, 16));
  if (key.length < 16) return null;
  const out = bytes.slice(16);
  for (let i = 0; i < 16; i++) out[i] ^= key[i];
  return out;
}

async function importHtml5(entries, { rootDir, engine }, ctx) {
  const prefix = rootDir ? `${rootDir}/` : '';
  const files = entries
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ entry: e, rel: e.path.slice(prefix.length) }))
    .filter((f) => {
      if (!f.rel) return false;
      const segs = f.rel.split('/');
      if (segs.length === 1) return !NWJS_FILE.test(segs[0]);
      return !NWJS_DIR.test(segs[0]);
    });

  ctx.onProgress?.({ phase: 'analyzing' });
  const find = (relLower) => files.find((f) => f.rel.toLowerCase() === relLower);

  const systemFile = find('data/system.json');
  if (!systemFile) throw new ImportError('data/System.json is missing, so this RPG Maker MV/MZ game cannot be started. Import the complete game folder.');
  const system = parseJson(await systemFile.entry.read()) || {};

  let htmlTitle = '';
  const indexFile = find('index.html');
  if (indexFile) {
    const m = new TextDecoder().decode(await indexFile.entry.read()).match(/<title>([^<]*)<\/title>/i);
    if (m) htmlTitle = m[1].trim();
  }
  const title = (typeof system.gameTitle === 'string' && system.gameTitle.trim())
    || htmlTitle
    || (rootDir && !/^www$/i.test(basename(rootDir)) ? basename(rootDir) : '')
    || (rootDir && rootDir.includes('/') ? basename(dirname(rootDir)) : '')
    || ctx.name || 'Untitled game';
  const id = `${slugify(title)}-${hashBytes(new TextEncoder().encode(title))}`;

  const existing = await db.getGame(id);
  if (existing && ctx.confirmReplace && !(await ctx.confirmReplace(existing))) {
    return { type: 'cancelled' };
  }

  // Title screen image for the thumbnail (plain or encrypted).
  let titleRel = null;
  const titleName = typeof system.title1Name === 'string' ? system.title1Name : '';
  if (titleName) {
    for (const ext of ['png', 'rpgmvp', 'png_']) {
      const f = find(`img/titles1/${titleName}.${ext}`.toLowerCase());
      if (f) {
        titleRel = f.rel;
        break;
      }
    }
  }

  let titleBytes = null;
  let size = 0;
  try {
    await db.deleteFiles(id);
    await db.setExtra(id, null);
    size = await writeFiles(id, files, ctx.onProgress, (item, data) => {
      if (item.rel === titleRel) titleBytes = data;
    });
  } catch (err) {
    await db.deleteGame(id).catch(() => {});
    throw friendlyStorageError(err);
  }

  ctx.onProgress?.({ phase: 'finishing' });
  let thumbnail = null;
  if (titleBytes) {
    const png = extOf(titleRel) === 'png' ? titleBytes : decryptRpgImage(titleBytes, system.encryptionKey);
    if (png) thumbnail = await makeThumbnail(png, 'png');
  }

  const game = {
    id,
    title,
    engine,
    size,
    fileCount: files.length,
    mzGameId: engine === 'mz' && system.advanced && system.advanced.gameId ? String(system.advanced.gameId) : null,
    thumbnail,
    addedAt: existing?.addedAt ?? Date.now(),
    updatedAt: Date.now(),
    lastPlayed: existing?.lastPlayed ?? null,
  };
  await db.putGame(game);
  return { type: 'game', game, replaced: !!existing };
}

function detectRtp(entries) {
  const byParent = new Map();
  for (const e of entries) {
    const segs = e.path.split('/');
    for (let i = 0; i < segs.length - 1; i++) {
      const cat = segs[i].toLowerCase();
      if (!RTP_CATEGORIES.has(cat)) continue;
      const parent = segs.slice(0, i).join('/');
      if (!byParent.has(parent)) byParent.set(parent, new Set());
      byParent.get(parent).add(cat);
    }
  }
  let best = null;
  for (const [parent, cats] of byParent) {
    if (cats.size < 4) continue;
    if (!best || cats.size > best.cats.size || (cats.size === best.cats.size && parent.length < best.rootDir.length)) {
      best = { rootDir: parent, cats };
    }
  }
  if (!best) return null;
  const version = RTP_2003_ONLY.some((c) => best.cats.has(c)) ? 2003 : 2000;
  return { rootDir: best.rootDir, version };
}

async function importRtp(entries, rtp, ctx) {
  const prefix = rtp.rootDir ? `${rtp.rootDir}/` : '';
  const files = entries
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ entry: e, rel: e.path.slice(prefix.length) }))
    .filter((f) => {
      const segs = f.rel.split('/');
      return segs.length === 2 && RTP_CATEGORIES.has(segs[0].toLowerCase()) && segs[1];
    });
  const owner = `rtp-${rtp.version}`;
  let size;
  try {
    await db.setSetting(owner, null);
    await db.deleteFiles(owner);
    size = await writeFiles(owner, files, ctx.onProgress);
  } catch (err) {
    await db.deleteFiles(owner).catch(() => {});
    throw friendlyStorageError(err);
  }
  const meta = { version: rtp.version, fileCount: files.length, size, importedAt: Date.now() };
  await db.setSetting(owner, meta);
  return { type: 'rtp', ...meta };
}

async function importSoundfont(entry) {
  const data = await entry.read();
  const tag = String.fromCharCode(...data.subarray(0, 4)) + String.fromCharCode(...data.subarray(8, 12));
  if (tag !== 'RIFFsfbk') throw new ImportError(`"${basename(entry.path)}" is not a valid SoundFont (.sf2) file.`);
  if (extOf(entry.path) === 'sf3') {
    throw new ImportError('SF3 (compressed) SoundFonts are not supported by the web player. Please use an .sf2 file.');
  }
  try {
    await db.putFiles('soundfont', [{ path: 'easyrpg.soundfont', data: toArrayBuffer(data) }]);
  } catch (err) {
    throw friendlyStorageError(err);
  }
  const meta = { name: basename(entry.path), size: data.byteLength, importedAt: Date.now() };
  await db.setSetting('soundfont', meta);
  return { type: 'soundfont', ...meta };
}

// ---------------------------------------------------------------- thumbnails

async function decodeXyz(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'XYZ1') throw new Error('Not an XYZ image');
  const w = dv.getUint16(4, true);
  const h = dv.getUint16(6, true);
  const raw = await inflateZlib(bytes.subarray(8));
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const c = raw[768 + i] * 3;
    img.data[i * 4] = raw[c];
    img.data[i * 4 + 1] = raw[c + 1];
    img.data[i * 4 + 2] = raw[c + 2];
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

async function makeThumbnail(bytes, ext) {
  try {
    const canvas = document.createElement('canvas');
    const ctx2d = canvas.getContext('2d');
    let photo = false;
    if (ext === 'xyz') {
      const img = await decodeXyz(bytes);
      canvas.width = img.width;
      canvas.height = img.height;
      ctx2d.putImageData(img, 0, 0);
    } else {
      const type = ext === 'png' ? 'image/png' : 'image/bmp';
      const bmp = await createImageBitmap(new Blob([bytes], { type }));
      const scale = Math.min(1, 480 / bmp.width, 360 / bmp.height);
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      ctx2d.imageSmoothingEnabled = scale < 1; // keep pixel art crisp, smooth large images
      ctx2d.imageSmoothingQuality = 'high';
      ctx2d.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      photo = scale < 1;
      bmp.close?.();
    }
    // Large (MV/MZ) title screens are stored as JPEG to keep the library small.
    return photo ? canvas.toDataURL('image/jpeg', 0.86) : canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('Could not create a thumbnail', err);
    return null;
  }
}

export function describeResult(result) {
  switch (result.type) {
    case 'game':
      return `${result.replaced ? 'Updated' : 'Added'} “${result.game.title}” (${formatBytes(result.game.size)}).`;
    case 'rtp':
      return `Installed the RPG Maker ${result.version} RTP (${result.fileCount} files). Games that need it will use it automatically.`;
    case 'soundfont':
      return `SoundFont “${result.name}” installed. MIDI music in all games will use it.`;
    default:
      return 'Import cancelled.';
  }
}
