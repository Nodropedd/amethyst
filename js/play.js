// Player page: prepares the selected game, starts EasyRPG Player and provides
// the toolbar, touch controls and error reporting around it.

import * as db from './db.js';
import { buildGameFs } from './gamefs.js';
import { installXhrShim } from './xhr-shim.js';
import { formatBytes } from './util.js';

const $ = (sel) => document.querySelector(sel);
const canvas = $('#canvas');
const loading = $('#loading');
const loadingText = $('#loading-text');
const loadingBar = $('#loading-bar');
const errorBox = $('#error');
const statusEl = $('#status');

const isTouch = window.matchMedia('(hover: none), (pointer: coarse)').matches;
let player = null;
let frame = null; // <iframe> of an RPG Maker MV/MZ game
let started = false;
let failed = false;

// ------------------------------------------------------------------ logging

const logLines = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack || ''}` : typeof a === 'object' ? safeJson(a) : String(a))).join(' ');
    logLines.push(`[${level}] ${text}`);
    if (logLines.length > 400) logLines.shift();
    original(...args);
  };
}
function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ------------------------------------------------------------------ UI helpers

function setLoading(text, progress = null) {
  loadingText.textContent = text;
  if (progress === null) loadingBar.removeAttribute('value');
  else loadingBar.value = progress;
}

function hideLoading() {
  loading.hidden = true;
}

function showError(title, message, { showLog = false } = {}) {
  failed = true;
  loading.hidden = true;
  errorBox.hidden = false;
  $('#error-title').textContent = title;
  $('#error-message').textContent = message;
  const logBox = $('#error-log');
  if (showLog) {
    logBox.hidden = false;
    logBox.querySelector('pre').textContent = logLines.slice(-80).join('\n');
  }
  window.removeEventListener('beforeunload', confirmLeave);
}

$('#error-copy').addEventListener('click', async () => {
  const text = logLines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('#error-copy').textContent = 'Copied!';
  } catch {
    $('#error-log pre').textContent = text;
  }
});
$('#error-reload').addEventListener('click', () => location.reload());

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

/** Download the player's WebAssembly with a progress bar. */
async function fetchWasm(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the player (${res.status} ${res.statusText}).`);
  // With gzip/brotli transfer encoding Content-Length is the compressed size: no reliable total then.
  const encoded = (res.headers.get('content-encoding') || 'identity') !== 'identity';
  const total = encoded ? 0 : Number(res.headers.get('content-length')) || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) setLoading(`Downloading EasyRPG Player… ${formatBytes(received)} / ${formatBytes(total)}`, Math.min(1, received / total));
    else setLoading(`Downloading EasyRPG Player… ${formatBytes(received)}`);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

function confirmLeave(e) {
  e.preventDefault();
  e.returnValue = '';
}

// ------------------------------------------------------------------ keyboard

const KEY_CODES = {
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Enter: 13, Escape: 27, ShiftLeft: 16, F1: 112, KeyZ: 90, KeyX: 88,
};
const KEY_NAMES = { ShiftLeft: 'Shift', KeyZ: 'z', KeyX: 'x' };

/** Where synthetic keys go: EasyRPG listens on its canvas, MV/MZ games on their document. */
function keyTarget() {
  if (frame) {
    try {
      return frame.contentDocument;
    } catch {
      return null;
    }
  }
  return document.getElementById('canvas');
}

/** Send a synthetic key event to the game. */
function sendKey(type, code) {
  const target = keyTarget();
  if (!target) return;
  const ev = new KeyboardEvent(type, { code, key: KEY_NAMES[code] || code, bubbles: true, cancelable: true });
  const keyCode = KEY_CODES[code] || 0;
  Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
  Object.defineProperty(ev, 'which', { get: () => keyCode });
  target.dispatchEvent(ev);
}

function tapKey(code) {
  sendKey('keydown', code);
  setTimeout(() => sendKey('keyup', code), 90);
}

