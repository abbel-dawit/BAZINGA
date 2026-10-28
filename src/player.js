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
let wantPlay = false;      // the listener wants music playing (used to undo pauses the phone does on its own)
let resumeAt = 0, resumeFor = null; // where to pick up the restored song after a refresh
let duckLevel = 1;         // temporary volume dip while the voice assistant talks (never saved)
let endHook = null;        // app.js: what to play when the queue runs out

const changed = () => {
  emit('player', P);
  if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = current() ? (P.playing || (wantPlay && P.loading) ? 'playing' : 'paused') : 'none'; } catch { }
};
const persist = debounce(() => kv.set('player', {
  queue: P.queue, cursor: P.cursor, mode: P.mode, shuffle: P.shuffle, repeat: P.repeat, volume: P.volume, preferOffline: P.preferOffline,
  time: Math.floor(P.time || 0)
}), 500);
export const setEndHook = fn => { endHook = fn; };
const outVol = () => Math.max(0, Math.min(1, P.volume * duckLevel));

// Ask the phone for a proper music audio session (high quality, keeps playing when locked).
// Safari 17+ supports this; elsewhere it's a harmless no-op.
export function audioMode(type = 'playback') { try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch { } }

export const current = () => (P.cursor >= 0 && P.queue[P.cursor]) ? lib.tracks.get(P.queue[P.cursor].id) : null;

export async function restore() {
  const s = await kv.get('player');
  if (s) { Object.assign(P, s, { playing: false }); resumeAt = +s.time || 0; P.time = resumeAt; }
  P.queue = P.queue.filter(q => lib.tracks.has(q.id));
  if (P.cursor >= P.queue.length) P.cursor = P.queue.length - 1;
  const t = current();
  if (t) P.duration = (t.durationMs || 0) / 1000;
  if (resumeAt && P.duration && resumeAt > P.duration - 5) resumeAt = P.time = 0;
  resumeFor = t?.id || null;
  audio.volume = P.volume;
  setupMediaSession();
  changed();
}

// ---------- YouTube IFrame player ----------
function loadYT() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => {
      ytPlayer = new YT.Player('yt-player', {
        width: '100%', height: '100%',
        // cc_load_policy 0 + unloading the captions module = no subtitles by default
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, cc_load_policy: 0, iv_load_policy: 3, ...(location.protocol.startsWith('http') ? { origin: location.origin } : {}) },
        events: {
          onReady: () => { ytPlayer.setVolume(outVol() * 100); resolve(ytPlayer); },
          onStateChange: e => {
            if (P.source !== 'yt') return;
            if (e.data === YT.PlayerState.PLAYING) { P.playing = true; P.loading = false; P.needsTap = false; wantPlay = true; resumeTries = 0; noCaptions(); changed(); }
            else if (e.data === YT.PlayerState.PAUSED) {
              if (isRerouting()) return;
              // Phones pause YouTube when you leave the browser or lock the screen. If you didn't
              // ask for that, start it again straight away.
              if (wantPlay && document.hidden && Date.now() - hiddenAt < 4000 && resumeTries < 6) { resumeTries++; setTimeout(() => { if (wantPlay) ytPlayer.playVideo(); }, 200 * resumeTries); return; }
              P.playing = false; if (!document.hidden) wantPlay = false; changed();
            }
            else if (e.data === YT.PlayerState.ENDED) ended();
            else if (e.data === YT.PlayerState.BUFFERING) { P.loading = true; changed(); }
            else if (e.data === YT.PlayerState.CUED && wantPlay) ytPlayer.playVideo();
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

let ytRetried = false, resumeTries = 0, hiddenAt = 0, captionsOffFor = null;
function noCaptions() {
  if (captionsOffFor === P.ytId) return; captionsOffFor = P.ytId;
  try { ytPlayer.unloadModule('captions'); ytPlayer.unloadModule('cc'); } catch { }
  try { ytPlayer.setOption('captions', 'track', {}); } catch { }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  hiddenAt = Date.now();
  // Leaving the browser / locking the phone: keep going
  if (wantPlay && P.source === 'yt') setTimeout(() => { try { if (wantPlay && ytPlayer?.getPlayerState?.() !== 1) ytPlayer.playVideo(); } catch { } }, 500);
  if (wantPlay && P.source === 'local' && audio.paused) audio.play().catch(() => { });
  persist();
});
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

let tickN = 0;
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
    if (P.playing && ++tickN % 10 === 0) persist(); // remember the spot every ~5 s
  }, 500);
}

