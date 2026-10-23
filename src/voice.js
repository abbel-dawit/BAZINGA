// "Hey BAZINGA!" — voice assistant.
// Listens with the browser's speech recognition, understands everyday phrasing,
// and answers out loud with the most natural voice the device has
// (e.g. Siri/"Enhanced"/"Premium" voices on Apple, "Natural" voices on Edge/Windows, Google voices on Chrome/Android).
// Browsers without speech recognition (e.g. Firefox) get a text box instead — it still talks back.
import { lib } from './store.js';
import * as store from './store.js';
import * as meta from './meta.js';
import * as player from './player.js';
import { P } from './player.js';
import { $, esc, norm, mainArtist, displayTitle, emit } from './util.js';

const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = !!Rec;
let app = null;           // hooks from app.js: { go, search, openNP, closeNP, lyrics, back, toast }
let rec = null, listening = false, open = false, savedVol = null;

const rand = a => a[Math.floor(Math.random() * a.length)];

// ---------- voice output ----------
let voice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = speechSynthesis.getVoices(); if (!vs.length) return null;
  const lang = (navigator.language || 'en-US').toLowerCase(), base = lang.slice(0, 2);
  const prefs = [/siri/i, /premium/i, /enhanced/i, /natural/i, /neural/i, /\b(ava|zoe|evan|nicky|samantha|allison|susan|aria|jenny|guy|libby|sonia|ryan)\b/i, /google (us|uk) english/i, /google/i];
  const score = v => {
    let s = 0;
    const vl = v.lang.toLowerCase().replace('_', '-');
    if (vl === lang) s += 40; else if (vl.startsWith(base)) s += 25;
    prefs.forEach((re, i) => { if (re.test(v.name)) s += 30 - i * 3; });
    if (/compact|espeak|robot/i.test(v.name)) s -= 40;
    if (v.localService) s += 2;
    return s;
  };
  return vs.slice().sort((a, b) => score(b) - score(a))[0];
}
if ('speechSynthesis' in window) { speechSynthesis.onvoiceschanged = () => { voice = pickVoice(); }; voice = pickVoice(); }

function duck(on) {
  if (on) { if (savedVol === null && P.playing) { savedVol = P.volume; player.setVolume(Math.min(P.volume, 0.25)); } }
  else if (savedVol !== null) { player.setVolume(savedVol); savedVol = null; }
}
function say(text, { show = true } = {}) {
  if (show) setReply(text);
  if (!('speechSynthesis' in window)) return Promise.resolve();
  return new Promise(res => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/BAZINGA!/g, 'Bazinga'));
      voice = voice || pickVoice();
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = 1.04; u.pitch = 1.02; u.volume = 1;
      setState('speaking'); duck(true);
      u.onend = u.onerror = () => { setState(listening ? 'listening' : 'idle'); if (!listening) duck(false); res(); };
      speechSynthesis.speak(u);
    } catch { res(); }
  });
}

// ---------- UI ----------
function el() { return $('#voice'); }
function setState(s) { const v = el(); if (v) v.dataset.state = s; }
function setHeard(t) { const h = el()?.querySelector('.vc-heard'); if (h) { h.textContent = t; h.classList.toggle('empty', !t); } }
function setReply(t) { const r = el()?.querySelector('.vc-reply'); if (r) r.textContent = t; }

const SUGGEST = ['Play my liked songs', 'Play Blinding Lights by The Weeknd', 'Add Essence to the queue', 'Search for Burna Boy', 'Go to my artists', 'Show the lyrics', 'Switch to music video', 'What\'s playing?'];

