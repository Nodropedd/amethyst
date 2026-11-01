// EasyRPG Player (web build) downloads every game file on demand with
// XMLHttpRequest from "games/<game>/<path>". For games stored in the browser
// library we intercept exactly those requests and answer them from IndexedDB,
// so the unmodified official player runs games that never touch a server.
// Every other request (the player itself, hosted games, ...) is untouched.

import { toArrayBuffer } from './util.js';

/**
 * @param {URL} prefix absolute URL of the virtual game folder, ending with "/"
 * @param {(relativePath: string) => Promise<ArrayBuffer|Uint8Array|null>} serve
 */
export function installXhrShim(prefix, serve) {
  const NativeXHR = window.XMLHttpRequest;
  const prefixPath = prefix.pathname;

  function match(url) {
    let abs;
    try {
      abs = new URL(url, document.baseURI);
    } catch {
      return null;
    }
    if (abs.origin !== prefix.origin || !abs.pathname.startsWith(prefixPath)) return null;
    let rel = abs.pathname.slice(prefixPath.length);
    try {
      rel = decodeURIComponent(rel);
    } catch { /* keep raw */ }
    return { rel, href: abs.href };
  }

  class GameXHR extends NativeXHR {
    open(method, url, async = true, user, password) {
      const m = match(String(url));
      if (!m) {
        this._local = null;
        return super.open(method, url, async, user ?? null, password ?? null);
      }
      this._local = { rel: m.rel, href: m.href, readyState: 1, status: 0, statusText: '', data: null, aborted: false };
      this._fire('readystatechange');
    }

    send(body) {
      const s = this._local;
      if (!s) return super.send(body);
      Promise.resolve()
        .then(() => serve(s.rel))
        .then((data) => {
          if (s.aborted) return;
          if (data) {
            s.status = 200;
            s.statusText = 'OK';
            s.data = toArrayBuffer(data);
          } else {
            s.status = 404;
            s.statusText = 'Not Found';
            s.data = new ArrayBuffer(0);
          }
          s.readyState = 4;
          const n = s.data.byteLength;
          this._fire('readystatechange');
          this._fire('progress', n);
          this._fire('load', n);
          this._fire('loadend', n);
        })
        .catch((err) => {
          console.error(`Could not read "${s.rel}" from the browser library`, err);
          if (s.aborted) return;
          s.readyState = 4;
          s.status = 0;
          this._fire('readystatechange');
          this._fire('error');
          this._fire('loadend');
        });
    }

    abort() {
      if (!this._local) return super.abort();
      this._local.aborted = true;
      this._fire('abort');
      this._fire('loadend');
    }

    _fire(type, total = 0) {
      const ev = type === 'readystatechange'
        ? new Event(type)
        : new ProgressEvent(type, { lengthComputable: total > 0, loaded: total, total });
      this.dispatchEvent(ev);
    }

    get readyState() { return this._local ? this._local.readyState : super.readyState; }
    get status() { return this._local ? this._local.status : super.status; }
    get statusText() { return this._local ? this._local.statusText : super.statusText; }
    get responseURL() { return this._local ? this._local.href : super.responseURL; }

    get response() {
      const s = this._local;
      if (!s) return super.response;
      if (s.readyState !== 4 || !s.data) return null;
      switch (this.responseType) {
        case 'arraybuffer': return s.data;
        case 'blob': return new Blob([s.data]);
        case 'json':
          try { return JSON.parse(new TextDecoder().decode(s.data)); } catch { return null; }
        default: return new TextDecoder().decode(s.data);
      }
    }

    get responseText() {
      const s = this._local;
      if (!s) return super.responseText;
      return s.data ? new TextDecoder().decode(s.data) : '';
    }

    setRequestHeader(name, value) {
      if (!this._local) super.setRequestHeader(name, value);
    }

    overrideMimeType(mime) {
      if (!this._local) super.overrideMimeType(mime);
    }

    getResponseHeader(name) {
      const s = this._local;
      if (!s) return super.getResponseHeader(name);
      if (s.readyState !== 4) return null;
      if (String(name).toLowerCase() === 'content-length') return String(s.data.byteLength);
      return null;
    }

    getAllResponseHeaders() {
      const s = this._local;
      if (!s) return super.getAllResponseHeaders();
      return s.readyState === 4 ? `content-length: ${s.data.byteLength}\r\n` : '';
    }
  }

  window.XMLHttpRequest = GameXHR;
}
