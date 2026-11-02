// Library page: import games, list them, manage saves, RTP and SoundFont.

import * as db from './db.js';
import { describeResult, entriesFromFileList, jobsFromDataTransfer, jobsFromFiles, runJob } from './importer.js';
import { deleteGameSaves, exportGameSaves, importGameSaves, listGameSaves, saveFileHint } from './saves.js';
import { formatBytes } from './util.js';

const $ = (sel) => document.querySelector(sel);

const ENGINE_NAMES = { 2000: 'RPG Maker 2000', 2003: 'RPG Maker 2003', mv: 'RPG Maker MV', mz: 'RPG Maker MZ' };

// ------------------------------------------------------------------ helpers

let toastTimer = null;
function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast-${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 9000 : 5000);
}

function relativeTime(ts) {
  if (!ts) return 'never';
  const diff = (ts - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, sec] of units) {
    if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit);
  }
  return 'just now';
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function placeholderThumb(title) {
  const letters = (title || '?').trim().slice(0, 2).toUpperCase();
  return el('div', { class: 'thumb thumb-placeholder', 'aria-hidden': 'true' }, letters);
}

function playUrl(id) {
  return `play.html?game=${encodeURIComponent(id)}`;
}

// ------------------------------------------------------------------ import

const importStatus = $('#import-status');
const importText = $('#import-text');
const importBar = $('#import-bar');
const queue = [];
let importing = false;

function setImportProgress(p, label) {
  importStatus.hidden = false;
  if (p.phase === 'importing') {
    importText.textContent = `Importing ${label}… ${p.done} / ${p.total} files (${formatBytes(p.bytes)})`;
    importBar.value = p.total ? p.done / p.total : 0;
  } else {
    const what = { reading: 'Reading', analyzing: 'Checking', finishing: 'Finishing' }[p.phase] || 'Working on';
    importText.textContent = `${what} ${label}…`;
    importBar.removeAttribute('value');
  }
}

function enqueue(jobs) {
  if (!jobs.length) return;
  queue.push(...jobs);
  if (!importing) processQueue();
}

async function processQueue() {
  importing = true;
  document.body.classList.add('is-importing');
  while (queue.length) {
    const job = queue.shift();
    setImportProgress({ phase: 'reading' }, job.label);
    try {
      const result = await runJob(job, {
        onProgress: (p) => setImportProgress(p, job.label),
        confirmReplace: (existing) => confirm(`“${existing.title}” is already in your library.\n\nReplace it with this version? Your save games are kept.`),
      });
      toast(describeResult(result), result.type === 'cancelled' ? 'info' : 'success');
      if (result.type === 'game') {
        await renderLibrary(result.game.id);
        requestPersistence();
      } else {
        await renderExtras();
      }
    } catch (err) {
      console.error(err);
      toast(`Could not import ${job.label}: ${err.message || err}`, 'error');
    }
  }
  importStatus.hidden = true;
  importing = false;
  document.body.classList.remove('is-importing');
  renderStorage();
}

$('#pick-zip').addEventListener('click', (e) => { e.stopPropagation(); $('#input-zip').click(); });
$('#pick-folder').addEventListener('click', (e) => { e.stopPropagation(); $('#input-folder').click(); });
$('#rtp-pick-zip').addEventListener('click', () => $('#input-zip').click());
$('#rtp-pick-folder').addEventListener('click', () => $('#input-folder').click());
$('#sf-pick').addEventListener('click', () => $('#input-sf').click());

$('#input-zip').addEventListener('change', (e) => {
  enqueue(jobsFromFiles(Array.from(e.target.files)));
  e.target.value = '';
});
$('#input-sf').addEventListener('change', (e) => {
  enqueue(jobsFromFiles(Array.from(e.target.files)));
  e.target.value = '';
});
$('#input-folder').addEventListener('change', (e) => {
  const files = e.target.files;
  if (files.length) {
    const top = (files[0].webkitRelativePath || '').split('/')[0] || 'folder';
    enqueue([{ label: top, entries: entriesFromFileList(files) }]);
  }
  e.target.value = '';
});

const dropzone = $('#dropzone');
dropzone.addEventListener('click', (e) => {
  if (e.target === dropzone || e.target.closest('.dz-icon, .dz-title, .dz-sub')) $('#input-zip').click();
});
dropzone.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === dropzone) {
    e.preventDefault();
    $('#input-zip').click();
  }
});

// Accept drops anywhere on the page.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('is-dragging');
});
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('is-dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-dragging');
  if (!e.dataTransfer) return;
  jobsFromDataTransfer(e.dataTransfer).then(enqueue).catch((err) => {
    console.error(err);
    toast(`Could not read the dropped files: ${err.message || err}`, 'error');
  });
});

// ------------------------------------------------------------------ library

