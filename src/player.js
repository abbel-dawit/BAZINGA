// Playback engine: YouTube (music video or audio upload) or an offline file on the device.
import { db, kv } from './db.js';
import { lib } from './store.js';
import * as store from './store.js';
import * as yt from './youtube.js';
import { emit, toast, debounce } from './util.js';

export const P = {
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

export const current = () => (P.cursor >= 0 && P.queue[P.cursor]) ? lib.tracks.get(P.queue[P.cursor].id) : null;

export async function restore() {
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
    if (!t.artwork) store.coverFromVideo(t.id, c.audio || c.video);
    if (!id) throw new Error('No YouTube match found for this song. Use ⋯ → "Set YouTube link".');
    if (!c[P.mode]) toast(`No ${P.mode === 'video' ? 'music video' : 'audio upload'} found — playing the other version`);
    await startYT(id);
    if (!autoplay) ytPlayer.pauseVideo();
    startTick();
    prefetchNext(my);
  } catch (e) {
    if (my !== loadToken) return;
    P.error = e.message; P.loading = false; P.playing = false; changed();
  }
}

// Look up the next couple of songs while this one plays, so skipping is instant.
function prefetchNext(my) {
  setTimeout(() => {
    if (my !== loadToken || !navigator.onLine) return;
    for (const q of P.queue.slice(P.cursor + 1, P.cursor + 3)) {
      const t = lib.tracks.get(q.id);
      if (t && !(t.localFileId && P.preferOffline)) yt.findForTrack(t).catch(() => { });
    }
  }, 2500);
}

function ended() {
  if (P.repeat === 'one') { seek(0); play(); return; }
  next(true);
}
audio.addEventListener('ended', () => P.source === 'local' && ended());
audio.addEventListener('play', () => { P.playing = true; changed(); });
audio.addEventListener('pause', () => { P.playing = false; changed(); });
audio.addEventListener('error', () => { if (P.source === 'local') { P.error = 'Could not play the offline file.'; changed(); } });

export function play() {
  if (!current()) return;
  if (P.source === 'local') audio.play();
  else if (P.source === 'yt' && ytPlayer) ytPlayer.playVideo();
  else load(true);
}
export function pause() {
  if (P.source === 'local') audio.pause();
  else if (ytPlayer?.pauseVideo) ytPlayer.pauseVideo();
  P.playing = false; changed();
}
export const toggle = () => P.playing ? pause() : play();

export function seek(sec) {
  if (P.source === 'local') audio.currentTime = sec;
  else ytPlayer?.seekTo?.(sec, true);
  P.time = sec; emit('time', P);
}

export function next(auto = false) {
  if (!P.queue.length) return;
  if (P.cursor < P.queue.length - 1) P.cursor++;
  else if (P.repeat === 'all') P.cursor = 0;
  else { if (auto) { P.playing = false; changed(); } return; }
  load(true);
}
export function prev() {
  if (P.time > 4) return seek(0);
  if (P.cursor > 0) { P.cursor--; load(true); }
  else seek(0);
}

// Replace the queue with a list and start at `start`
export function playList(ids, start = 0, { shuffle = P.shuffle } = {}) {
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
export function addToQueue(ids, playNext = false) {
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
export function removeFromQueue(i) {
  if (i === P.cursor) return;
  P.queue.splice(i, 1);
  if (i < P.cursor) P.cursor--;
  persist(); changed();
}
export function moveInQueue(from, to) {
  if (from === to) return;
  const [it] = P.queue.splice(from, 1);
  P.queue.splice(to, 0, it);
  if (P.cursor === from) P.cursor = to;
  else if (from < P.cursor && to >= P.cursor) P.cursor--;
  else if (from > P.cursor && to <= P.cursor) P.cursor++;
  persist(); changed();
}
export function jumpTo(i) { P.cursor = i; load(true); }
export function clearQueue() { P.queue = P.queue.slice(0, P.cursor + 1); persist(); changed(); }
export function clearUserQueue() { P.queue = P.queue.filter((q, i) => i <= P.cursor || !q.user); persist(); changed(); }

export function setShuffle(v) {
  P.shuffle = v;
  if (v && P.cursor >= 0) {
    const rest = P.queue.slice(P.cursor + 1).sort(() => Math.random() - 0.5);
    P.queue = [...P.queue.slice(0, P.cursor + 1), ...rest];
  }
  persist(); changed();
}
export function cycleRepeat() { P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat]; persist(); changed(); }
export function setVolume(v) { P.volume = v; audio.volume = v; ytPlayer?.setVolume?.(v * 100); persist(); changed(); }

// Switch between music video and audio-only version, keeping position
export async function setMode(mode) {
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
export function setPreferOffline(v) { P.preferOffline = v; persist(); }
export const reloadCurrent = () => load(true);

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
export function stopAll() {
  loadToken++; audio.pause(); audio.removeAttribute('src');
  try { ytPlayer?.stopVideo?.(); } catch { }
  P.queue = []; P.cursor = -1; P.playing = false; changed();
}
