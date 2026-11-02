// Injected (by sw.js) at the top of an imported RPG Maker MV / MZ game's
// index.html, before any game script runs.
(function () {
  'use strict';
  var script = document.currentScript;
  var gameId = script && script.getAttribute('data-game-id');
  if (!gameId) return;

  // 1. Separate save games. RPG Maker MV saves to localStorage under fixed
  //    names ("RPG File1", ...), and every game on this site shares one
  //    localStorage, so each game gets its own key prefix.
  var prefix = 'amethyst:' + gameId + ':';
  var real = null;
  try {
    real = window.localStorage;
  } catch (e) { /* storage blocked */ }

  if (real) {
    var ownKeys = function () {
      var out = [];
      for (var i = 0; i < real.length; i++) {
        var k = real.key(i);
        if (k !== null && k.indexOf(prefix) === 0) out.push(k.slice(prefix.length));
      }
      return out;
    };
    var api = {
      getItem: function (k) { return real.getItem(prefix + k); },
      setItem: function (k, v) { real.setItem(prefix + k, String(v)); },
      removeItem: function (k) { real.removeItem(prefix + k); },
      clear: function () { ownKeys().forEach(function (k) { real.removeItem(prefix + k); }); },
      key: function (i) { var keys = ownKeys(); return i >= 0 && i < keys.length ? keys[i] : null; },
    };
    var storage = new Proxy(api, {
      get: function (target, prop) {
        if (prop === 'length') return ownKeys().length;
        if (typeof prop === 'symbol' || Object.prototype.hasOwnProperty.call(api, prop)) return target[prop];
        var v = real.getItem(prefix + prop);
        return v === null ? undefined : v;
      },
      set: function (target, prop, value) {
        if (typeof prop === 'symbol' || Object.prototype.hasOwnProperty.call(api, prop)) return true;
        real.setItem(prefix + prop, String(value));
        return true;
      },
      deleteProperty: function (target, prop) {
        if (typeof prop !== 'symbol') real.removeItem(prefix + prop);
        return true;
      },
      has: function (target, prop) {
        return Object.prototype.hasOwnProperty.call(api, prop) || prop === 'length'
          || (typeof prop === 'string' && real.getItem(prefix + prop) !== null);
      },
      ownKeys: function () { return ownKeys(); },
      getOwnPropertyDescriptor: function (target, prop) {
        if (typeof prop !== 'string') return undefined;
        var v = real.getItem(prefix + prop);
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      },
    });

    var replaced = false;
    try {
      Object.defineProperty(window, 'localStorage', { configurable: true, enumerable: true, get: function () { return storage; } });
      replaced = window.localStorage === storage;
    } catch (e) { /* fall back below */ }

    if (!replaced) {
      // Fallback: prefix keys at the Storage prototype of this frame.
      var proto = Object.getPrototypeOf(real);
      var orig = { getItem: proto.getItem, setItem: proto.setItem, removeItem: proto.removeItem };
      proto.getItem = function (k) { return orig.getItem.call(this, this === real ? prefix + k : k); };
      proto.setItem = function (k, v) { return orig.setItem.call(this, this === real ? prefix + k : k, v); };
      proto.removeItem = function (k) { return orig.removeItem.call(this, this === real ? prefix + k : k); };
    }
  }

  // 2. Scale the game to the window like the desktop/mobile versions do
  //    (in desktop browsers MV/MZ otherwise show it unscaled in the corner).
  var patched = false;
  function patchGraphics() {
    // RPG Maker MZ (PIXI 5) refuses WebGL without GPU acceleration; allow it
    // so games still start on machines with blocklisted graphics drivers.
    if (window.PIXI && PIXI.settings && 'FAIL_IF_MAJOR_PERFORMANCE_CAVEAT' in PIXI.settings) {
      PIXI.settings.FAIL_IF_MAJOR_PERFORMANCE_CAVEAT = false;
    }
    if (patched || typeof window.Graphics !== 'function' || typeof window.Graphics._defaultStretchMode !== 'function') return;
    window.Graphics._defaultStretchMode = function () { return true; };
    patched = true;
  }
  document.addEventListener('load', patchGraphics, true); // fires after each <script> loads
  document.addEventListener('DOMContentLoaded', patchGraphics);

  // 3. Report errors to the surrounding player page (shown in its log).
  window.addEventListener('error', function (e) {
    try {
      window.parent.postMessage({ type: 'amethyst-game-error', message: String(e.message || e) }, location.origin);
    } catch (err) { /* ignore */ }
  });
})();