async function renderLibrary(highlightId = null) {
  const grid = $('#game-grid');
  let games = [];
  try {
    games = await db.listGames();
  } catch (err) {
    grid.replaceChildren(el('p', { class: 'error-text' }, `Your browser blocked access to local storage (${err.message}). Private browsing modes often do this — try a normal window.`));
    return;
  }
  games.sort((a, b) => (b.lastPlayed || b.addedAt || 0) - (a.lastPlayed || a.addedAt || 0));
  $('#library-empty').hidden = games.length > 0;
  $('#library-count').textContent = games.length ? `${games.length} game${games.length === 1 ? '' : 's'}` : '';

  grid.replaceChildren(...games.map((g) => gameCard(g, g.id === highlightId)));
}

function gameCard(game, highlight) {
  const thumb = game.thumbnail
    ? el('img', { class: 'thumb', src: game.thumbnail, alt: '', loading: 'lazy' })
    : placeholderThumb(game.title);
  const meta = [ENGINE_NAMES[game.engine] || 'RPG Maker', formatBytes(game.size)].join(' · ');
  return el('article', { class: `game-card${highlight ? ' highlight' : ''}` },
    el('a', { class: 'thumb-link', href: playUrl(game.id), title: `Play ${game.title}` }, thumb,
      el('span', { class: 'play-badge', 'aria-hidden': 'true' }, '▶')),
    el('div', { class: 'card-body' },
      el('h3', { class: 'card-title', title: game.title }, game.title),
      el('p', { class: 'card-meta muted' }, meta),
      el('p', { class: 'card-meta muted' }, `Last played ${relativeTime(game.lastPlayed)}`)),
    el('div', { class: 'card-actions' },
      el('a', { class: 'btn btn-primary', href: playUrl(game.id) }, 'Play'),
      el('button', { class: 'btn btn-icon', type: 'button', title: 'Saves & options', 'aria-label': `Options for ${game.title}`, onclick: () => openGameDialog(game.id) }, '⋯')));
}

async function renderHosted() {
  let list = [];
  try {
    const res = await fetch('games/games.json', { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      list = Array.isArray(data) ? data : data.games || [];
    }
  } catch { /* no hosted games */ }
  list = list.filter((g) => g && typeof g.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(g.id));
  $('#hosted').hidden = list.length === 0;
  $('#hosted-grid').replaceChildren(...list.map((g) => {
    const thumb = g.thumbnail
      ? el('img', { class: 'thumb', src: g.thumbnail, alt: '', loading: 'lazy' })
      : placeholderThumb(g.title || g.id);
    return el('article', { class: 'game-card' },
      el('a', { class: 'thumb-link', href: playUrl(g.id), title: `Play ${g.title || g.id}` }, thumb,
        el('span', { class: 'play-badge', 'aria-hidden': 'true' }, '▶')),
      el('div', { class: 'card-body' },
        el('h3', { class: 'card-title' }, g.title || g.id),
        g.description ? el('p', { class: 'card-meta muted' }, g.description) : null,
        g.engine ? el('p', { class: 'card-meta muted' }, ENGINE_NAMES[g.engine] || '') : null),
      el('div', { class: 'card-actions' }, el('a', { class: 'btn btn-primary', href: playUrl(g.id) }, 'Play')));
  }));
}

// ------------------------------------------------------------------ game dialog

const dialog = $('#game-dialog');
let dialogGame = null;

async function openGameDialog(id) {
  const game = await db.getGame(id);
  if (!game) return;
  dialogGame = game;
  $('#gd-title').textContent = game.title;
  $('#gd-meta').textContent = [
    ENGINE_NAMES[game.engine] || 'RPG Maker',
    `${game.fileCount} files`,
    formatBytes(game.size),
    `added ${relativeTime(game.addedAt)}`,
  ].join(' · ');
  const img = $('#gd-thumb');
  if (game.thumbnail) {
    img.src = game.thumbnail;
    img.hidden = false;
  } else img.hidden = true;
  $('#gd-encoding').value = game.textEncoding || '';
  const html5 = game.engine === 'mv' || game.engine === 'mz';
  $('#gd-encoding-section').hidden = html5; // MV/MZ games are Unicode
  $('#gd-import-input').accept = saveFileHint(game);
  await renderSaves();
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

async function renderSaves() {
  const list = $('#gd-saves');
  let saves = [];
  try {
    saves = await listGameSaves(dialogGame);
  } catch (err) {
    console.warn(err);
  }
  if (!saves.length) {
    list.replaceChildren(el('li', { class: 'muted' }, 'No save games yet.'));
  } else {
    list.replaceChildren(...saves.map((s) => el('li', {},
      el('span', {}, s.name),
      el('span', { class: 'muted' }, s.date ? `${s.date.toLocaleString()} · ${formatBytes(s.size)}` : formatBytes(s.size)))));
  }
  $('#gd-export').disabled = !saves.length;
  $('#gd-delete-saves').disabled = !saves.length;
}

$('#gd-export').addEventListener('click', async () => {
  const blob = await exportGameSaves(dialogGame);
  if (!blob) return toast('This game has no save games yet.');
  const safe = dialogGame.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || dialogGame.id;
  downloadBlob(blob, `${safe} - saves.zip`);
});
$('#gd-import').addEventListener('click', () => $('#gd-import-input').click());
$('#gd-import-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (!files.length) return;
  try {
    const n = await importGameSaves(dialogGame, files);
    toast(`Imported ${n} save game${n === 1 ? '' : 's'}.`, 'success');
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
  renderSaves();
});
$('#gd-delete-saves').addEventListener('click', async () => {
  if (!confirm(`Delete all save games of “${dialogGame.title}”? This cannot be undone.\n\nTip: export them first.`)) return;
  await deleteGameSaves(dialogGame);
  toast('Save games deleted.');
  renderSaves();
});
$('#gd-encoding').addEventListener('change', async (e) => {
  await db.updateGame(dialogGame.id, { textEncoding: e.target.value || null });
  toast('Encoding saved. It is used the next time you start the game.');
});
$('#gd-delete').addEventListener('click', async () => {
  if (!confirm(`Remove “${dialogGame.title}” from your library?\n\nYour save games are kept and come back if you import the game again.`)) return;
  await db.deleteGame(dialogGame.id);
  dialog.close();
  toast(`Removed “${dialogGame.title}”.`);
  renderLibrary();
  renderStorage();
});
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close(); // click on backdrop
});

