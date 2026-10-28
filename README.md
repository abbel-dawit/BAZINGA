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

To ship an update, edit the files and bump `VERSION` in `sw.js` (currently `bazinga-v9`) so phones fetch the new version.

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


### New in v1.1
- **Logo**: Bubble Sans X wordmark, a glowing bolt that gently grows and shrinks, and the version number under the logo (change it in `APP_VERSION` at the top of `src/app.js`). **Add the font file:** download Bubble Sans X (SIL Open Font License) from https://www.fontspace.com/bubble-sans-x-font-f159983 and save it as `fonts/BubbleSansX.otf` (or `.woff2` / `.ttf`). Until then the logo uses the similar Fredoka font.
- **Full-screen player**: the video/cover stays still while everything else scrolls (swipe or mouse-wheel anywhere, including over the top bar), the queue scrolls inside its own window, and the lag is gone. Subtitles are off by default.
- **Voice assistant** closes by itself when it's done (stays open if it couldn't help), never leaves the music quieter, and hands the phone's audio back to music mode after using the microphone.
- **Background play**: if the phone pauses YouTube when you switch apps or lock the screen, BAZINGA! starts it again straight away, with lock-screen controls (play/pause/next/previous/seek). See "Honest limits" below.
- **Autoplay**: when the queue finishes it starts your Liked Songs (or replays the queue — Settings → Playback).
- **Refresh / reopen** lands on the same page, scroll position, song and spot in the song.
- **Faster song switching**: the YouTube player loads at start-up, songs are looked up when you rest on/touch them, and the next 3 (and previous) songs are prepared in advance.
- **YouTube backup**: Settings → YouTube backup → "Save playlists to YouTube" creates all the playlists you tick (and Liked Songs) on your YouTube account in one go; later runs only add new songs. Import goes the other way. Without the Google key it gives ready-made YouTube playlist links instead.
- **Import moved into Settings** (Settings → Import music); the Import tab is gone.
- **Library**: broad genres only (Hip-Hop/Rap, Afrobeats, Pop, R&B, Soul, Rock, Country, Jazz, Classical, Electronic, Latin, Reggae, Gospel…) with the top 10 in the filter and no "Unknown"; year filter is multi-select chips (no from/to dates); artists sorted by most songs with search, A–Z letters still work, yellow play buttons; un-liking a song on the Liked page leaves it for a few seconds so you can re-like it; hearts react instantly everywhere; "Undo" on removed-from-playlist and removed-from-Liked.
- **Home**: Jump back in first, then your top 6 playlists as cards with "See all", consistent spacing.
- **Phones**: no mini video pop-up, song rows are the same size liked or not, previous-track button in the mini player, taller solid top bar.
- **Other**: yellow search button, bigger letters on playlists without covers, the playing song pops out with a long 3D yellow shadow, cover art on the minimised video window (desktop), tab title "BAZINGA! - Music Made For You".

### Earlier
- **Voice assistant ("Ask BAZINGA!")**: tap the mic and say things like "play my liked songs", "play Tapout by Rich Gang", "add Essence to the queue", "play my road trip playlist", "search for Burna Boy", "go to my artists", "show the lyrics", "switch to music video", "what's playing?". It answers out loud with the most natural voice the device has. Browsers without speech recognition (e.g. Firefox) get a text box instead.
- **YouTube search** on the Search page (own tab, plus a "From YouTube" section under All). Tapping a result plays that exact video.
- **New from your artists** on Home: latest albums, EPs and singles from the artists you listen to most (refreshed every 12 hours).
- **Lyrics** in the full-screen player via Genius's official lyrics widget. If Genius blocks the lookup from the browser, a one-tap "Open lyrics on Genius" button appears; adding a free Genius access token in Settings → Lyrics lets them load inside the app.
- **Faster everything**: one YouTube search per song (two only when needed), several songs matched at once on different servers, fastest servers used first, upcoming songs looked up in advance, all lookups cached on the device, right-sized images, and a rate limiter that stays under Apple's limits so your IP never gets blocked.
- **Optional accounts & cross-device sync**: Google, Discord or email + password (with email verification and password reset), powered by Supabase. Guests can keep using the app without an account and upgrade any time; their music is merged in.
- **YouTube account sync**: save any playlist, album or your Liked Songs to your YouTube account (music videos or audio, private/unlisted/public, updates add only new songs), and import your YouTube playlists and Liked videos back in.
- **Better covers**: Deezer and the song's YouTube thumbnail fill in any missing cover art; artists get real photos.



## Set up accounts & sync (Supabase, one time, by the app owner)

Accounts are optional — people can always use BAZINGA! without one. With accounts set up, the welcome screen and Settings offer **Continue with Google**, **Continue with Discord** and **Continue with email** (sign-up with email verification, log in, forgot password). Signed-in users' library, likes, playlists, albums, YouTube matches and profile sync automatically across all their devices.

1. Create a free project at https://supabase.com (pick a region close to your users).
2. **SQL Editor → New query** → paste everything in `supabase/setup.sql` → **Run**. This creates the profiles table, the private storage for synced libraries, the security rules (each user can only touch their own data) and the "delete my account" function.
3. **Project Settings → API**: copy the **Project URL** and the **anon / publishable key** into `index.html`:
   ```js
   window.BAZINGA_CONFIG = {
     googleClientId: '',
     supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
     supabaseAnonKey: 'YOUR-ANON-KEY'
   };
   ```
   (The anon key is meant to be public; the security rules from step 2 protect the data. Never put the *service_role* key in the app.)
