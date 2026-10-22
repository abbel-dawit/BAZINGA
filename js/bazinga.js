/* BAZINGA — built from src/ by build.py. Edit src/, then run: python3 build.py */
(() => {
"use strict";
// ---------- db.js ----------
const __m_db = (() => {
// BAZINGA — on-device storage (IndexedDB). Nothing ever leaves the device.
const DB_NAME = 'bazinga';
const DB_VERSION = 1;
const STORES = ['kv', 'tracks', 'albums', 'playlists', 'files', 'backups', 'ytcache'];
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          db.createObjectStore(s, s === 'kv' || s === 'ytcache' ? undefined : { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Storage is blocked in this browser (private mode?)'));
    req.onblocked = () => reject(new Error('Close other BAZINGA tabs and reload.'));
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const db = {
  get: (store, key) => open().then(d => reqP(d.transaction(store).objectStore(store).get(key))),
  all: (store) => open().then(d => reqP(d.transaction(store).objectStore(store).getAll())),
  keys: (store) => open().then(d => reqP(d.transaction(store).objectStore(store).getAllKeys())),
  put: (store, val, key) => tx(store, 'readwrite', s => { key === undefined ? s.put(val) : s.put(val, key); }),
  putMany: (store, vals) => tx(store, 'readwrite', s => { for (const v of vals) s.put(v); }),
  del: (store, key) => tx(store, 'readwrite', s => { s.delete(key); }),
  clear: (store) => tx(store, 'readwrite', s => { s.clear(); }),
  async destroy() {
    if (dbp) { (await dbp).close(); dbp = null; }
    await new Promise(res => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  }
};

// Simple key/value helpers
const kv = {
  get: (k, dflt = null) => db.get('kv', k).then(v => v === undefined ? dflt : v),
  set: (k, v) => db.put('kv', v, k),
  del: (k) => db.del('kv', k)
};

return { STORES, db, kv };
})();
// ---------- util.js ----------
const __m_util = (() => {
// Shared helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const uid = (p = 'id') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Normalise a title/artist for matching ("Song (feat. X) - Remastered 2011" -> "song")
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*[\(\[][^\)\]]*(feat|ft\.|with|remaster|version|edit|mono|stereo|live|deluxe)[^\)\]]*[\)\]]/g, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mono|stereo|live).*$/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const mainArtist = a => String(a || '').split(/,|&| feat\.? | ft\.? | x /i)[0].trim();
const trackKey = (artist, title) => 't_' + norm(mainArtist(artist)) + '|' + norm(title);
const albumKey = (artist, title) => 'a_' + norm(mainArtist(artist)) + '|' + norm(title);

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
const fmtDur = ms => ms ? fmtTime(ms / 1000) : '';
const yearOf = d => { const m = String(d || '').match(/\d{4}/); return m ? +m[0] : null; };

function debounce(fn, ms = 300) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Event bus
const bus = new EventTarget();
const on = (ev, fn) => bus.addEventListener(ev, e => fn(e.detail));
const emit = (ev, detail) => bus.dispatchEvent(new CustomEvent(ev, { detail }));
const toast = (msg, kind = 'info') => emit('toast', { msg, kind });

// JSONP (used for Apple's free iTunes Search API, which doesn't always send CORS headers)
let jsonpN = 0;
function jsonp(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const cb = '__bz_jsonp_' + (++jsonpN);
    const s = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);
    function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
    window[cb] = data => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error('network')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}

// Resize an image file to a square-ish data URL (for profile pictures)
function imageToDataURL(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// base64url + deflate for compact share links
async function packToString(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let out = bytes;
  if ('CompressionStream' in window) {
    const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    out = new Uint8Array(await new Response(cs).arrayBuffer());
  }
  let bin = ''; out.forEach(b => bin += String.fromCharCode(b));
  return ('CompressionStream' in window ? 'z' : 'j') + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function unpackString(str) {
  const mode = str[0];
  const b64 = str.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  let bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  if (mode === 'z') {
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function hashColor(s) {
  let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(h) % 360} 55% 38%)`;
}

return { $, $$, uid, esc, norm, mainArtist, trackKey, albumKey, fmtTime, fmtDur, yearOf, debounce, sleep, on, emit, toast, jsonp, imageToDataURL, downloadBlob, packToString, unpackString, hashColor };
})();
// ---------- ui.js ----------
const __m_ui = (() => {
// Reusable UI pieces: icons, rows, cards, menus, modals, toasts, filters.
const { esc, fmtDur, hashColor, $, on, mainArtist, yearOf } = __m_util;

const I = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  library: '<path d="M4 4v16M9 4v16M14 5l5 15"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  offline: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  minus: '<path d="M5 12h14"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  apple: '<path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.5-1-2.5-3.8zM14.2 5.8c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.7-1.3z" fill="currentColor" stroke="none"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
  next: '<path d="M5 5l10 7-10 7z" fill="currentColor"/><path d="M19 5v14"/>',
  prev: '<path d="M19 5L9 12l10 7z" fill="currentColor"/><path d="M5 5v14"/>',
  shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  repeat: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  heartFill: '<path fill="currentColor" d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  queue: '<path d="M3 6h13M3 12h13M3 18h8"/><path d="M17 15v6l5-3z" fill="currentColor"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  video: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3"/>',
  audio: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/>',
  yt: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9v6l5-3z" fill="currentColor"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  sparkle: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  cloudOff: '<path d="M3 3l18 18M8 8a5 5 0 0 0-2 9.6h10M18 17.3A4 4 0 0 0 16.5 10a6 6 0 0 0-6.4-4.6"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  spotify: '<circle cx="12" cy="12" r="10"/><path d="M7 9.5c3.5-1 7-.7 10 1M7.5 12.8c3-.8 5.6-.5 8 .9M8 16c2.3-.5 4.3-.3 6 .7"/>',
  grip: '<circle cx="9" cy="7" r="1.2" fill="currentColor"/><circle cx="15" cy="7" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="17" r="1.2" fill="currentColor"/><circle cx="15" cy="17" r="1.2" fill="currentColor"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] || ''}</svg>`;

function cover(src, label, cls = '') {
  if (src) return `<div class="cover ${cls}"><img src="${esc(src)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('noimg');this.remove()"><span>${esc((label || '?')[0])}</span></div>`;
  return `<div class="cover noimg ${cls}" style="--c:${hashColor(label)}"><span>${esc((label || '?')[0].toUpperCase())}</span></div>`;
}

// One song row. `ctx` = {list, index, playlistId}
function trackRow(t, i, ctx = {}, playingId) {
  const isNow = playingId === t.id;
  const artists = (t.artists?.length ? t.artists : [t.artist]).map(a =>
    `<a href="#/artist/${encodeURIComponent(mainArtist(a))}" class="lnk">${esc(a)}</a>`).join(', ');
  return `<div class="row ${isNow ? 'now' : ''}" data-act="play-row" data-list="${ctx.list}" data-i="${i}" data-id="${esc(t.id)}" role="button" tabindex="0">
    <div class="row-num">${isNow ? '<span class="eq"><i></i><i></i><i></i></span>' : (ctx.numbered ? (t.trackNumber || i + 1) : '')}${cover(t.artwork, t.title, 'sm')}</div>
    <div class="row-main">
      <div class="row-title">${esc(t.title)}${t.explicit ? '<span class="e">E</span>' : ''}${t.localFileId ? `<span class="off" title="Available offline">${icon('offline')}</span>` : ''}</div>
      <div class="row-sub">${artists}</div>
    </div>
    <div class="row-album hide-sm">${t.album ? `<a class="lnk" data-act="goto-album" data-id="${esc(t.id)}">${esc(t.album)}</a>` : ''}</div>
    <div class="row-meta hide-sm">${t.genre ? `<span class="pill">${esc(t.genre)}</span>` : ''}${t.year || yearOf(t.releaseDate) || ''}</div>
    <button class="ib like ${t.liked ? 'on' : ''}" data-act="like" data-id="${esc(t.id)}" aria-label="Like">${icon(t.liked ? 'heartFill' : 'heart')}</button>
    <div class="row-dur hide-xs">${fmtDur(t.durationMs)}</div>
    <button class="ib" data-act="track-menu" data-id="${esc(t.id)}" data-pl="${ctx.playlistId || ''}" aria-label="More">${icon('more')}</button>
  </div>`;
}

function card({ href, img, title, sub, round = false, act = '', id = '' }) {
  return `<a class="card" href="${href}">
    <div class="card-art ${round ? 'round' : ''}">${cover(img, title)}${act ? `<button class="fab-play" data-act="${act}" data-id="${esc(id)}" aria-label="Play">${icon('play')}</button>` : ''}</div>
    <div class="card-t">${esc(title)}</div><div class="card-s">${esc(sub || '')}</div></a>`;
}

// ---------- Toasts ----------
on('toast', ({ msg, kind }) => {
  const root = $('#toasts'); if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
});

// ---------- Modal ----------
function modal(html, { wide = false, onMount, locked = false } = {}) {
  return new Promise(resolve => {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${locked ? '' : `<button class="ib modal-x" data-close aria-label="Close">${icon('close')}</button>`}${html}</div>`;
    root.appendChild(wrap);
    const close = v => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 180); document.removeEventListener('keydown', key); resolve(v); };
    const key = e => { if (e.key === 'Escape' && !locked) close(null); };
    document.addEventListener('keydown', key);
    wrap.addEventListener('click', e => {
      if ((e.target === wrap && !locked) || e.target.closest('[data-close]')) close(null);
      const r = e.target.closest('[data-resolve]');
      if (r) close(r.dataset.resolve);
    });
    wrap.querySelector('form')?.addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target), o = {};
      for (const k of new Set(fd.keys())) { const v = fd.getAll(k); o[k] = v.length > 1 ? v : v[0]; }
      close(o);
    });
    onMount?.(wrap.querySelector('.modal'), close);
    setTimeout(() => wrap.querySelector('input:not([type=file]),button.primary')?.focus(), 50);
  });
}
async function promptText(title, value = '', label = 'Name', okText = 'Save') {
  const r = await modal(`<h3>${esc(title)}</h3><form><label class="fld"><span>${esc(label)}</span><input name="v" value="${esc(value)}" required maxlength="100"></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${esc(okText)}</button></div></form>`);
  return r ? r.v.trim() : null;
}
async function confirmBox(title, body, okText = 'Confirm', danger = false) {
  const r = await modal(`<h3>${esc(title)}</h3><p class="muted">${body}</p>
    <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-resolve="ok">${esc(okText)}</button></div>`);
  return r === 'ok';
}

// ---------- Popup menu (bottom sheet on phones) ----------
function menu(anchor, items) {
  closeMenu();
  const root = $('#menu-root');
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.filter(Boolean).map(it => it === '-' ? '<hr>' :
    it.header ? `<div class="menu-h">${it.header}</div>` :
    `<button data-k="${it.k}" class="${it.danger ? 'danger' : ''}">${icon(it.icon || 'plus')}<span>${esc(it.label)}</span></button>`).join('');
  const back = document.createElement('div'); back.className = 'menu-back';
  root.append(back, m);
  const mobile = innerWidth < 700;
  if (mobile) m.classList.add('sheet');
  else {
    const r = anchor.getBoundingClientRect();
    const mw = 260, mh = Math.min(m.scrollHeight, innerHeight - 20);
    m.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
    m.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
  }
  return new Promise(resolve => {
    m.addEventListener('click', e => { const b = e.target.closest('button[data-k]'); if (b) { closeMenu(); resolve(b.dataset.k); } });
    back.addEventListener('click', () => { closeMenu(); resolve(null); });
  });
}
function closeMenu() { const r = $('#menu-root'); if (r) r.innerHTML = ''; }

// ---------- Filters (genre + release date + sort + text) ----------
function applyFilters(list, f) {
  let out = list;
  if (f.q) {
    const q = f.q.toLowerCase();
    out = out.filter(t => (t.title + ' ' + t.artist + ' ' + (t.album || '')).toLowerCase().includes(q));
  }
  if (f.genres?.length) out = out.filter(t => f.genres.includes(t.genre || '—'));
  const y = t => t.year || yearOf(t.releaseDate);
  if (f.from) out = out.filter(t => y(t) && y(t) >= +f.from);
  if (f.to) out = out.filter(t => y(t) && y(t) <= +f.to);
  if (f.liked) out = out.filter(t => t.liked);
  if (f.offline) out = out.filter(t => t.localFileId);
  const by = {
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    title: (a, b) => a.title.localeCompare(b.title),
    artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
    newest: (a, b) => (b.releaseDate || String(y(b) || '')).localeCompare(a.releaseDate || String(y(a) || '')),
    oldest: (a, b) => (y(a) || 9999) - (y(b) || 9999) || (a.releaseDate || '').localeCompare(b.releaseDate || ''),
    album: (a, b) => (a.album || '').localeCompare(b.album || '') || (a.trackNumber || 0) - (b.trackNumber || 0)
  }[f.sort];
  if (by) out = [...out].sort(by);
  return out;
}

function filterBar(f, tracks, { showSort = true, keepOrder = false } = {}) {
  const gm = new Map();
  for (const t of tracks) { const g = t.genre || '—'; gm.set(g, (gm.get(g) || 0) + 1); }
  const genres = [...gm.entries()].sort((a, b) => b[1] - a[1]);
  const years = tracks.map(t => t.year || yearOf(t.releaseDate)).filter(Boolean);
  const minY = years.length ? Math.min(...years) : 1950, maxY = years.length ? Math.max(...years) : new Date().getFullYear();
  const decades = [...new Set(years.map(y => Math.floor(y / 10) * 10))].sort();
  const active = (f.genres?.length || 0) + (f.from || f.to ? 1 : 0) + (f.liked ? 1 : 0) + (f.offline ? 1 : 0);
  return `<div class="filters">
    <div class="filter-top">
      <label class="searchbox sm">${icon('search')}<input data-f="q" placeholder="Filter songs" value="${esc(f.q || '')}"></label>
      <button class="chip ${f.open ? 'on' : ''}" data-act="toggle-filters">${icon('filter')}Filters${active ? ` <b>${active}</b>` : ''}</button>
      ${showSort ? `<select data-f="sort" class="select" aria-label="Sort">
        ${keepOrder ? `<option value="" ${!f.sort ? 'selected' : ''}>Custom order</option>` : ''}
        ${[['added', 'Recently added'], ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['newest', 'Release: newest'], ['oldest', 'Release: oldest']]
          .map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>` : ''}
    </div>
    ${f.open ? `<div class="filter-panel">
      <div class="fp-sec"><div class="fp-h">Genre</div><div class="chips">
        ${genres.length ? genres.map(([g, n]) => `<button class="chip ${f.genres?.includes(g) ? 'on' : ''}" data-act="f-genre" data-g="${esc(g)}">${g === '—' ? 'Unknown' : esc(g)} <small>${n}</small></button>`).join('') : '<span class="muted">Genres appear as songs get matched.</span>'}
      </div></div>
      <div class="fp-sec"><div class="fp-h">Release date</div>
        <div class="chips">${decades.map(d => `<button class="chip ${+f.from === d && +f.to === d + 9 ? 'on' : ''}" data-act="f-decade" data-d="${d}">${d}s</button>`).join('')}</div>
        <div class="years"><label>From <input type="number" data-f="from" min="1900" max="2100" placeholder="${minY}" value="${esc(f.from || '')}"></label>
        <label>To <input type="number" data-f="to" min="1900" max="2100" placeholder="${maxY}" value="${esc(f.to || '')}"></label></div>
      </div>
      <div class="fp-sec"><div class="chips">
        <button class="chip ${f.liked ? 'on' : ''}" data-act="f-flag" data-k="liked">${icon('heart')}Liked only</button>
        <button class="chip ${f.offline ? 'on' : ''}" data-act="f-flag" data-k="offline">${icon('offline')}Offline only</button>
        ${active ? '<button class="chip ghost" data-act="f-clear">Clear all</button>' : ''}
      </div></div>
    </div>` : ''}
  </div>`;
}

function empty(title, body, cta = '') {
  return `<div class="empty"><img src="icons/icon-192.png" alt="" class="empty-bolt"><h3>${title}</h3><p class="muted">${body}</p>${cta}</div>`;
}

return { icon, cover, trackRow, card, modal, promptText, confirmBox, menu, closeMenu, applyFilters, filterBar, empty };
})();
// ---------- meta.js ----------
const __m_meta = (() => {
// Music metadata (genre, release date, artwork, albums, artists) from Apple's free
// iTunes Search API — no key, no account. Results are cached on the device.
const { jsonp, norm, mainArtist, albumKey, trackKey, yearOf, sleep } = __m_util;

const BASE = 'https://itunes.apple.com';
let country = 'US';
const setCountry = c => { country = (c || 'US').toUpperCase(); };

// Apple asks for ~20 req/min; we space calls out to stay polite.
let last = 0;
const GAP = 1200;
const mem = new Map();
async function call(path, params) {
  const q = new URLSearchParams({ ...params, country }).toString();
  const url = `${BASE}/${path}?${q}`;
  if (mem.has(url)) return mem.get(url);
  const wait = last + GAP - Date.now();
  last = Math.max(Date.now(), last + GAP);
  if (wait > 0) await sleep(wait);
  const p = jsonp(url).then(d => d.results || []).catch(e => { mem.delete(url); throw e; });
  mem.set(url, p);
  return p;
}

const art = (u, size = 600) => u ? u.replace(/\/\d+x\d+(bb)?\./, `/${size}x${size}bb.`) : '';

function songFromItunes(r) {
  return {
    id: trackKey(r.artistName, r.trackName),
    title: r.trackName,
    artist: r.artistName,
    album: r.collectionName || '',
    albumId: r.collectionName ? albumKey(r.collectionArtistName || r.artistName, r.collectionName) : '',
    itunesAlbumId: r.collectionId || null,
    itunesArtistId: r.artistId || null,
    itunesId: r.trackId || null,
    trackNumber: r.trackNumber || 0,
    discNumber: r.discNumber || 1,
    genre: r.primaryGenreName || '',
    releaseDate: r.releaseDate ? r.releaseDate.slice(0, 10) : '',
    year: yearOf(r.releaseDate),
    durationMs: r.trackTimeMillis || 0,
    artwork: art(r.artworkUrl100),
    explicit: r.trackExplicitness === 'explicit',
    enriched: true
  };
}
function albumFromItunes(r) {
  return {
    id: albumKey(r.artistName, r.collectionName),
    title: r.collectionName,
    artist: r.artistName,
    itunesAlbumId: r.collectionId,
    itunesArtistId: r.artistId || null,
    genre: r.primaryGenreName || '',
    releaseDate: r.releaseDate ? r.releaseDate.slice(0, 10) : '',
    year: yearOf(r.releaseDate),
    trackCount: r.trackCount || 0,
    artwork: art(r.artworkUrl100)
  };
}

async function searchSongs(term, limit = 25) {
  return (await call('search', { term, media: 'music', entity: 'song', limit })).filter(r => r.kind === 'song').map(songFromItunes);
}
async function searchAlbums(term, limit = 25) {
  return (await call('search', { term, media: 'music', entity: 'album', limit })).filter(r => r.collectionType === 'Album').map(albumFromItunes);
}
async function searchArtists(term, limit = 10) {
  return (await call('search', { term, media: 'music', entity: 'musicArtist', limit }))
    .map(r => ({ name: r.artistName, itunesArtistId: r.artistId, genre: r.primaryGenreName || '' }));
}

// Full album tracklist
async function albumTracks(itunesAlbumId) {
  const res = await call('lookup', { id: itunesAlbumId, entity: 'song', limit: 200 });
  const album = res.find(r => r.wrapperType === 'collection');
  const songs = res.filter(r => r.wrapperType === 'track' && r.kind === 'song').map(songFromItunes)
    .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber));
  return { album: album ? albumFromItunes(album) : null, tracks: songs };
}

async function artistAlbums(itunesArtistId) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'album', limit: 200 });
  const seen = new Set();
  return res.filter(r => r.wrapperType === 'collection' && r.collectionType === 'Album').map(albumFromItunes)
    .filter(a => { const k = norm(a.title); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
}
async function artistTopSongs(itunesArtistId) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'song', limit: 25 });
  return res.filter(r => r.wrapperType === 'track').map(songFromItunes);
}
async function findArtistId(name) {
  const res = await searchArtists(mainArtist(name), 5);
  const n = norm(mainArtist(name));
  return (res.find(a => norm(a.name) === n) || res[0])?.itunesArtistId || null;
}

// Find the best iTunes match for a track we only know by name, to fill in
// genre / release date / artwork / album id.
async function matchTrack(t) {
  const res = await searchSongs(`${mainArtist(t.artist)} ${t.title}`, 10);
  const nt = norm(t.title), na = norm(mainArtist(t.artist));
  let best = null, bestScore = 0;
  for (const r of res) {
    let s = 0;
    if (norm(r.title) === nt) s += 5; else if (norm(r.title).includes(nt) || nt.includes(norm(r.title))) s += 2;
    if (norm(mainArtist(r.artist)) === na) s += 4; else if (norm(r.artist).includes(na)) s += 2;
    if (t.album && norm(r.album) === norm(t.album)) s += 2;
    if (t.durationMs && r.durationMs && Math.abs(t.durationMs - r.durationMs) < 4000) s += 1;
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return bestScore >= 6 ? best : null;
}

async function findAlbum(artist, title) {
  const res = await searchAlbums(`${mainArtist(artist)} ${title}`, 10);
  const nt = norm(title), na = norm(mainArtist(artist));
  return res.find(a => norm(a.title) === nt && norm(a.artist).includes(na))
      || res.find(a => norm(a.title).includes(nt) && norm(a.artist).includes(na))
      || null;
}

return { setCountry, art, songFromItunes, albumFromItunes, searchSongs, searchAlbums, searchArtists, albumTracks, artistAlbums, artistTopSongs, findArtistId, matchTrack, findAlbum };
})();
// ---------- store.js ----------
const __m_store = (() => {
// The user's library, kept in memory and mirrored to IndexedDB.
const { db } = __m_db;
const { uid, emit, debounce, norm, mainArtist, albumKey } = __m_util;
const meta = __m_meta;

const lib = {
  tracks: new Map(),
  albums: new Map(),
  playlists: new Map()
};

const changed = debounce(() => emit('library'), 120);
const notify = (why = 'change') => { changed(); emit('dirty', why); };

async function load() {
  const [t, a, p] = await Promise.all([db.all('tracks'), db.all('albums'), db.all('playlists')]);
  lib.tracks = new Map(t.map(x => [x.id, x]));
  lib.albums = new Map(a.map(x => [x.id, x]));
  lib.playlists = new Map(p.map(x => [x.id, x]));
}

// Merge incoming tracks into the library, never throwing away data we already have.
async function upsertTracks(list, extra = {}) {
  const out = [];
  for (const n of list) {
    const old = lib.tracks.get(n.id);
    const merged = old ? { ...old } : { addedAt: Date.now() };
    for (const [k, v] of Object.entries(n)) {
      if (v !== undefined && v !== null && v !== '' && !(k === 'addedAt' && old)) merged[k] = v;
    }
    Object.assign(merged, extra);
    if (old?.liked && !old.transient) merged.liked = true;
    delete merged.transient;
    lib.tracks.set(merged.id, merged);
    out.push(merged);
  }
  await db.putMany('tracks', out);
  notify('tracks');
  queueEnrich(out);
  return out;
}

// Keep a track in memory only (e.g. playing a search result) until the user saves it.
function remember(t) {
  if (!lib.tracks.has(t.id)) lib.tracks.set(t.id, { ...t, transient: true });
  return lib.tracks.get(t.id);
}
const saved = () => [...lib.tracks.values()].filter(t => !t.transient);

async function updateTrack(id, patch) {
  const t = lib.tracks.get(id); if (!t) return;
  if (t.transient) { Object.assign(t, patch); await upsertTracks([t]); return; }
  Object.assign(t, patch);
  await db.put('tracks', t);
  notify('track');
}

async function toggleLike(id) {
  const t = lib.tracks.get(id); if (!t) return;
  await updateTrack(id, { liked: !t.liked });
  return t.liked;
}

function isReferenced(id) {
  const t = lib.tracks.get(id);
  if (!t) return false;
  if (t.liked || t.localFileId) return true;
  for (const p of lib.playlists.values()) if (p.trackIds.includes(id)) return true;
  for (const a of lib.albums.values()) if (a.trackIds?.includes(id)) return true;
  return false;
}
async function gc(ids) {
  for (const id of ids) if (!isReferenced(id)) { lib.tracks.delete(id); await db.del('tracks', id); }
}

async function deleteTrack(id) {
  const t = lib.tracks.get(id);
  if (t?.localFileId) await db.del('files', t.localFileId);
  for (const p of lib.playlists.values()) {
    if (p.trackIds.includes(id)) { p.trackIds = p.trackIds.filter(x => x !== id); await db.put('playlists', p); }
  }
  for (const a of lib.albums.values()) {
    if (a.trackIds?.includes(id)) { a.trackIds = a.trackIds.filter(x => x !== id); await db.put('albums', a); }
  }
  lib.tracks.delete(id); await db.del('tracks', id);
  notify('delete');
}

// ---------- Playlists ----------
async function createPlaylist(name, trackIds = [], extra = {}) {
  const p = { id: uid('pl'), name: name || 'New playlist', trackIds: [...new Set(trackIds)], createdAt: Date.now(), ...extra };
  lib.playlists.set(p.id, p);
  await db.put('playlists', p);
  notify('playlist');
  return p;
}
async function savePlaylist(p) { lib.playlists.set(p.id, p); await db.put('playlists', p); notify('playlist'); }
async function addToPlaylist(pid, ids) {
  const p = lib.playlists.get(pid); if (!p) return 0;
  const before = p.trackIds.length;
  p.trackIds = [...new Set([...p.trackIds, ...ids])];
  await savePlaylist(p);
  return p.trackIds.length - before;
}
async function removeFromPlaylist(pid, id) {
  const p = lib.playlists.get(pid); if (!p) return;
  p.trackIds = p.trackIds.filter(x => x !== id);
  await savePlaylist(p); await gc([id]);
}
async function deletePlaylist(pid) {
  const p = lib.playlists.get(pid); if (!p) return;
  lib.playlists.delete(pid); await db.del('playlists', pid);
  await gc(p.trackIds); notify('playlist');
}

// ---------- Albums ----------
async function saveAlbum(album, tracks) {
  const saved = await upsertTracks(tracks.map(t => ({ ...t, album: album.title, albumId: album.id, itunesAlbumId: album.itunesAlbumId || t.itunesAlbumId })));
  const a = { ...album, trackIds: saved.map(t => t.id), savedAt: Date.now() };
  lib.albums.set(a.id, a);
  await db.put('albums', a);
  notify('album');
  return a;
}
async function removeAlbum(id) {
  const a = lib.albums.get(id); if (!a) return;
  lib.albums.delete(id); await db.del('albums', id);
  await gc(a.trackIds || []); notify('album');
}

// ---------- Derived views ----------
function artists() {
  const m = new Map();
  for (const t of saved()) {
    const names = t.artists?.length ? t.artists : [mainArtist(t.artist)];
    for (const name of names) {
      const k = norm(name); if (!k) continue;
      const e = m.get(k) || { key: k, name, count: 0, artwork: '', genres: new Set(), itunesArtistId: null };
      e.count++;
      if (!e.artwork && t.artwork) e.artwork = t.artwork;
      if (t.genre) e.genres.add(t.genre);
      if (!e.itunesArtistId && t.itunesArtistId && norm(mainArtist(t.artist)) === k) e.itunesArtistId = t.itunesArtistId;
      m.set(k, e);
    }
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function genres() {
  const m = new Map();
  for (const t of saved()) if (t.genre) m.set(t.genre, (m.get(t.genre) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// Albums the user has songs from but hasn't explicitly saved
function implicitAlbums() {
  const m = new Map();
  for (const t of saved()) {
    if (!t.album) continue;
    const id = t.albumId || albumKey(t.artist, t.album);
    if (lib.albums.has(id)) continue;
    const e = m.get(id) || { id, title: t.album, artist: mainArtist(t.artist), artwork: t.artwork, year: t.year, itunesAlbumId: t.itunesAlbumId, trackIds: [], implicit: true };
    e.trackIds.push(t.id);
    if (!e.itunesAlbumId && t.itunesAlbumId) e.itunesAlbumId = t.itunesAlbumId;
    m.set(id, e);
  }
  return [...m.values()];
}

// ---------- Background enrichment (genre, release date, artwork, album ids) ----------
let enrichQ = [], enriching = false, enrichOn = true;
const setEnrich = v => { enrichOn = v; if (v) queueEnrich([...lib.tracks.values()]); };
const enrichPending = () => enrichQ.length;
function queueEnrich(list) {
  for (const t of list) if (!t.enriched && !enrichQ.includes(t.id)) enrichQ.push(t.id);
  runEnrich();
}
async function runEnrich() {
  if (enriching || !enrichOn) return;
  enriching = true;
  while (enrichQ.length && enrichOn) {
    if (!navigator.onLine) { await new Promise(r => setTimeout(r, 10000)); continue; }
    const id = enrichQ.shift();
    const t = lib.tracks.get(id);
    if (!t || t.enriched) continue;
    try {
      const m = await meta.matchTrack(t);
      const patch = { enriched: true };
      if (m) {
        if (!t.genre && m.genre) patch.genre = m.genre;
        if (!t.releaseDate && m.releaseDate) { patch.releaseDate = m.releaseDate; patch.year = m.year; }
        if (!t.artwork && m.artwork) patch.artwork = m.artwork;
        if (!t.album && m.album) { patch.album = m.album; patch.albumId = m.albumId; }
        if (!t.durationMs && m.durationMs) patch.durationMs = m.durationMs;
        patch.itunesAlbumId = m.itunesAlbumId; patch.itunesArtistId = m.itunesArtistId;
      }
      Object.assign(t, patch);
      await db.put('tracks', t);
      emit('dirty', 'enrich'); // no full re-render while browsing
      emit('enrich', enrichQ.length);
    } catch (e) {
      enrichQ.push(id); // retry later
      await new Promise(r => setTimeout(r, 15000));
    }
  }
  enriching = false;
  emit('enrich', 0);
}

return { lib, notify, load, upsertTracks, remember, saved, updateTrack, toggleLike, deleteTrack, createPlaylist, savePlaylist, addToPlaylist, removeFromPlaylist, deletePlaylist, saveAlbum, removeAlbum, artists, genres, implicitAlbums, setEnrich, enrichPending, queueEnrich };
})();
// ---------- youtube.js ----------
const __m_youtube = (() => {
// Finding YouTube videos for each song — free and keyless by default.
// Order of attempts:
//   1. Your own YouTube Data API key (optional, Settings) — most reliable.
//   2. Public Invidious instances (open-source YouTube front-ends with a free JSON API).
//   3. Public Piped instances.
// Every match is cached on the device, so a song is only ever looked up once.
const { db } = __m_db;
const { norm, mainArtist, sleep } = __m_util;

let settings = { ytKey: '', customInstance: '' };
const setYTSettings = s => { settings = { ...settings, ...s }; };

const FALLBACK_INVIDIOUS = [
  'https://inv.nadeko.net', 'https://invidious.nerdvpn.de', 'https://yewtu.be',
  'https://invidious.f5.si', 'https://iv.melmac.space', 'https://invidious.privacyredirect.com'
];
const FALLBACK_PIPED = ['https://pipedapi.kavin.rocks', 'https://api.piped.private.coffee', 'https://pipedapi.adminforge.de'];

let instances = null; // {inv:[], piped:[]}
const bad = new Map(); // instance -> time it failed

async function fetchJSON(url, ms = 9000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function loadInstances() {
  if (instances) return instances;
  const inv = [], piped = [];
  try {
    const list = await fetchJSON('https://api.invidious.io/instances.json?sort_by=health', 6000);
    for (const [, info] of list) {
      if (info?.type === 'https' && info.api && info.cors) inv.push(info.uri.replace(/\/$/, ''));
    }
  } catch { /* offline or blocked — use fallbacks */ }
  try {
    const list = await fetchJSON('https://piped-instances.kavin.rocks/', 6000);
    for (const i of list) if (i.api_url) piped.push(i.api_url.replace(/\/$/, ''));
  } catch { }
  instances = {
    inv: [...new Set([...inv, ...FALLBACK_INVIDIOUS])],
    piped: [...new Set([...piped, ...FALLBACK_PIPED])]
  };
  return instances;
}

const healthy = u => !(bad.has(u) && Date.now() - bad.get(u) < 10 * 60e3);

// Normalised result: {id, title, author, seconds}
async function searchViaKey(q) {
  const u = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10&videoCategoryId=10&q=${encodeURIComponent(q)}&key=${encodeURIComponent(settings.ytKey)}`;
  const d = await fetchJSON(u);
  return (d.items || []).map(i => ({ id: i.id.videoId, title: decodeEntities(i.snippet.title), author: i.snippet.channelTitle, seconds: 0 }));
}
async function searchInvidious(base, q) {
  const d = await fetchJSON(`${base}/api/v1/search?type=video&q=${encodeURIComponent(q)}`);
  return d.filter(v => v.type === 'video').map(v => ({ id: v.videoId, title: v.title, author: v.author, seconds: v.lengthSeconds || 0 }));
}
async function searchPiped(base, q) {
  const d = await fetchJSON(`${base}/search?filter=videos&q=${encodeURIComponent(q)}`);
  return (d.items || []).filter(v => v.url?.includes('watch')).map(v => ({
    id: new URL(v.url, 'https://x.y').searchParams.get('v'), title: v.title, author: v.uploaderName, seconds: v.duration || 0
  }));
}
function decodeEntities(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }

async function rawSearch(q) {
  if (settings.ytKey) {
    try { return await searchViaKey(q); } catch (e) { console.warn('YT key search failed', e); }
  }
  const inst = await loadInstances();
  const tries = [];
  if (settings.customInstance) tries.push(['inv', settings.customInstance.replace(/\/$/, '')]);
  // Spread load: shuffle top instances a little
  const pick = arr => arr.filter(healthy).slice(0, 8).sort(() => Math.random() - 0.5);
  for (const u of pick(inst.inv)) tries.push(['inv', u]);
  for (const u of pick(inst.piped)) tries.push(['piped', u]);
  for (const [kind, base] of tries) {
    try {
      const r = kind === 'inv' ? await searchInvidious(base, q) : await searchPiped(base, q);
      if (r.length) return r;
    } catch { bad.set(base, Date.now()); }
  }
  throw new Error('No YouTube search source is reachable right now. Add your own free YouTube API key in Settings, or paste a link manually.');
}

// Score a result for "video" (official music video) or "audio" (Topic channel / official audio)
function score(r, t, mode) {
  const title = norm(r.title), author = String(r.author || '').toLowerCase();
  const nt = norm(t.title), na = norm(mainArtist(t.artist));
  let s = 0;
  if (title.includes(nt)) s += 6;
  if (title.includes(na) || norm(author).includes(na)) s += 4;
  const isTopic = author.endsWith(' - topic');
  const vevo = author.includes('vevo');
  const raw = String(r.title).toLowerCase();
  if (mode === 'audio') {
    if (isTopic) s += 8;
    if (/official audio|\baudio\b/.test(raw)) s += 5;
    if (/lyric/.test(raw)) s += 1;
    if (/music video|official video/.test(raw)) s -= 2;
  } else {
    if (/official (music )?video|music video/.test(raw)) s += 7;
    if (vevo || norm(author) === na) s += 3;
    if (isTopic) s -= 4;
    if (/lyric|audio/.test(raw)) s -= 2;
  }
  if (/\b(cover|karaoke|instrumental|reaction|8d|slowed|sped up|nightcore|remix|live)\b/.test(raw) && !/(remix|live)/.test(norm(t.title))) s -= 6;
  if (t.durationMs && r.seconds) {
    const diff = Math.abs(r.seconds - t.durationMs / 1000);
    if (diff < 5) s += 3; else if (diff > 90 && mode === 'audio') s -= 3;
    if (r.seconds > 1200) s -= 5;
  }
  return s;
}

async function findForTrack(t, { force = false } = {}) {
  const key = t.id;
  if (!force) {
    const c = await db.get('ytcache', key);
    if (c && (c.video || c.audio)) return c;
  }
  const base = `${mainArtist(t.artist)} ${t.title}`;
  const out = { video: null, audio: null, videoTitle: '', audioTitle: '', checkedAt: Date.now() };
  const pool = new Map();
  for (const q of [`${base} official music video`, `${base} official audio`]) {
    try { for (const r of await rawSearch(q)) if (r.id && !pool.has(r.id)) pool.set(r.id, r); }
    catch (e) { if (!pool.size) throw e; }
    await sleep(150);
  }
  const list = [...pool.values()];
  const best = mode => list.map(r => [score(r, t, mode), r]).sort((a, b) => b[0] - a[0])[0];
  const v = best('video'), a = best('audio');
  if (v && v[0] >= 8) { out.video = v[1].id; out.videoTitle = v[1].title; }
  if (a && a[0] >= 8) { out.audio = a[1].id; out.audioTitle = a[1].title; }
  if (out.audio === out.video && out.audio) {
    // Same upload won both: look for a distinct second best for the other mode
    const alt = list.filter(r => r.id !== out.video).map(r => [score(r, t, 'audio'), r]).sort((x, y) => y[0] - x[0])[0];
    if (alt && alt[0] >= 8) { out.audio = alt[1].id; out.audioTitle = alt[1].title; }
  }
  if (!out.video && !out.audio && list[0]) { out.audio = list[0].id; out.audioTitle = list[0].title; out.guess = true; }
  await db.put('ytcache', out, key);
  return out;
}

async function setManual(trackId, mode, id, title = '') {
  const c = (await db.get('ytcache', trackId)) || {};
  c[mode] = id; c[mode + 'Title'] = title || 'Set manually'; c.manual = true; c.checkedAt = Date.now();
  await db.put('ytcache', c, trackId);
  return c;
}

function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1, 12);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(embed|shorts|live)\/([\w-]{11})/);
    if (m) return m[2];
  } catch { }
  return null;
}

// Build "untitled playlist" links that open straight on YouTube (50 videos per link)
function youtubePlaylistLinks(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    out.push('https://www.youtube.com/watch_videos?video_ids=' + ids.slice(i, i + 50).join(','));
  }
  return out;
}

return { setYTSettings, rawSearch, findForTrack, setManual, parseYouTubeId, youtubePlaylistLinks };
})();
// ---------- spotify.js ----------
const __m_spotify = (() => {
// Spotify import (Liked Songs + playlists). Runs 100% in the browser using
// OAuth PKCE with the user's OWN free Spotify developer Client ID, so there is
// no shared server and no shared request limit. Tokens stay on the device.
const { kv } = __m_db;
const { trackKey, albumKey, yearOf, sleep } = __m_util;

const SCOPES = 'user-library-read playlist-read-private playlist-read-collaborative';
const redirectUri = () => location.origin + location.pathname;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function login(clientId) {
  if (!location.protocol.startsWith('http')) throw new Error('Spotify login only works on the hosted (GitHub Pages) version of BAZINGA.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('bz_sp_verifier', verifier);
  sessionStorage.setItem('bz_sp_state', state);
  await kv.set('spotifyClientId', clientId);
  const p = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state
  });
  location.href = 'https://accounts.spotify.com/authorize?' + p;
}

// Call on startup: completes the login if we just came back from Spotify.
async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.get('code') && !q.get('error')) return false;
  const clean = () => history.replaceState(null, '', redirectUri() + location.hash);
  if (q.get('error')) { clean(); throw new Error('Spotify login was cancelled.'); }
  if (q.get('state') !== sessionStorage.getItem('bz_sp_state')) { clean(); throw new Error('Spotify login expired — please try again.'); }
  const clientId = await kv.get('spotifyClientId');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, grant_type: 'authorization_code', code: q.get('code'),
      redirect_uri: redirectUri(), code_verifier: sessionStorage.getItem('bz_sp_verifier')
    })
  });
  clean();
  if (!r.ok) throw new Error('Spotify login failed (' + r.status + '). Check the Redirect URI in your Spotify app.');
  await saveToken(await r.json());
  return true;
}

