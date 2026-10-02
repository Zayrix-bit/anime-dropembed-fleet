# 🚀 Anime DropEmbed Fleet — Project State, Architecture & History
> **IMPORTANT FOR AI AGENTS / ANTIGRAVITY CODING ASSISTANTS:**
> If you have lost conversation history or are starting a fresh session, **read this file first**. It documents the exact current state, technical decisions, root-cause analyses, credentials, architecture, and step-by-step procedures to continue.

---

## 📌 1. Project Overview & Goal
This project is an automated, distributed fleet pipeline designed to ingest, convert, and host thousands of Hindi Dubbed anime episodes onto [DropEmbed.com](https://dropembed.com) with database isolation in MySQL, complete with a real-time monitoring dashboard on port `3001`.

- **Source Database**: `jeevanka_anime` on Hetzner MySQL (`37.27.232.161`)
- **Source Video Providers**:
  1. `blakiteapi.xyz` (Rumble Cloud HLS streams with byte-ranges)
  2. `vidara.to` (Obfuscated HLS streams using `.woff2` / `.css` chunks and IP-tokenized API)
- **Target Host**: DropEmbed.com API (Video Transcoding & Bunny Stream CDN hosting)
- **Repository**: `Zayrix-bit/anime-dropembed-fleet`

---

## 🔑 2. Database & API Credentials
```env
DB_HOST=37.27.232.161
DB_PORT=3306
DB_USER=jeevanka_user
DB_PASSWORD=MyAnimePass@2026!
DB_NAME=jeevanka_anime

DROPEMBED_API_KEY=dpe_live_c9bbcfeff68964f97bf935152ffe040b
DROPEMBED_API=https://dropembed.com/api
DROPEMBED_ACCOUNT_EMAIL=rk18109ry@gmail.com
```

### Key Database Tables:
- `dropembed_anime_series`: Metadata of anime series, format (Movie vs TV), dub type, poster URLs.
- `dropembed_anime_episodes`: Every episode's current stream state (`MP4`, `ERROR`, `HLS_ERROR`), `filecode`, `embed_url`, `watch_url`, `updated_at`.
- `anime_episodes`: Original raw sources with `embed_url` pointing to `vidara.to` or `blakiteapi.xyz`.

---

## 📊 3. Current Live Status (As of October 2, 2026)

| Metric | Status | Details |
| :--- | :--- | :--- |
| **Total Episodes in Database** | **6,113** | 100% |
| ✅ **Successfully Processed as MP4** | **5,921** | **96.9% Completed** 🎉 |
| ❌ **Remaining Error Episodes** | **192** | **3.1% Remaining** (Deleted on source CDN) |
| ⚡ **Vidara.to Error Episodes** | **0 (ZERO!)** | **100% Recovered** (All 268 resolved) |
| ☁️ **Total DropEmbed Storage** | **1,896,149 MB (~1.9 TB)** | 5,946 total video files in DropEmbed |
| 🖥️ **Live Web Dashboard** | **Active on Port 3001** | `http://localhost:3001` |
| 🌐 **Public Anime Portal** | **Active on Port 3000** | `http://localhost:3000` |

### Remaining Error Breakdown (192 episodes):
- `stream_type = 'HLS_ERROR'`: **176** (Rumble CDN source files deleted / 403 / 416)
- `stream_type = 'ERROR'`: **16** (Source video not found on Blakite / Vidara)
- `vidara.to`: **0** left!

---

## 🛠️ 4. Technical Problems Encountered & Exact Solutions
*(Read this section carefully so you do not repeat past mistakes!)*

### Problem 1: Local Bandwidth & Speed
- **Issue**: Downloading gigabytes of episodes locally on the user's computer would consume massive bandwidth and take days.
- **Solution**: Built a distributed GitHub Actions matrix fleet (`.github/workflows/fleet.yml` & `.github/workflows/recover.yml`) running across 10 cloud runner shards simultaneously.

### Problem 2: Vidara.to Video Stream Obfuscation
- **Issue**: Vidara streams cannot be downloaded by simple scraping. Their segment files are disguised as `.woff2` font files or `.css` stylesheets, and HLS URLs require an IP-bound token generated via `POST https://vidara.to/api/stream` with `Referer: https://vidara.to/e/{filecode}`.
- **Solution**: Automated token fetching in `recover-errors.js` via `getVidaraStreamUrl(filecode)`.

### Problem 3: Missing FFmpeg on GitHub Runners
- **Issue**: GitHub Actions' `ubuntu-latest` image switched to Ubuntu 24.04 where `ffmpeg` is not pre-installed, causing `/bin/sh: 1: ffmpeg: not found`.
- **Solution**: Added native package verification step: `which ffmpeg || (sudo apt-get update -qq && sudo apt-get install -y ffmpeg)`.

### Problem 4: 3rd-Party FFmpeg Static Builds Segfaulting
- **Issue**: `FedericoCarboni/setup-ffmpeg@v3` installed static binaries that segfaulted (`Segmentation fault (core dumped)`) on multi-gigabyte concatenated TS streams due to glibc memory alignment issues.
- **Solution**: Switched to official Ubuntu native packages (`/usr/bin/ffmpeg`) and used `spawnSync` with `-analyzeduration 100M -probesize 100M`.

### Problem 5: Cloudflare 413 Payload Too Large
- **Issue**: Direct video file uploads to `POST https://dropembed.com/api/videos/upload` failed with `HTTP 413 Payload Too Large (cloudflare)` whenever a file exceeded 100 MB (e.g. *Grave of the Fireflies* movie was 1.35 GB). Cloudflare free/pro tiers have a strict 100MB body limit.
- **Solution**: **THE ULTIMATE BREAKTHROUGH** — We discovered that DropEmbed's `POST https://dropembed.com/api/videos/remote-upload` **natively accepts Vidara's `master.m3u8` streaming URLs directly**!
  - We do NOT need to download segments locally or on GitHub.
  - We do NOT need to run FFmpeg or remux files.
  - DropEmbed's backend cloud servers fetch all segments directly over multi-gigabit pipes, transcode them on Bunny Stream, and make the embed ready in seconds.
  - Processing time dropped from **15 minutes per episode to under 1.5 seconds per episode**!

### Problem 6: HLS Segment Extension Mismatch, Cloudflare 413 & MySQL Connection Limit
- **Issue A (FFmpeg & DropEmbed HLS Failure)**: When DropEmbed or native FFmpeg was sent Rumble HLS streams (`.tar?r_file=chunklist.m3u8`), FFmpeg failed with `URL is not in allowed_segment_extensions` or `detected format mpegts extension none mismatches allowed extensions in url`. Rumble's segment URLs (`mR8fA.caa.tar?r_file=media-0.ts`) have `.tar` before the query string, which FFmpeg treats as a disallowed extension.
- **Solution A**: Created an intelligent playlist parser in `recover-errors.js` that intercepts the m3u8 playlist, appends `&ext=.ts` to every segment URL, and saves a local rewritten playlist. FFmpeg detects `.ts` natively and remuxes the stream into MP4 at **8.55x speed** with 0 quality loss (`-c copy`).
- **Issue B (Direct Upload 413 for >95MB Files)**: Direct POST uploads to `POST https://dropembed.com/api/videos/upload` hit Cloudflare's strict 100 MB proxy body size limit on files >95 MB (e.g. 1.35 GB movies).
- **Solution B**: Built a dual upload engine:
  - If MP4 <= 95 MB: Direct multipart/form-data upload (takes 2 seconds).
  - If MP4 > 95 MB: GitHub Action runner launches a local HTTP file server on port 8080 and creates an ephemeral **Cloudflare Quick Tunnel (`cloudflared tunnel --url http://127.0.0.1:8080`)**. The tunnel outputs a public URL (`https://*.trycloudflare.com/video.mp4`), which is passed to DropEmbed's `POST /api/videos/remote-upload`. DropEmbed streams multi-gigabyte files directly server-to-server with ZERO body size limit!
- **Issue C (MySQL ER_CON_COUNT_ERROR: Too Many Connections)**: The shared MySQL server on Hetzner has `max_connections: 151` with ~145 connections actively consumed by other system services. When 10 GitHub runner shards connected at the exact same millisecond, MySQL threw `ER_CON_COUNT_ERROR` (code 1040).
- **Solution C**: Reduced recovery matrix to 3 shards (`max-parallel: 3`), added staggered startup delays (`SHARD_INDEX * 4000ms`), configured single-connection pools (`connectionLimit: 1`), and wrapped all pool initializations and DB updates in 15-attempt exponential backoff retry loops.

---

## 📁 5. Codebase Structure & File Roles

```
anime-dropembed-fleet/
├── .github/workflows/
│   ├── fleet.yml              # Main matrix fleet runner (10 shards) for bulk remote-upload
│   └── recover.yml            # Recovery workflow for remaining error episodes
├── public/                    # Frontend dashboard assets (HTML, Tailwind, Vanilla JS)
│   ├── index.html             # Dashboard page with live metrics, charts, episode table
│   └── app.js                 # Dashboard logic, auto-refresh every 15s
├── recover-errors.js          # Direct Vidara HLS -> DropEmbed remote ingest script
├── worker.js                  # Main fleet worker script for Blakite Rumble streams
├── server.js                  # Express backend running on Port 3001 serving stats & APIs
├── PROJECT_STATE.md           # THIS FILE — Persistent memory and project documentation
└── package.json               # Dependencies (express, mysql2)
```

---

## 💻 6. How to Run & Verify (Commands Cheat-Sheet)

### 1. Check Database Status (Run in Node):
```bash
node -e "import mysql from 'mysql2/promise'; const c = await mysql.createConnection({host:'37.27.232.161',user:'jeevanka_user',password:'MyAnimePass@2026!',database:'jeevanka_anime'}); const [r] = await c.query('SELECT stream_type, COUNT(*) as cnt FROM dropembed_anime_episodes GROUP BY stream_type ORDER BY cnt DESC'); console.table(r); await c.end();"
```

### 2. Check DropEmbed Account Stats:
```bash
node -e "const res = await fetch('http://localhost:3001/api/stats'); console.log(await res.json());"
```

### 3. Run Recovery Script Locally:
```powershell
$env:SHARD_INDEX='0'; $env:TOTAL_SHARDS='1'; $env:BATCH_SIZE='0'; node recover-errors.js
```

### 4. Trigger GitHub Recovery Workflow:
```bash
gh workflow run recover.yml --ref main --repo Zayrix-bit/anime-dropembed-fleet
```

### 5. Check Live GitHub Workflow Runs:
```bash
gh run list --repo Zayrix-bit/anime-dropembed-fleet -L 5
```

---

## 🎯 7. Next Steps for Any Agent Resuming This Work
1. **Current Mission Accomplished**: All 268 Vidara episodes have been 100% recovered and updated to `MP4` in the database.
2. **Next Task (The Remaining 211 Blakite Episodes)**:
   - Check why `176 HLS_ERROR` and `35 ERROR` episodes in `blakiteapi.xyz` failed in `worker.js`.
   - Mostly, these are due to expired Rumble byte-ranges in `qualities_json` or outdated CDN URLs.
   - To fix them: call `https://blakiteapi.xyz/api/get.php?id={season}-{episode}&tmdbId={tmdb_id}` to refresh fresh `dataId` and `ranges`, then re-queue them to DropEmbed via `remote-upload`.

---

## 📚 8. Blakite Catalog Reconciliation & Dual Dub ('Both') Integration
On October 2, 2026, a comprehensive live audit between `https://blakiteapi.xyz/api/getAllAnime.php` and the MySQL database was conducted:

### Blakite Catalog Summary:
- **FanDub (`language=FanDub`)**: 55 Titles on Blakite -> **All 55 saved in DB (0 missing)**.
- **Official / ORG (`language=ORG`)**: 234 Titles on Blakite -> **231 saved in DB**.
- The 3 remaining unindexed titles on Blakite:
  1. `Mahabharat` (TMDB 503928, Movie - Indian animation, API returns content not found).
  2. `Squid Game` (TMDB 93405, 2 Seasons - Korean Live Action Drama).
  3. `Genie, Make a Wish` (TMDB 228689, 1 Season - Korean Live Action Drama).

### Dual-Dub (`Both`) Resolution:
- **Tokyo Revengers** (TMDB: `105009`): Blakite has S1 (Official, 24 eps) and S2+S3 (FanDub, 25 eps). Previously tagged as 'FanDub' in `anime_series`.
- **Re:Monster** (TMDB: `235389`): Blakite has S1 Official (12 eps) and S1 FanDub (12 eps). Previously tagged as 'FanDub'.
- **Database & Code Fix**:
  - `anime_series` & `dropembed_anime_series`: Updated `dub_type = 'Both'` for both titles. Tokyo Revengers `total_seasons` updated to `3` and `total_episodes` to `49`. Re:Monster `total_episodes` updated to `24`.
  - Backend filter logic (`anime-portal` & `anime-dropembed-fleet` `server.js`): Updated `WHERE (dub_type = ? OR dub_type = 'Both')` so that filtering by either 'Official' or 'FanDub' includes both hybrid titles.
  - Stats API: Updated to `SUM(CASE WHEN dub_type IN ('Official', 'Both') THEN 1 ELSE 0 END)` showing **231 Official** and **55 FanDub** titles.
  - Frontend UI (`app.js`): Displays `🎙️ Official & 🎧 FanDub` badge for `dub_type = 'Both'`. Season tabs allow seamless switching across Official (S1) and FanDub (S2/S3).

---

## 🚀 9. Cloud Remux Recovery Results & Source-Expired Episodes Audit
On October 2, 2026, the updated cloud remux recovery fleet was executed via GitHub Actions:
- **GitHub Workflow Run**: `#36991110283` (`recover.yml`)
- **Execution Time**: Under 5 minutes across 3 parallel cloud shards (`ubuntu-latest`).
- **Results**:
  - **19 Episodes Newly Recovered & Ingested**: Native FFmpeg remuxed at up to 1080p, streamed through ephemeral Cloudflare Quick Tunnels, and stored in DropEmbed as clean MP4s:
    - *The Eminence in Shadow (Hindi Fan Dubbed)*: All 12 episodes (S1E1–E12) 100% recovered!
    - *Tokyo Revengers (Hindi Fan Dubbed)*: S2E4 recovered!
    - *Shikimori's Not Just a Cutie (Hindi Fan Dubbed)*: S1E5, S1E8 recovered!
    - *CLASSROOM FOR HEROES (Hindi Fan Dubbed)*: S1E12 recovered!
    - *The Dangers in My Heart (Hindi Fan Dubbed)*: S1E7 recovered!
    - *The Dreaming Boy Is a Realist (Hindi Fan Dubbed)*: S1E7 recovered!
    - *My Stepmom's Daughter Is My Ex (Hindi Fan Dubbed)*: S1E5 recovered!

### 🛑 Root-Cause of the Remaining 192 Unrecoverable Episodes:
The remaining 192 episodes failed stream resolution because **the underlying video files were physically deleted / taken down from Rumble CDN (`hugh.cdn.rumble.cloud`) by the source uploader**:
- HTTP requests to their segment files return `HTTP 403 AccessDenied (<Code>AccessDenied</Code>)` or `HTTP 416 InvalidRange`.
- Neither Blakite nor Vidara hosts alternative streams for these specific episodes.

#### Top Expired Anime Breakdown:
1. **The Rising of the Shield Hero** (Official): 20 episodes (`S1`: E1, E3, E4, E6, E8, E11-E13, E16-E19, E21-E23; `S2`: E1, E3, E7-E9)
2. **The Ancient Magus' Bride** (Official): 17 episodes (`S1`: E1-E6, E8, E10, E11, E13-E18, E21, E22)
3. **My Hero Academia** (Official): 15 episodes (`S6`: E4-E13, E18, E25; `S7`: E4, E15; `S8`: E1)
4. **Dragon Ball Z Kai** (Official): 13 episodes (`S2`: E19-E22, E24, E25, E27, E29, E30, E32-E35)
5. **DARLING in the FRANXX** (Official): 12 episodes (`S1`: E2-E7, E16-E19, E21, E24)
6. **Mob Psycho 100** (Official): 12 episodes (`S1`: E1-E12 — entire season expired on source CDN)
7. **My Hero Academia: Vigilantes** (Official): 11 episodes (`S1`: E1, E2, E4-E12)
8. **I Parry Everything** (Official): 10 episodes (`S1`: E1-E4, E6, E7, E9-E12)
9. **Bleach (Classic)** (Official): 10 episodes (`S2`: E2, E4, E8-E10, E12, E20, E21; `S3`: E1, E8)
10. **Naruto (Classic)** (Official): 10 episodes (`S1`: E10, E15, E18, E23; `S2`: E4, E17, E21, E25; `S3`: E19; `S5`: E17)
11. **Mechanical Marie** (Official): 10 episodes (`S1`: E1-E10)
12. **My One-Hit Kill Sister** (Official): 5 episodes (`S1`: E2, E4, E8, E9, E11)
13. **Pokémon** (Official): 4 episodes (`S19`: E45-E48)
14. **Naruto Shippūden** (Official): 3 episodes (`S1`: E5, E6; `S10`: E7)
15. **The Warrior Princess and the Barbaric King** (Official): 3 episodes (`S1`: E3, E4, E8)
16. **Movies (FanDub)**: 4 full movies (*A Silent Voice: The Movie*, *I Want to Eat Your Pancreas*, *Patema Inverted*, *Summer Ghost*)
17. **Singular Episodes**: 1-2 episodes each across *Demon Lord Retry*, *Overlord*, *Code Geass*, *Haikyu!!*, *Devil May Cry*, *DB DAIMA*, *Fairy Tail 100YQ*, *SAO*, *Grand Blue*, *Hokkaido Gals*, *Ameku M.D.*, *Catch Me at the Ballpark*, *Clevatess*, *Magic Maker*, *My Unique Skill*, *Nippon Sangoku*, *Paradox Live*, *She Professed Herself Pupil*, *Teogonia*, *Thunder 3*, *Wistoria S2*, *Witch Hat Atelier*, *YAIBA*.

---

## 🏆 10. Summary of Fleet Milestones
- **5,921 Playable MP4 Episodes** successfully uploaded to DropEmbed (**96.9% catalog completion**).
- **278 out of 284 Anime Series** have working, playable episodes ready on DropEmbed (**97.9% series coverage**).
- **1.9 Terabytes (1,896,149 MB)** of optimized video streams stored on DropEmbed CDN.
- **Dual-Dub ('Both') architecture** seamlessly deployed across backend APIs and frontend UI with multi-season playback.
- **Cloud remuxing pipeline** verified with native FFmpeg, Cloudflare Quick Tunnel streaming, and 0 bytes consumed on local machines.

