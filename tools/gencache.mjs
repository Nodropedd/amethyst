#!/usr/bin/env node
// Prepares games that are hosted on this website (in games/<id>/):
//   * writes games/<id>/index.json, the file list EasyRPG Player's web
//     version needs (same format as the official "gencache" tool)
//   * writes games/games.json, the list shown under "Games on this site"
//
// Usage:  node tools/gencache.mjs            (all folders in games/)
//         node tools/gencache.mjs games/foo  (only that game)
//
// Folder names become the game id in the URL (play.html?game=<id>), so they
// must be lowercase letters, digits, "-" or "_".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameFs } from '../js/gamefs.js';
import { readDatabaseInfo } from '../js/lcf.js';
import { decodeCandidates, decodeUnknown, normalizeKey, parseIni, stripExt } from '../js/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const gamesDir = path.resolve(here, '..', 'games');
const listFile = path.join(gamesDir, 'games.json');
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function walk(dir, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'index.json' && !base) continue;
    if (ent.name.startsWith('.')) continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full, rel));
    else if (ent.isFile() || ent.isSymbolicLink()) out.push(rel);
  }
  return out;
}

function processGame(dir) {
  const id = path.basename(dir);
  if (!ID_RE.test(id)) {
    console.warn(`! Skipping "${id}": folder names must be lowercase letters, digits, "-" or "_".`);
    return null;
  }
  const files = walk(dir);
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  if (!lower.has('rpg_rt.ldb') || !lower.has('rpg_rt.lmt')) {
    console.warn(`! Skipping "${id}": RPG_RT.ldb / RPG_RT.lmt not found at the top level of the folder.`);
    return null;
  }

  const { json } = buildGameFs({ gameFiles: files.map((f) => ({ path: f, source: f })) });
  fs.writeFileSync(path.join(dir, 'index.json'), json);

  const info = readDatabaseInfo(new Uint8Array(fs.readFileSync(path.join(dir, lower.get('rpg_rt.ldb'))))) || { engine: 2000 };
  let title = id;
  if (lower.has('rpg_rt.ini')) {
    const ini = parseIni(decodeUnknown(new Uint8Array(fs.readFileSync(path.join(dir, lower.get('rpg_rt.ini'))))));
    if (ini.rpg_rt && ini.rpg_rt.gametitle) title = ini.rpg_rt.gametitle.trim() || id;
  }

  let thumbnail;
  if (info.titleName) {
    const titleFiles = files.filter((f) => /^title\//i.test(f) && /\.(png|bmp)$/i.test(f));
    for (const name of decodeCandidates(info.titleName)) {
      const hit = titleFiles.find((f) => normalizeKey(stripExt(f.split('/')[1])) === normalizeKey(name));
      if (hit) {
        thumbnail = `games/${id}/${hit.split('/').map(encodeURIComponent).join('/')}`;
        break;
      }
    }
  }

  console.log(`✓ ${id}: ${files.length} files, RPG Maker ${info.engine}, "${title}"`);
  return { id, title, engine: info.engine, thumbnail };
}

const args = process.argv.slice(2);
const targets = args.length
  ? args.map((a) => path.resolve(a))
  : fs.existsSync(gamesDir)
    ? fs.readdirSync(gamesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(gamesDir, e.name))
    : [];

let existing = [];
try {
  existing = JSON.parse(fs.readFileSync(listFile, 'utf8'));
} catch { /* first run */ }
const byId = new Map(existing.map((g) => [g.id, g]));

const results = targets.map(processGame).filter(Boolean);
for (const r of results) {
  // Keep hand-written fields such as "description" or a custom title.
  const prev = byId.get(r.id) || {};
  byId.set(r.id, { ...r, ...prev, engine: r.engine, thumbnail: prev.thumbnail || r.thumbnail });
}
if (!args.length) {
  // Full rebuild: drop entries whose folder no longer exists.
  for (const id of [...byId.keys()]) if (!fs.existsSync(path.join(gamesDir, id))) byId.delete(id);
}

const list = [...byId.values()].sort((a, b) => String(a.title).localeCompare(String(b.title)));
fs.mkdirSync(gamesDir, { recursive: true });
fs.writeFileSync(listFile, `${JSON.stringify(list, null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), listFile)} (${list.length} game${list.length === 1 ? '' : 's'}).`);