// The player samples input once per frame: a press shorter than a frame would
// be lost, so touch presses are held for at least this long.
const MIN_PRESS_MS = 70;

/** Press/release helper for on-screen controls that guarantees a minimum press time. */
function makeKeyHolder(code, onChange) {
  let downAt = 0;
  let releaseTimer = null;
  return {
    press() {
      if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
        return; // still held from the last press
      }
      downAt = performance.now();
      sendKey('keydown', code);
      onChange?.(true);
    },
    release() {
      const wait = Math.max(0, MIN_PRESS_MS - (performance.now() - downAt));
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        sendKey('keyup', code);
        onChange?.(false);
      }, wait);
    },
  };
}

function focusGame() {
  if (frame) {
    try {
      frame.contentWindow.focus();
    } catch { /* ignore */ }
    return;
  }
  const c = document.getElementById('canvas');
  if (c && c.focus) c.focus({ preventScroll: true });
}

// Keys whose browser default (help, find, reload, scrolling, ...) must not fire while playing.
const BLOCKED_KEYS = new Set(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F12',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Tab', 'Backspace']);

window.addEventListener('keydown', (e) => {
  if (!started) return;
  const inForm = e.target && (e.target.closest?.('input, textarea, select, [contenteditable]'));
  if (inForm) return;
  if (BLOCKED_KEYS.has(e.key) || e.key === 'Spacebar') e.preventDefault();
  // Keys pressed while the game is not focused (e.g. after clicking the toolbar): forward them.
  if (frame || e.target !== document.getElementById('canvas')) {
    forwardKey(e);
    focusGame();
  }
}, true);

window.addEventListener('keyup', (e) => {
  if (!started) return;
  if ((frame || e.target !== document.getElementById('canvas')) && !e.target?.closest?.('input, textarea, select')) forwardKey(e);
}, true);

function forwardKey(e) {
  const target = keyTarget();
  if (!target || !target.dispatchEvent) return;
  const ev = new KeyboardEvent(e.type, {
    key: e.key, code: e.code, location: e.location, repeat: e.repeat,
    ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
    bubbles: true, cancelable: true,
  });
  const keyCode = e.keyCode;
  Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
  Object.defineProperty(ev, 'which', { get: () => keyCode });
  target.dispatchEvent(ev);
}

// ------------------------------------------------------------------ audio unlock

function resumeAudio() {
  const ctx = player && player.SDL2 && player.SDL2.audioContext;
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  updateSoundHint();
}

function updateSoundHint() {
  const ctx = player && player.SDL2 && player.SDL2.audioContext;
  $('#sound-hint').hidden = !(ctx && ctx.state === 'suspended');
}

for (const type of ['pointerdown', 'keydown', 'touchend']) {
  window.addEventListener(type, resumeAudio, { capture: true, passive: true });
}

// ------------------------------------------------------------------ toolbar

let hideTimer = null;
function pokeToolbar() {
  document.body.classList.remove('toolbar-hidden');
  clearTimeout(hideTimer);
  if (!isTouch) hideTimer = setTimeout(() => {
    if (!$('#toolbar').matches(':hover') && $('#help').hidden) document.body.classList.add('toolbar-hidden');
  }, 2500);
}
window.addEventListener('mousemove', pokeToolbar, { passive: true });
pokeToolbar();

function toolbarAction(id, fn) {
  $(id).addEventListener('click', (e) => {
    e.preventDefault();
    fn();
    if (started) focusGame();
  });
}

toolbarAction('#btn-back', () => {
  window.removeEventListener('beforeunload', confirmLeave);
  location.href = 'index.html';
});
toolbarAction('#btn-settings', () => tapKey('F1'));
toolbarAction('#btn-screenshot', () => {
  if (player && player.api && player.api.takeScreenshot) player.api.takeScreenshot();
});
toolbarAction('#btn-reset', () => {
  if (frame) {
    if (confirm('Restart the game? Unsaved progress will be lost.')) frame.contentWindow.location.reload();
    return;
  }
  if (player && player.api && confirm('Return to the title screen? Unsaved progress will be lost.')) player.api.requestReset();
});
toolbarAction('#btn-help', () => {
  $('#help').hidden = !$('#help').hidden;
});
toolbarAction('#help-close', () => {
  $('#help').hidden = true;
});
toolbarAction('#btn-touch', () => {
  setTouchControls(!document.body.classList.contains('touch-on'));
});

