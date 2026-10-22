// Music metadata (genre, release date, artwork, albums, artists) from Apple's free
// iTunes Search API — no key, no account. Results are cached on the device.
import { jsonp, norm, mainArtist, albumKey, trackKey, yearOf, sleep } from './util.js';

const BASE = 'https://itunes.apple.com';
let country = 'US';
export const setCountry = c => { country = (c || 'US').toUpperCase(); };

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

export async function searchSongs(term, limit = 25) {
  return (await call('search', { term, media: 'music', entity: 'song', limit })).filter(r => r.kind === 'song').map(songFromItunes);
}
export async function searchAlbums(term, limit = 25) {
  return (await call('search', { term, media: 'music', entity: 'album', limit })).filter(r => r.collectionType === 'Album').map(albumFromItunes);
}
export async function searchArtists(term, limit = 10) {
  return (await call('search', { term, media: 'music', entity: 'musicArtist', limit }))
    .map(r => ({ name: r.artistName, itunesArtistId: r.artistId, genre: r.primaryGenreName || '' }));
}

// Full album tracklist
export async function albumTracks(itunesAlbumId) {
  const res = await call('lookup', { id: itunesAlbumId, entity: 'song', limit: 200 });
  const album = res.find(r => r.wrapperType === 'collection');
  const songs = res.filter(r => r.wrapperType === 'track' && r.kind === 'song').map(songFromItunes)
    .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber));
  return { album: album ? albumFromItunes(album) : null, tracks: songs };
}

export async function artistAlbums(itunesArtistId) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'album', limit: 200 });
  const seen = new Set();
  return res.filter(r => r.wrapperType === 'collection' && r.collectionType === 'Album').map(albumFromItunes)
    .filter(a => { const k = norm(a.title); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
}
export async function artistTopSongs(itunesArtistId) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'song', limit: 25 });
  return res.filter(r => r.wrapperType === 'track').map(songFromItunes);
}
export async function findArtistId(name) {
  const res = await searchArtists(mainArtist(name), 5);
  const n = norm(mainArtist(name));
  return (res.find(a => norm(a.name) === n) || res[0])?.itunesArtistId || null;
}

// Find the best iTunes match for a track we only know by name, to fill in
// genre / release date / artwork / album id.
export async function matchTrack(t) {
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

export async function findAlbum(artist, title) {
  const res = await searchAlbums(`${mainArtist(artist)} ${title}`, 10);
  const nt = norm(title), na = norm(mainArtist(artist));
  return res.find(a => norm(a.title) === nt && norm(a.artist).includes(na))
      || res.find(a => norm(a.title).includes(nt) && norm(a.artist).includes(na))
      || null;
}