4. **Authentication → URL Configuration**: Site URL `https://<your-username>.github.io/bazinga/`, and add `https://<your-username>.github.io/bazinga/**` to **Redirect URLs**.
5. **Email & password**: Authentication → Sign In / Providers → Email: enabled, **Confirm email ON**.
   ⚠️ Supabase's built-in email sender only sends about **2 emails per hour** and only to your own team, so real users won't get verification emails until you connect a free email service: **Authentication → Emails → SMTP Settings** (e.g. Resend, Brevo or SendGrid). You can also edit the "Confirm signup" and "Reset password" email templates there.
6. **Google sign-in**: in Google Cloud Console create an OAuth client ID (Web application) — the same project as YouTube sync is fine. Authorized JavaScript origin: `https://<your-username>.github.io`; Authorized redirect URI: `https://YOUR-PROJECT.supabase.co/auth/v1/callback`. Paste its Client ID + Client Secret into Supabase → Authentication → Providers → **Google**.
7. **Discord sign-in**: https://discord.com/developers/applications → New Application → **OAuth2** → add redirect `https://YOUR-PROJECT.supabase.co/auth/v1/callback` → copy Client ID + Client Secret into Supabase → Authentication → Providers → **Discord**.
8. Push to GitHub. Done.

Notes: the free Supabase plan includes plenty of room for synced libraries (each one is a small compressed file) but may pause projects that go unused for a while — check Supabase's current plan limits. Passwords are handled entirely by Supabase. Users can delete their account (cloud data included) any time in Settings.

## Set up YouTube account sync (one time, by the app owner)

"Save to YouTube" and "Sign in with YouTube" need a free Google sign-in key (OAuth Client ID) for your copy of BAZINGA!. Without it, everything else still works, including importing public YouTube playlist links and the no-sign-in "open as a temporary YouTube playlist" option.

1. Go to https://console.cloud.google.com → create a project (e.g. "BAZINGA").
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **OAuth consent screen** (Google Auth Platform → Branding/Audience):
   - User type **External**, app name **BAZINGA!**, your support email, logo (`icons/icon-512.png`).
   - App home page: `https://<your-username>.github.io/bazinga/`
   - Privacy policy: `https://<your-username>.github.io/bazinga/privacy.html` (this file is included and generated by `build.py`).
   - Scope: `https://www.googleapis.com/auth/youtube`.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Authorized JavaScript origins: `https://<your-username>.github.io` (no path, no trailing slash).
5. Copy the Client ID (ends in `.apps.googleusercontent.com`) and paste it into `index.html`:
   `window.BAZINGA_CONFIG = { googleClientId: 'YOUR-ID.apps.googleusercontent.com' };`
6. Push to GitHub. Done.

**Limits to know about (set by Google, not BAZINGA!):**
- While the app is in **Testing**, only Google accounts you add as test users can sign in. Switch it to **In production** to open it up: until Google *verifies* the app, users see an "unverified app" warning and at most **100 users** can connect. Submit it for verification in the console to remove both (Google asks for a short screen recording showing what the app does with YouTube access).
- Each Client ID gets **10,000 YouTube units per day**, shared by everyone using it. Creating a playlist costs 50, adding each song costs 50, so roughly **200 songs per day in total**. Uploads that hit the limit pause and can be resumed the next day. Heavy users can paste **their own** Client ID in Settings → YouTube account to get their own daily allowance. You can also request a higher quota from Google.

## Support & socials

- Tips: https://buymeacoffee.com/bazinga.app (Support tab, sidebar, footer, an occasional gentle pop-up at most once every 3 weeks, and Settings). The QR code is `icons/bmc-qr.png`.
- Footer links: Instagram `@bazinga.app`, X/Twitter `@bazinga_app`.

## Honest limits

- **YouTube audio/video can't be downloaded.** Saving YouTube streams breaks YouTube's terms of service and rips copyrighted music, so BAZINGA doesn't do it. Offline playback works from music files the user owns.
- **Keyless YouTube search** goes through free public Invidious/Piped servers, which are sometimes slow or down. For reliable matching, a user can paste their own free YouTube Data API key in Settings. Every match is cached on the device so each song is only searched once.
- **Spotify (2026 rules)**: Spotify requires the developer account to have Premium and only lets apps read playlists the user owns or collaborates on. Users without Premium can use the CSV import instead.
- **Background play on phones**: BAZINGA! restarts YouTube right away when the phone pauses it, and that works on most Android phones. iPhones (Safari) don't allow a web page to play YouTube video with the screen locked, whatever the app does; songs with an offline file always keep playing. Installing BAZINGA! to the Home Screen helps on both.
- Genres, release dates, artwork, albums and artist pages come from Apple's free iTunes Search API (no key).

## Privacy & Terms

Users must accept the Privacy Policy & Terms of Use (in `src/legal.js`) when creating a profile; if you change the text, bump `TERMS_VERSION` and everyone is asked to accept again. The text is a template, not legal advice.


There is no backend. Profile, library, tokens and backups live in the browser's IndexedDB on the user's device. The app only talks directly to Spotify (if connected), YouTube / Invidious / Piped (to find and play videos) and Apple's iTunes Search API (for music info).

---
© 2026 Abbel Dawit