async function saveToken(t) {
  const prev = (await kv.get('spotifyToken')) || {};
  await kv.set('spotifyToken', {
    access: t.access_token, refresh: t.refresh_token || prev.refresh,
    expires: Date.now() + (t.expires_in - 60) * 1000
  });
}

async function token() {
  const t = await kv.get('spotifyToken');
  if (!t) throw new Error('Not connected to Spotify.');
  if (Date.now() < t.expires) return t.access;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: await kv.get('spotifyClientId') })
  });
  if (!r.ok) { await kv.del('spotifyToken'); throw new Error('Spotify session expired — reconnect.'); }
  await saveToken(await r.json());
  return (await kv.get('spotifyToken')).access;
}

const isConnected = async () => !!(await kv.get('spotifyToken'));
const disconnect = () => kv.del('spotifyToken');

async function api(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url.startsWith('http') ? url : 'https://api.spotify.com/v1' + url, {
      headers: { Authorization: 'Bearer ' + await token() }
    });
    if (r.status === 429) { await sleep((+r.headers.get('Retry-After') || 2) * 1000); continue; }
    if (!r.ok) { const e = new Error('Spotify ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  throw new Error('Spotify is rate-limiting — try again in a minute.');
}

// Follow `next` links, trying a big page size first and smaller ones if Spotify refuses.
async function paged(path, onPage) {
  let out = [];
  for (const limit of [50, 20, 10]) {
    try {
      let url = path + (path.includes('?') ? '&' : '?') + 'limit=' + limit;
      out = [];
      while (url) {
        const d = await api(url);
        out.push(...(d.items || []));
        onPage?.(out.length, d.total);
        url = d.next;
      }
      return out;
    } catch (e) { if (e.status !== 400) throw e; }
  }
  return out;
}

function toTrack(t, addedAt) {
  if (!t || t.type === 'episode' || !t.name) return null;
  const artists = (t.artists || []).map(a => a.name);
  const artist = artists.join(', ');
  const al = t.album || {};
  return {
    id: trackKey(artist, t.name),
    title: t.name, artist, artists,
    album: al.name || '',
    albumId: al.name ? albumKey((al.artists?.[0]?.name) || artists[0], al.name) : '',
    spotifyId: t.id || null, spotifyAlbumId: al.id || null,
    releaseDate: al.release_date || '', year: yearOf(al.release_date),
    durationMs: t.duration_ms || 0,
    artwork: al.images?.[0]?.url || '',
    explicit: !!t.explicit,
    trackNumber: t.track_number || 0,
    addedAt: addedAt ? Date.parse(addedAt) : Date.now()
  };
}

async function likedSongs(onProgress) {
  const items = await paged('/me/tracks', onProgress);
  return items.map(i => toTrack(i.track || i.item, i.added_at)).filter(Boolean);
}

async function playlists() {
  const items = await paged('/me/playlists');
  return items.filter(Boolean).map(p => ({
    spotifyId: p.id, name: p.name, image: p.images?.[0]?.url || '',
    total: (p.items || p.tracks)?.total ?? null, owner: p.owner?.display_name || ''
  }));
}

async function playlistTracks(id, onProgress) {
  let items;
  try { items = await paged(`/playlists/${id}/items`, onProgress); }
  catch (e) {
    if (e.status === 404 || e.status === 403) items = await paged(`/playlists/${id}/tracks`, onProgress);
    else throw e;
  }
  return items.map(i => toTrack(i.item || i.track, i.added_at)).filter(Boolean);
}

return { redirectUri, login, handleRedirect, isConnected, disconnect, toTrack, likedSongs, playlists, playlistTracks };
})();
// ---------- importers.js ----------
const __m_importers = (() => {
// Importers that need no account at all: CSV exports (e.g. Exportify), pasted
// text lists, and music files already on the device (read their tags).
const { trackKey, albumKey, yearOf } = __m_util;

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

function tracksFromCSV(text) {
  const rows = parseCSV(text.replace(/^﻿/, ''));
  if (rows.length < 2) return [];
  const h = rows[0].map(x => x.trim().toLowerCase());
  const col = (...names) => h.findIndex(x => names.some(n => x === n || x.includes(n)));
  const ci = {
    title: col('track name', 'title', 'song', 'name'),
    artist: col('artist name', 'artist'),
    album: col('album name', 'album'),
    date: col('release date', 'album release date', 'year'),
    dur: col('duration (ms)', 'duration'),
    genre: col('genres', 'genre'),
    added: col('added at', 'date added'),
    uri: col('track uri', 'spotify uri', 'uri')
  };
  if (ci.title < 0 || ci.artist < 0) throw new Error('CSV needs at least a track/title column and an artist column.');
  return rows.slice(1).map(r => {
    const title = (r[ci.title] || '').trim(), artist = (r[ci.artist] || '').replace(/\\,/g, ',').trim();
    if (!title || !artist) return null;
    const album = ci.album >= 0 ? r[ci.album]?.trim() : '';
    let dur = ci.dur >= 0 ? r[ci.dur] : '';
    let durationMs = 0;
    if (/^\d+$/.test(dur)) durationMs = +dur > 10000 ? +dur : +dur * 1000;
    else if (/^\d+:\d\d$/.test(dur)) { const [m, s] = dur.split(':'); durationMs = (+m * 60 + +s) * 1000; }
    const genre = ci.genre >= 0 ? (r[ci.genre] || '').split(',')[0].trim() : '';
    const releaseDate = ci.date >= 0 ? (r[ci.date] || '').trim() : '';
    const uri = ci.uri >= 0 ? r[ci.uri] || '' : '';
    return {
      id: trackKey(artist, title), title, artist, artists: artist.split(/\s*,\s*/),
      album, albumId: album ? albumKey(artist, album) : '',
      releaseDate, year: yearOf(releaseDate), durationMs,
      genre: genre ? genre.replace(/\b\w/g, c => c.toUpperCase()) : '',
      spotifyId: uri.startsWith('spotify:track:') ? uri.split(':')[2] : null,
      addedAt: ci.added >= 0 && Date.parse(r[ci.added]) ? Date.parse(r[ci.added]) : Date.now()
    };
  }).filter(Boolean);
}

// "Artist - Title", "Title by Artist", or "Artist – Title" one per line
function tracksFromText(text) {
  return text.split(/\r?\n/).map(l => l.replace(/^\s*\d+[\.\)]\s*/, '').trim()).filter(Boolean).map(l => {
    let artist, title, m;
    if ((m = l.match(/^(.+?)\s+[-–—]\s+(.+)$/))) { artist = m[1]; title = m[2]; }
    else if ((m = l.match(/^(.+?)\s+by\s+(.+)$/i))) { title = m[1]; artist = m[2]; }
    else return null;
    return { id: trackKey(artist, title), title: title.trim(), artist: artist.trim(), artists: [artist.trim()], addedAt: Date.now() };
  }).filter(Boolean);
}

// ---- Minimal ID3v2 / filename tag reader for local music files ----
function readSyncsafe(b, o) { return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]; }
function decodeText(bytes) {
  const enc = bytes[0]; const body = bytes.subarray(1);
  let s;
  if (enc === 1 || enc === 2) s = new TextDecoder(enc === 2 ? 'utf-16be' : 'utf-16').decode(body);
  else if (enc === 3) s = new TextDecoder('utf-8').decode(body);
  else s = new TextDecoder('latin1').decode(body);
  return s.replace(/\0+$/g, '').split('\0')[0].trim();
}
async function readID3(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (String.fromCharCode(...head.subarray(0, 3)) !== 'ID3') return {};
  const ver = head[3];
  const size = readSyncsafe(head, 6);
  const b = new Uint8Array(await file.slice(10, 10 + Math.min(size, 2_000_000)).arrayBuffer());
  const tags = {}; let o = 0;
  const map = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TYER: 'year', TDRC: 'year', TCON: 'genre', TRCK: 'track', TPE2: 'albumArtist' };
  while (o + 10 < b.length) {
    const id = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsz = ver === 4 ? readSyncsafe(b, o + 4) : (b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7];
    if (fsz <= 0 || o + 10 + fsz > b.length) break;
    const data = b.subarray(o + 10, o + 10 + fsz);
    if (map[id]) tags[map[id]] = decodeText(data);
    if (id === 'APIC' && !tags.picture) {
      try {
        let p = 1; while (data[p]) p++; const mime = new TextDecoder('latin1').decode(data.subarray(1, p)) || 'image/jpeg';
        p += 2; // picture type
        if (data[0] === 1 || data[0] === 2) { while (p < data.length - 1 && !(data[p] === 0 && data[p + 1] === 0)) p += 2; p += 2; }
        else { while (data[p]) p++; p++; }
        tags.picture = new Blob([data.subarray(p)], { type: mime });
      } catch { }
    }
    o += 10 + fsz;
  }
  if (tags.genre) tags.genre = tags.genre.replace(/^\(\d+\)/, '').trim();
  return tags;
}

