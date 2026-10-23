# ⚡ BAZINGA!

Turn your Spotify Liked Songs and playlists into YouTube music-video **and** audio playlists — with a full music player, albums, artists, queue, filters, sharing, offline files and automatic backups. Everything is stored on the user's own device. No server, no database, no sign-up.

## Put it online with GitHub Pages (free)

1. Create a new **public** repository on GitHub (e.g. `bazinga`).
2. Upload everything in this folder to the repository root (drag-and-drop on the GitHub website works). Keep the folder structure: `index.html`, `sw.js`, `manifest.webmanifest`, `favicon.ico`, `.nojekyll`, `css/`, `js/`, `icons/` (and `src/` + `build.py` if you want to edit later). `index.html` must be at the top level of the repo, not inside another folder.
3. Repository → **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
4. After a minute your app is live at `https://<your-username>.github.io/bazinga/`.

Users can install it like an app: browser menu → **Install** / **Add to Home Screen**.

You can also just double-click `index.html` to try it on your computer — your library and offline files work, but YouTube playback, Spotify login and share links need the hosted GitHub Pages address.

## Editing the code

The readable source is in `src/`. After changing it, run `python3 build.py` to regenerate `js/bazinga.js` (the single file the app loads).

To ship an update, edit the files and bump `VERSION` in `sw.js` (e.g. `bazinga-v2`) so phones fetch the new version.

## Features

- **Account**: just a username + profile picture, saved on the device. Delete it any time (Settings → Delete account) — wipes everything.
- **Import**: Apple Music (library `.xml` or playlist `.txt` exported from the Music app on Mac/Windows — playlists, Favorite songs, genres, years), Spotify Liked Songs & playlists (each user connects with their own free Spotify developer Client ID, so there is no shared rate limit), CSV files (e.g. from exportify.net — no Spotify key needed), pasted "Artist - Title" lists, and music files/folders on the device.
- **YouTube**: finds an official **music video** and an **audio** version (Topic channel / official audio) for every song. Switch between Video and Audio any time in the player. "Open on YouTube" turns any playlist into YouTube playlist links (50 songs per link). Any match can be fixed by pasting a link.
- **Player**: play/pause, next/prev, seek, shuffle, repeat (all/one), volume, lock-screen controls, Add to queue, Play next, drag-to-reorder queue.
- **Library**: Songs, Liked, Playlists, Albums, **Artists list** (everyone in your music), genre pages.
- **Filters**: by genre, release decade or exact year range, liked-only, offline-only, plus sorting by date added / title / artist / album / release date.
- **Albums**: search any album, open the album of any song, **save full albums** to your library.
- **Artists**: "Go to artist" from any song → popular songs, full discography, and your songs by them.
- **Sharing**: share a song, playlist or album as a link. The whole list is packed inside the link — nothing is uploaded. The receiver can play it and save it into their own library.
- **Offline**: add music files you own; they're matched to your songs automatically, grouped into albums, and play without internet. The app itself also opens offline.
- **Backups (auto-updating, on device)**: rolling snapshots after every change (last 5), plus on Chrome/Edge desktop a linked backup **file** that rewrites itself automatically. On every browser: one-tap download and restore of a backup file.


### New in this version
- **Voice assistant ("Ask BAZINGA!")**: tap the mic and say things like "play my liked songs", "play Tapout by Rich Gang", "add Essence to the queue", "play my road trip playlist", "search for Burna Boy", "go to my artists", "show the lyrics", "switch to music video", "what's playing?". It answers out loud with the most natural voice the device has. Browsers without speech recognition (e.g. Firefox) get a text box instead.
- **YouTube search** on the Search page (own tab, plus a "From YouTube" section under All). Tapping a result plays that exact video.
- **New from your artists** on Home: latest albums, EPs and singles from the artists you listen to most (refreshed every 12 hours).
- **Lyrics** in the full-screen player via Genius's official lyrics widget. If Genius blocks the lookup from the browser, a one-tap "Open lyrics on Genius" button appears; adding a free Genius access token in Settings → Lyrics lets them load inside the app.
- **Faster everything**: one YouTube search per song (two only when needed), several songs matched at once on different servers, fastest servers used first, upcoming songs looked up in advance, all lookups cached on the device, right-sized images, and a rate limiter that stays under Apple's limits so your IP never gets blocked.
- **Better covers**: Deezer and the song's YouTube thumbnail fill in any missing cover art; artists get real photos.

## Honest limits

- **YouTube audio/video can't be downloaded.** Saving YouTube streams breaks YouTube's terms of service and rips copyrighted music, so BAZINGA doesn't do it. Offline playback works from music files the user owns.
- **Keyless YouTube search** goes through free public Invidious/Piped servers, which are sometimes slow or down. For reliable matching, a user can paste their own free YouTube Data API key in Settings. Every match is cached on the device so each song is only searched once.
- **Spotify (2026 rules)**: Spotify requires the developer account to have Premium and only lets apps read playlists the user owns or collaborates on. Users without Premium can use the CSV import instead.
- **Background play on phones**: YouTube embeds may pause when the screen locks (a browser/YouTube restriction). Offline files keep playing.
- Genres, release dates, artwork, albums and artist pages come from Apple's free iTunes Search API (no key).

## Privacy & Terms

Users must accept the Privacy Policy & Terms of Use (in `src/legal.js`) when creating a profile; if you change the text, bump `TERMS_VERSION` and everyone is asked to accept again. The text is a template, not legal advice.


There is no backend. Profile, library, tokens and backups live in the browser's IndexedDB on the user's device. The app only talks directly to Spotify (if connected), YouTube / Invidious / Piped (to find and play videos) and Apple's iTunes Search API (for music info).

---
© 2026 Abbel Dawit
