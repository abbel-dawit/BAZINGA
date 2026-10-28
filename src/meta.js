// Music metadata (genre, release date, artwork, albums, artists) from Apple's free
// iTunes Search API, plus Deezer's free API as a fallback for cover art and
// artist photos. No keys, no accounts.
//
// Speed + safety:
//  • Every answer is cached on the device (memory + IndexedDB), so repeat visits cost 0 requests.
//  • A token bucket keeps us under Apple's ~20 requests/minute guideline, so the user's IP never
//    gets blocked. Things the user is waiting for (search, opening an album) always jump ahead of
//    background work (filling in genres), and background work leaves headroom for them.
//  • Identical requests in flight are shared, never sent twice.
import { jsonp, norm, mainArtist, albumKey, trackKey, yearOf, sleep } from './util.js';
import { db } from './db.js';

const BASE = 'https://itunes.apple.com';
let country = 'US';
export const setCountry = c => { country = (c || 'US').toUpperCase(); };

// ---------- persistent cache ----------
const mem = new Map();
const DAY = 864e5;
async function cached(key, ttl, fn) {
  const m = mem.get(key);
  if (m && (m.p || Date.now() - m.t < ttl)) return m.p || m.v;
  try {
    const hit = await db.get('metacache', key);
    if (hit && Date.now() - hit.t < ttl) { mem.set(key, { v: hit.v, t: hit.t }); return hit.v; }
  } catch { }
  const p = fn().then(v => {
    mem.set(key, { v, t: Date.now() });
    db.put('metacache', { v, t: Date.now() }, key).catch(() => { });
    return v;
  }, e => { mem.delete(key); throw e; });
  mem.set(key, { p });
  return p;
}
// Drop cache entries older than 30 days, once per start, when idle
setTimeout(async () => {
  try {
    const keys = await db.keys('metacache'), vals = await db.all('metacache');
    keys.forEach((k, i) => { if (Date.now() - (vals[i]?.t || 0) > 30 * DAY) db.del('metacache', k); });
  } catch { }
}, 20000);

// ---------- iTunes rate limiter (token bucket with priorities) ----------
const CAP = 9, REFILL_MS = 3000, BG_RESERVE = 4;
let tokens = CAP, lastRefill = Date.now(), pausedUntil = 0;
const waiting = [[], []]; // [foreground, background]
let pumping = false;
function refill() {
  const n = Math.floor((Date.now() - lastRefill) / REFILL_MS);
  if (n > 0) { tokens = Math.min(CAP, tokens + n); lastRefill += n * REFILL_MS; }
}
async function pump() {
  if (pumping) return; pumping = true;
  while (waiting[0].length || waiting[1].length) {
    refill();
    const now = Date.now();
    if (now < pausedUntil) { await sleep(pausedUntil - now); continue; }
    if (waiting[0].length && tokens >= 1) { tokens--; waiting[0].shift()(); continue; }
    if (!waiting[0].length && waiting[1].length && tokens > BG_RESERVE) { tokens--; waiting[1].shift()(); continue; }
    await sleep(Math.max(80, lastRefill + REFILL_MS - Date.now()));
  }
  pumping = false;
}
const slot = (bg) => new Promise(r => { waiting[bg ? 1 : 0].push(r); pump(); });
export const backgroundBusy = () => waiting[1].length;

async function call(path, params, { bg = false, ttl = DAY } = {}) {
  const q = new URLSearchParams({ ...params, country }).toString();
  const url = `${BASE}/${path}?${q}`;
  return cached('it:' + url, ttl, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await slot(bg);
      try { return (await jsonp(url, 10000)).results || []; }
      catch (e) {
        // Apple answers rate-limited requests with an error page: back off for everyone
        pausedUntil = Date.now() + 15000 * (attempt + 1);
        tokens = 0;
        if (attempt === 2 || !navigator.onLine) throw e;
      }
    }
  });
}