async function readLocalFile(file) {
  let tags = {};
  try { tags = await readID3(file); } catch { }
  const base = file.name.replace(/\.[^.]+$/, '').replace(/^\d+[\s.\-_]+/, '');
  let artist = tags.artist, title = tags.title;
  if (!artist || !title) {
    const m = base.match(/^(.+?)\s+-\s+(.+)$/);
    if (m) { artist = artist || m[1]; title = title || m[2]; }
    else { title = title || base; artist = artist || (file.webkitRelativePath?.split('/').slice(-3, -2)[0]) || 'Unknown Artist'; }
  }
  return {
    artist: artist.trim(), title: title.trim(), album: tags.album || '', albumArtist: tags.albumArtist || '',
    year: yearOf(tags.year), genre: tags.genre || '', trackNumber: parseInt(tags.track) || 0, picture: tags.picture || null
  };
}

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|mp4)$/i;

// ---------- Apple Music / iTunes exports ----------
// Music app (Mac) or Apple Music / iTunes (Windows):
//   File → Library → Export Playlist…  → "Plain Text" (.txt, UTF-16, tab separated)
//   File → Library → Export Library…   → .xml (every playlist + Loved songs)
async function readTextSmart(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  // UTF-16 without BOM: lots of zero bytes
  let zeros = 0; for (let i = 1; i < Math.min(buf.length, 400); i += 2) if (buf[i] === 0) zeros++;
  if (zeros > 100) return new TextDecoder('utf-16le').decode(buf);
  return new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
}

function appleTrack(o) {
  const title = (o.title || '').trim(), artist = (o.artist || '').trim();
  if (!title || !artist) return null;
  const year = parseInt(o.year) || null;
  return {
    id: trackKey(artist, title), title, artist, artists: artist.split(/\s*(?:,|&)\s*/).filter(Boolean),
    album: (o.album || '').trim(), albumId: o.album ? albumKey(o.albumArtist || artist, o.album) : '',
    genre: (o.genre || '').trim(), year, releaseDate: o.releaseDate || (year ? String(year) : ''),
    durationMs: o.durationMs || 0, trackNumber: parseInt(o.trackNumber) || 0,
    addedAt: o.added && Date.parse(o.added) ? Date.parse(o.added) : Date.now()
  };
}

// Plain-text playlist export (tab separated, first row = headers)
function tracksFromAppleTxt(text) {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const h = lines[0].split('\t').map(x => x.trim().toLowerCase());
  const ix = n => h.indexOf(n);
  const c = { name: ix('name'), artist: ix('artist'), album: ix('album'), genre: ix('genre'), year: ix('year'), time: ix('time'), track: ix('track number'), added: ix('date added'), albumArtist: ix('album artist') };
  if (c.name < 0 || c.artist < 0) throw new Error('This doesn\'t look like an Apple Music playlist export (needs Name and Artist columns).');
  return lines.slice(1).map(l => {
    const r = l.split('\t');
    const t = +r[c.time];
    return appleTrack({
      title: r[c.name], artist: r[c.artist], album: r[c.album], genre: r[c.genre], year: r[c.year],
      durationMs: isFinite(t) && t > 0 ? (t > 20000 ? t : t * 1000) : 0, trackNumber: r[c.track], added: r[c.added],
      albumArtist: c.albumArtist >= 0 ? r[c.albumArtist] : ''
    });
  }).filter(Boolean);
}

// Full library export (XML property list)
function fromAppleXML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Couldn\'t read that XML file.');
  const val = el => {
    if (!el) return null;
    switch (el.tagName) {
      case 'dict': { const o = {}; const k = [...el.children]; for (let i = 0; i < k.length; i += 2) o[k[i].textContent] = val(k[i + 1]); return o; }
      case 'array': return [...el.children].map(val);
      case 'integer': case 'real': return +el.textContent;
      case 'true': return true; case 'false': return false;
      case 'data': return null;
      default: return el.textContent;
    }
  };
  const root = val(doc.querySelector('plist > dict'));
  if (!root?.Tracks) throw new Error('This doesn\'t look like an Apple Music library export.');
  const byId = new Map(), loved = [];
  for (const [tid, o] of Object.entries(root.Tracks)) {
    if (o['Has Video'] || o['Movie'] || o['TV Show'] || o['Podcast'] || o['Music Video']) continue;
    const t = appleTrack({
      title: o.Name, artist: o.Artist || o['Album Artist'], album: o.Album, albumArtist: o['Album Artist'], genre: o.Genre, year: o.Year,
      releaseDate: o['Release Date'] ? String(o['Release Date']).slice(0, 10) : '', durationMs: o['Total Time'] || 0,
      trackNumber: o['Track Number'], added: o['Date Added']
    });
    if (!t) continue;
    byId.set(String(tid), t);
    if (o.Loved || o.Favorited) loved.push(t.id);
  }
  const SKIP = /^(Library|Music|Movies|TV Shows|Podcasts|Audiobooks|Downloaded|Purchased|Genius|Recently (Added|Played)|Top 25 Most Played)$/i;
  const playlists = (root.Playlists || []).filter(p => !p.Master && !p['Distinguished Kind'] && !p.Folder && !SKIP.test(p.Name || '') && p['Playlist Items']?.length)
    .map(p => ({ name: p.Name, smart: !!p['Smart Info'], trackIds: [...new Set(p['Playlist Items'].map(i => byId.get(String(i['Track ID']))?.id).filter(Boolean))] }))
    .filter(p => p.trackIds.length);
  return { tracks: [...byId.values()], playlists, loved };
}

return { parseCSV, tracksFromCSV, tracksFromText, readLocalFile, AUDIO_EXT, readTextSmart, tracksFromAppleTxt, fromAppleXML };
})();
// ---------- player.js ----------
const __m_player = (() => {
// Playback engine: YouTube (music video or audio upload) or an offline file on the device.
const { db, kv } = __m_db;
const { lib } = __m_store;
const yt = __m_youtube;
const { emit, toast, debounce } = __m_util;

const P = {
  queue: [],          // [{id, user}]
  cursor: -1,
  mode: 'audio',      // 'video' | 'audio'
  preferOffline: true,
  shuffle: false,
  repeat: 'off',      // off | all | one
  playing: false,
  loading: false,
  source: null,       // 'yt' | 'local'
  ytId: null,
  time: 0, duration: 0,
  volume: 0.9,
  error: ''
};

const audio = new Audio();
audio.preload = 'auto';
let ytPlayer = null, ytReady = null, tick = null, objUrl = null, loadToken = 0;

const changed = () => emit('player', P);
const persist = debounce(() => kv.set('player', {
  queue: P.queue, cursor: P.cursor, mode: P.mode, shuffle: P.shuffle, repeat: P.repeat, volume: P.volume, preferOffline: P.preferOffline
}), 500);

const current = () => (P.cursor >= 0 && P.queue[P.cursor]) ? lib.tracks.get(P.queue[P.cursor].id) : null;

async function restore() {
  const s = await kv.get('player');
  if (s) Object.assign(P, s, { playing: false });
  P.queue = P.queue.filter(q => lib.tracks.has(q.id));
  if (P.cursor >= P.queue.length) P.cursor = P.queue.length - 1;
  audio.volume = P.volume;
  changed();
}

// ---------- YouTube IFrame player ----------
function loadYT() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => {
      ytPlayer = new YT.Player('yt-player', {
        width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, ...(location.protocol.startsWith('http') ? { origin: location.origin } : {}) },
        events: {
          onReady: () => { ytPlayer.setVolume(P.volume * 100); resolve(ytPlayer); },
          onStateChange: e => {
            if (P.source !== 'yt') return;
            if (e.data === YT.PlayerState.PLAYING) { P.playing = true; P.loading = false; changed(); }
            else if (e.data === YT.PlayerState.PAUSED) { P.playing = false; changed(); }
            else if (e.data === YT.PlayerState.ENDED) ended();
            else if (e.data === YT.PlayerState.BUFFERING) { P.loading = true; changed(); }
          },
          onError: e => ytError(e.data)
        }
      });
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytReady = null; reject(new Error('Could not load YouTube player (offline?)')); };
    document.head.appendChild(s);
  });
  return ytReady;
}

let ytRetried = false;
async function ytError(code) {
  const t = current(); if (!t) return;
  // 101/150 = embedding disabled by owner; try the other version, then re-search once
  const c = await db.get('ytcache', t.id) || {};
  const other = P.mode === 'video' ? 'audio' : 'video';
  if (c[other] && c[other] !== P.ytId) { toast('That upload can\'t be embedded — using the ' + other + ' version'); return startYT(c[other]); }
  if (!ytRetried) {
    ytRetried = true;
    try { const n = await yt.findForTrack(t, { force: true }); const id = n[P.mode] || n[other]; if (id && id !== P.ytId) return startYT(id); } catch { }
  }
  P.error = 'YouTube won\'t play this one here (code ' + code + '). Set a different link from the ⋯ menu.';
  P.loading = false; changed();
  setTimeout(() => { if (P.error) next(); }, 2500);
}

function startTick() {
  clearInterval(tick);
  tick = setInterval(() => {
    if (P.source === 'yt' && ytPlayer?.getCurrentTime) {
      P.time = ytPlayer.getCurrentTime() || 0;
      P.duration = ytPlayer.getDuration() || P.duration;
    } else if (P.source === 'local') {
      P.time = audio.currentTime; P.duration = audio.duration || P.duration;
    }
    emit('time', P);
    updatePositionState();
  }, 500);
}

async function startYT(id) {
  P.source = 'yt'; P.ytId = id; P.loading = true; changed();
  const pl = await loadYT();
  pl.loadVideoById(id);
  pl.setVolume(P.volume * 100);
  emit('video-visible', true);
}

// ---------- Core ----------
async function load(autoplay = true) {
  const my = ++loadToken;
  const t = current();
  audio.pause();
  try { ytPlayer?.pauseVideo?.(); } catch { }
  P.error = ''; P.time = 0; P.duration = (t?.durationMs || 0) / 1000; ytRetried = false;
  if (!t) { P.playing = false; P.source = null; changed(); return; }
  P.loading = true; changed();
  setMediaSession(t);
  persist();

  // Offline file first (if user prefers it or we're offline)
  if (t.localFileId && (P.preferOffline || !navigator.onLine)) {
    const f = await db.get('files', t.localFileId);
    if (my !== loadToken) return;
    if (f?.blob) {
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = URL.createObjectURL(f.blob);
      P.source = 'local'; P.ytId = null;
      emit('video-visible', false);
      audio.src = objUrl;
      if (autoplay) audio.play().catch(() => { P.playing = false; changed(); });
      P.loading = false; changed(); startTick();
      return;
    }
  }
  if (!navigator.onLine) {
    P.error = 'You\'re offline and this song has no offline file. Skipping…'; P.loading = false; changed();
    setTimeout(() => my === loadToken && next(), 1500); return;
  }
  try {
    const c = await yt.findForTrack(t);
    if (my !== loadToken) return;
    const id = c[P.mode] || c[P.mode === 'video' ? 'audio' : 'video'];
    if (!id) throw new Error('No YouTube match found for this song. Use ⋯ → "Set YouTube link".');
    if (!c[P.mode]) toast(`No ${P.mode === 'video' ? 'music video' : 'audio upload'} found — playing the other version`);
    await startYT(id);
    if (!autoplay) ytPlayer.pauseVideo();
    startTick();
  } catch (e) {
    if (my !== loadToken) return;
    P.error = e.message; P.loading = false; P.playing = false; changed();
  }
}

function ended() {
  if (P.repeat === 'one') { seek(0); play(); return; }
  next(true);
}
audio.addEventListener('ended', () => P.source === 'local' && ended());
audio.addEventListener('play', () => { P.playing = true; changed(); });
audio.addEventListener('pause', () => { P.playing = false; changed(); });
audio.addEventListener('error', () => { if (P.source === 'local') { P.error = 'Could not play the offline file.'; changed(); } });

function play() {
  if (!current()) return;
  if (P.source === 'local') audio.play();
  else if (P.source === 'yt' && ytPlayer) ytPlayer.playVideo();
  else load(true);
}
function pause() {
  if (P.source === 'local') audio.pause();
  else if (ytPlayer?.pauseVideo) ytPlayer.pauseVideo();
  P.playing = false; changed();
}
const toggle = () => P.playing ? pause() : play();

function seek(sec) {
  if (P.source === 'local') audio.currentTime = sec;
  else ytPlayer?.seekTo?.(sec, true);
  P.time = sec; emit('time', P);
}

function next(auto = false) {
  if (!P.queue.length) return;
  if (P.cursor < P.queue.length - 1) P.cursor++;
  else if (P.repeat === 'all') P.cursor = 0;
  else { if (auto) { P.playing = false; changed(); } return; }
  load(true);
}
function prev() {
  if (P.time > 4) return seek(0);
  if (P.cursor > 0) { P.cursor--; load(true); }
  else seek(0);
}

// Replace the queue with a list and start at `start`
function playList(ids, start = 0, { shuffle = P.shuffle } = {}) {
  ids = ids.filter(id => lib.tracks.has(id));
  if (!ids.length) return toast('Nothing to play');
  let list = ids.map(id => ({ id, user: false }));
  if (shuffle) {
    const first = list.splice(start, 1)[0];
    list.sort(() => Math.random() - 0.5);
    list.unshift(first); start = 0;
  }
  P.queue = list; P.cursor = start; P.shuffle = shuffle;
  load(true);
}

// Add to the end of the "up next" user section (after the current song and any user-queued songs)
function addToQueue(ids, playNext = false) {
  ids = [].concat(ids).filter(id => lib.tracks.has(id));
  if (!ids.length) return;
  const items = ids.map(id => ({ id, user: true }));
  if (P.cursor < 0) { P.queue = items; P.cursor = 0; load(true); return; }
  let at = P.cursor + 1;
  if (!playNext) while (at < P.queue.length && P.queue[at].user) at++;
  P.queue.splice(at, 0, ...items);
  persist(); changed();
  toast(ids.length === 1 ? (playNext ? 'Playing next' : 'Added to queue') : `${ids.length} songs added to queue`);
}
function removeFromQueue(i) {
  if (i === P.cursor) return;
  P.queue.splice(i, 1);
  if (i < P.cursor) P.cursor--;
  persist(); changed();
}
function moveInQueue(from, to) {
  if (from === to) return;
  const [it] = P.queue.splice(from, 1);
  P.queue.splice(to, 0, it);
  if (P.cursor === from) P.cursor = to;
  else if (from < P.cursor && to >= P.cursor) P.cursor--;
  else if (from > P.cursor && to <= P.cursor) P.cursor++;
  persist(); changed();
}
function jumpTo(i) { P.cursor = i; load(true); }
function clearQueue() { P.queue = P.queue.slice(0, P.cursor + 1); persist(); changed(); }
function clearUserQueue() { P.queue = P.queue.filter((q, i) => i <= P.cursor || !q.user); persist(); changed(); }

function setShuffle(v) {
  P.shuffle = v;
  if (v && P.cursor >= 0) {
    const rest = P.queue.slice(P.cursor + 1).sort(() => Math.random() - 0.5);
    P.queue = [...P.queue.slice(0, P.cursor + 1), ...rest];
  }
  persist(); changed();
}
function cycleRepeat() { P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat]; persist(); changed(); }
function setVolume(v) { P.volume = v; audio.volume = v; ytPlayer?.setVolume?.(v * 100); persist(); changed(); }

// Switch between music video and audio-only version, keeping position
async function setMode(mode) {
  if (mode === P.mode) return;
  P.mode = mode; persist(); changed();
  const t = current();
  if (t && P.source === 'yt') {
    const at = P.time, wasPlaying = P.playing;
    const c = await yt.findForTrack(t);
    const id = c[mode];
    if (!id) { toast(`No ${mode === 'video' ? 'music video' : 'audio version'} found for this song`); return; }
    await startYT(id);
    setTimeout(() => { ytPlayer.seekTo(Math.min(at, (ytPlayer.getDuration() || 9999) - 2), true); if (!wasPlaying) ytPlayer.pauseVideo(); }, 900);
  }
}
function setPreferOffline(v) { P.preferOffline = v; persist(); }
const reloadCurrent = () => load(true);

// ---------- Lock screen / media keys ----------
function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album || '',
    artwork: t.artwork ? [{ src: t.artwork, sizes: '600x600', type: 'image/jpeg' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
  });
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', play);
  ms.setActionHandler('pause', pause);
  ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('nexttrack', () => next());
  try { ms.setActionHandler('seekto', d => seek(d.seekTime)); } catch { }
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !P.duration) return;
  try { navigator.mediaSession.setPositionState({ duration: P.duration, position: Math.min(P.time, P.duration), playbackRate: 1 }); } catch { }
}

// Stop everything (used when deleting the account)
function stopAll() {
  loadToken++; audio.pause(); audio.removeAttribute('src');
  try { ytPlayer?.stopVideo?.(); } catch { }
  P.queue = []; P.cursor = -1; P.playing = false; changed();
}