let startWatch = null;
async function startYT(id, start = 0) {
  P.source = 'yt'; P.ytId = id; P.loading = true; P.needsTap = false; changed();
  const pl = await loadYT();
  pl.loadVideoById(start > 1 ? { videoId: id, startSeconds: start } : id);
  pl.setVolume(outVol() * 100);
  emit('video-visible', true);
  // Some phones (iPhone especially) only let YouTube start after you tap the video itself once.
  // If nothing has started after a few seconds, show the video so one tap starts it.
  clearTimeout(startWatch);
  const my = loadToken;
  startWatch = setTimeout(() => {
    if (my !== loadToken || !wantPlay || P.source !== 'yt' || document.hidden) return;
    let st = -9; try { st = ytPlayer.getPlayerState(); } catch { }
    if (st === -1 || st === 5 || st === 2 && !P.playing) { P.needsTap = true; P.loading = false; changed(); emit('needs-tap'); }
  }, 3500);
}
// Load the YouTube player in the background right after start-up, so the first song starts instantly
export function warmup() { if (location.protocol.startsWith('http') && navigator.onLine) loadYT().catch(() => { }); }

// ---------- Core ----------
async function load(autoplay = true) {
  const my = ++loadToken;
  const t = current();
  const at = resumeFor && resumeFor === t?.id ? resumeAt : 0; resumeAt = 0; resumeFor = null;
  audio.pause();
  if (P.source !== 'yt') { try { ytPlayer?.pauseVideo?.(); } catch { } }
  P.error = ''; P.time = at; P.duration = (t?.durationMs || 0) / 1000; ytRetried = false;
  if (!t) { P.playing = false; P.source = null; wantPlay = false; changed(); return; }
  if (autoplay) { wantPlay = true; audioMode('playback'); }
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
      audio.volume = outVol();
      if (at) audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = at; } catch { } }, { once: true });
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
    await startYT(id, at);
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
    const around = [...P.queue.slice(P.cursor + 1, P.cursor + 4), ...(P.cursor > 0 ? [P.queue[P.cursor - 1]] : [])];
    for (const q of around) {
      const t = lib.tracks.get(q.id);
      if (t && !(t.localFileId && P.preferOffline)) yt.findForTrack(t).catch(() => { });
    }
  }, 600);
}
// Start looking up a song the moment the pointer rests on it, so tapping it plays right away
export function prefetch(id) {
  const t = lib.tracks.get(id);
  if (t && navigator.onLine && !(t.localFileId && P.preferOffline)) yt.findForTrack(t).catch(() => { });
}

function ended() {
  if (P.repeat === 'one') { seek(0); play(); return; }
  next(true);
}
audio.addEventListener('ended', () => P.source === 'local' && ended());
audio.addEventListener('play', () => { P.playing = true; changed(); });
audio.addEventListener('pause', () => { if (isRerouting()) return; P.playing = false; changed(); });
audio.addEventListener('error', () => { if (P.source === 'local') { P.error = 'Could not play the offline file.'; changed(); } });

export function play() {
  if (!current()) return;
  wantPlay = true; audioMode('playback');
  if (P.source === 'local') audio.play();
  else if (P.source === 'yt' && ytPlayer) ytPlayer.playVideo();
  else load(true);
}
export function pause() {
  wantPlay = false;
  if (P.source === 'local') audio.pause();
  else if (ytPlayer?.pauseVideo) ytPlayer.pauseVideo();
  P.playing = false; changed();
}
export const toggle = () => P.playing ? pause() : play();