export function initVoice(hooks) {
  app = hooks;
  const wrap = document.createElement('div');
  wrap.id = 'voice'; wrap.hidden = true; wrap.dataset.state = 'idle';
  wrap.innerHTML = `<div class="vc-back" data-vc="close"></div>
    <div class="vc-sheet" role="dialog" aria-label="Voice assistant">
      <button class="ib vc-x" data-vc="close" aria-label="Close">✕</button>
      <div class="vc-orb" data-vc="mic" role="button" aria-label="Tap to talk"><i></i><i></i><i></i><b></b></div>
      <div class="vc-heard empty"></div>
      <div class="vc-reply">${canListen ? 'Listening… try "Play my liked songs"' : 'Type what you\'d like — for example "Play Tapout by Rich Gang"'}</div>
      <form class="vc-form"><input name="q" placeholder="${canListen ? 'Or type a request…' : 'Type a request…'}" autocomplete="off" enterkeyhint="go"><button class="btn primary sm">Go</button></form>
      <div class="vc-sugg">${SUGGEST.map(s => `<button class="chip" data-vc-say="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', e => {
    const c = e.target.closest('[data-vc]');
    if (c?.dataset.vc === 'close') close();
    if (c?.dataset.vc === 'mic') listening ? stopListening() : listen();
    const s = e.target.closest('[data-vc-say]'); if (s) { setHeard(s.dataset.vcSay); handle(s.dataset.vcSay); }
  });
  wrap.querySelector('.vc-form').addEventListener('submit', e => {
    e.preventDefault(); const q = e.target.q.value.trim(); if (!q) return;
    e.target.q.value = ''; stopListening(); setHeard(q); handle(q);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) close(); });
}

export function openVoice() {
  const v = el(); if (!v) return;
  open = true; v.hidden = false; requestAnimationFrame(() => v.classList.add('on'));
  setHeard('');
  setReply(canListen ? rand(['I\'m listening…', 'Go ahead, I\'m listening.', 'What do you want to hear?']) : 'Type what you\'d like — for example "Play Tapout by Rich Gang"');
  // Unlock speech on iOS: speak an empty utterance inside the tap
  try { if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { }
  if (canListen) listen(); else v.querySelector('input').focus();
}
function close() {
  stopListening(); try { speechSynthesis.cancel(); } catch { }
  duck(false);
  const v = el(); if (!v) return;
  open = false; v.classList.remove('on'); setTimeout(() => { if (!open) v.hidden = true; }, 220);
}

function listen() {
  if (!canListen) return;
  try { speechSynthesis.cancel(); } catch { }
  rec = new Rec();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  let final = '';
  rec.onstart = () => { listening = true; setState('listening'); duck(true); };
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]; if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
    }
    setHeard((final + ' ' + interim).trim());
  };
  rec.onerror = e => {
    listening = false; setState('idle');
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setReply('I need microphone access. Allow it in your browser\'s site settings, or type below.');
    else if (e.error === 'no-speech') setReply('I didn\'t hear anything. Tap the orb and try again.');
    else if (e.error === 'network') setReply('Voice recognition needs internet. You can type instead.');
  };
  rec.onend = () => {
    listening = false; setState('idle');
    if (final.trim()) handle(final.trim()); else duck(false);
  };
  try { rec.start(); } catch { }
}
function stopListening() { try { rec?.abort(); } catch { } listening = false; }

// ---------- understanding ----------
function clean(s) {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/[.!?,]+$/g, '')
    .replace(/^(hey |ok |okay )?(bazinga|bazinga!)[, ]*/i, '')
    .replace(/^(please |can you |could you |would you |will you |i want to |i wanna |i'd like to |let's |lets |yo |hey )+/g, '')
    .replace(/ please$/g, '').replace(/\s+/g, ' ').trim();
}
function sim(a, b) {
  const A = norm(a), B = norm(b); if (!A || !B) return 0;
  if (A === B) return 1;
  if (B.includes(A) || A.includes(B)) return 0.85 * Math.min(A.length, B.length) / Math.max(A.length, B.length) + 0.15;
  const ta = new Set(A.split(' ')), tb = new Set(B.split(' '));
  let inter = 0; ta.forEach(x => { if (tb.has(x)) inter++; });
  return inter / Math.max(ta.size, tb.size);
}
function bestOf(list, q, key, min = 0.55) {
  let best = null, s = 0;
  for (const x of list) { const v = sim(q, key(x)); if (v > s) { s = v; best = x; } }
  return s >= min ? best : null;
}
const libTracks = () => store.saved();
const likedIds = () => libTracks().filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id);
function artistTracks(name) {
  const n = norm(name);
  return libTracks().filter(t => norm(mainArtist(t.artist)) === n || (t.artists || []).some(a => norm(a) === n));
}