return { P, current, restore, play, pause, toggle, seek, next, prev, playList, addToQueue, removeFromQueue, moveInQueue, jumpTo, clearQueue, clearUserQueue, setShuffle, cycleRepeat, setVolume, setMode, setPreferOffline, reloadCurrent, stopAll };
})();
// ---------- backup.js ----------
const __m_backup = (() => {
// Auto-updating backups, all on the user's own device:
//  • Rolling snapshots inside the app's storage (last 5) — instant undo for mistakes.
//  • A linked backup FILE on the device (Chrome/Edge desktop): rewritten automatically on every change,
//    so it survives even if the browser's data is wiped.
//  • One-tap download / restore of a .json backup file on every browser.
const { db, kv } = __m_db;
const { debounce, emit, downloadBlob, on, toast } = __m_util;

const KEEP = 5;
const fsSupported = 'showSaveFilePicker' in window;

async function snapshot() {
  const [tracks, albums, playlists] = await Promise.all([db.all('tracks'), db.all('albums'), db.all('playlists')]);
  const ytKeys = await db.keys('ytcache');
  const ytVals = await db.all('ytcache');
  return {
    app: 'BAZINGA', version: 1, createdAt: new Date().toISOString(),
    profile: await kv.get('profile'),
    settings: await kv.get('settings'),
    player: await kv.get('player'),
    tracks: tracks.map(t => ({ ...t, localFileId: undefined, hadLocalFile: !!t.localFileId || t.hadLocalFile })),
    albums, playlists,
    ytcache: ytKeys.map((k, i) => [k, ytVals[i]])
  };
}

async function restore(data) {
  if (!data || data.app !== 'BAZINGA') throw new Error('That isn\'t a BAZINGA backup file.');
  // Keep links to offline files that still exist on this device
  const existing = new Map((await db.all('tracks')).filter(t => t.localFileId).map(t => [t.id, t.localFileId]));
  for (const s of ['tracks', 'albums', 'playlists', 'ytcache']) await db.clear(s);
  await db.putMany('tracks', (data.tracks || []).map(t => {
    const x = { ...t }; delete x.localFileId;
    if (existing.has(t.id)) x.localFileId = existing.get(t.id);
    return x;
  }));
  await db.putMany('albums', data.albums || []);
  await db.putMany('playlists', data.playlists || []);
  for (const [k, v] of data.ytcache || []) await db.put('ytcache', v, k);
  if (data.profile) await kv.set('profile', data.profile);
  if (data.settings) await kv.set('settings', data.settings);
  if (data.player) await kv.set('player', data.player);
}

async function writeInternal(snap) {
  const id = 'bk_' + Date.now();
  await db.put('backups', { id, ts: Date.now(), size: JSON.stringify(snap).length, counts: { tracks: snap.tracks.length, playlists: snap.playlists.length, albums: snap.albums.length }, data: snap });
  const all = (await db.all('backups')).sort((a, b) => b.ts - a.ts);
  for (const old of all.slice(KEEP)) await db.del('backups', old.id);
}

let fileState = 'none'; // none | ok | needs-permission | error
const linkedFileState = () => fileState;

async function writeFile(snap) {
  const h = await kv.get('backupHandle');
  if (!h) { fileState = 'none'; return; }
  const perm = await h.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') { fileState = 'needs-permission'; emit('backup-state'); return; }
  try {
    const w = await h.createWritable();
    await w.write(JSON.stringify(snap));
    await w.close();
    fileState = 'ok';
  } catch (e) { fileState = 'error'; console.warn(e); }
}

async function runBackup() {
  const profile = await kv.get('profile');
  if (!profile) return; // no account yet
  const snap = await snapshot();
  await writeInternal(snap);
  if (fsSupported) await writeFile(snap);
  await kv.set('lastBackup', Date.now());
  emit('backup-state');
}

const scheduled = debounce(runBackup, 4000);
function startAuto() {
  on('dirty', scheduled);
  // Also back up when the app is hidden/closed so nothing is lost
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') runBackup(); });
  // Check linked file permission on start
  kv.get('backupHandle').then(async h => {
    if (!h) return;
    fileState = (await h.queryPermission({ mode: 'readwrite' })) === 'granted' ? 'ok' : 'needs-permission';
    emit('backup-state');
  });
}

async function linkFile() {
  const h = await window.showSaveFilePicker({
    suggestedName: 'BAZINGA-backup.json',
    types: [{ description: 'BAZINGA backup', accept: { 'application/json': ['.json'] } }]
  });
  await kv.set('backupHandle', h);
  fileState = 'ok';
  await runBackup();
  toast('Auto-backup file linked — it updates itself on every change');
}
async function regrant() {
  const h = await kv.get('backupHandle'); if (!h) return;
  if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') { fileState = 'ok'; await runBackup(); toast('Auto-backup resumed'); }
}
async function unlinkFile() { await kv.del('backupHandle'); fileState = 'none'; emit('backup-state'); }

async function download() {
  const snap = await snapshot();
  const d = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([JSON.stringify(snap)], { type: 'application/json' }), `BAZINGA-backup-${d}.json`);
  await kv.set('lastDownload', Date.now());
  emit('backup-state');
}

const listInternal = async () => (await db.all('backups')).sort((a, b) => b.ts - a.ts);
async function restoreInternal(id) { const b = await db.get('backups', id); if (b) await restore(b.data); }
async function restoreFromFile(file) { await restore(JSON.parse(await file.text())); }

return { fsSupported, snapshot, restore, linkedFileState, runBackup, startAuto, linkFile, regrant, unlinkFile, download, listInternal, restoreInternal, restoreFromFile };
})();
// ---------- legal.js ----------
const __m_legal = (() => {
// Privacy Policy & Terms of Use. Bump TERMS_VERSION whenever the text changes —
// every user will then be asked to accept again.
const TERMS_VERSION = '2026-10-22';
const OWNER = 'Abbel Dawit';

const LEGAL_HTML = `
<p class="tiny muted">Last updated: 22 October 2026 · Version ${TERMS_VERSION}</p>

<h3>Terms of Use</h3>
<p>BAZINGA! ("the App") is a free, personal project made available by ${OWNER} ("we", "us"). By creating a profile or otherwise using the App you agree to these Terms and the Privacy Policy below. If you do not agree, do not use the App.</p>

<h4>1. What the App is</h4>
<p>The App is a tool that runs entirely in your web browser. It helps you organise music you already have access to, look up matching videos on YouTube, and play them through YouTube's official embedded player or from files stored on your own device. The App does not host, sell, stream from its own servers, or distribute any music or video.</p>

<h4>2. Not affiliated</h4>
<p>The App is independent and is not affiliated with, endorsed by or sponsored by Spotify, YouTube, Google, Apple, or any artist, label or rights holder. All trademarks, names and artwork belong to their respective owners.</p>

<h4>3. Your responsibilities</h4>
<ul>
<li>You must be at least 13 years old (or the minimum age required where you live) to use the App.</li>
<li>You are solely responsible for how you use the App and for any content you import, add, play or share, including making sure you have the right to use any music files you add to the App.</li>
<li>You must follow the terms of every third-party service you use through the App, including YouTube's Terms of Service, Spotify's Developer and User Terms, and Apple's terms.</li>
<li>You must not use the App for anything unlawful, to infringe anyone's rights, or to attempt to download or copy content from YouTube or other services.</li>
<li>You are responsible for keeping your own backups. Data stored in a browser can be lost (for example if browser data is cleared or a device is lost).</li>
</ul>

<h4>4. Third-party services</h4>
<p>The App connects directly from your device to third-party services (listed in the Privacy Policy). We do not control those services and are not responsible for their availability, accuracy, content, matching results, or how they handle your data. Search results and video matches are produced automatically and may be wrong, unavailable or removed at any time.</p>

<h4>5. No warranty</h4>
<p>THE APP IS PROVIDED "AS IS" AND "AS AVAILABLE", FREE OF CHARGE, WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING ANY WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, AVAILABILITY, SECURITY, OR THAT IT WILL BE ERROR-FREE OR THAT DATA WILL NOT BE LOST.</p>

<h4>6. Limitation of liability</h4>
<p>TO THE FULLEST EXTENT PERMITTED BY LAW, ${OWNER.toUpperCase()} AND ANY CONTRIBUTORS TO BAZINGA! SHALL NOT BE LIABLE FOR ANY CLAIM, LOSS OR DAMAGE OF ANY KIND — INCLUDING DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, LOSS OF DATA, LOSS OF PROFITS, DEVICE PROBLEMS, DATA CHARGES, OR CLAIMS BY THIRD PARTIES (INCLUDING COPYRIGHT CLAIMS) — ARISING OUT OF OR RELATED TO YOUR USE OF, OR INABILITY TO USE, THE APP OR ANY THIRD-PARTY SERVICE OR CONTENT ACCESSED THROUGH IT, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE. YOU USE THE APP ENTIRELY AT YOUR OWN RISK.</p>
<p>Some jurisdictions do not allow certain warranties or liabilities to be excluded. In those places, the exclusions above apply to the maximum extent the law allows.</p>

<h4>7. Indemnity</h4>
<p>You agree to defend, indemnify and hold harmless ${OWNER} and any contributors from any claims, damages, costs and expenses (including reasonable legal fees) arising from your use of the App, your content, or your breach of these Terms or of any third party's rights or terms.</p>

<h4>8. Changes and ending use</h4>
<p>We may change, suspend or discontinue the App, or update these Terms, at any time without notice. If the Terms change, the App will ask you to accept the new version before continuing. You can stop using the App at any time and delete your account and all its data from Settings.</p>

<h4>9. General</h4>
<p>If any part of these Terms is found unenforceable, the rest remains in effect. These Terms are the entire agreement between you and us about the App.</p>

<h3>Privacy Policy</h3>
<h4>What we collect</h4>
<p><b>Nothing.</b> BAZINGA! has no servers, no accounts on our side, no analytics and no advertising. We never receive your username, profile picture, music library, listening history or backups.</p>

<h4>What is stored on your device</h4>
<p>Your username, profile picture, library, playlists, albums, YouTube matches, settings, any music files you add, any Spotify sign-in token, and automatic backups are stored only in your browser's storage on your device (and in any backup file you choose to save). You can erase all of it at any time with <b>Settings → Delete account</b>.</p>

<h4>Third-party services your device talks to</h4>
<p>To work, the App sends requests directly from your device to these services, which receive your IP address and the search terms or IDs needed. Their own privacy policies apply:</p>
<ul>
<li><b>YouTube / Google</b> — to show and play videos with the official YouTube player, and, if you add your own API key, to search YouTube.</li>
<li><b>Public Invidious and Piped servers</b> (independent, community-run) — to search for matching YouTube videos without an API key.</li>
<li><b>Apple iTunes Search API</b> — to look up genres, release dates, artwork, albums and artists.</li>
<li><b>Spotify</b> — only if you choose to connect it, to read your Liked Songs and playlists.</li>
<li><b>Google Fonts</b> and <b>GitHub Pages</b> — to load the App's fonts and files.</li>
</ul>

<h4>Sharing</h4>
<p>When you share a song, playlist or album, its song list (and your username) is packed into the link itself. Anyone you give the link to can read it. Nothing is uploaded by the App.</p>

<h4>Children</h4>
<p>The App is not directed at children under 13.</p>

<h4>Contact</h4>
<p>Questions about these terms can be raised through the App's public GitHub repository.</p>
`;

return { TERMS_VERSION, OWNER, LEGAL_HTML };
})();
// ---------- app.js ----------
const __m_app = (() => {
// BAZINGA — app shell, router and views
const { db, kv } = __m_db;
const { $, $$, esc, on, emit, toast, debounce, fmtTime, fmtDur, imageToDataURL, mainArtist, norm, trackKey, albumKey, yearOf, packToString, unpackString, sleep, downloadBlob, uid } = __m_util;
const { icon, cover, trackRow, card, modal, promptText, confirmBox, menu, applyFilters, filterBar, empty } = __m_ui;
const store = __m_store;
const { lib } = __m_store;
const meta = __m_meta;
const yt = __m_youtube;
const sp = __m_spotify;
const imp = __m_importers;
const player = __m_player;
const { P } = __m_player;
const backup = __m_backup;
const { LEGAL_HTML, TERMS_VERSION } = __m_legal;

const view = () => $('#view');
const lists = new Map();      // listKey -> [trackIds] for "play from here"
const sections = new Map();   // sectionKey -> {tracks, opts}
const fstate = {};            // sectionKey -> filter state
let settings = { country: 'US', ytKey: '', customInstance: '', enrich: true };
let profile = null;
let routeToken = 0;

// ================= BOOT =================
async function boot() {
  window.__bzStarted = true;
  if (location.protocol === 'file:') setTimeout(() => toast('Opened from a file: library & offline files work, but YouTube playback, Spotify and sharing need the GitHub Pages link.', 'err'), 1500);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { });
  settings = { ...settings, ...(await kv.get('settings', {})) };
  applySettings();
  try { if (await sp.handleRedirect()) { toast('Spotify connected ✓'); location.hash = '#/import'; } }
  catch (e) { toast(e.message, 'err'); }
  await store.load();
  profile = await kv.get('profile');
  await player.restore();
  backup.startAuto();
  wireGlobal();
  if (!profile) return onboarding();
  showApp();
}

function applySettings() {
  meta.setCountry(settings.country);
  yt.setYTSettings({ ytKey: settings.ytKey, customInstance: settings.customInstance });
  store.setEnrich(settings.enrich !== false);
}
async function saveSettings(patch) { settings = { ...settings, ...patch }; await kv.set('settings', settings); applySettings(); emit('dirty', 'settings'); }

async function termsGate() {
  while (profile.termsAccepted !== TERMS_VERSION) {
    const r = await modal(`<h3>${icon('shield')} Privacy Policy & Terms</h3>
      <p class="muted tiny">${profile.termsAccepted ? 'Our terms have been updated. ' : ''}Please read and accept to keep using BAZINGA!.</p>
      <div class="legal-box">${LEGAL_HTML}</div>
      <form><label class="agree"><input type="checkbox" name="ok" required><span>I have read and agree to the Privacy Policy and Terms of Use, and I understand BAZINGA! is provided as-is with no liability.</span></label>
      <div class="modal-actions"><button type="button" class="btn ghost" data-resolve="no">Decline</button><button class="btn primary">Accept</button></div></form>`, { wide: true, locked: true });
    if (r && r.ok) { profile.termsAccepted = TERMS_VERSION; profile.termsAcceptedAt = new Date().toISOString(); await kv.set('profile', profile); emit('dirty', 'terms'); }
    else if (r === 'no') await modal(`<h3>You need to accept to use BAZINGA!</h3><p class="muted">If you don't agree, you can delete your account and all its data from this device.</p>
      <div class="modal-actions"><button class="btn danger" data-resolve="del">Delete my data</button><button class="btn primary" data-resolve="back">Go back</button></div>`, { locked: true })
      .then(x => x === 'del' && deleteAccount());
  }
}

async function showApp() {
  await termsGate();
  $('#onboarding').hidden = true;
  $('#app').hidden = false;
  $$('.ni').forEach(el => { const n = [...el.classList].find(c => c.startsWith('ni-')).slice(3); el.outerHTML = icon(n); });
  renderProfileChip(); renderSidebarPlaylists(); renderPlayer();
  route();
  if (navigator.storage?.persist) navigator.storage.persist();
}

// ================= ONBOARDING =================
function onboarding() {
  $('#app').hidden = true;
  const ob = $('#onboarding'); ob.hidden = false;
  let pic = '';
  ob.innerHTML = `<div class="ob-card">
    <img src="icons/icon-512.png" class="ob-logo" alt="">
    <h1 class="wordmark">BAZINGA!</h1>
    <p class="muted">Your Spotify library, turned into YouTube music videos & audio — with a full player, albums, offline files and backups. Everything stays on this device.</p>
    <form id="ob-form">
      <label class="ob-pic" title="Add a profile picture">
        <input type="file" accept="image/*" id="ob-file" hidden>
        <div class="avatar xl" id="ob-avatar">${icon('user')}</div>
        <span>Add photo</span>
      </label>
      <label class="fld"><span>Pick a username</span><input name="username" required maxlength="30" autocomplete="nickname" placeholder="e.g. thunderkid"></label>
      <label class="agree"><input type="checkbox" name="terms" required><span>I agree to the <a class="lnk" href="#" id="ob-legal">Privacy Policy & Terms of Use</a>. BAZINGA! is provided as-is and isn't liable for anything.</span></label>
      <button class="btn primary big">Let's go ${icon('play')}</button>
      <p class="tiny muted">No email, no password. Just a name and a picture, saved only on this device. You can delete it any time in Settings.</p>
    </form>
    <button class="btn ghost" id="ob-restore">${icon('restore')}Restore from a backup file</button>
    <p class="copyright">© 2026 Abbel Dawit · BAZINGA!</p>
  </div>`;
  $('#ob-legal').onclick = e => { e.preventDefault(); showLegal(); };
  $('#ob-file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    pic = await imageToDataURL(f, 256);
    $('#ob-avatar').innerHTML = `<img src="${pic}" alt="">`;
  };
  $('#ob-form').onsubmit = async e => {
    e.preventDefault();
    const username = new FormData(e.target).get('username').trim();
    if (!username) return;
    if (!e.target.terms.checked) return toast('Please accept the Privacy Policy & Terms', 'err');
    profile = { username, picture: pic, createdAt: Date.now(), termsAccepted: TERMS_VERSION, termsAcceptedAt: new Date().toISOString() };
    await kv.set('profile', profile);
    emit('dirty', 'profile');
    location.hash = '#/home';
    showApp();
  };
  $('#ob-restore').onclick = () => pickFile('.json,application/json', async f => {
    try { await backup.restoreFromFile(f); location.reload(); } catch (err) { toast(err.message, 'err'); }
  });
}

// ================= ROUTER =================
window.addEventListener('hashchange', () => profile && profile.termsAccepted === TERMS_VERSION && route());
const showLegal = () => modal(`<h3>${icon('shield')} Privacy Policy & Terms</h3><div class="legal-box">${LEGAL_HTML}</div>`, { wide: true });
async function route() {
  const my = ++routeToken;
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, ...rest] = h.split('/');
  const arg = rest.map(decodeURIComponent);
  lists.clear(); sections.clear();
  $$('.nav a, .tabbar a').forEach(a => a.classList.toggle('on', a.dataset.r === name || (name === 'library' && a.dataset.r === 'library')));
  document.body.classList.remove('np-open');
  $('#modal-root').innerHTML = ''; $('#menu-root').innerHTML = '';
  closeQueueOnMobile();
  const v = view();
  v.scrollTop = 0; $('#main').scrollTop = 0;
  const routes = { home: vHome, search: vSearch, library: vLibrary, playlist: vPlaylist, album: vAlbum, artist: vArtist, import: vImport, offline: vOffline, settings: vSettings, s: vShared, queue: vQueue, genre: vGenre, legal: vLegal };
  const fn = routes[name] || vHome;
  v.innerHTML = '<div class="loading"><div class="bolt-spin"></div></div>';
  try { await fn(arg, my); } catch (e) { console.error(e); if (my === routeToken) v.innerHTML = empty('Something went wrong', esc(e.message)); }
}
const stale = my => my !== routeToken;
const rerender = debounce(() => {
  // Re-render the current view softly when library changes (keeps scroll)
  const sc = $('#main').scrollTop;
  route().then(() => { $('#main').scrollTop = sc; });
}, 250);

// ================= TRACK LIST SECTIONS =================
const PAGE = 150;
function tracksSection(key, tracks, opts = {}) {
  sections.set(key, { tracks, opts });
  fstate[key] = fstate[key] || { sort: opts.defaultSort ?? 'added', open: false };
  return `<div class="tsec" data-tsec="${key}">${tracksSectionInner(key)}</div>`;
}
function tracksSectionInner(key) {
  const { tracks, opts } = sections.get(key);
  const f = fstate[key];
  const shown = opts.noFilter ? tracks : applyFilters(tracks, f);
  lists.set(key, shown.map(t => t.id));
  const cur = player.current()?.id;
  const head = opts.noFilter ? '' : filterBar(f, tracks, { keepOrder: opts.keepOrder });
  const count = !opts.noFilter && shown.length !== tracks.length ? `<div class="muted tiny count">${shown.length} of ${tracks.length} songs</div>` : '';
  const rows = shown.slice(0, PAGE).map((t, i) => trackRow(t, i, { list: key, playlistId: opts.playlistId, numbered: opts.numbered }, cur)).join('');
  const more = shown.length > PAGE ? `<div class="more" data-more="${key}" data-at="${PAGE}"></div>` : '';
  return head + count + `<div class="rows">${rows || '<div class="muted pad">No songs match these filters.</div>'}</div>` + more;
}
function refreshSection(key, keepFocus) {
  const el = $(`[data-tsec="${key}"]`); if (!el) return;
  const active = document.activeElement?.dataset?.f;
  const pos = document.activeElement?.selectionStart;
  el.innerHTML = tracksSectionInner(key);
  if (keepFocus && active) { const i = el.querySelector(`[data-f="${active}"]`); i?.focus(); try { i.setSelectionRange(pos, pos); } catch { } }
  observeMore();
}
const moreObs = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const el = e.target, key = el.dataset.more, at = +el.dataset.at;
    const ids = lists.get(key) || [];
    const rowsEl = el.previousElementSibling;
    const cur = player.current()?.id;
    const { opts } = sections.get(key) || { opts: {} };
    rowsEl.insertAdjacentHTML('beforeend', ids.slice(at, at + PAGE).map((id, j) => trackRow(lib.tracks.get(id), at + j, { list: key, playlistId: opts.playlistId }, cur)).join(''));
    if (at + PAGE >= ids.length) { moreObs.unobserve(el); el.remove(); } else el.dataset.at = at + PAGE;
  }
}, { rootMargin: '600px' });
function observeMore() { $$('[data-more]').forEach(el => moreObs.observe(el)); }