// ---------- Deezer (covers + artist photos; generous limits, still spaced politely) ----------
let dzLast = 0;
async function deezer(path, params, ttl = 7 * DAY) {
  const url = `https://api.deezer.com/${path}?${new URLSearchParams({ ...params, output: 'jsonp' })}`;
  return cached('dz:' + url, ttl, async () => {
    const wait = dzLast + 150 - Date.now(); dzLast = Math.max(Date.now(), dzLast + 150);
    if (wait > 0) await sleep(wait);
    const d = await jsonp(url, 8000);
    if (d?.error) throw new Error(d.error.message || 'Deezer error');
    return d?.data || [];
  });
}
export async function deezerCover(t) {
  const q = `artist:"${mainArtist(t.artist)}" track:"${String(t.title).replace(/\s*[\(\[].*?[\)\]]/g, '')}"`;
  let res = await deezer('search', { q, limit: 5 });
  if (!res.length) res = await deezer('search', { q: `${mainArtist(t.artist)} ${t.title}`, limit: 5 });
  const na = norm(mainArtist(t.artist));
  const hit = res.find(r => norm(r.artist?.name).includes(na) || na.includes(norm(r.artist?.name))) || null;
  return hit ? { artwork: hit.album?.cover_xl || hit.album?.cover_big || '', album: hit.album?.title || '', durationMs: (hit.duration || 0) * 1000 } : null;
}
const picMem = new Map();
export async function artistPicture(name) {
  const k = norm(name); if (!k) return '';
  if (picMem.has(k)) return picMem.get(k);
  const p = deezer('search/artist', { q: mainArtist(name), limit: 3 }, 14 * DAY).then(res => {
    const a = res.find(r => norm(r.name) === k) || res[0];
    const pic = a?.picture_xl || a?.picture_big || '';
    return /\/artist\/\/|images\/artist\/?$/.test(pic) ? '' : pic; // Deezer's blank placeholder
  }).catch(() => '');
  picMem.set(k, p);
  return p;
}

// ---------- iTunes helpers ----------
export const art = (u, size = 600) => u ? u.replace(/\/\d+x\d+(bb)?\./, `/${size}x${size}bb.`) : '';

export function songFromItunes(r) {
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
export function albumFromItunes(r) {
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

export async function searchSongs(term, limit = 25, o) {
  return (await call('search', { term, media: 'music', entity: 'song', limit }, o)).filter(r => r.kind === 'song').map(songFromItunes);
}
export async function searchAlbums(term, limit = 25, o) {
  return (await call('search', { term, media: 'music', entity: 'album', limit }, o)).filter(r => r.collectionType === 'Album').map(albumFromItunes);
}
export async function searchArtists(term, limit = 10, o) {
  return (await call('search', { term, media: 'music', entity: 'musicArtist', limit }, o))
    .map(r => ({ name: r.artistName, itunesArtistId: r.artistId, genre: r.primaryGenreName || '' }));
}

export async function albumTracks(itunesAlbumId) {
  const res = await call('lookup', { id: itunesAlbumId, entity: 'song', limit: 200 }, { ttl: 14 * DAY });
  const album = res.find(r => r.wrapperType === 'collection');
  const songs = res.filter(r => r.wrapperType === 'track' && r.kind === 'song').map(songFromItunes)
    .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber));
  return { album: album ? albumFromItunes(album) : null, tracks: songs };
}

export async function artistAlbums(itunesArtistId, o) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'album', limit: 200 }, { ttl: 3 * DAY, ...o });
  const seen = new Set();
  return res.filter(r => r.wrapperType === 'collection' && r.collectionType === 'Album').map(albumFromItunes)
    .filter(a => { const k = norm(a.title); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
}
export async function artistTopSongs(itunesArtistId) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'song', limit: 25 }, { ttl: 3 * DAY });
  return res.filter(r => r.wrapperType === 'track').map(songFromItunes);
}
// Newest releases (albums, EPs and singles) for an artist
export async function artistLatest(itunesArtistId, o) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'album', sort: 'recent', limit: 6 }, { ttl: DAY / 2, ...o });
  return res.filter(r => r.wrapperType === 'collection').map(albumFromItunes);
}
export async function findArtistId(name, o) {
  const res = await searchArtists(mainArtist(name), 5, { ttl: 30 * DAY, ...o });
  const n = norm(mainArtist(name));
  return (res.find(a => norm(a.name) === n) || res[0])?.itunesArtistId || null;
}

// Best iTunes match for a song we only know by name (fills genre/date/artwork/album)
export async function matchTrack(t, o = { bg: true }) {
  const res = await searchSongs(`${mainArtist(t.artist)} ${t.title}`, 10, { ttl: 30 * DAY, ...o });
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

export async function findAlbum(artist, title) {
  const res = await searchAlbums(`${mainArtist(artist)} ${title}`, 10, { ttl: 14 * DAY });
  const nt = norm(title), na = norm(mainArtist(artist));
  return res.find(a => norm(a.title) === nt && norm(a.artist).includes(na))
      || res.find(a => norm(a.title).includes(nt) && norm(a.artist).includes(na))
      || null;
}
