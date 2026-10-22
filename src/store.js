// The user's library, kept in memory and mirrored to IndexedDB.
import { db } from './db.js';
import { uid, emit, debounce, norm, mainArtist, albumKey } from './util.js';
import * as meta from './meta.js';

export const lib = {
  tracks: new Map(),
  albums: new Map(),
  playlists: new Map()
};

const changed = debounce(() => emit('library'), 120);
export const notify = (why = 'change') => { changed(); emit('dirty', why); };

export async function load() {
  const [t, a, p] = await Promise.all([db.all('tracks'), db.all('albums'), db.all('playlists')]);
  lib.tracks = new Map(t.map(x => [x.id, x]));
  lib.albums = new Map(a.map(x => [x.id, x]));
  lib.playlists = new Map(p.map(x => [x.id, x]));
}

// Merge incoming tracks into the library, never throwing away data we already have.
export async function upsertTracks(list, extra = {}) {
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
export function remember(t) {
  if (!lib.tracks.has(t.id)) lib.tracks.set(t.id, { ...t, transient: true });
  return lib.tracks.get(t.id);
}
export const saved = () => [...lib.tracks.values()].filter(t => !t.transient);

export async function updateTrack(id, patch) {
  const t = lib.tracks.get(id); if (!t) return;
  if (t.transient) { Object.assign(t, patch); await upsertTracks([t]); return; }
  Object.assign(t, patch);
  await db.put('tracks', t);
  notify('track');
}

export async function toggleLike(id) {
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

export async function deleteTrack(id) {
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
export async function createPlaylist(name, trackIds = [], extra = {}) {
  const p = { id: uid('pl'), name: name || 'New playlist', trackIds: [...new Set(trackIds)], createdAt: Date.now(), ...extra };
  lib.playlists.set(p.id, p);
  await db.put('playlists', p);
  notify('playlist');
  return p;
}
export async function savePlaylist(p) { lib.playlists.set(p.id, p); await db.put('playlists', p); notify('playlist'); }
export async function addToPlaylist(pid, ids) {
  const p = lib.playlists.get(pid); if (!p) return 0;
  const before = p.trackIds.length;
  p.trackIds = [...new Set([...p.trackIds, ...ids])];
  await savePlaylist(p);
  return p.trackIds.length - before;
}
export async function removeFromPlaylist(pid, id) {
  const p = lib.playlists.get(pid); if (!p) return;
  p.trackIds = p.trackIds.filter(x => x !== id);
  await savePlaylist(p); await gc([id]);
}
export async function deletePlaylist(pid) {
  const p = lib.playlists.get(pid); if (!p) return;
  lib.playlists.delete(pid); await db.del('playlists', pid);
  await gc(p.trackIds); notify('playlist');
}

// ---------- Albums ----------
export async function saveAlbum(album, tracks) {
  const saved = await upsertTracks(tracks.map(t => ({ ...t, album: album.title, albumId: album.id, itunesAlbumId: album.itunesAlbumId || t.itunesAlbumId })));
  const a = { ...album, trackIds: saved.map(t => t.id), savedAt: Date.now() };
  lib.albums.set(a.id, a);
  await db.put('albums', a);
  notify('album');
  return a;
}
export async function removeAlbum(id) {
  const a = lib.albums.get(id); if (!a) return;
  lib.albums.delete(id); await db.del('albums', id);
  await gc(a.trackIds || []); notify('album');
}

// ---------- Derived views ----------
export function artists() {
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

export function genres() {
  const m = new Map();
  for (const t of saved()) if (t.genre) m.set(t.genre, (m.get(t.genre) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// Albums the user has songs from but hasn't explicitly saved
export function implicitAlbums() {
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
export const setEnrich = v => { enrichOn = v; if (v) queueEnrich([...lib.tracks.values()]); };
export const enrichPending = () => enrichQ.length;
export function queueEnrich(list) {
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
