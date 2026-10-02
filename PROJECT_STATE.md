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
| ✅ **Successfully Processed as MP4** | **5,902** | **96.5% Completed** 🎉 |
| ❌ **Remaining Error Episodes** | **211** | **3.5% Remaining** |
| ⚡ **Vidara.to Error Episodes** | **0 (ZERO!)** | **100% Recovered** (All 268 resolved) |
| ☁️ **Total DropEmbed Storage** | **1,500+ GB (~1.5 TB)** | Over 5,800 active video files |
| 🖥️ **Live Web Dashboard** | **Active on Port 3001** | `http://localhost:3001` |

### Remaining Error Breakdown (211 episodes):
- `stream_type = 'HLS_ERROR'`: **176** (All `blakiteapi.xyz` sources)
- `stream_type = 'ERROR'`: **35** (All `blakiteapi.xyz` sources)
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
  - Cloudflare's 100MB limit is completely bypassed because only a 100-byte JSON payload (`{ urls: [hlsUrl] }`) is sent.
  - DropEmbed's backend cloud servers fetch all segments directly over multi-gigabit pipes, transcode them on Bunny Stream, and make the embed ready in seconds.
  - Processing time dropped from **15 minutes per episode to under 1.5 seconds per episode**!

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