// ================= VIEWS =================
function header(title, sub = '', art = '', actions = '', kind = '') {
  return `<header class="hero ${art ? 'has-art' : ''}">
    ${art ? `<div class="hero-art ${kind === 'artist' ? 'round' : ''}">${art}</div>` : ''}
    <div class="hero-txt">${kind ? `<div class="kicker">${kind}</div>` : ''}<h1>${title}</h1>${sub ? `<div class="hero-sub">${sub}</div>` : ''}</div>
  </header>${actions ? `<div class="actions">${actions}</div>` : ''}`;
}
const playBtns = (act, id = '') => `<button class="btn primary round-play" data-act="${act}" data-id="${esc(id)}" aria-label="Play">${icon('play')}</button>
  <button class="ib lg" data-act="${act}" data-id="${esc(id)}" data-shuffle="1" aria-label="Shuffle play" title="Shuffle">${icon('shuffle')}</button>
  <button class="ib lg" data-act="${act}" data-id="${esc(id)}" data-queue="1" aria-label="Add all to queue" title="Add to queue">${icon('queue')}</button>`;

// ---------- HOME ----------
async function vHome(_, my) {
  const all = store.saved();
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  if (!all.length) {
    view().innerHTML = `<div class="page">${header(`${greet}, ${esc(profile.username)}`)}
      ${empty('Your library is empty', 'Bring in your Spotify Liked Songs or playlists, add music files from this device, or search for any album.',
        `<div class="row-btns"><a class="btn primary" href="#/import">${icon('import')}Import music</a><a class="btn" href="#/search">${icon('search')}Search albums</a></div>`)}</div>`;
    return;
  }
  const liked = all.filter(t => t.liked);
  const recent = [...all].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 12);
  const pls = [...lib.playlists.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const albums = [...lib.albums.values()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const arts = store.artists().sort((a, b) => b.count - a.count).slice(0, 12);
  const gens = store.genres().slice(0, 14);
  const cur = player.current();
  lists.set('recent', recent.map(t => t.id));
  view().innerHTML = `<div class="page">
    ${header(`${greet}, ${esc(profile.username)}`, `${all.length} songs · ${lib.playlists.size} playlists · ${lib.albums.size} albums`)}
    <div class="quick">
      <a class="qt" href="#/library/liked"><div class="qt-art liked">${icon('heartFill')}</div><span>Liked Songs</span><small>${liked.length}</small></a>
      ${pls.slice(0, 5).map(p => `<a class="qt" href="#/playlist/${p.id}">${cover(plCover(p), p.name, 'qt-art')}<span>${esc(p.name)}</span><small>${p.trackIds.length}</small></a>`).join('')}
    </div>
    ${cur ? `<section><h2>Continue listening</h2><div class="rows">${trackRow(cur, 0, { list: 'cont' }, cur.id)}</div></section>` : ''}
    <section><div class="sec-h"><h2>Recently added</h2><a href="#/library/songs" class="lnk">See all</a></div>
      <div class="rows">${recent.map((t, i) => trackRow(t, i, { list: 'recent' }, cur?.id)).join('')}</div></section>
    ${gens.length ? `<section><h2>Your genres</h2><div class="genre-tiles">${gens.map(([g, n]) => `<a class="gt" href="#/genre/${encodeURIComponent(g)}" style="--c:${genreColor(g)}"><b>${esc(g)}</b><small>${n} songs</small></a>`).join('')}</div></section>` : ''}
    ${albums.length ? `<section><div class="sec-h"><h2>Your albums</h2><a href="#/library/albums" class="lnk">See all</a></div><div class="cards">${albums.slice(0, 10).map(albumCard).join('')}</div></section>` : ''}
    <section><div class="sec-h"><h2>Your artists</h2><a href="#/library/artists" class="lnk">See all</a></div>
      <div class="cards">${arts.map(a => card({ href: `#/artist/${encodeURIComponent(a.name)}`, img: a.artwork, title: a.name, sub: `${a.count} song${a.count > 1 ? 's' : ''}`, round: true })).join('')}</div></section>
  </div>`;
  if (cur) lists.set('cont', [cur.id]);
}
function genreColor(g) { let h = 7; for (const c of g) h = (h * 33 + c.charCodeAt(0)) % 360; return `hsl(${h} 70% 42%)`; }
const plCover = p => p.image || (p.trackIds.map(id => lib.tracks.get(id)?.artwork).find(Boolean) || '');
const albumCard = a => card({ href: albumHref(a), img: a.artwork, title: a.title, sub: [a.year, a.artist].filter(Boolean).join(' · '), act: 'play-album', id: a.id });
const albumHref = a => lib.albums.has(a.id) || !a.itunesAlbumId ? `#/album/${encodeURIComponent(a.id)}` : `#/album/it/${a.itunesAlbumId}`;

// ---------- GENRE ----------
async function vGenre([g]) {
  const tracks = store.saved().filter(t => t.genre === g);
  view().innerHTML = `<div class="page">${header(esc(g), `${tracks.length} songs in your library`, '', playBtns('play-list', 'genre'), 'Genre')}
    ${tracksSection('genre', tracks)}</div>`;
  observeMore();
}

// ---------- LIBRARY ----------
async function vLibrary([tab = 'songs']) {
  const all = store.saved();
  const tabs = [['songs', 'Songs', all.length], ['liked', 'Liked', all.filter(t => t.liked).length], ['playlists', 'Playlists', lib.playlists.size], ['albums', 'Albums', lib.albums.size + store.implicitAlbums().length], ['artists', 'Artists', store.artists().length]];
  let body = '';
  if (tab === 'songs' || tab === 'liked') {
    const tracks = tab === 'liked' ? all.filter(t => t.liked) : all;
    body = tracks.length ? `<div class="actions">${playBtns('play-list', tab)}${matchBtn(tab)}</div>${tracksSection(tab, tracks)}`
      : empty(tab === 'liked' ? 'No liked songs yet' : 'No songs yet', 'Tap the heart on any song, or import your Spotify Liked Songs.', `<a class="btn primary" href="#/import">${icon('import')}Import</a>`);
  } else if (tab === 'playlists') {
    const pls = [...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
    body = `<div class="actions"><button class="btn" data-act="new-playlist">${icon('plus')}New playlist</button><a class="btn ghost" href="#/import">${icon('import')}Import playlists</a></div>
      <div class="cards">${card({ href: '#/library/liked', img: '', title: 'Liked Songs', sub: `${all.filter(t => t.liked).length} songs` }).replace('<div class="cover noimg', '<div class="cover noimg liked-cover')}
      ${pls.map(p => card({ href: `#/playlist/${p.id}`, img: plCover(p), title: p.name, sub: `${p.trackIds.length} songs${p.source ? ' · ' + p.source : ''}`, act: 'play-playlist', id: p.id })).join('')}</div>`;
  } else if (tab === 'albums') {
    const saved = [...lib.albums.values()].sort((a, b) => a.title.localeCompare(b.title));
    const imp = store.implicitAlbums().sort((a, b) => b.trackIds.length - a.trackIds.length || a.title.localeCompare(b.title));
    body = `<div class="actions"><a class="btn" href="#/search/albums">${icon('search')}Find albums</a></div>
      ${saved.length ? `<h2>Saved albums</h2><div class="cards">${saved.map(albumCard).join('')}</div>` : empty('No saved albums yet', 'Search any album, or open one from a song (⋯ → Go to album) and tap "Save album".')}
      ${imp.length ? `<h2>From your songs</h2><p class="muted tiny">Albums you have songs from. Open one to see and save the full album.</p><div class="cards">${imp.map(a => card({ href: albumHref(a), img: a.artwork, title: a.title, sub: `${a.artist} · ${a.trackIds.length} in library`, act: 'play-album', id: a.id })).join('')}</div>` : ''}`;
  } else if (tab === 'artists') {
    const arts = store.artists();
    const letters = [...new Set(arts.map(a => (a.name[0] || '#').toUpperCase().replace(/[^A-Z]/, '#')))];
    body = arts.length ? `<div class="az">${letters.map(l => `<a href="#" data-act="az" data-l="${l}">${l}</a>`).join('')}</div>
      <div class="artist-list">${arts.map(a => `<a class="artist-row" href="#/artist/${encodeURIComponent(a.name)}" data-letter="${(a.name[0] || '#').toUpperCase().replace(/[^A-Z]/, '#')}">
        ${cover(a.artwork, a.name, 'round sm')}<div><b>${esc(a.name)}</b><small>${a.count} song${a.count > 1 ? 's' : ''}${a.genres.size ? ' · ' + esc([...a.genres].slice(0, 2).join(', ')) : ''}</small></div>
        <button class="ib" data-act="play-artist" data-name="${esc(a.name)}" aria-label="Play">${icon('play')}</button></a>`).join('')}</div>`
      : empty('No artists yet', 'Artists from all your songs, playlists and albums show up here.');
  }
  view().innerHTML = `<div class="page"><h1 class="page-h">Your Library</h1>
    <div class="tabs">${tabs.map(([k, l, n]) => `<a href="#/library/${k}" class="tab ${tab === k ? 'on' : ''}">${l}<small>${n}</small></a>`).join('')}</div>${body}</div>`;
  observeMore();
}
const matchBtn = key => `<button class="btn ghost" data-act="match-list" data-list="${key}" title="Find YouTube versions for every song">${icon('yt')}Find YouTube matches</button>
  <button class="btn ghost" data-act="yt-export" data-list="${key}">${icon('link')}Open on YouTube</button>`;

// ---------- PLAYLIST ----------
async function vPlaylist([id]) {
  const p = lib.playlists.get(id);
  if (!p) { view().innerHTML = empty('Playlist not found', 'It may have been deleted.'); return; }
  const tracks = p.trackIds.map(i => lib.tracks.get(i)).filter(Boolean);
  const dur = tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  fstate['pl'] = fstate['pl'] && fstate['pl']._id === id ? fstate['pl'] : { sort: '', open: false, _id: id };
  view().innerHTML = `<div class="page">
    ${header(esc(p.name), `${esc(profile.username)} · ${tracks.length} songs${dur ? ' · ' + fmtTime(dur / 1000) : ''}${p.source ? ' · from ' + esc(p.source) : ''}`, cover(plCover(p), p.name), '', 'Playlist')}
    <div class="actions">${playBtns('play-list', 'pl')}
      <button class="ib lg" data-act="share-playlist" data-id="${p.id}" title="Share">${icon('share')}</button>
      <button class="ib lg" data-act="playlist-menu" data-id="${p.id}" title="More">${icon('more')}</button>
      ${matchBtn('pl')}</div>
    ${tracks.length ? tracksSection('pl', tracks, { playlistId: p.id, keepOrder: true, defaultSort: '' }) : empty('This playlist is empty', 'Use ⋯ → "Add to playlist" on any song.')}
  </div>`;
  observeMore();
}

// ---------- ALBUM ----------
async function vAlbum(arg, my) {
  let album, tracks, savedA = null, remote = null;
  if (arg[0] === 'it') {
    const res = await meta.albumTracks(arg[1]);
    if (stale(my)) return;
    if (!res.album) { view().innerHTML = empty('Album not found', ''); return; }
    album = res.album; tracks = res.tracks;
    savedA = lib.albums.get(album.id);
  } else {
    const id = arg[0];
    savedA = lib.albums.get(id);
    album = savedA || store.implicitAlbums().find(a => a.id === id);
    if (!album) { view().innerHTML = empty('Album not found', ''); return; }
    tracks = (album.trackIds || []).map(i => lib.tracks.get(i)).filter(Boolean);
    if (!savedA && album.itunesAlbumId) { location.replace(`#/album/it/${album.itunesAlbumId}`); return; }
    if (!savedA && navigator.onLine) {
      // try to find the full album
      try { remote = await meta.findAlbum(album.artist, album.title); } catch { }
      if (stale(my)) return;
      if (remote) { location.replace(`#/album/it/${remote.itunesAlbumId}`); return; }
    }
  }
  // Use library versions of tracks where they exist (keeps likes, offline files, YouTube links)
  tracks = tracks.map(t => lib.tracks.get(t.id) || store.remember(t));
  const dur = tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  const offlineN = tracks.filter(t => t.localFileId).length;
  window.__album = { album, tracks };
  const artistLink = `<a class="lnk" href="#/artist/${encodeURIComponent(mainArtist(album.artist))}">${esc(album.artist)}</a>`;
  view().innerHTML = `<div class="page">
    ${header(esc(album.title), `${artistLink} · ${album.year || ''} · ${tracks.length} songs${dur ? ' · ' + fmtTime(dur / 1000) : ''}${album.genre ? ' · ' + esc(album.genre) : ''}`, cover(album.artwork, album.title), '', 'Album')}
    <div class="actions">${playBtns('play-list', 'album')}
      ${savedA ? `<button class="btn" data-act="unsave-album" data-id="${esc(album.id)}">${icon('check')}Saved</button>` : `<button class="btn primary-o" data-act="save-album">${icon('plus')}Save album</button>`}
      <button class="ib lg" data-act="share-album" title="Share">${icon('share')}</button>
      <button class="btn ghost" data-act="album-offline">${icon('offline')}Offline files${offlineN ? ` (${offlineN}/${tracks.length})` : ''}</button>
      ${matchBtn('album')}</div>
    ${tracksSection('album', tracks, { noFilter: true, numbered: true })}
    ${album.releaseDate ? `<p class="muted tiny pad">Released ${new Date(album.releaseDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>` : ''}
  </div>`;
}

// ---------- ARTIST ----------
async function vArtist([name], my) {
  const n = norm(name);
  const mine = store.saved().filter(t => (t.artists?.length ? t.artists : [mainArtist(t.artist)]).some(a => norm(a) === n) || norm(mainArtist(t.artist)) === n);
  const a = store.artists().find(x => x.key === n);
  view().innerHTML = `<div class="page">${header(esc(name), `${mine.length} song${mine.length === 1 ? '' : 's'} in your library`, cover(a?.artwork || mine[0]?.artwork, name), '', 'artist')}
    <div class="actions">${mine.length ? playBtns('play-list', 'artist-mine') : ''}</div>
    ${mine.length ? `<h2>In your library</h2>${tracksSection('artist-mine', mine, { defaultSort: 'newest' })}` : ''}
    <div id="artist-remote"><div class="loading sm"><div class="bolt-spin"></div></div></div></div>`;
  observeMore();
  let id = a?.itunesArtistId || mine.find(t => t.itunesArtistId && norm(mainArtist(t.artist)) === n)?.itunesArtistId;
  try {
    if (!id) id = await meta.findArtistId(name);
    if (stale(my)) return;
    if (!id) { $('#artist-remote').innerHTML = ''; return; }
    const [albums, top] = await Promise.all([meta.artistAlbums(id), meta.artistTopSongs(id)]);
    if (stale(my)) return;
    const topT = top.slice(0, 10).map(t => lib.tracks.get(t.id) || store.remember(t));
    lists.set('artist-top', topT.map(t => t.id));
    const cur = player.current()?.id;
    $('#artist-remote').innerHTML = `
      ${topT.length ? `<h2>Popular songs</h2><div class="rows">${topT.map((t, i) => trackRow(t, i, { list: 'artist-top' }, cur)).join('')}</div>` : ''}
      ${albums.length ? `<h2>Discography</h2><div class="cards">${albums.map(al => card({ href: `#/album/it/${al.itunesAlbumId}`, img: al.artwork, title: al.title, sub: `${al.year || ''} · ${al.trackCount} songs` })).join('')}</div>` : ''}`;
  } catch {
    if (!stale(my)) $('#artist-remote').innerHTML = `<p class="muted pad">${navigator.onLine ? 'Couldn\'t load more about this artist right now.' : 'You\'re offline — showing your library only.'}</p>`;
  }
}

// ---------- SEARCH ----------
let lastSearch = { q: '', tab: 'all' };
async function vSearch([tab = lastSearch.tab]) {
  lastSearch.tab = tab;
  view().innerHTML = `<div class="page"><h1 class="page-h">Search</h1>
    <label class="searchbox big">${icon('search')}<input id="sq" placeholder="Songs, albums, artists…" value="${esc(lastSearch.q)}" autocomplete="off" enterkeyhint="search"></label>
    <div class="tabs">${[['all', 'All'], ['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists']].map(([k, l]) => `<a href="#/search/${k}" class="tab ${tab === k ? 'on' : ''}">${l}</a>`).join('')}</div>
    <div id="sres"></div></div>`;
  const inp = $('#sq');
  const run = debounce(() => doSearch(inp.value.trim(), tab), 450);
  inp.addEventListener('input', run);
  if (innerWidth > 700) inp.focus();
  if (lastSearch.q) doSearch(lastSearch.q, tab);
  else $('#sres').innerHTML = searchHints();
}
function searchHints() {
  const g = store.genres().slice(0, 12);
  return `<p class="muted">Search the whole music catalogue for full albums, artists and songs — play them as YouTube videos or audio, save albums to your library.</p>
  ${g.length ? `<h2>Browse your genres</h2><div class="genre-tiles">${g.map(([x, n]) => `<a class="gt" href="#/genre/${encodeURIComponent(x)}" style="--c:${genreColor(x)}"><b>${esc(x)}</b><small>${n} songs</small></a>`).join('')}</div>` : ''}`;
}
async function doSearch(q, tab) {
  lastSearch.q = q;
  const box = $('#sres'); if (!box) return;
  if (!q) { box.innerHTML = searchHints(); return; }
  const local = applyFilters(store.saved(), { q }).slice(0, 8);
  box.innerHTML = `${local.length && tab !== 'albums' && tab !== 'artists' ? `<h2>In your library</h2>${rowsFor('s-local', local)}` : ''}<div class="loading sm"><div class="bolt-spin"></div></div>`;
  if (!navigator.onLine) { box.querySelector('.loading').outerHTML = '<p class="muted">Offline — only your library is searchable.</p>'; return; }
  try {
    const want = t => tab === 'all' || tab === t;
    const [songs, albums, artists] = await Promise.all([
      want('songs') ? meta.searchSongs(q, tab === 'songs' ? 40 : 10) : [],
      want('albums') ? meta.searchAlbums(q, tab === 'albums' ? 40 : 12) : [],
      want('artists') ? meta.searchArtists(q, tab === 'artists' ? 20 : 6) : []
    ]);
    if (lastSearch.q !== q || !$('#sres')) return;
    const st = songs.map(t => lib.tracks.get(t.id) || store.remember(t));
    box.querySelector('.loading')?.remove();
    box.insertAdjacentHTML('beforeend', `
      ${artists.length ? `<h2>Artists</h2><div class="cards">${artists.map(a => card({ href: `#/artist/${encodeURIComponent(a.name)}`, img: '', title: a.name, sub: a.genre, round: true })).join('')}</div>` : ''}
      ${albums.length ? `<h2>Albums</h2><div class="cards">${albums.map(a => card({ href: `#/album/it/${a.itunesAlbumId}`, img: a.artwork, title: a.title, sub: `${a.artist} · ${a.year || ''}` })).join('')}</div>` : ''}
      ${st.length ? `<h2>Songs</h2>${rowsFor('s-songs', st)}` : ''}
      ${!artists.length && !albums.length && !st.length ? '<p class="muted">No results.</p>' : ''}`);
  } catch (e) {
    box.querySelector('.loading')?.remove();
    box.insertAdjacentHTML('beforeend', '<p class="muted">Search is unavailable right now. Try again in a moment.</p>');
  }
}
function rowsFor(key, tracks) {
  lists.set(key, tracks.map(t => t.id));
  const cur = player.current()?.id;
  return `<div class="rows">${tracks.map((t, i) => trackRow(t, i, { list: key }, cur)).join('')}</div>`;
}

// ---------- IMPORT ----------
async function vImport() {
  const connected = await sp.isConnected();
  const clientId = await kv.get('spotifyClientId', '');
  view().innerHTML = `<div class="page"><h1 class="page-h">Import music</h1>
    <div class="panel">
      <div class="panel-h">${icon('spotify', 'brand-sp')}<div><h2>From Spotify</h2><p class="muted tiny">Liked Songs and your playlists. Uses your own free Spotify developer key, so there's no shared limit.</p></div></div>
      ${connected ? `<div class="row-btns">
          <button class="btn primary" data-act="sp-liked">${icon('heartFill')}Import Liked Songs</button>
          <button class="btn" data-act="sp-playlists">${icon('library')}Choose playlists</button>
          <button class="btn ghost" data-act="sp-disconnect">Disconnect</button></div>`
      : `<details class="howto" ${clientId ? '' : 'open'}><summary>One-time setup (2 minutes)</summary><ol>
          <li>Open <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener" class="lnk">developer.spotify.com/dashboard</a> and log in.</li>
          <li>Click <b>Create app</b>. Any name. Tick <b>Web API</b>.</li>
          <li>Under <b>Redirect URIs</b> add exactly: <code class="copy" data-act="copy" data-v="${esc(sp.redirectUri())}">${esc(sp.redirectUri())}</code></li>
          <li>Save, then copy the <b>Client ID</b> and paste it below.</li></ol>
          <p class="tiny muted">Spotify now requires the developer account to have Premium. No Premium? Use the CSV option below — it works for everyone.</p></details>
        <form class="inline-form" id="sp-form"><input name="cid" placeholder="Spotify Client ID" value="${esc(clientId)}" required pattern="[A-Za-z0-9]{20,40}"><button class="btn primary">${icon('spotify')}Connect Spotify</button></form>`}
    </div>
    <div class="panel">
      <div class="panel-h">${icon('apple', 'brand-am')}<div><h2>From Apple Music</h2><p class="muted tiny">Import playlists, your whole library and Favorite (Loved) songs, with genres and years. No Apple account login needed.</p></div></div>
      <details class="howto"><summary>How to export from Apple Music</summary><ol>
        <li><b>Mac</b> (Music app) or <b>Windows</b> (Apple Music / iTunes app).</li>
        <li><b>Everything at once:</b> File → Library → <b>Export Library…</b> → save the <code>.xml</code> file.</li>
        <li><b>One playlist:</b> select it, then File → Library → <b>Export Playlist…</b> → format <b>Plain Text</b> (<code>.txt</code>).</li>
        <li>Drop the file below. On iPhone/Android the Apple Music app can't export — do it once on a computer, or use any converter that gives a CSV and the CSV option below.</li></ol></details>
      <label class="drop"><input type="file" accept=".xml,.txt,text/plain,text/xml,application/xml" multiple hidden data-act-change="apple">${icon('apple')}<span>Choose Apple Music export (.xml / .txt)</span></label>
    </div>
    <div class="panel">
      <div class="panel-h">${icon('file')}<div><h2>From a CSV file</h2><p class="muted tiny">No Spotify key needed. Export any playlist or your Liked Songs at <a class="lnk" href="https://exportify.net" target="_blank" rel="noopener">exportify.net</a> (or any CSV with title + artist columns), then drop the files here. Genres and release dates come along too.</p></div></div>
      <label class="drop" data-drop="csv"><input type="file" accept=".csv,text/csv" multiple hidden data-act-change="csv">${icon('import')}<span>Choose CSV files</span></label>
    </div>
    <div class="panel">
      <div class="panel-h">${icon('edit')}<div><h2>Paste a list</h2><p class="muted tiny">One song per line — "Artist - Title" or "Title by Artist".</p></div></div>
      <form id="paste-form"><textarea name="t" rows="5" placeholder="Daft Punk - One More Time&#10;Blinding Lights by The Weeknd"></textarea>
      <div class="row-btns"><input name="name" placeholder="Playlist name (optional)"><button class="btn">${icon('plus')}Add songs</button></div></form>
    </div>
    <div class="panel">
      <div class="panel-h">${icon('folder')}<div><h2>Music files on this device</h2><p class="muted tiny">MP3/M4A/FLAC/etc. that you own. They play fully offline and get grouped into albums from their tags. Songs already in your library get linked automatically.</p></div></div>
      <div class="row-btns"><button class="btn" data-act="add-files">${icon('file')}Add files</button><button class="btn" data-act="add-folder">${icon('folder')}Add a folder</button></div>
    </div>
  </div>`;
  $('#sp-form')?.addEventListener('submit', e => { e.preventDefault(); sp.login(new FormData(e.target).get('cid').trim()); });
  $('#paste-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const tracks = imp.tracksFromText(fd.get('t'));
    if (!tracks.length) return toast('Couldn\'t read any "Artist - Title" lines', 'err');
    const saved = await store.upsertTracks(tracks);
    if (fd.get('name')) { const p = await store.createPlaylist(fd.get('name'), saved.map(t => t.id), { source: 'pasted' }); location.hash = '#/playlist/' + p.id; }
    else { await Promise.all(saved.map(t => store.updateTrack(t.id, { liked: true }))); toast(`${saved.length} songs added to Liked`); location.hash = '#/library/liked'; }
  });
  $('[data-act-change="csv"]').addEventListener('change', e => importCSVFiles([...e.target.files]));
  $('[data-act-change="apple"]').addEventListener('change', e => importAppleFiles([...e.target.files]));
}

async function importCSVFiles(files) {
  for (const f of files) {
    try {
      const tracks = imp.tracksFromCSV(await f.text());
      if (!tracks.length) { toast(`${f.name}: no songs found`, 'err'); continue; }
      const saved = await store.upsertTracks(tracks);
      const name = f.name.replace(/\.csv$/i, '').replace(/_/g, ' ');
      if (/liked/i.test(name)) { for (const t of saved) await store.updateTrack(t.id, { liked: true }); toast(`${saved.length} Liked Songs imported`); }
      else { await store.createPlaylist(name, saved.map(t => t.id), { source: 'CSV' }); toast(`Playlist "${name}" imported (${saved.length})`); }
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  renderSidebarPlaylists();
  location.hash = '#/library/playlists';
}

async function importAppleFiles(files) {
  let any = false;
  for (const f of files) {
    try {
      const text = await imp.readTextSmart(f);
      if (/^\s*<\?xml|<plist/i.test(text.slice(0, 400))) {
        const lib2 = imp.fromAppleXML(text);
        if (!lib2.tracks.length) { toast(`${f.name}: no songs found`, 'err'); continue; }
        const r = await modal(`<h3>Import from Apple Music</h3><p class="muted tiny">${lib2.tracks.length} songs found. Pick what to bring in.</p>
          <form><div class="pick-list">
            <label class="pick"><div class="cover sm noimg liked-cover"><span>♥</span></div><span><b>Favorite (Loved) songs → Liked</b><small>${lib2.loved.length} songs</small></span><input type="checkbox" name="loved" value="1" ${lib2.loved.length ? 'checked' : 'disabled'}></label>
            <label class="pick"><div class="cover sm noimg"><span>♪</span></div><span><b>All songs in my library</b><small>${lib2.tracks.length} songs</small></span><input type="checkbox" name="all" value="1"></label>
            ${lib2.playlists.map((p, i) => `<label class="pick">${cover('', p.name, 'sm')}<span><b>${esc(p.name)}</b><small>${p.trackIds.length} songs${p.smart ? ' · smart playlist' : ''}</small></span><input type="checkbox" name="p" value="${i}" ${p.smart ? '' : 'checked'}></label>`).join('')}
          </div><div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Import</button></div></form>`, { wide: true });
        if (!r) continue;
        const pick = [].concat(r.p || []).map(Number);
        const need = new Set([...(r.loved ? lib2.loved : []), ...pick.flatMap(i => lib2.playlists[i].trackIds), ...(r.all ? lib2.tracks.map(t => t.id) : [])]);
        const saved = await store.upsertTracks(lib2.tracks.filter(t => need.has(t.id)));
        if (r.loved) for (const id of lib2.loved) if (need.has(id)) await store.updateTrack(id, { liked: true });
        for (const i of pick) {
          const p = lib2.playlists[i];
          const ex = [...lib.playlists.values()].find(x => x.source === 'Apple Music' && x.name === p.name);
          if (ex) { ex.trackIds = p.trackIds; await store.savePlaylist(ex); } else await store.createPlaylist(p.name, p.trackIds, { source: 'Apple Music' });
        }
        toast(`Apple Music: ${saved.length} songs, ${pick.length} playlists imported`, 'ok'); any = true;
      } else {
        const tracks = imp.tracksFromAppleTxt(text);
        if (!tracks.length) { toast(`${f.name}: no songs found`, 'err'); continue; }
        const saved = await store.upsertTracks(tracks);
        const name = f.name.replace(/\.txt$/i, '');
        await store.createPlaylist(name, saved.map(t => t.id), { source: 'Apple Music' });
        toast(`Playlist "${name}" imported (${saved.length})`, 'ok'); any = true;
      }
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  renderSidebarPlaylists();
  if (any) location.hash = '#/library/playlists';
}

async function spImportLiked() {
  const prog = progress('Importing Liked Songs…');
  try {
    const tracks = await sp.likedSongs((n, total) => prog.set(n, total));
    await store.upsertTracks(tracks, { liked: true });
    prog.done(`${tracks.length} Liked Songs imported`);
    location.hash = '#/library/liked';
  } catch (e) { prog.fail(e.message); }
}
async function spChoosePlaylists() {
  let pls;
  const prog = progress('Loading your playlists…');
  try { pls = await sp.playlists(); prog.close(); } catch (e) { return prog.fail(e.message); }
  if (!pls.length) return toast('No playlists found on that account');
  const r = await modal(`<h3>Choose playlists to import</h3>
    <form><div class="pick-list">${pls.map(p => `<label class="pick">${cover(p.image, p.name, 'sm')}<span><b>${esc(p.name)}</b><small>${p.total ?? '?'} songs · ${esc(p.owner)}</small></span><input type="checkbox" name="p" value="${p.spotifyId}" checked></label>`).join('')}</div>
    <p class="tiny muted">Spotify only lets apps read songs in playlists you own or collaborate on.</p>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Import</button></div></form>`, { wide: true });
  if (!r) return;
  const sel = [].concat(r.p || []);
  const picked = pls.filter(p => sel.includes(p.spotifyId));
  let ok = 0;
  for (const p of picked) {
    const pr = progress(`Importing "${p.name}"…`);
    try {
      const tracks = await sp.playlistTracks(p.spotifyId, (n, t) => pr.set(n, t));
      const saved = await store.upsertTracks(tracks);
      const existing = [...lib.playlists.values()].find(x => x.spotifyId === p.spotifyId);
      if (existing) { existing.trackIds = saved.map(t => t.id); existing.name = p.name; await store.savePlaylist(existing); }
      else await store.createPlaylist(p.name, saved.map(t => t.id), { source: 'Spotify', spotifyId: p.spotifyId, image: p.image });
      pr.done(`"${p.name}" — ${saved.length} songs`); ok++;
    } catch (e) { pr.fail(`"${p.name}": ${e.status === 403 ? 'Spotify doesn\'t allow reading this playlist (not yours)' : e.message}`); }
  }
  renderSidebarPlaylists();
  if (ok) location.hash = '#/library/playlists';
}

// ---------- OFFLINE ----------
async function vOffline() {
  const off = store.saved().filter(t => t.localFileId);
  let est = '';
  try { const e = await navigator.storage.estimate(); est = `${(e.usage / 1e6).toFixed(0)} MB used of ~${(e.quota / 1e9).toFixed(1)} GB available`; } catch { }
  const persisted = await navigator.storage?.persisted?.();
  view().innerHTML = `<div class="page">${header('Offline', `${off.length} songs playable without internet${est ? ' · ' + est : ''}`, '', '', '')}
    <div class="panel">
      <p class="muted">BAZINGA plays offline from music files you own that are stored on this device. Add files or a whole folder — they're matched to songs in your library by their tags or by "Artist - Title" file names, and grouped into albums.</p>
      <div class="row-btns"><button class="btn primary" data-act="add-files">${icon('file')}Add music files</button><button class="btn" data-act="add-folder">${icon('folder')}Add a folder</button>
      <label class="toggle"><input type="checkbox" id="pref-off" ${P.preferOffline ? 'checked' : ''}><span></span>Prefer offline files when online too</label></div>
      ${persisted === false ? '<p class="tiny muted">Tip: install BAZINGA (browser menu → Install / Add to Home Screen) so your browser keeps the files safe.</p>' : ''}
      <p class="tiny muted">YouTube streams themselves can't be saved — that's against YouTube's rules — so songs without a file need internet.</p>
    </div>
    ${off.length ? `<div class="actions">${playBtns('play-list', 'offline')}</div>${tracksSection('offline', off)}` : empty('Nothing offline yet', 'Add music files above to listen anywhere.')}</div>`;
  $('#pref-off').onchange = e => player.setPreferOffline(e.target.checked);
  observeMore();
}

async function addLocalFiles(files, { albumHint } = {}) {
  files = files.filter(f => imp.AUDIO_EXT.test(f.name) || f.type.startsWith('audio/'));
  if (!files.length) return toast('No audio files found', 'err');
  const prog = progress(`Adding ${files.length} files…`);
  let linked = 0, added = 0;
  const albums = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    prog.set(i + 1, files.length);
    try {
      const tag = await imp.readLocalFile(f);
      let id = trackKey(tag.artist, tag.title);
      // Album page: match by title against the album's tracks
      if (albumHint && !lib.tracks.has(id)) {
        const m = albumHint.find(t => norm(t.title) === norm(tag.title) || norm(f.name).includes(norm(t.title)));
        if (m) id = m.id;
      }
      const existing = lib.tracks.get(id);
      const fileId = 'f_' + id;
      await db.put('files', { id: fileId, blob: f, name: f.name, type: f.type, size: f.size, addedAt: Date.now() });
      let art = existing?.artwork || '';
      if (!art && tag.picture) { try { art = await imageToDataURL(tag.picture, 300); } catch { } }
      const t = {
        ...(existing || {}), id, title: existing?.title || tag.title, artist: existing?.artist || tag.artist,
        album: existing?.album || tag.album, genre: existing?.genre || tag.genre, year: existing?.year || tag.year,
        trackNumber: existing?.trackNumber || tag.trackNumber, artwork: art, localFileId: fileId
      };
      if (t.album && !t.albumId) t.albumId = albumKey(tag.albumArtist || t.artist, t.album);
      await store.upsertTracks([t]);
      existing && !existing.transient ? linked++ : added++;
      if (t.album) {
        const a = albums.get(t.albumId) || { id: t.albumId, title: t.album, artist: tag.albumArtist || mainArtist(t.artist), year: t.year, genre: t.genre, artwork: art, ids: [] };
        a.ids.push([t.trackNumber || 999, id]); if (!a.artwork) a.artwork = art;
        albums.set(t.albumId, a);
      }
    } catch (e) { console.warn('file failed', f.name, e); }
  }
  // Save albums found in the files (so they show up as albums on the device)
  for (const a of albums.values()) {
    const old = lib.albums.get(a.id);
    const ids = a.ids.sort((x, y) => x[0] - y[0]).map(x => x[1]);
    const merged = { ...(old || {}), id: a.id, title: old?.title || a.title, artist: old?.artist || a.artist, year: old?.year || a.year, genre: old?.genre || a.genre, artwork: old?.artwork || a.artwork, trackIds: [...new Set([...(old?.trackIds || []), ...ids])], savedAt: old?.savedAt || Date.now() };
    lib.albums.set(a.id, merged); await db.put('albums', merged);
  }
  store.notify('files');
  prog.done(`${added} new songs, ${linked} linked to your library${albums.size ? `, ${albums.size} albums` : ''} — available offline`);
}

// ---------- SETTINGS ----------
async function vSettings() {
  const lastB = await kv.get('lastBackup');
  const lastD = await kv.get('lastDownload');
  const snaps = await backup.listInternal();
  const fstate2 = backup.linkedFileState();
  view().innerHTML = `<div class="page"><h1 class="page-h">Settings</h1>
    <div class="panel profile-panel">
      <label class="ob-pic"><input type="file" accept="image/*" id="pf-file" hidden><div class="avatar xl">${profile.picture ? `<img src="${profile.picture}" alt="">` : icon('user')}</div><span>Change photo</span></label>
      <div><div class="kicker">Account</div><h2 class="pf-name">${esc(profile.username)}</h2>
      <div class="row-btns"><button class="btn" data-act="rename-user">${icon('edit')}Change username</button>${profile.picture ? `<button class="btn ghost" data-act="remove-pic">Remove photo</button>` : ''}</div></div>
    </div>

    <div class="panel"><h2>${icon('restore')} Backup & restore</h2>
      <p class="muted">BAZINGA backs itself up automatically every time something changes. Last backup: <b>${lastB ? new Date(lastB).toLocaleString() : 'not yet'}</b>.</p>
      ${backup.fsSupported ? `<div class="sub-panel"><b>Auto-updating backup file</b>
        <p class="tiny muted">Pick a file on this device (e.g. in Documents or a synced folder). BAZINGA keeps it up to date automatically — it survives even if browser data is cleared.</p>
        ${fstate2 === 'ok' ? `<p class="ok-line">${icon('check')} Linked and up to date.</p><button class="btn ghost" data-act="bk-unlink">Unlink file</button>`
          : fstate2 === 'needs-permission' ? `<button class="btn primary" data-act="bk-regrant">Resume auto-backup (allow access)</button>`
          : `<button class="btn primary" data-act="bk-link">${icon('file')}Choose backup file</button>`}</div>`
        : `<div class="sub-panel"><b>Backup file</b><p class="tiny muted">This browser can't write to a file automatically, so download a backup now and then (last: ${lastD ? new Date(lastD).toLocaleDateString() : 'never'}). We'll remind you weekly.</p></div>`}
      <div class="row-btns"><button class="btn" data-act="bk-download">${icon('import')}Download backup now</button><button class="btn" data-act="bk-restore-file">${icon('restore')}Restore from file</button></div>
      ${snaps.length ? `<details class="howto"><summary>Automatic snapshots on this device (${snaps.length})</summary>${snaps.map(s => `<div class="snap"><span>${new Date(s.ts).toLocaleString()} · ${s.counts.tracks} songs, ${s.counts.playlists} playlists, ${s.counts.albums} albums</span><button class="btn sm ghost" data-act="bk-restore-snap" data-id="${s.id}">Restore</button></div>`).join('')}</details>` : ''}
      <p class="tiny muted">Backups contain your library, playlists, albums, YouTube matches, profile and settings. Offline music files aren't copied (they're large) — keep the originals and re-add them after a restore.</p>
    </div>

    <div class="panel"><h2>${icon('yt')} YouTube matching</h2>
      <p class="muted tiny">By default BAZINGA finds videos through free public services — no key, no limits, but they're sometimes slow or down. For rock-solid matching add your own free YouTube Data API key (Google Cloud Console → YouTube Data API v3 → Credentials). It's stored only on this device.</p>
      <form id="yt-form" class="stack">
        <label class="fld"><span>Your YouTube API key (optional)</span><input name="ytKey" value="${esc(settings.ytKey)}" placeholder="AIza…" autocomplete="off"></label>
        <label class="fld"><span>Custom Invidious server (optional)</span><input name="customInstance" value="${esc(settings.customInstance)}" placeholder="https://your-invidious.example"></label>
        <button class="btn">Save</button></form>
      <button class="btn ghost" data-act="clear-ytcache">Forget all YouTube matches</button>
    </div>

    <div class="panel"><h2>${icon('sparkle')} Music info</h2>
      <label class="toggle"><input type="checkbox" id="set-enrich" ${settings.enrich !== false ? 'checked' : ''}><span></span>Automatically fill in genres, release dates & artwork</label>
      <label class="fld"><span>Music store region (for search & albums)</span><select id="set-country" class="select">${['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'BR', 'MX', 'JP', 'KR', 'IN', 'NG', 'ZA', 'KE', 'ET', 'EG', 'AE', 'TR', 'PL', 'IE', 'NZ'].map(c => `<option ${settings.country === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <p class="tiny muted" id="enrich-status"></p>
    </div>

    <div class="panel danger-zone"><h2>${icon('trash')} Delete account</h2>
      <p class="muted">Erases your profile, library, playlists, albums, offline files and on-device backups from this device. A backup file you saved elsewhere is not touched.</p>
      <button class="btn danger" data-act="delete-account">Delete my account</button></div>
    <p class="tiny muted center"><a class="lnk" href="#/legal">Privacy Policy & Terms</a></p>
  </div>`;
  $('#pf-file').onchange = async e => { const f = e.target.files[0]; if (!f) return; profile.picture = await imageToDataURL(f, 256); await kv.set('profile', profile); emit('dirty'); renderProfileChip(); vSettings(); };
  $('#yt-form').onsubmit = async e => { e.preventDefault(); await saveSettings(Object.fromEntries(new FormData(e.target))); toast('Saved'); };
  $('#set-enrich').onchange = e => saveSettings({ enrich: e.target.checked });
  $('#set-country').onchange = e => saveSettings({ country: e.target.value });
  const st = () => { const el = $('#enrich-status'); if (el) { const n = store.enrichPending(); el.textContent = n ? `Filling in details for ${n} songs in the background…` : ''; } };
  st(); on('enrich', st);
}

// ---------- SHARED LINK ----------
async function vShared([data]) {
  let d;
  try { d = await unpackString(data); } catch { view().innerHTML = empty('This share link is broken', 'Ask your friend to share it again.'); return; }
  const tracks = (d.t || []).map(x => ({
    id: trackKey(x[1], x[0]), title: x[0], artist: x[1], artists: x[1].split(/\s*,\s*/), album: x[2] || '', year: x[3] || null, genre: x[4] || '', durationMs: x[5] || 0, artwork: x[6] || '', _yt: [x[7], x[8]]
  }));
  for (const t of tracks) { if (t._yt[0] || t._yt[1]) { const c = (await db.get('ytcache', t.id)) || {}; if (!c.video && t._yt[0]) c.video = t._yt[0]; if (!c.audio && t._yt[1]) c.audio = t._yt[1]; await db.put('ytcache', c, t.id); } delete t._yt; }
  const ts = tracks.map(t => lib.tracks.get(t.id) || store.remember(t));
  window.__shared = { d, tracks: ts };
  view().innerHTML = `<div class="page">${header(esc(d.n || 'Shared music'), `Shared by ${esc(d.by || 'a friend')} · ${ts.length} songs`, cover(d.a || ts[0]?.artwork, d.n), '', d.k === 'album' ? 'Album' : d.k === 'song' ? 'Song' : 'Playlist')}
    <div class="actions">${playBtns('play-list', 'shared')}<button class="btn primary-o" data-act="save-shared">${icon('plus')}Save to my library</button></div>
    ${tracksSection('shared', ts, { noFilter: true })}</div>`;
}

// ---------- LEGAL ----------
async function vLegal() {
  view().innerHTML = `<div class="page"><h1 class="page-h">Privacy Policy & Terms</h1><div class="panel legal">${LEGAL_HTML}
    <p class="ok-line">${icon('check')} You accepted version ${esc(profile.termsAccepted || '')}${profile.termsAcceptedAt ? ' on ' + new Date(profile.termsAcceptedAt).toLocaleDateString() : ''}.</p></div></div>`;
}

// ---------- QUEUE (full page on phones) ----------
async function vQueue() { view().innerHTML = `<div class="page"><h1 class="page-h">Queue</h1><div id="queue-page"></div></div>`; renderQueue($('#queue-page')); }

// ================= PROGRESS HELPER =================
function progress(label) {
  const root = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast prog';
  el.innerHTML = `<div class="pl">${esc(label)}</div><div class="bar"><i style="width:0%"></i></div><button class="ib sm" aria-label="Stop">${icon('close')}</button>`;
  root.appendChild(el);
  const ctl = { cancelled: false };
  el.querySelector('button').onclick = () => { ctl.cancelled = true; el.remove(); };
  const end = (msg, kind) => { el.remove(); if (msg) toast(msg, kind); };
  return Object.assign(ctl, {
    set(n, total) { el.querySelector('i').style.width = total ? (100 * n / total).toFixed(1) + '%' : '30%'; el.querySelector('.pl').textContent = `${label} ${n}${total ? '/' + total : ''}`; },
    done: m => end(m, 'ok'), fail: m => end(m, 'err'), close: () => end()
  });
}

// ================= YOUTUBE BATCH + EXPORT =================
async function matchList(ids) {
  const todo = [];
  for (const id of ids) { const c = await db.get('ytcache', id); if (!c || (!c.video && !c.audio)) todo.push(id); }
  if (!todo.length) return toast('All songs already have YouTube matches ✓');
  const prog = progress('Finding YouTube versions…');
  let found = 0, failed = 0;
  for (let i = 0; i < todo.length && !prog.cancelled; i++) {
    prog.set(i + 1, todo.length);
    try { const c = await yt.findForTrack(lib.tracks.get(todo[i])); if (c.video || c.audio) found++; }
    catch (e) { failed++; if (failed >= 3 && !found) { prog.fail(e.message); return; } }
    await sleep(250);
  }
  if (!prog.cancelled) prog.done(`Matched ${found} of ${todo.length} songs`);
  emit('dirty', 'yt');
}
async function ytExport(ids) {
  const vids = [], auds = [];
  let missing = 0;
  for (const id of ids) { const c = await db.get('ytcache', id); if (c?.video) vids.push(c.video); if (c?.audio) auds.push(c.audio); if (!c?.video && !c?.audio) missing++; }
  if (!vids.length && !auds.length) return toast('Tap "Find YouTube matches" first', 'err');
  const v = yt.youtubePlaylistLinks(vids), a = yt.youtubePlaylistLinks(auds);
  const part = (links, label) => links.map((l, i) => `<a class="btn ${i ? '' : 'primary'} block" href="${l}" target="_blank" rel="noopener">${icon('yt')}${label}${links.length > 1 ? ` — part ${i + 1}/${links.length}` : ''}</a>`).join('');
  modal(`<h3>Open as a YouTube playlist</h3>
    <p class="muted tiny">Opens YouTube with all songs queued as a playlist (YouTube allows 50 per link). On YouTube you can save it to your account.${missing ? ` ${missing} songs have no match yet.` : ''}</p>
    <h4>${icon('video')} Music videos (${vids.length})</h4>${part(v, 'Video playlist') || '<p class="muted tiny">None found.</p>'}
    <h4>${icon('audio')} Audio versions (${auds.length})</h4>${part(a, 'Audio playlist') || '<p class="muted tiny">None found.</p>'}`);
}

// ================= SHARING =================
async function shareTracks(kind, name, tracks, artwork) {
  const t = [];
  for (const x of tracks.slice(0, 400)) {
    const c = await db.get('ytcache', x.id) || {};
    t.push([x.title, x.artist, x.album || '', x.year || yearOf(x.releaseDate) || 0, x.genre || '', x.durationMs || 0, (x.artwork || '').startsWith('data:') ? '' : x.artwork || '', c.video || '', c.audio || '']);
  }
  const packed = await packToString({ k: kind, n: name, by: profile.username, a: (artwork || '').startsWith('data:') ? '' : artwork, t });
  const url = location.href.split('#')[0] + '#/s/' + packed;
  const text = `${name} — on BAZINGA! ⚡`;
  if (navigator.share && innerWidth < 900) { try { await navigator.share({ title: name, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  modal(`<h3>Share "${esc(name)}"</h3><p class="muted tiny">Anyone with this link can open, play and save it in their own BAZINGA. The whole ${kind} is packed inside the link — nothing is uploaded anywhere.</p>
    <div class="copy-box"><input readonly value="${esc(url)}"><button class="btn primary" data-act="copy" data-v="${esc(url)}">Copy</button></div>
    <div class="row-btns"><a class="btn ghost" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}">WhatsApp</a>
    <a class="btn ghost" target="_blank" rel="noopener" href="https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}">Telegram</a>
    <a class="btn ghost" target="_blank" rel="noopener" href="mailto:?subject=${encodeURIComponent(text)}&body=${encodeURIComponent(url)}">Email</a></div>`);
}

// ================= TRACK MENU =================
async function trackMenu(btn, id, plId) {
  const t = lib.tracks.get(id); if (!t) return;
  const c = await db.get('ytcache', id) || {};
  const pls = [...lib.playlists.values()];
  const k = await menu(btn, [
    { header: `<b>${esc(t.title)}</b><small>${esc(t.artist)}</small>` },
    { k: 'next', label: 'Play next', icon: 'play' },
    { k: 'queue', label: 'Add to queue', icon: 'queue' },
    { k: 'addpl', label: 'Add to playlist…', icon: 'plus' },
    { k: 'like', label: t.liked ? 'Remove from Liked' : 'Add to Liked Songs', icon: 'heart' },
    '-',
    t.album || t.itunesAlbumId ? { k: 'album', label: 'Go to album', icon: 'disc' } : null,
    t.album || t.itunesAlbumId ? { k: 'savealbum', label: 'Save full album', icon: 'plus' } : null,
    { k: 'artist', label: 'Go to artist', icon: 'mic' },
    { k: 'share', label: 'Share song', icon: 'share' },
    '-',
    { k: 'ytv', label: c.video ? 'Change music video link' : 'Set music video link', icon: 'video' },
    { k: 'yta', label: c.audio ? 'Change audio link' : 'Set audio link', icon: 'audio' },
    c.video || c.audio ? { k: 'ytopen', label: 'Open on YouTube', icon: 'yt' } : null,
    { k: 'file', label: t.localFileId ? 'Replace offline file' : 'Attach offline file', icon: 'offline' },
    t.localFileId ? { k: 'unfile', label: 'Remove offline file', icon: 'cloudOff' } : null,
    '-',
    plId ? { k: 'unpl', label: 'Remove from this playlist', icon: 'trash', danger: true } : null,
    !t.transient ? { k: 'del', label: 'Remove from library', icon: 'trash', danger: true } : null
  ]);
  if (!k) return;
  if (k === 'next' || k === 'queue') player.addToQueue(id, k === 'next');
  if (k === 'addpl') addToPlaylistDialog([id]);
  if (k === 'like') { await store.toggleLike(id); toast(lib.tracks.get(id).liked ? 'Added to Liked Songs' : 'Removed from Liked'); }
  if (k === 'album') gotoAlbum(t);
  if (k === 'savealbum') saveAlbumOf(t);
  if (k === 'artist') location.hash = '#/artist/' + encodeURIComponent(mainArtist(t.artist));
  if (k === 'share') shareTracks('song', `${t.title} — ${t.artist}`, [t], t.artwork);
  if (k === 'ytv' || k === 'yta') setYTLink(t, k === 'ytv' ? 'video' : 'audio', c);
  if (k === 'ytopen') window.open('https://www.youtube.com/watch?v=' + (c[P.mode] || c.video || c.audio), '_blank', 'noopener');
  if (k === 'file') pickFile('audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', f => attachFile(t, f));
  if (k === 'unfile') { await db.del('files', t.localFileId); await store.updateTrack(id, { localFileId: null }); toast('Offline file removed'); }
  if (k === 'unpl') { await store.removeFromPlaylist(plId, id); toast('Removed from playlist'); }
  if (k === 'del' && await confirmBox('Remove from library?', `"${esc(t.title)}" will be removed from your library and all playlists.`, 'Remove', true)) { await store.deleteTrack(id); toast('Removed'); }
}

async function attachFile(t, f) {
  if (t.transient) await store.upsertTracks([t]);
  const fileId = 'f_' + t.id;
  await db.put('files', { id: fileId, blob: f, name: f.name, type: f.type, size: f.size, addedAt: Date.now() });
  await store.updateTrack(t.id, { localFileId: fileId });
  toast('Available offline ✓');
}

async function setYTLink(t, mode, c) {
  const r = await modal(`<h3>${mode === 'video' ? 'Music video' : 'Audio'} for "${esc(t.title)}"</h3>
    ${c[mode] ? `<p class="muted tiny">Current: ${esc(c[mode + 'Title'] || c[mode])}</p>` : ''}
    <form><label class="fld"><span>Paste a YouTube link</span><input name="u" placeholder="https://youtube.com/watch?v=…" required></label>
    <div class="modal-actions"><a class="btn ghost" target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=${encodeURIComponent(t.artist + ' ' + t.title + (mode === 'audio' ? ' audio' : ' official video'))}">${icon('search')}Search YouTube</a><button class="btn primary">Save</button></div></form>
    <button class="btn ghost block" data-resolve="research">${icon('restore')}Search again automatically</button>`);
  if (!r) return;
  if (r === 'research') {
    try { await yt.findForTrack(t, { force: true }); toast('Updated'); } catch (e) { toast(e.message, 'err'); }
  } else {
    const vid = yt.parseYouTubeId(r.u);
    if (!vid) return toast('That doesn\'t look like a YouTube link', 'err');
    await yt.setManual(t.id, mode, vid);
    toast('Saved ✓');
  }
  emit('dirty', 'yt');
  if (player.current()?.id === t.id && P.mode === mode) player.reloadCurrent();
}

async function addToPlaylistDialog(ids) {
  const pls = [...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
  const r = await modal(`<h3>Add to playlist</h3><div class="pick-list">
    <button class="pick" data-resolve="__new">${'<div class="cover sm noimg"><span>+</span></div>'}<span><b>New playlist</b></span></button>
    ${pls.map(p => `<button class="pick" data-resolve="${p.id}">${cover(plCover(p), p.name, 'sm')}<span><b>${esc(p.name)}</b><small>${p.trackIds.length} songs</small></span></button>`).join('')}</div>`);
  if (!r) return;
  for (const id of ids) { const t = lib.tracks.get(id); if (t?.transient) await store.upsertTracks([t]); }
  if (r === '__new') {
    const name = await promptText('New playlist', '', 'Name', 'Create'); if (!name) return;
    await store.createPlaylist(name, ids); toast(`Added to "${name}"`);
  } else { const n = await store.addToPlaylist(r, ids); toast(n ? `Added to "${lib.playlists.get(r).name}"` : 'Already in that playlist'); }
  renderSidebarPlaylists();
}

async function resolveAlbum(t) {
  if (t.itunesAlbumId) return { href: `#/album/it/${t.itunesAlbumId}`, itunesAlbumId: t.itunesAlbumId };
  if (t.albumId && lib.albums.has(t.albumId)) return { href: `#/album/${encodeURIComponent(t.albumId)}` };
  if (!t.album) return null;
  const a = await meta.findAlbum(t.artist, t.album).catch(() => null);
  if (a) { store.updateTrack(t.id, { itunesAlbumId: a.itunesAlbumId }); return { href: `#/album/it/${a.itunesAlbumId}`, itunesAlbumId: a.itunesAlbumId }; }
  return { href: `#/album/${encodeURIComponent(t.albumId || albumKey(t.artist, t.album))}` };
}
async function gotoAlbum(t) {
  const r = await resolveAlbum(t);
  if (r) location.hash = r.href; else toast('Album not found', 'err');
}
async function saveAlbumOf(t) {
  const r = await resolveAlbum(t);
  if (!r?.itunesAlbumId) return toast('Couldn\'t find the full album', 'err');
  const { album, tracks } = await meta.albumTracks(r.itunesAlbumId);
  if (!album) return toast('Couldn\'t load that album', 'err');
  await store.saveAlbum(album, tracks.map(x => lib.tracks.get(x.id) ? { ...x, ...stripTransient(lib.tracks.get(x.id)) } : x));
  toast(`Saved album "${album.title}" (${tracks.length} songs)`);
}
const stripTransient = t => { const x = { ...t }; delete x.transient; return x; };

async function playlistMenu(btn, id) {
  const p = lib.playlists.get(id); if (!p) return;
  const k = await menu(btn, [
    { k: 'rename', label: 'Rename', icon: 'edit' },
    { k: 'cover', label: 'Change cover', icon: 'file' },
    { k: 'dup', label: 'Duplicate', icon: 'plus' },
    { k: 'csv', label: 'Export as CSV', icon: 'import' },
    p.spotifyId ? { k: 'resync', label: 'Re-sync from Spotify', icon: 'restore' } : null,
    '-', { k: 'del', label: 'Delete playlist', icon: 'trash', danger: true }
  ]);
  if (k === 'rename') { const n = await promptText('Rename playlist', p.name); if (n) { p.name = n; await store.savePlaylist(p); renderSidebarPlaylists(); } }
  if (k === 'cover') pickFile('image/*', async f => { p.image = await imageToDataURL(f, 400); await store.savePlaylist(p); });
  if (k === 'dup') { const np = await store.createPlaylist(p.name + ' (copy)', p.trackIds); renderSidebarPlaylists(); location.hash = '#/playlist/' + np.id; }
  if (k === 'csv') {
    const rows = [['Track Name', 'Artist Name(s)', 'Album Name', 'Release Date', 'Genres', 'Duration (ms)']];
    for (const tid of p.trackIds) { const t = lib.tracks.get(tid); if (t) rows.push([t.title, t.artist, t.album || '', t.releaseDate || t.year || '', t.genre || '', t.durationMs || '']); }
    downloadBlob(new Blob([rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' }), p.name + '.csv');
  }
  if (k === 'resync') {
    const pr = progress(`Syncing "${p.name}"…`);
    try { const tr = await sp.playlistTracks(p.spotifyId, (n, t) => pr.set(n, t)); const s = await store.upsertTracks(tr); p.trackIds = s.map(t => t.id); await store.savePlaylist(p); pr.done('Synced ✓'); }
    catch (e) { pr.fail(e.message); }
  }
  if (k === 'del' && await confirmBox('Delete playlist?', `"${esc(p.name)}" will be deleted. Songs stay in your library if they're liked or in other playlists/albums.`, 'Delete', true)) {
    await store.deletePlaylist(id); renderSidebarPlaylists(); location.hash = '#/library/playlists';
  }
}

// ================= GLOBAL EVENTS =================
function pickFile(accept, cb, { multiple = false, dir = false } = {}) {
  const i = document.createElement('input');
  i.type = 'file'; i.accept = accept; i.multiple = multiple;
  if (dir) i.webkitdirectory = true;
  i.onchange = () => { const fs = [...i.files]; if (fs.length) cb(multiple || dir ? fs : fs[0]); };
  i.click();
}

function idsForPlayAct(el) {
  const key = el.dataset.id;
  if (lists.has(key)) return lists.get(key);
  return [];
}

function wireGlobal() {
  document.addEventListener('click', async e => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act, id = a.dataset.id;
    switch (act) {
      case 'play-row': {
        if (e.target.closest('a')) return; // artist/album links
        const ids = lists.get(a.dataset.list) || [a.dataset.id];
        const i = +a.dataset.i;
        if (player.current()?.id === a.dataset.id && P.queue[P.cursor]?.id === a.dataset.id) { player.toggle(); return; }
        player.playList(ids, Math.min(i, ids.length - 1), { shuffle: false });
        break;
      }
      case 'like': e.stopPropagation(); { const t = lib.tracks.get(id); if (t?.transient) { await store.upsertTracks([{ ...t, liked: true }]); toast('Added to Liked Songs'); } else { const v = await store.toggleLike(id); toast(v ? 'Added to Liked Songs' : 'Removed from Liked'); } } break;
      case 'track-menu': e.stopPropagation(); trackMenu(a, id, a.dataset.pl); break;
      case 'goto-album': e.preventDefault(); e.stopPropagation(); gotoAlbum(lib.tracks.get(id)); break;
      case 'play-list': {
        const ids = lists.get(id) || [];
        if (a.dataset.queue) player.addToQueue(ids);
        else player.playList(ids, a.dataset.shuffle ? Math.floor(Math.random() * ids.length) : 0, { shuffle: !!a.dataset.shuffle });
        break;
      }
      case 'play-playlist': e.preventDefault(); e.stopPropagation(); player.playList(lib.playlists.get(id)?.trackIds || [], 0, { shuffle: false }); break;
      case 'play-album': {
        e.preventDefault(); e.stopPropagation();
        const al = lib.albums.get(id) || store.implicitAlbums().find(x => x.id === id);
        player.playList(al?.trackIds || [], 0, { shuffle: false }); break;
      }
      case 'play-artist': {
        e.preventDefault(); e.stopPropagation();
        const n = norm(a.dataset.name);
        player.playList(store.saved().filter(t => (t.artists?.length ? t.artists : [t.artist]).some(x => norm(x) === n) || norm(mainArtist(t.artist)) === n).map(t => t.id), 0, { shuffle: true }); break;
      }
      case 'toggle-filters': { const key = a.closest('[data-tsec]').dataset.tsec; fstate[key].open = !fstate[key].open; refreshSection(key); break; }
      case 'f-genre': { const key = a.closest('[data-tsec]').dataset.tsec; const f = fstate[key]; const g = a.dataset.g; f.genres = f.genres?.includes(g) ? f.genres.filter(x => x !== g) : [...(f.genres || []), g]; refreshSection(key); break; }
      case 'f-decade': { const key = a.closest('[data-tsec]').dataset.tsec; const f = fstate[key]; const d = +a.dataset.d; if (+f.from === d && +f.to === d + 9) { f.from = f.to = ''; } else { f.from = d; f.to = d + 9; } refreshSection(key); break; }
      case 'f-flag': { const key = a.closest('[data-tsec]').dataset.tsec; fstate[key][a.dataset.k] = !fstate[key][a.dataset.k]; refreshSection(key); break; }
      case 'f-clear': { const key = a.closest('[data-tsec]').dataset.tsec; Object.assign(fstate[key], { genres: [], from: '', to: '', liked: false, offline: false, q: '' }); refreshSection(key); break; }
      case 'new-playlist': { const n = await promptText('New playlist', '', 'Name', 'Create'); if (n) { const p = await store.createPlaylist(n); renderSidebarPlaylists(); location.hash = '#/playlist/' + p.id; } break; }
      case 'playlist-menu': playlistMenu(a, id); break;
      case 'share-playlist': { const p = lib.playlists.get(id); shareTracks('playlist', p.name, p.trackIds.map(x => lib.tracks.get(x)).filter(Boolean), plCover(p)); break; }
      case 'share-album': { const { album, tracks } = window.__album; shareTracks('album', `${album.title} — ${album.artist}`, tracks, album.artwork); break; }
      case 'save-album': { const { album, tracks } = window.__album; await store.saveAlbum(album, tracks.map(stripTransient)); toast(`Album saved to your library`); break; }
      case 'unsave-album': if (await confirmBox('Remove album?', 'The album will be removed from your library. Liked songs and songs in playlists stay.', 'Remove', true)) { await store.removeAlbum(id); toast('Album removed'); } break;
      case 'album-offline': { const { tracks } = window.__album; pickFile('audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', fs => addLocalFiles(fs, { albumHint: tracks }), { multiple: true }); break; }
      case 'save-shared': {
        const { d, tracks } = window.__shared;
        const saved = await store.upsertTracks(tracks.map(stripTransient));
        if (d.k === 'song') { await store.updateTrack(saved[0].id, { liked: true }); toast('Added to Liked Songs'); }
        else { const p = await store.createPlaylist(d.n, saved.map(t => t.id), { source: 'shared by ' + (d.by || 'friend'), image: d.a || '' }); renderSidebarPlaylists(); location.hash = '#/playlist/' + p.id; }
        break;
      }
      case 'match-list': matchList(lists.get(a.dataset.list) || []); break;
      case 'yt-export': ytExport(lists.get(a.dataset.list) || []); break;
      case 'sp-liked': spImportLiked(); break;
      case 'sp-playlists': spChoosePlaylists(); break;
      case 'sp-disconnect': await sp.disconnect(); vImport(); break;
      case 'add-files': pickFile('audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', fs => addLocalFiles(fs), { multiple: true }); break;
      case 'add-folder': pickFile('', fs => addLocalFiles(fs), { dir: true }); break;
      case 'copy': navigator.clipboard?.writeText(a.dataset.v).then(() => toast('Copied ✓')); break;
      case 'az': { e.preventDefault(); $(`[data-letter="${a.dataset.l}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
      case 'rename-user': { const n = await promptText('Change username', profile.username, 'Username'); if (n) { profile.username = n; await kv.set('profile', profile); emit('dirty'); renderProfileChip(); vSettings(); } break; }
      case 'remove-pic': profile.picture = ''; await kv.set('profile', profile); emit('dirty'); renderProfileChip(); vSettings(); break;
      case 'bk-link': try { await backup.linkFile(); vSettings(); } catch (err) { if (err.name !== 'AbortError') toast(err.message, 'err'); } break;
      case 'bk-regrant': await backup.regrant(); vSettings(); renderBackupNag(); break;
      case 'bk-unlink': await backup.unlinkFile(); vSettings(); break;
      case 'bk-download': await backup.download(); toast('Backup downloaded ✓'); renderBackupNag(); break;
      case 'bk-restore-file': pickFile('.json,application/json', async f => {
        if (!await confirmBox('Restore this backup?', 'Your current library will be replaced with the one in the backup file.', 'Restore')) return;
        try { await backup.restoreFromFile(f); toast('Restored ✓'); setTimeout(() => location.reload(), 600); } catch (err) { toast(err.message, 'err'); }
      }); break;
      case 'bk-restore-snap': if (await confirmBox('Restore snapshot?', 'Your current library will be replaced with this snapshot.', 'Restore')) { await backup.restoreInternal(id); location.reload(); } break;
      case 'clear-ytcache': if (await confirmBox('Forget YouTube matches?', 'Songs will be searched again next time they play.', 'Forget', true)) { await db.clear('ytcache'); toast('Done'); } break;
      case 'delete-account': deleteAccount(); break;
      case 'bk-nag-dl': await backup.download(); renderBackupNag(); break;
      case 'bk-nag-x': await kv.set('lastDownload', Date.now()); renderBackupNag(); break;
    }
  });
  // Keyboard: Enter on a row plays it; space toggles playback
  document.addEventListener('keydown', e => {
    if (e.target.matches('input,textarea,select')) return;
    if (e.key === 'Enter' && e.target.matches('.row')) e.target.click();
    if (e.code === 'Space' && !e.target.matches('button,a,.row')) { e.preventDefault(); player.toggle(); }
  });
  // Filter inputs
  document.addEventListener('input', e => {
    const f = e.target.dataset.f; if (!f) return;
    const key = e.target.closest('[data-tsec]')?.dataset.tsec; if (!key) return;
    fstate[key][f] = e.target.value;
    if (f === 'q' || f === 'from' || f === 'to') debouncedRefresh(key);
    else refreshSection(key);
  });
  document.addEventListener('change', e => {
    if (e.target.dataset.f === 'sort') { const key = e.target.closest('[data-tsec]').dataset.tsec; fstate[key].sort = e.target.value; refreshSection(key); }
  });
  // Drag & drop CSV/audio anywhere
  document.addEventListener('dragover', e => { if (profile) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (!profile) return; e.preventDefault();
    const fs = [...e.dataTransfer.files];
    const csv = fs.filter(f => /\.csv$/i.test(f.name)), aud = fs.filter(f => imp.AUDIO_EXT.test(f.name));
    const apple = fs.filter(f => /\.(xml|txt)$/i.test(f.name));
    if (csv.length) importCSVFiles(csv);
    if (apple.length) importAppleFiles(apple);
    if (aud.length) addLocalFiles(aud);
  });

  on('library', () => { renderSidebarPlaylists(); if (!document.querySelector('.modal-wrap') && !isTyping()) softRefresh(); });
  on('player', renderPlayer);
  on('time', renderTime);
  on('video-visible', v => document.body.classList.toggle('has-video', v));
  on('backup-state', renderBackupNag);
  window.addEventListener('online', () => document.body.classList.remove('is-offline'));
  window.addEventListener('offline', () => document.body.classList.add('is-offline'));
  if (!navigator.onLine) document.body.classList.add('is-offline');
  window.addEventListener('resize', placeDock);
  wirePlayerUI();
}
const debouncedRefresh = debounce(k => refreshSection(k, true), 200);
const isTyping = () => document.activeElement?.matches('input,textarea');
// Lighter refresh: only re-render sections in place when possible
function softRefresh() {
  const h = location.hash;
  if (/^#\/(search|import|settings|s\/)/.test(h)) return;
  rerender();
}

async function deleteAccount() {
  const ok = await modal(`<h3>Delete your account?</h3>
    <p class="muted">This permanently erases <b>${esc(profile.username)}</b> and everything BAZINGA saved on this device: library, playlists, albums, offline files and on-device backups. This can't be undone.</p>
    <form><label class="fld"><span>Type your username to confirm</span><input name="u" required autocomplete="off"></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn danger">Delete everything</button></div></form>`);
  if (!ok) return;
  if (ok.u.trim() !== profile.username) return toast('Username didn\'t match — nothing was deleted', 'err');
  player.stopAll();
  await db.destroy();
  try { localStorage.clear(); sessionStorage.clear(); } catch { }
  if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  location.replace(location.pathname);
}

// ================= SIDEBAR / PROFILE =================
function renderProfileChip() {
  const html = `<div class="avatar">${profile.picture ? `<img src="${profile.picture}" alt="">` : esc(profile.username[0].toUpperCase())}</div><span>${esc(profile.username)}</span>`;
  $$('.profile-chip').forEach(el => el.innerHTML = html);
}
function renderSidebarPlaylists() {
  const el = $('#side-pl'); if (!el) return;
  const pls = [...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = `<a href="#/library/liked" class="spl">${'<div class="cover sm noimg liked-cover"><span>♥</span></div>'}<span>Liked Songs</span></a>` +
    pls.map(p => `<a href="#/playlist/${p.id}" class="spl">${cover(plCover(p), p.name, 'sm')}<span>${esc(p.name)}</span></a>`).join('');
}
async function renderBackupNag() {
  const el = $('#nag'); if (!el || !profile) return;
  const st = backup.linkedFileState();
  const lastD = await kv.get('lastDownload');
  const n = store.saved().length;
  if (st === 'needs-permission') el.innerHTML = `<div class="nag">${icon('restore')}<span>Auto-backup to your file is paused.</span><button class="btn sm primary" data-act="bk-regrant">Resume</button></div>`;
  else if (!backup.fsSupported && n > 20 && (!lastD || Date.now() - lastD > 7 * 864e5)) el.innerHTML = `<div class="nag">${icon('restore')}<span>Keep your library safe — save a backup file to this device.</span><button class="btn sm primary" data-act="bk-nag-dl">Save backup</button><button class="ib sm" data-act="bk-nag-x" aria-label="Dismiss">${icon('close')}</button></div>`;
  else el.innerHTML = '';
}

// ================= PLAYER UI =================
function wirePlayerUI() {
  const bar = $('#playerbar'), np = $('#np');
  const handle = e => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const k = b.dataset.p;
    if (k === 'toggle') player.toggle();
    if (k === 'next') player.next();
    if (k === 'prev') player.prev();
    if (k === 'shuffle') player.setShuffle(!P.shuffle);
    if (k === 'repeat') player.cycleRepeat();
    if (k === 'mode') player.setMode(b.dataset.m);
    if (k === 'like') { const t = player.current(); if (t) (t.transient ? store.upsertTracks([{ ...t, liked: true }]) : store.toggleLike(t.id)).then(renderPlayer); }
    if (k === 'queue') toggleQueue();
    if (k === 'npq') toggleNPQueue();
    if (k === 'dock-min') { document.body.classList.toggle('dock-min'); try { localStorage.setItem('bz_dock_min', document.body.classList.contains('dock-min') ? '1' : ''); } catch { } placeDock(); }
    if (k === 'open') openNP();
    if (k === 'close') closeNP();
    if (k === 'more') { const t = player.current(); if (t) trackMenu(b, t.id); }
    if (k === 'mute') player.setVolume(P.volume > 0 ? 0 : 0.8);
    if (k === 'artist') { const t = player.current(); if (t) { closeNP(); location.hash = '#/artist/' + encodeURIComponent(mainArtist(t.artist)); } }
    if (k === 'album') { const t = player.current(); if (t) { closeNP(); gotoAlbum(t); } }
    if (k === 'dock-size') { document.body.classList.toggle('dock-big'); placeDock(); }
  };
  bar.addEventListener('click', handle); np.addEventListener('click', handle);
  $('#yt-dock').addEventListener('click', handle);
  for (const r of $$('.seek')) {
    r.addEventListener('input', () => { seeking = true; $$('.t-now').forEach(x => x.textContent = fmtTime(r.value * P.duration / 1000)); });
    r.addEventListener('change', () => { player.seek(r.value * P.duration / 1000); seeking = false; });
  }
  $$('.vol').forEach(v => v.addEventListener('input', () => player.setVolume(+v.value)));
  // Swipe down to close now-playing on phones
  let y0 = null;
  np.addEventListener('touchstart', e => { if (e.target.closest('.np-q-body, .grip') || $('.np-layout')?.scrollTop > 0 || e.target.closest('.np-scroll')?.scrollTop > 0) return; y0 = e.touches[0].clientY; }, { passive: true });
  try { if (localStorage.getItem('bz_dock_min')) document.body.classList.add('dock-min'); if (localStorage.getItem('bz_npq') !== '0') document.body.classList.add('np-q'); } catch { }
  np.addEventListener('touchend', e => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 110) closeNP(); y0 = null; });
}
let seeking = false;
function openNP() { if (!player.current()) return; document.body.classList.add('np-open'); renderNP(); requestAnimationFrame(placeDock); setTimeout(placeDock, 320); }
function closeNP() { document.body.classList.remove('np-open'); placeDock(); }
function toggleQueue() {
  if (innerWidth < 1000) { location.hash = '#/queue'; return; }
  document.body.classList.toggle('queue-open');
  if (document.body.classList.contains('queue-open')) renderQueue($('#queue-panel .qp-body'));
  placeDock();
}
function toggleNPQueue() {
  const on = !document.body.classList.contains('np-q');
  document.body.classList.toggle('np-q', on);
  try { localStorage.setItem('bz_npq', on ? '1' : '0'); } catch { }
  renderNP();
  if (on && innerWidth <= 900) setTimeout(() => $('.np-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}
function closeQueueOnMobile() { if (innerWidth < 1000) document.body.classList.remove('queue-open'); }

function renderPlayer() {
  const t = player.current();
  document.body.classList.toggle('has-track', !!t);
  const bar = $('#playerbar');
  if (!t) { bar.innerHTML = ''; return; }
  const modeBtns = `<div class="seg" role="group" aria-label="Playback version">
    <button data-p="mode" data-m="video" class="${P.mode === 'video' ? 'on' : ''}" title="Music video">${icon('video')}<span>Video</span></button>
    <button data-p="mode" data-m="audio" class="${P.mode === 'audio' ? 'on' : ''}" title="Audio only">${icon('audio')}<span>Audio</span></button></div>`;
  bar.innerHTML = `<div class="pb-progress"><i></i></div>
    <div class="pb-left" data-p="open">
      ${cover(t.artwork, t.title, 'pb-art')}
      <div class="pb-meta"><div class="pb-title">${esc(t.title)}</div><div class="pb-artist">${P.error ? `<span class="err-text">${esc(P.error)}</span>` : esc(t.artist)}</div></div>
      <button class="ib like ${t.liked && !t.transient ? 'on' : ''}" data-p="like" aria-label="Like">${icon(t.liked && !t.transient ? 'heartFill' : 'heart')}</button>
    </div>
    <div class="pb-center">
      <div class="pb-ctrls">
        <button class="ib hide-sm ${P.shuffle ? 'on' : ''}" data-p="shuffle" aria-label="Shuffle">${icon('shuffle')}</button>
        <button class="ib hide-sm" data-p="prev" aria-label="Previous">${icon('prev')}</button>
        <button class="play-btn ${P.loading ? 'busy' : ''}" data-p="toggle" aria-label="${P.playing ? 'Pause' : 'Play'}">${icon(P.playing ? 'pause' : 'play')}</button>
        <button class="ib" data-p="next" aria-label="Next">${icon('next')}</button>
        <button class="ib hide-sm ${P.repeat !== 'off' ? 'on' : ''}" data-p="repeat" aria-label="Repeat">${icon('repeat')}${P.repeat === 'one' ? '<b class="r1">1</b>' : ''}</button>
      </div>
      <div class="pb-seek hide-sm"><span class="t-now">${fmtTime(P.time)}</span><input type="range" class="seek" min="0" max="1000" value="0" aria-label="Seek"><span class="t-dur">${fmtTime(P.duration)}</span></div>
    </div>
    <div class="pb-right hide-sm">
      ${P.source === 'local' ? `<span class="badge">${icon('offline')}Offline file</span>` : modeBtns}
      <button class="ib ${document.body.classList.contains('queue-open') ? 'on' : ''}" data-p="queue" aria-label="Queue">${icon('queue')}</button>
      <button class="ib" data-p="mute" aria-label="Mute">${icon(P.volume > 0 ? 'volume' : 'mute')}</button>
      <input type="range" class="vol" min="0" max="1" step="0.01" value="${P.volume}" aria-label="Volume">
    </div>`;
  bar.querySelector('.seek')?.addEventListener('input', e => { seeking = true; }, { once: false });
  const s = bar.querySelector('.seek');
  if (s) { s.addEventListener('input', () => { seeking = true; bar.querySelector('.t-now').textContent = fmtTime(s.value * P.duration / 1000); }); s.addEventListener('change', () => { player.seek(s.value * P.duration / 1000); seeking = false; }); }
  bar.querySelector('.vol')?.addEventListener('input', e => player.setVolume(+e.target.value));
  renderTime();
  $$('.row').forEach(r => {
    const now = r.dataset.id === t.id;
    if (now !== r.classList.contains('now')) {
      r.classList.toggle('now', now);
      const num = r.querySelector('.row-num');
      const eq = num.querySelector('.eq');
      if (now && !eq) num.insertAdjacentHTML('afterbegin', '<span class="eq"><i></i><i></i><i></i></span>');
      if (!now && eq) eq.remove();
    }
  });
  document.body.classList.toggle('is-playing', P.playing);
  if (document.body.classList.contains('np-open')) renderNP();
  if (document.body.classList.contains('queue-open')) renderQueue($('#queue-panel .qp-body'));
  if (location.hash === '#/queue') renderQueue($('#queue-page'));
  const dt = $('#yt-dock .dock-title'); if (dt) dt.textContent = `${t.title} · ${t.artist}`;
  document.title = (P.playing ? '▶ ' : '') + `${t.title} · ${t.artist} — BAZINGA!`;
  placeDock();
}
function renderTime() {
  const pct = P.duration ? Math.min(1, P.time / P.duration) : 0;
  $$('.pb-progress i').forEach(i => i.style.width = (pct * 100) + '%');
  if (seeking) return;
  $$('.seek').forEach(s => s.value = Math.round(pct * 1000));
  $$('.t-now').forEach(x => x.textContent = fmtTime(P.time));
  $$('.t-dur').forEach(x => x.textContent = fmtTime(P.duration));
}

let qDragging = false;
function renderNP() {
  if (qDragging) return;
  const t = player.current(); if (!t) return closeNP();
  const np = $('#np');
  const keep = { lay: $('.np-layout')?.scrollTop || 0, sc: $('.np-scroll')?.scrollTop || 0, q: $('.np-q-body')?.scrollTop || 0 };
  const showVid = P.source === 'yt';
  const qOn = document.body.classList.contains('np-q');
  const upNext = Math.max(0, P.queue.length - P.cursor - 1);
  np.innerHTML = `<div class="np-bg" style="background-image:url('${esc(t.artwork || 'icons/icon-512.png')}')"></div>
    <div class="np-layout">
    <div class="np-scroll">
    <div class="np-top"><button class="ib" data-p="close" aria-label="Close">${icon('down')}</button><div class="np-ctx">Now playing</div><button class="ib" data-p="more" aria-label="More">${icon('more')}</button></div>
    <div class="np-media ${showVid ? 'vid' : ''}">${showVid ? '<div id="np-slot" class="np-slot"></div>' : cover(t.artwork, t.title, 'np-art')}</div>
    <div class="np-info"><div><h2>${esc(t.title)}</h2><button class="lnk np-artist" data-p="artist">${esc(t.artist)}</button>${t.album ? `<button class="lnk np-album" data-p="album">${icon('disc')}${esc(t.album)}</button>` : ''}</div>
      <button class="ib lg like ${t.liked && !t.transient ? 'on' : ''}" data-p="like" aria-label="Like">${icon(t.liked && !t.transient ? 'heartFill' : 'heart')}</button></div>
    ${P.error ? `<p class="err-text">${esc(P.error)}</p>` : ''}
    <div class="np-seek"><input type="range" class="seek" min="0" max="1000" value="0" aria-label="Seek"><div class="np-times"><span class="t-now">0:00</span><span class="t-dur">0:00</span></div></div>
    <div class="np-ctrls">
      <button class="ib lg ${P.shuffle ? 'on' : ''}" data-p="shuffle" aria-label="Shuffle">${icon('shuffle')}</button>
      <button class="ib xl" data-p="prev" aria-label="Previous">${icon('prev')}</button>
      <button class="play-btn big ${P.loading ? 'busy' : ''}" data-p="toggle" aria-label="Play/Pause">${icon(P.playing ? 'pause' : 'play')}</button>
      <button class="ib xl" data-p="next" aria-label="Next">${icon('next')}</button>
      <button class="ib lg ${P.repeat !== 'off' ? 'on' : ''}" data-p="repeat" aria-label="Repeat">${icon('repeat')}${P.repeat === 'one' ? '<b class="r1">1</b>' : ''}</button>
    </div>
    <div class="np-extra">
      ${P.source === 'local' ? `<span class="badge">${icon('offline')}Playing offline file</span>` : `<div class="seg big" role="group">
        <button data-p="mode" data-m="video" class="${P.mode === 'video' ? 'on' : ''}">${icon('video')}<span>Music video</span></button>
        <button data-p="mode" data-m="audio" class="${P.mode === 'audio' ? 'on' : ''}">${icon('audio')}<span>Audio only</span></button></div>`}
      <button class="chip ${qOn ? 'on' : ''}" data-p="npq" aria-pressed="${qOn}">${icon('queue')}${qOn ? 'Hide queue' : 'Show queue'}${upNext ? ` <small>${upNext}</small>` : ''}</button>
    </div>
    <div class="np-tags">${t.genre ? `<span class="pill">${esc(t.genre)}</span>` : ''}${t.year ? `<span class="pill">${t.year}</span>` : ''}${t.durationMs ? `<span class="pill">${fmtDur(t.durationMs)}</span>` : ''}</div>
    </div>
    ${qOn ? `<aside class="np-queue"><div class="np-q-head"><h3>Up next</h3><span class="muted tiny">Drag ${icon('grip')} to reorder</span><button class="ib sm" data-p="npq" aria-label="Hide queue">${icon('close')}</button></div><div class="np-q-body"></div></aside>` : ''}
    </div>`;
  const s = np.querySelector('.seek');
  s.addEventListener('input', () => { seeking = true; np.querySelector('.t-now').textContent = fmtTime(s.value * P.duration / 1000); });
  s.addEventListener('change', () => { player.seek(s.value * P.duration / 1000); seeking = false; });
  if (qOn) renderQueue(np.querySelector('.np-q-body'));
  np.querySelector('.np-layout').scrollTop = keep.lay; np.querySelector('.np-scroll').scrollTop = keep.sc;
  const qb = np.querySelector('.np-q-body'); if (qb) qb.scrollTop = keep.q;
  np.querySelector('.np-layout').addEventListener('scroll', placeDock, { passive: true });
  np.querySelector('.np-scroll').addEventListener('scroll', placeDock, { passive: true });
  renderTime();
  placeDock();
}

// The YouTube player lives in one fixed element (moving an iframe would reload it).
// We just position it over the right slot: the now-playing screen, or a corner mini-dock.
function placeDock() {
  const dock = $('#yt-dock');
  const vis = P.source === 'yt' && !!player.current();
  dock.classList.toggle('show', vis);
  if (!vis) return;
  const slot = document.body.classList.contains('np-open') ? $('#np-slot') : null;
  if (slot) {
    const r = slot.getBoundingClientRect();
    Object.assign(dock.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', right: 'auto', bottom: 'auto' });
    dock.classList.add('in-np');
  } else {
    dock.classList.remove('in-np');
    dock.removeAttribute('style');
  }
}
$('#np')?.addEventListener('scroll', placeDock, true);

function renderQueue(el) {
  if (!el || qDragging) return;
  const cur = player.current();
  if (!cur) { el.innerHTML = '<p class="muted pad">Nothing playing. Pick a song to start.</p>'; return; }
  const after = P.queue.slice(P.cursor + 1).map((q, j) => ({ ...q, i: P.cursor + 1 + j })).slice(0, 300);
  const row = q => { const t = lib.tracks.get(q.id); if (!t) return ''; return `<div class="qrow ${q.user ? 'user' : ''}" data-qi="${q.i}">
      <span class="grip" title="Drag to reorder">${icon('grip')}</span>${cover(t.artwork, t.title, 'sm')}<div class="row-main" data-qjump="${q.i}"><div class="row-title">${esc(t.title)}${q.user ? '<span class="qtag">queued</span>' : ''}</div><div class="row-sub">${esc(t.artist)}</div></div>
      <button class="ib sm" data-qrm="${q.i}" aria-label="Remove from queue" title="Remove">${icon('close')}</button></div>`; };
  el.innerHTML = `<div class="q-h">Now playing</div><div class="qrow now">${cover(cur.artwork, cur.title, 'sm')}<div class="row-main"><div class="row-title">${esc(cur.title)}</div><div class="row-sub">${esc(cur.artist)}</div></div></div>
    ${after.length ? `<div class="q-h">Next up <span>${after.some(q => q.user) ? '<button class="lnk" data-qclear>Clear queued</button>' : ''}</span></div><div class="qlist">${after.map(row).join('')}</div>`
      : '<p class="muted tiny pad">Nothing after this song. Use ⋯ → "Add to queue" on any song.</p>'}`;
  el.onclick = e => {
    if (el._dragged) { el._dragged = false; return; }
    const j = e.target.closest('[data-qjump]'); if (j) player.jumpTo(+j.dataset.qjump);
    const r = e.target.closest('[data-qrm]'); if (r) player.removeFromQueue(+r.dataset.qrm);
    if (e.target.closest('[data-qclear]')) player.clearUserQueue();
  };
  // Drag to reorder — pointer events, so it works with mouse AND touch
  el.onpointerdown = e => {
    const g = e.target.closest('.grip'); if (!g) return;
    const rowEl = g.closest('.qrow'), list = el.querySelector('.qlist'); if (!rowEl || !list) return;
    e.preventDefault();
    const from = +rowEl.dataset.qi;
    const startOrder = [...list.children].map(r => +r.dataset.qi);
    rowEl.classList.add('dragging'); qDragging = true;
    g.setPointerCapture(e.pointerId);
    const scroller = el.closest('.np-q-body, .qp-body, #main, .np-layout') || el;
    let raf = null, lastY = e.clientY;
    const autoscroll = () => {
      const r = scroller.getBoundingClientRect();
      if (lastY < r.top + 50) scroller.scrollTop -= 10; else if (lastY > r.bottom - 50) scroller.scrollTop += 10;
      raf = requestAnimationFrame(autoscroll);
    };
    raf = requestAnimationFrame(autoscroll);
    const move = ev => {
      lastY = ev.clientY;
      const sibs = [...list.children].filter(r => r !== rowEl);
      const before = sibs.find(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
      if (before) { if (rowEl.nextSibling !== before) list.insertBefore(rowEl, before); }
      else if (list.lastElementChild !== rowEl) list.appendChild(rowEl);
    };
    const up = () => {
      cancelAnimationFrame(raf);
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      rowEl.classList.remove('dragging'); qDragging = false;
      const newPos = [...list.children].indexOf(rowEl);
      const to = startOrder[newPos];
      if (to !== from) { el._dragged = true; player.moveInQueue(from, to); } else emit('player', P);
    };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  };
}

boot().catch(e => { console.error(e); const f = document.getElementById('boot-fail'); if (f) { f.hidden = false; f.style.display = 'grid'; f.querySelector('code').textContent = e.message; } });

return {  };
})();
})();