const viewport = $('#viewport');
const fsSupported = !!(viewport.requestFullscreen || viewport.webkitRequestFullscreen);
if (!fsSupported) $('#btn-fullscreen').hidden = true;
toolbarAction('#btn-fullscreen', () => {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else {
    const req = viewport.requestFullscreen || viewport.webkitRequestFullscreen;
    Promise.resolve(req.call(viewport)).then(() => {
      // Prefer landscape on phones (ignored where unsupported).
      if (isTouch && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    }).catch(() => {});
  }
});

function relayout() {
  // SDL only re-reads the canvas size on window resize events.
  window.dispatchEvent(new Event('resize'));
}
for (const ev of ['fullscreenchange', 'webkitfullscreenchange', 'orientationchange']) {
  document.addEventListener(ev, () => setTimeout(relayout, 100));
}

// ------------------------------------------------------------------ touch controls

// MV/MZ games have their own touch support, so the on-screen pad is opt-in there.
let touchPrefKey = 'easyrpg-touch-controls';

function setTouchControls(on) {
  document.body.classList.toggle('touch-on', on);
  try {
    localStorage.setItem(touchPrefKey, on ? '1' : '0');
  } catch { /* ignore */ }
  relayout();
}

function initTouchControls(html5 = false) {
  touchPrefKey = html5 ? 'html5-touch-controls' : 'easyrpg-touch-controls';
  let saved = null;
  try {
    saved = localStorage.getItem(touchPrefKey);
  } catch { /* ignore */ }
  setTouchControls(saved === null ? (isTouch && !html5) : saved === '1');

  // D-pad: direction is chosen by angle from the centre, so sliding works.
  const dpad = $('#dpad');
  const dirKeys = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  const holders = {};
  for (const [dir, code] of Object.entries(dirKeys)) {
    const arm = dpad.querySelector(`[data-dir="${dir}"]`);
    holders[dir] = makeKeyHolder(code, (on) => arm?.classList.toggle('active', on));
  }
  const active = new Map(); // pointerId -> direction
  const held = new Map(); // direction -> number of pointers on it

  const press = (dir) => {
    held.set(dir, (held.get(dir) || 0) + 1);
    if (held.get(dir) === 1) holders[dir].press();
  };
  const release = (dir) => {
    const n = (held.get(dir) || 0) - 1;
    held.set(dir, Math.max(0, n));
    if (n <= 0) holders[dir].release();
  };
  const dirFromPoint = (e) => {
    const r = dpad.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < r.width * 0.12) return null;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  };
  const update = (e) => {
    const next = dirFromPoint(e);
    const prev = active.get(e.pointerId) ?? null;
    if (next === prev) return;
    if (prev) release(prev);
    if (next) press(next);
    active.set(e.pointerId, next);
  };
  dpad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dpad.setPointerCapture?.(e.pointerId);
    update(e);
  });
  dpad.addEventListener('pointermove', (e) => {
    if (active.has(e.pointerId)) update(e);
  });
  const end = (e) => {
    const prev = active.get(e.pointerId);
    if (prev) release(prev);
    active.delete(e.pointerId);
  };
  dpad.addEventListener('pointerup', end);
  dpad.addEventListener('pointercancel', end);
  dpad.addEventListener('lostpointercapture', end);

  for (const btn of document.querySelectorAll('#buttons [data-code]')) {
    const holder = makeKeyHolder(btn.dataset.code, (on) => btn.classList.toggle('active', on));
    let pointers = 0;
    const down = (e) => {
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      if (++pointers === 1) holder.press();
    };
    const up = () => {
      if (pointers === 0) return;
      if (--pointers === 0) holder.release();
    };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', () => {
      if (pointers > 0) {
        pointers = 1;
        up();
      }
    });
  }

  for (const el of document.querySelectorAll('#touch-controls, #touch-controls *')) {
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

// ------------------------------------------------------------------ game preparation

async function loadRtpTable(engine) {
  try {
    const res = await fetch('js/rtp-table.json');
    const all = await res.json();
    return all[String(engine)] || {};
  } catch (err) {
    console.warn('RTP name table unavailable', err);
    return {};
  }
}

async function prepareLocalGame(game) {
  const paths = await db.listFilePaths(game.id);
  if (!paths.length) throw new Error('The files of this game are missing from the browser storage. Please import the game again.');

  let rtp = null;
  const rtpOwner = game.engine === 2003 ? 'rtp-2003' : 'rtp-2000';
  if ((await db.getSetting('use-rtp', true)) !== false) {
    const rtpPaths = await db.listFilePaths(rtpOwner);
    if (rtpPaths.length) {
      rtp = {
        files: rtpPaths.map((p) => ({ path: p, source: { owner: rtpOwner, path: p } })),
        table: await loadRtpTable(game.engine),
      };
    }
  }

  const soundfont = (await db.getSetting('soundfont')) ? { owner: 'soundfont', path: 'easyrpg.soundfont' } : null;

  const aliases = ((await db.getExtra(game.id)) || {}).aliases || {};
  const fs = buildGameFs({
    gameFiles: paths.map((p) => ({ path: p, source: { owner: game.id, path: p }, aliases: aliases[p] })),
    rtp,
    soundfont,
  });
  if (rtp) console.info(`RTP ${game.engine}: ${fs.rtpFiles} files available as fallback`);

  const indexBytes = new TextEncoder().encode(fs.json);
  const prefix = new URL(`games/${game.id}/`, document.baseURI);
  installXhrShim(prefix, async (rel) => {
    if (rel === 'index.json') return indexBytes.slice();
    const src = fs.resolve(rel);
    if (!src) return null;
    return db.getFile(src.owner, src.path);
  });
}

async function findHostedGame(id) {
  try {
    const res = await fetch('games/games.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    const list = await res.json();
    return (Array.isArray(list) ? list : list.games || []).find((g) => g.id === id) || null;
  } catch {
    return null;
  }
}

function watchPlayerStatus() {
  // EasyRPG reports its progress through the #status element.
  new MutationObserver(() => {
    const text = statusEl.textContent.trim();
    if (failed) return;
    if (/exception thrown/i.test(text)) {
      showError('The player crashed', 'EasyRPG Player stopped because of an unexpected error. The log below may explain what went wrong.', { showLog: true });
    } else if (text && !started) {
      setLoading(text.replace(/\.\.\.$/, '…'));
    }
  }).observe(statusEl, { childList: true, characterData: true, subtree: true });
}

// ------------------------------------------------------------------ main

async function main() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('game') || '';
  const gameId = raw.toLowerCase();
  if (!gameId || !/^[a-z0-9][a-z0-9_-]*$/.test(gameId)) {
    showError('No game selected', 'Open a game from your library to play it.');
    return;
  }
  if (raw !== gameId) {
    // The player derives its download path from the raw URL value.
    params.set('game', gameId);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }

  if (!window.WebAssembly) {
    showError('Browser not supported', 'Your browser does not support WebAssembly. Please use a current version of Chrome, Edge, Firefox or Safari.');
    return;
  }

  setLoading('Opening game…');

  let game = null;
  try {
    game = await db.getGame(gameId);
  } catch (err) {
    console.warn('Library not available', err);
  }

  if (game && (game.engine === 'mv' || game.engine === 'mz')) {
    initTouchControls(true);
    await startHtml5Game(game);
    return;
  }
  initTouchControls(false);

  let title;
  if (game) {
    title = game.title;
    if (game.textEncoding && /^\d+$/.test(game.textEncoding) && !params.has('encoding')) {
      // EasyRPG reads its command line options from the page URL (?encoding=932 -> --encoding 932).
      params.set('encoding', game.textEncoding);
      history.replaceState(null, '', `${location.pathname}?${params}`);
    }
    setLoading('Preparing game files…');
    await prepareLocalGame(game);
    db.updateGame(game.id, { lastPlayed: Date.now() }).catch(() => {});
  } else {
    const hosted = await findHostedGame(gameId);
    const probe = await fetch(`games/${gameId}/index.json`, { cache: 'no-cache' }).catch(() => null);
    if (!probe || !probe.ok) {
      showError('Game not found', 'This game is not in the library of this browser. Go back and import it (ZIP file or folder) first.');
      return;
    }
    title = hosted?.title || gameId;
  }

  document.title = `${title} – Amethyst`;
  $('#game-title').textContent = title;

  const wasmBinary = await fetchWasm('player/index.wasm');
  setLoading('Starting EasyRPG Player…');
  await loadScript('player/index.js');
  if (typeof window.createEasyRpgPlayer !== 'function') throw new Error('The player script did not load correctly.');

  watchPlayerStatus();
  player = await window.createEasyRpgPlayer({ game: gameId, wasmBinary });
  player.initApi();
  started = true;
  hideLoading();
  focusGame();
  relayout();
  window.addEventListener('beforeunload', confirmLeave);
  setTimeout(updateSoundHint, 500);

  canvas.addEventListener('pointerdown', focusGame);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ------------------------------------------------------------------ RPG Maker MV / MZ

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

async function startHtml5Game(game) {
  document.body.classList.add('html5-game');
  document.title = `${game.title} – Amethyst`;
  $('#game-title').textContent = game.title;

  if (!('serviceWorker' in navigator)) {
    showError('Not available in this browser window',
      'RPG Maker MV and MZ games need service workers, which this browser has turned off (for example in Firefox private windows). Please use a normal window of a current browser.');
    return;
  }

  setLoading('Preparing game…');
  await navigator.serviceWorker.register('sw.js');
  await withTimeout(navigator.serviceWorker.ready, 20000, 'The game service did not start. Reload the page to try again.');
  db.updateGame(game.id, { lastPlayed: Date.now() }).catch(() => {});

  window.addEventListener('message', (e) => {
    if (e.origin === location.origin && e.data && e.data.type === 'amethyst-game-error') console.error(`[game] ${e.data.message}`);
  });

  frame = document.createElement('iframe');
  frame.id = 'game-frame';
  frame.title = game.title;
  frame.allow = 'autoplay; fullscreen; gamepad';
  frame.setAttribute('allowfullscreen', '');
  const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
  // Mouse movement over the game happens inside the frame: use it to reveal the toolbar.
  // (Re-attached after every load, e.g. when the game restarts.)
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow.addEventListener('mousemove', pokeToolbar, { passive: true });
    } catch { /* ignore */ }
  });
  frame.src = `html5/${encodeURIComponent(game.id)}/index.html`;
  canvas.hidden = true;
  $('#screen').append(frame);
  setLoading('Starting the game…');
  await loaded;

  // Make sure the page really came from the game service (a forced reload can bypass it).
  let served = false;
  try {
    served = !!frame.contentDocument.querySelector('script[data-game-id]');
  } catch { /* ignore */ }
  if (!served) {
    if (!sessionStorage.getItem('html5-retry')) {
      sessionStorage.setItem('html5-retry', '1');
      location.reload();
      return;
    }
    showError('Could not start the game', 'The game service is not active. Reload the page (without holding Shift) and try again.');
    return;
  }
  sessionStorage.removeItem('html5-retry');

  started = true;
  hideLoading();
  focusGame();
  window.addEventListener('beforeunload', confirmLeave);
}

window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled promise rejection', e.reason);
});

main().catch((err) => {
  console.error(err);
  showError('Could not start the game', err && err.message ? err.message : String(err), { showLog: true });
});