// ------------------------------------------------------------------ extras

async function renderExtras() {
  for (const v of [2000, 2003]) {
    const meta = await db.getSetting(`rtp-${v}`);
    $(`#rtp-${v}-status`).textContent = meta ? `installed · ${meta.fileCount} files · ${formatBytes(meta.size)}` : 'not installed';
    $(`#rtp-${v}-status`).classList.toggle('ok', !!meta);
    $(`#rtp-${v}-remove`).hidden = !meta;
  }
  $('#use-rtp').checked = (await db.getSetting('use-rtp', true)) !== false;

  const sf = await db.getSetting('soundfont');
  $('#sf-status').textContent = sf ? `${sf.name} · ${formatBytes(sf.size)}` : 'built-in synthesizer';
  $('#sf-status').classList.toggle('ok', !!sf);
  $('#sf-remove').hidden = !sf;
}

for (const v of [2000, 2003]) {
  $(`#rtp-${v}-remove`).addEventListener('click', async () => {
    if (!confirm(`Remove the RPG Maker ${v} RTP from this browser?`)) return;
    await db.setSetting(`rtp-${v}`, null);
    await db.deleteFiles(`rtp-${v}`);
    renderExtras();
    renderStorage();
  });
}
$('#use-rtp').addEventListener('change', (e) => db.setSetting('use-rtp', e.target.checked));
$('#sf-remove').addEventListener('click', async () => {
  await db.setSetting('soundfont', null);
  await db.deleteFiles('soundfont');
  toast('SoundFont removed. Games use the built-in synthesizer again.');
  renderExtras();
  renderStorage();
});

async function renderStorage() {
  if (!navigator.storage || !navigator.storage.estimate) {
    $('#storage-usage').textContent = 'unknown';
    $('#storage-persist').textContent = 'unknown';
    return;
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    $('#storage-usage').textContent = `${formatBytes(usage)} of ${formatBytes(quota)} available`;
  } catch {
    $('#storage-usage').textContent = 'unknown';
  }
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  $('#storage-persist').textContent = persisted ? 'protected from automatic cleanup' : 'the browser may clear it when disk space is low';
  $('#storage-persist').classList.toggle('ok', persisted);
  $('#btn-persist').hidden = persisted || !navigator.storage.persist;
}

async function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      await navigator.storage.persist();
    } catch { /* ignore */ }
    renderStorage();
  }
}

$('#btn-persist').addEventListener('click', async () => {
  await requestPersistence();
  const ok = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  toast(ok ? 'Your games and saves are now protected.' : 'The browser declined. Bookmarking or installing this site usually helps.', ok ? 'success' : 'info');
});

// ------------------------------------------------------------------ start

window.addEventListener('pageshow', (e) => {
  // Coming back from the player via the back button: refresh "last played".
  if (e.persisted) renderLibrary();
});

function adaptToDevice() {
  // Phones and tablets cannot drag & drop or pick folders: offer ZIP files only.
  const touchOnly = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (!touchOnly) return;
  $('.dz-title').textContent = 'Add a game';
  $('.dz-sub').innerHTML = 'Choose the game\'s <b>ZIP</b> file';
  for (const id of ['#pick-folder', '#rtp-pick-folder']) $(id).hidden = true;
}

async function init() {
  adaptToDevice();
  if (!window.isSecureContext) {
    toast('This site must be opened over https:// (or http://localhost) for storage to work.', 'error');
  }
  await renderLibrary();
  await Promise.all([renderHosted(), renderExtras().catch(console.warn), renderStorage()]);
}

init().catch((err) => {
  console.error(err);
  toast(err.message || String(err), 'error');
});