// Work out what "X" is: liked songs / a playlist / an album / an artist / a song
async function resolve(q, { prefer } = {}) {
  q = q.replace(/^(the |some |a )/, '').trim();
  if (/^(my )?(liked|favorite|favourite|loved)( songs| tracks| music)?$|^my (likes|favorites|favourites)$/.test(q)) {
    const ids = likedIds(); return ids.length ? { kind: 'liked', ids, label: 'your Liked Songs' } : { none: 'You don\'t have any liked songs yet.' };
  }
  let m;
  if ((m = q.match(/^(?:my )?playlist (?:called |named )?(.+)$/)) || (m = q.match(/^(?:my )?(.+?) playlist$/)) || prefer === 'playlist') {
    const name = m ? m[1] : q;
    const p = bestOf([...lib.playlists.values()], name, x => x.name, 0.45);
    if (p) return { kind: 'playlist', ids: p.trackIds, label: `your ${p.name} playlist` };
    if (m) return { none: `I couldn't find a playlist called ${name}.` };
  }
  if ((m = q.match(/^(?:the )?album (.+?)(?: by (.+))?$/))) {
    const [, title, by] = m;
    const local = bestOf([...lib.albums.values()], title, a => a.title, 0.6);
    if (local && (!by || sim(by, local.artist) > 0.5)) return { kind: 'album', ids: local.trackIds, label: `${local.title} by ${local.artist}` };
    const res = await meta.searchAlbums(by ? `${by} ${title}` : title, 5);
    const a = res[0]; if (!a) return { none: `I couldn't find the album ${title}.` };
    const { tracks } = await meta.albumTracks(a.itunesAlbumId);
    return { kind: 'album', ids: tracks.map(t => (lib.tracks.get(t.id) || store.remember(t)).id), label: `${a.title} by ${a.artist}` };
  }
  if ((m = q.match(/^(?:songs|music|tracks|something|stuff|anything|hits) (?:by|from) (.+)$/)) || (m = q.match(/^(.+?)'s (?:songs|music|hits)$/))) {
    return await artistPick(m[1]);
  }
  if ((m = q.match(/^(.+) by (.+)$/))) {
    const [, title, by] = m;
    const local = libTracks().find(t => sim(title, t.title) > 0.8 && (sim(by, t.artist) > 0.6 || (t.artists || []).some(a => sim(by, a) > 0.7)));
    if (local) return { kind: 'song', ids: [local.id], label: `${displayTitle(local)} by ${local.artist}` };
    const res = await meta.searchSongs(`${by} ${title}`, 8);
    const hit = res.find(r => sim(by, r.artist) > 0.5) || res[0];
    if (hit) { const t = lib.tracks.get(hit.id) || store.remember(hit); return { kind: 'song', ids: [t.id], label: `${t.title} by ${t.artist}` }; }
    return { none: `I couldn't find ${title} by ${by}.` };
  }
  // Bare name: playlist? artist? song?
  const p = bestOf([...lib.playlists.values()], q, x => x.name, 0.8);
  if (p) return { kind: 'playlist', ids: p.trackIds, label: `your ${p.name} playlist` };
  const art = store.artists().find(a => norm(a.name) === norm(q));
  if (art) return artistPick(art.name);
  const local = bestOf(libTracks(), q, t => t.title, 0.75);
  if (local) return { kind: 'song', ids: [local.id], label: `${displayTitle(local)} by ${local.artist}` };
  const res = await meta.searchSongs(q, 8);
  if (res[0]) {
    // If the words are really an artist name, play that artist
    if (res.filter(r => norm(r.artist) === norm(q)).length >= 3) return artistPick(res.find(r => norm(r.artist) === norm(q)).artist);
    const t = lib.tracks.get(res[0].id) || store.remember(res[0]);
    return { kind: 'song', ids: [t.id], label: `${t.title} by ${t.artist}` };
  }
  return { none: `I couldn't find anything for ${q}.` };
}
async function artistPick(name) {
  const mine = artistTracks(name);
  if (mine.length) return { kind: 'artist', ids: mine.map(t => t.id), label: mine[0].artist, shuffle: true };
  const id = await meta.findArtistId(name);
  if (!id) return { none: `I couldn't find the artist ${name}.` };
  const top = await meta.artistTopSongs(id);
  if (!top.length) return { none: `I couldn't find songs by ${name}.` };
  return { kind: 'artist', ids: top.map(t => (lib.tracks.get(t.id) || store.remember(t)).id), label: top[0].artist, shuffle: false };
}

const PAGES = { home: '#/home', library: '#/library/songs', songs: '#/library/songs', 'liked songs': '#/library/liked', likes: '#/library/liked', liked: '#/library/liked', playlists: '#/library/playlists', albums: '#/library/albums', artists: '#/library/artists', search: '#/search', settings: '#/settings', import: '#/import', offline: '#/offline', queue: '#/queue', 'privacy policy': '#/legal', terms: '#/legal' };

async function handle(raw) {
  const q = clean(raw);
  if (!q) return;
  setState('thinking');
  try { await run(q); } catch (e) { console.warn(e); await say('Hmm, something went wrong there. Mind trying again?'); }
  if (!listening) setState('idle');
}

async function run(q) {
  let m;
  const cur = player.current();
  // --- playback controls
  if (/^(pause|stop)( the| this)?( music| song| track| it| playing)?$/.test(q)) { player.pause(); return say(rand(['Paused.', 'Okay, paused.', 'Done.'])); }
  if (/^(resume|continue|unpause|keep playing|play)( the| my)?( music| song| it)?$/.test(q)) { if (!cur) return say('There\'s nothing queued up yet. Try "play my liked songs".'); player.play(); return say(rand(['Here we go.', 'Resuming.', 'Back on.'])); }
  if (/^(next|skip)( song| track| this( one| song)?)?$|^play (the )?next song$/.test(q)) { player.next(); return say(rand(['Skipping.', 'Next one.', 'Got it.'])); }
  if (/^(previous|last|go to the previous|play the previous|back to the last)( song| track| one)?$/.test(q)) { player.prev(); return say('Going back.'); }
  if (/^(restart|start over|play (it|this) again|from the (top|beginning))$/.test(q)) { player.seek(0); player.play(); return say('From the top.'); }
  if ((m = q.match(/^(turn )?(shuffle)( on| off)?$|^(turn (on|off) )shuffle$/))) { const off = /off/.test(q); player.setShuffle(!off); return say(off ? 'Shuffle\'s off.' : 'Shuffle\'s on.'); }
  if (/repeat (this|the song|one|it)|loop (this|it|the song)/.test(q)) { while (P.repeat !== 'one') player.cycleRepeat(); return say('I\'ll keep this one on repeat.'); }
  if (/^(turn )?(repeat|loop)( on| all)?$/.test(q)) { while (P.repeat !== 'all') player.cycleRepeat(); return say('Repeat is on.'); }
  if (/(repeat|loop) off|stop (repeating|looping)/.test(q)) { while (P.repeat !== 'off') player.cycleRepeat(); return say('Repeat is off.'); }
  if (/^(volume up|louder|turn (it|this|the volume) up|crank it( up)?)$/.test(q)) { const v = Math.min(1, (savedVol ?? P.volume) + 0.2); savedVol = null; player.setVolume(v); return say('Turning it up.'); }
  if (/^(volume down|quieter|softer|turn (it|this|the volume) down)$/.test(q)) { const v = Math.max(0.05, (savedVol ?? P.volume) - 0.2); savedVol = null; player.setVolume(v); return say('Turning it down.'); }
  if ((m = q.match(/^(?:set )?(?:the )?volume (?:to )?(\d{1,3})(?: percent|%)?$/))) { savedVol = null; player.setVolume(Math.min(100, +m[1]) / 100); return say(`Volume at ${Math.min(100, +m[1])} percent.`); }
  if (/^mute$/.test(q)) { savedVol = null; player.setVolume(0); return say('Muted.', { show: true }); }
  if (/(switch to|show|play|watch)( me)?( the)?( music)? video|video mode/.test(q)) { if (!cur) return say('Nothing\'s playing yet.'); await player.setMode('video'); app.openNP(); return say('Here\'s the music video.'); }
  if (/(audio only|switch to audio|audio mode|hide (the )?video|just (the )?audio)/.test(q)) { await player.setMode('audio'); return say('Switched to audio only.'); }
  if (/^(show|open|display|pull up|give me)( me)?( the)? lyrics/.test(q) || /^lyrics$/.test(q)) { if (!cur) return say('Play something first and I\'ll pull up the lyrics.'); app.openNP(); app.lyrics(true); return say('Here are the lyrics.'); }
  if (/^(hide|close)( the)? lyrics/.test(q)) { app.lyrics(false); return say('Lyrics hidden.'); }
  if (/^(open|show|go to)( the)? (now playing|full ?screen|player)$/.test(q)) { app.openNP(); return say('Here you go.'); }
  if (/^(close|exit|leave)( the)? (now playing|full ?screen|player)$/.test(q)) { app.closeNP(); return say('Okay.'); }
  if (/^(what'?s|what is) (this|playing|this song)|^what song is (this|playing)|^who (sings|is singing|made) (this|it)|^what am i listening to/.test(q)) {
    if (!cur) return say('Nothing\'s playing right now.');
    return say(`This is ${displayTitle(cur)} by ${cur.artist}${cur.album ? `, from ${cur.album}` : ''}.`);
  }
  if (/^(i )?(like|love)( this| this song| it)$|^(save|like|add) (this|this song|it) to (my )?(liked|likes|favorites|library)/.test(q)) {
    if (!cur) return say('Nothing\'s playing.');
    if (!cur.liked || cur.transient) await store.upsertTracks([{ ...cur, liked: true, likedAt: Date.now() }]);
    return say(rand(['Saved to your Liked Songs.', 'Love it too. Added to Liked Songs.']));
  }
  // --- navigation
  if (/^(go )?back$|^go to the previous page$/.test(q)) { app.back(); return say('Okay.'); }
  if ((m = q.match(/^(?:go to|open|show(?: me)?|take me to|bring up|navigate to)(?: the| my)? (home|library|songs|liked songs|likes|liked|playlists|albums|artists|search|settings|import|offline|queue|privacy policy|terms)(?: page| tab| list)?$/))) {
    app.go(PAGES[m[1]]); return say(rand(['Here you go.', 'Opening ' + m[1] + '.', 'Sure.']));
  }
  if ((m = q.match(/^(?:go to|open|show(?: me)?)(?: the)? artist (.+)$/))) { app.go('#/artist/' + encodeURIComponent(m[1])); return say(`Here's ${m[1]}.`); }
  // --- search
  if ((m = q.match(/^(?:search(?: for)?|find(?: me)?|look up|look for|search youtube for) (.+)$/))) {
    app.search(m[1], /youtube/.test(q) ? 'youtube' : 'all'); return say(rand([`Here's what I found for ${m[1]}.`, `Searching for ${m[1]}.`]));
  }
  // --- queue
  if ((m = q.match(/^(?:add|put|throw|stick) (.+?) (?:to|in|on|into) (?:the |my )?queue$/)) || (m = q.match(/^queue(?: up)? (.+)$/)) || (m = q.match(/^play (.+?) next$/))) {
    const next = /^play .+ next$/.test(q);
    const r = await resolve(m[1]);
    if (r.none) return say(r.none);
    player.addToQueue(r.ids, next);
    return say(next ? `${cap(r.label)} plays next.` : (r.ids.length > 1 ? `Added ${r.ids.length} songs from ${r.label} to your queue.` : `Added ${r.label} to your queue.`));
  }
  // --- play something
  if ((m = q.match(/^(?:play|put on|listen to|start|blast|shuffle)(?: me)? (.+)$/))) {
    const shuffleWanted = /^shuffle /.test(q) || / on shuffle$/.test(q);
    const r = await resolve(m[1].replace(/ on shuffle$/, ''));
    if (r.none) return say(r.none);
    player.playList(r.ids, 0, { shuffle: shuffleWanted || !!r.shuffle });
    const lines = r.kind === 'song' ? [`Playing ${r.label}.`, `Here's ${r.label}.`] :
      r.kind === 'artist' ? [`Playing ${r.label}.`, `Here's some ${r.label}.`] :
      [`Playing ${r.label}.`, `Here's ${r.label}.`, `Starting ${r.label}.`];
    return say(rand(lines));
  }
  // --- anything else: treat it as something to play if it looks like a name, else search
  if (q.split(' ').length <= 6) {
    const r = await resolve(q);
    if (!r.none) { player.playList(r.ids, 0, { shuffle: !!r.shuffle }); return say(`Playing ${r.label}.`); }
  }
  app.search(q, 'all');
  return say(`I wasn't sure what you meant, so I searched for "${q}".`);
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