export function seek(sec) {
  if (!P.source) { resumeAt = sec; resumeFor = current()?.id || null; } // not started yet (e.g. after a refresh): start from here
  if (P.source === 'local') audio.currentTime = sec;
  else ytPlayer?.seekTo?.(sec, true);
  P.time = sec; emit('time', P);
}

export function next(auto = false) {
  if (!P.queue.length) return;
  if (P.cursor < P.queue.length - 1) P.cursor++;
  else if (P.repeat === 'all') P.cursor = 0;
  else {
    // Queue finished: autoplay (replay the queue or start Liked Songs — Settings → Playback)
    const plan = endHook?.(P.queue.map(q => q.id));
    if (plan?.ids?.length) {
      let list = plan.ids.filter(id => lib.tracks.has(id)).map(id => ({ id, user: false }));
      if (plan.shuffle) list.sort(() => Math.random() - 0.5);
      if (list.length) { P.queue = list; P.cursor = 0; if (plan.msg) toast(plan.msg); load(true); return; }
    }
    if (auto) { P.playing = false; wantPlay = false; changed(); }
    return;
  }
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
export function setVolume(v) { P.volume = v; duckLevel = 1; applyVol(); persist(); changed(); }
function applyVol() { audio.volume = outVol(); try { ytPlayer?.setVolume?.(outVol() * 100); } catch { } }
// Quietly dip the music (voice assistant) without touching the saved volume
export function duck(on) { duckLevel = on ? Math.min(1, 0.25 / Math.max(P.volume, 0.01)) : 1; applyVol(); }

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
    await startYT(id, at);
    if (!wasPlaying) setTimeout(() => ytPlayer.pauseVideo(), 600);
  }
}
export function setPreferOffline(v) { P.preferOffline = v; persist(); }
export const reloadCurrent = () => load(true);
// Restart the sound output in place (fixes thin "phone call" audio after the microphone was used)
let rerouting = 0;
export function refreshOutput() {
  if (!P.playing) return;
  rerouting = Date.now();
  if (P.source === 'local') { const at = audio.currentTime; audio.pause(); setTimeout(() => { try { audio.currentTime = at; } catch { } audio.play().catch(() => { }); }, 120); }
  else if (P.source === 'yt' && ytPlayer) { try { ytPlayer.pauseVideo(); setTimeout(() => ytPlayer.playVideo(), 160); } catch { } }
}
const isRerouting = () => Date.now() - rerouting < 1500;

// ---------- Lock screen / media keys ----------
function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || '',
      artwork: t.artwork && !t.artwork.startsWith('data:') ? [{ src: t.artwork, sizes: '600x600', type: 'image/jpeg' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
    });
  } catch { }
}
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const h = (k, fn) => { try { ms.setActionHandler(k, fn); } catch { } };
  h('play', play); h('pause', pause); h('stop', pause);
  h('previoustrack', prev); h('nexttrack', () => next());
  h('seekto', d => seek(d.seekTime));
  h('seekbackward', d => seek(Math.max(0, P.time - (d.seekOffset || 10))));
  h('seekforward', d => seek(Math.min(P.duration || 1e9, P.time + (d.seekOffset || 10))));
  const t = current(); if (t) setMediaSession(t);
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !P.duration) return;
  try { navigator.mediaSession.setPositionState({ duration: P.duration, position: Math.min(P.time, P.duration), playbackRate: 1 }); } catch { }
}

// Stop everything (used when deleting the account)
export function stopAll() {
  loadToken++; wantPlay = false; audio.pause(); audio.removeAttribute('src');
  try { ytPlayer?.stopVideo?.(); } catch { }
  P.queue = []; P.cursor = -1; P.playing = false; changed();
}
