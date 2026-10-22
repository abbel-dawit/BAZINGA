// Finding YouTube videos for each song — free and keyless by default.
// Order of attempts:
//   1. Your own YouTube Data API key (optional, Settings) — most reliable.
//   2. Public Invidious instances (open-source YouTube front-ends with a free JSON API).
//   3. Public Piped instances.
// Every match is cached on the device, so a song is only ever looked up once.
import { db } from './db.js';
import { norm, mainArtist, sleep } from './util.js';

let settings = { ytKey: '', customInstance: '' };
export const setYTSettings = s => { settings = { ...settings, ...s }; };

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

export async function rawSearch(q) {
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

export async function findForTrack(t, { force = false } = {}) {
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

export async function setManual(trackId, mode, id, title = '') {
  const c = (await db.get('ytcache', trackId)) || {};
  c[mode] = id; c[mode + 'Title'] = title || 'Set manually'; c.manual = true; c.checkedAt = Date.now();
  await db.put('ytcache', c, trackId);
  return c;
}

export function parseYouTubeId(input) {
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
export function youtubePlaylistLinks(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    out.push('https://www.youtube.com/watch_videos?video_ids=' + ids.slice(i, i + 50).join(','));
  }
  return out;
}
