// BAZINGA — app shell, router and views
import { db, kv } from './db.js';
import { $, $$, esc, on, emit, toast, debounce, fmtTime, fmtDur, imageToDataURL, mainArtist, norm, trackKey, albumKey, yearOf, packToString, unpackString, sleep, downloadBlob, uid } from './util.js';
import { icon, cover, trackRow, card, modal, promptText, confirmBox, menu, applyFilters, filterBar, empty } from './ui.js';
import * as store from './store.js';
import { lib } from './store.js';
import * as meta from './meta.js';
import * as yt from './youtube.js';
import * as sp from './spotify.js';
import * as imp from './importers.js';
import * as player from './player.js';
import { P } from './player.js';
import * as backup from './backup.js';
import { LEGAL_HTML, TERMS_VERSION } from './legal.js';

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
