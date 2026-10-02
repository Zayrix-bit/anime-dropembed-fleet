import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Environment Configuration ──
const DB_HOST = process.env.DB_HOST || '37.27.232.161';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER || 'jeevanka_user';
const DB_PASSWORD = process.env.DB_PASSWORD || 'MyAnimePass@2026!';
const DB_NAME = process.env.DB_NAME || 'jeevanka_anime';

const DROPEMBED_API_KEY = process.env.DROPEMBED_API_KEY || 'dpe_live_c9bbcfeff68964f97bf935152ffe040b';
const DROPEMBED_FOLDER_ID = process.env.DROPEMBED_FOLDER_ID ? parseInt(process.env.DROPEMBED_FOLDER_ID, 10) : null;
const DROPEMBED_API = 'https://dropembed.com/api';

// Workflow Inputs
const MAGNET_URI = process.env.MAGNET_URI || process.argv[2] || '';
const TMDB_ID = parseInt(process.env.TMDB_ID || process.argv[3] || '0', 10);
const TARGET_SEASON = parseInt(process.env.TARGET_SEASON || process.argv[4] || '1', 10);
const TARGET_EPISODE = process.env.TARGET_EPISODE || process.argv[5] || 'AUTO'; // 'AUTO', '1', '2', etc.
const EPISODE_TITLE = process.env.EPISODE_TITLE || '';

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const PROCESSED_DIR = path.join(__dirname, 'processed_media');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Local HTTP Server + Cloudflare Quick Tunnel ──
let tunnelUrl = null;
let tunnelProc = null;
const HTTP_PORT = 8990;

const fileServer = http.createServer((req, res) => {
  const cleanUrl = req.url.split('?')[0].replace(/^\/+/, '');
  const filePath = path.join(PROCESSED_DIR, cleanUrl);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('File not found');
  }
});

function initLocalServerAndTunnel() {
  return new Promise((resolve) => {
    fileServer.listen(HTTP_PORT, '0.0.0.0', () => {
      console.log(`📡 Local HTTP server listening on port ${HTTP_PORT}`);

      try {
        const proc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${HTTP_PORT}`], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        tunnelProc = proc;

        let resolved = false;
        const parseLine = (chunk) => {
          const str = chunk.toString();
          const match = str.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
          if (match && !resolved) {
            resolved = true;
            tunnelUrl = match[0];
            console.log(`🌐 Cloudflare Quick Tunnel ready: ${tunnelUrl}`);
            resolve(tunnelUrl);
          }
        };

        proc.stdout.on('data', parseLine);
        proc.stderr.on('data', parseLine);

        setTimeout(() => {
          if (!resolved) {
            console.log(`ℹ️ Cloudflare tunnel timeout (will fallback to direct upload if possible)`);
            resolve(null);
          }
        }, 10000);
      } catch (err) {
        console.log(`ℹ️ cloudflared not available: ${err.message}`);
        resolve(null);
      }
    });
  });
}

// ── Resolver for Nyaa.si URLs, Direct .torrent files, and Magnet URIs ──
async function resolveTorrentSource(input) {
  const trimmed = input.trim();

  // Case 1: Direct Magnet URI
  if (trimmed.startsWith('magnet:?')) {
    console.log(`🧲 Input is a direct Magnet URI`);
    return { type: 'magnet', source: trimmed };
  }

  // Case 2: Tsukihime Search or Torrent URL (e.g., https://tsukihime.org/search?q=... or https://tsukihime.org/torrent/...)
  const isTsukihime = trimmed.includes('tsukihime.org');
  if (isTsukihime) {
    console.log(`🌙 Detected Tsukihime URL: ${trimmed}`);
    try {
      const parsedUrl = new URL(trimmed);

      // Sub-case 2A: Search URL (e.g. /search?q=...)
      if (parsedUrl.pathname.includes('/search')) {
        const query = parsedUrl.searchParams.get('q') || '';
        console.log(`   Searching Tsukihime API for query: "${query}"...`);
        const searchApi = `https://api.tsukihime.org/v1/search/torrents?q=${encodeURIComponent(query)}&limit=25`;
        const res = await fetch(searchApi, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000)
        });
        const data = await res.json();
        const results = data.results || [];

        if (results.length > 0) {
          let chosen = null;
          if (TARGET_EPISODE && TARGET_EPISODE !== 'AUTO') {
            const padEp = String(TARGET_EPISODE).padStart(2, '0');
            chosen = results.find(r => {
              const name = (r.name || '').toLowerCase();
              return name.includes('e' + padEp) || name.includes(' - ' + padEp) || name.includes('e' + TARGET_EPISODE);
            });
          }
          if (!chosen) chosen = results[0];

          console.log(`   ✅ Tsukihime matched: "${chosen.name}"`);
          const trackers = [
            'http://nyaa.tracker.wf:7777/announce',
            'udp://open.stealth.si:80/announce',
            'udp://tracker.opentrackr.org:1337/announce',
            'udp://exodus.desync.com:6969/announce',
            'udp://tracker.torrent.eu.org:451/announce'
          ].map(t => `&tr=${encodeURIComponent(t)}`).join('');
          const magnet = `magnet:?xt=urn:btih:${chosen.btih}&dn=${encodeURIComponent(chosen.name)}${trackers}`;
          return { type: 'magnet', source: magnet };
        } else {
          console.warn(`   ⚠️ No results found on Tsukihime API for "${query}".`);
        }
      }

      // Sub-case 2B: Single Torrent / Release URL (e.g. /torrent/{id} or /torrents/{id})
      const torrentIdMatch = parsedUrl.pathname.match(/\/(?:torrent|torrents|release|releases)\/(\d+)/i);
      if (torrentIdMatch) {
        const tid = torrentIdMatch[1];
        console.log(`   Fetching Tsukihime single torrent ID: ${tid}...`);
        const res = await fetch(`https://api.tsukihime.org/v1/torrents/${tid}`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000)
        });
        if (res.ok) {
          const t = await res.json();
          if (t && t.btih) {
            console.log(`   ✅ Retrieved BTIH: ${t.btih} ("${t.name}")`);
            const magnet = `magnet:?xt=urn:btih:${t.btih}&dn=${encodeURIComponent(t.name)}`;
            return { type: 'magnet', source: magnet };
          }
        }
      }
    } catch (err) {
      console.warn(`   ⚠️ Error parsing Tsukihime URL: ${err.message}`);
    }
  }

  // Case 3: Nyaa.si / Sukebei View URL (e.g., https://nyaa.si/view/2168567)
  const nyaaMatch = trimmed.match(/(?:nyaa\.si|sukebei\.nyaa\.si|nyaa\.land)\/view\/(\d+)/i);
  if (nyaaMatch) {
    const nyaaId = nyaaMatch[1];
    console.log(`🔍 Detected Nyaa.si View URL (ID: ${nyaaId})`);

    // Try fetching page to extract magnet URI
    try {
      console.log(`   Fetching ${trimmed} to extract magnet link...`);
      const res = await fetch(trimmed, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(15000)
      });

      if (res.ok) {
        const html = await res.text();
        const magnetMatch = html.match(/href=["'](magnet:\?[^"']+)["']/i);
        if (magnetMatch) {
          const magnet = magnetMatch[1].replace(/&amp;/g, '&');
          console.log(`   ✅ Extracted Magnet Link from Nyaa: ${magnet.slice(0, 90)}...`);
          return { type: 'magnet', source: magnet };
        }
      }
    } catch (err) {
      console.warn(`   ⚠️ Could not fetch Nyaa HTML directly (${err.message}). Trying .torrent download...`);
    }

    // Direct Nyaa download link fallback
    const directTorrentUrl = `https://nyaa.si/download/${nyaaId}.torrent`;
    console.log(`   🌐 Using direct Nyaa .torrent URL: ${directTorrentUrl}`);
    return { type: 'torrent_url', source: directTorrentUrl };
  }

  // Case 3: Direct .torrent URL
  if (trimmed.endsWith('.torrent') || trimmed.includes('/download/')) {
    console.log(`🌐 Input is a direct .torrent file URL: ${trimmed}`);
    return { type: 'torrent_url', source: trimmed };
  }

  // Case 4: Any Webpage with a magnet link (e.g. 1337x, AnimeTM, etc.)
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      console.log(`🔍 Fetching webpage to extract magnet: ${trimmed}`);
      const res = await fetch(trimmed, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(15000)
      });
      if (res.ok) {
        const html = await res.text();
        const magnetMatch = html.match(/href=["'](magnet:\?[^"']+)["']/i);
        if (magnetMatch) {
          const magnet = magnetMatch[1].replace(/&amp;/g, '&');
          console.log(`   ✅ Extracted Magnet Link: ${magnet.slice(0, 90)}...`);
          return { type: 'magnet', source: magnet };
        }
      }
    } catch (err) {
      console.warn(`Could not fetch page: ${err.message}`);
    }
    return { type: 'torrent_url', source: trimmed };
  }

  return { type: 'raw', source: trimmed };
}

// ── Torrent Downloader using aria2c ──
async function downloadTorrent(rawInput) {
  const resolved = await resolveTorrentSource(rawInput);
  let targetArg = resolved.source;

  // If it's a .torrent URL, download the .torrent file first or pass directly
  if (resolved.type === 'torrent_url') {
    const torrentFile = path.join(DOWNLOADS_DIR, 'input.torrent');
    try {
      console.log(`📥 Downloading .torrent file from ${resolved.source}...`);
      const res = await fetch(resolved.source, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(20000)
      });
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(torrentFile, buffer);
        console.log(`✅ Saved .torrent file (${buffer.length} bytes) to ${torrentFile}`);
        targetArg = torrentFile;
      }
    } catch (err) {
      console.warn(`Direct .torrent file download warning: ${err.message}. Passing URL to aria2c directly.`);
    }
  }

  console.log(`\n======================================================`);
  console.log(`🧲 STARTING TORRENT DOWNLOAD VIA ARIA2C`);
  console.log(`Target: ${targetArg.slice(0, 100)}...`);
  console.log(`======================================================`);

  const trackers = [
    'http://nyaa.tracker.wf:7777/announce',
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://explodie.org:6969/announce',
    'udp://tracker.openbittorrent.com:6969/announce'
  ].join(',');

  const ariaArgs = [
    '--enable-dht=true',
    '--enable-dht6=true',
    '--bt-enable-lpd=true',
    '--bt-max-peers=120',
    '--max-connection-per-server=16',
    '--seed-time=0',
    '--max-overall-upload-limit=1K',
    '--summary-interval=5',
    '--bt-stop-timeout=120',
    '--bt-tracker=' + trackers,
    '--dir=' + DOWNLOADS_DIR,
    targetArg
  ];

  const startTime = Date.now();
  const proc = spawn('aria2c', ariaArgs, { stdio: 'inherit' });

  return new Promise((resolve, reject) => {
    proc.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`\n✅ Torrent downloaded successfully in ${elapsed}s!`);
        resolve(true);
      } else {
        reject(new Error(`aria2c exited with error code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start aria2c: ${err.message}. Ensure aria2 is installed.`));
    });
  });
}

// ── Recursive Video File Finder ──
function findVideoFiles(dir) {
  let files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(findVideoFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.mkv', '.mp4', '.avi', '.mov', '.ts', '.webm'].includes(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

// ── Episode Number Parser ──
function extractEpisodeInfo(filename, defaultSeason = 1) {
  // 1. S01E05 or s1e5
  const sEpMatch = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})/i);
  if (sEpMatch) {
    return {
      season: parseInt(sEpMatch[1], 10),
      episode: parseInt(sEpMatch[2], 10)
    };
  }

  // 2. " - 05 " or " - 05[" or " - 05." or "E05"
  const epMatch = filename.match(/(?:-\s*|ep(?:isode)?\s*|e)(\d{1,3})(?:v\d)?(?:\s*\[|\s*\(|\s*\.|\s*$)/i);
  if (epMatch) {
    return {
      season: defaultSeason,
      episode: parseInt(epMatch[1], 10)
    };
  }

  // 3. Fallback standalone number before extension or quality
  const numMatch = filename.match(/\b(\d{1,3})\b(?=\s*\[|\s*\(|\.mkv|\.mp4)/i);
  if (numMatch) {
    return {
      season: defaultSeason,
      episode: parseInt(numMatch[1], 10)
    };
  }

  return {
    season: defaultSeason,
    episode: 1
  };
}

// ── Intelligent Hindi Audio Stream Detection ──
function getBestAudioStream(inputPath) {
  try {
    const res = spawnSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=index,codec_type:stream_tags=language,title',
      '-of', 'json',
      inputPath
    ]);
    if (res.status === 0) {
      const data = JSON.parse(res.stdout.toString());
      const audioStreams = (data.streams || []).filter(s => s.codec_type === 'audio');
      
      // 1. Look for Hindi language tag or title
      const hindiStream = audioStreams.find(s => {
        const lang = (s.tags?.language || '').toLowerCase();
        const title = (s.tags?.title || '').toLowerCase();
        return lang.includes('hin') || title.includes('hindi');
      });

      if (hindiStream) {
        console.log(`   🎙️ Found HINDI Audio Stream at stream index ${hindiStream.index}!`);
        return hindiStream.index;
      }

      // 2. Fallback to first audio stream
      if (audioStreams.length > 0) {
        return audioStreams[0].index;
      }
    }
  } catch (err) {
    console.warn(`   ⚠️ ffprobe check warning: ${err.message}`);
  }
  return null;
}

// ── Fast Remux to Streamable Web MP4 ──
async function remuxToFastWebMp4(inputPath, outputPath) {
  console.log(`   ⚙️ Fast Remuxing to MP4: ${path.basename(inputPath)}`);
  
  const preferredAudioIndex = getBestAudioStream(inputPath);
  const args = ['-y', '-i', inputPath];

  if (preferredAudioIndex !== null) {
    args.push('-map', '0:v:0', '-map', `0:${preferredAudioIndex}`);
  }

  args.push(
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  );

  const res = spawnSync('ffmpeg', args, { timeout: 600000 });
  if (res.status === 0 && fs.existsSync(outputPath)) {
    const size = fs.statSync(outputPath).size;
    console.log(`   ✅ Remux Complete: ${(size / 1024 / 1024).toFixed(1)} MB`);
    return size;
  }
  throw new Error(`FFmpeg remux error: ${res.stderr ? res.stderr.toString().slice(-300) : 'Unknown'}`);
}

// ── Upload to DropEmbed ──
async function uploadToDropEmbed(filePath, title) {
  const stat = fs.statSync(filePath);
  const sizeMb = (stat.size / 1024 / 1024).toFixed(1);

  // Strategy A: If <= 95 MB, direct multipart
  if (stat.size <= 95 * 1024 * 1024) {
    console.log(`   📤 Direct Form Upload (${sizeMb} MB)...`);
    const blob = await fs.openAsBlob(filePath, { type: 'video/mp4' });
    const formData = new FormData();
    formData.append('video', blob, path.basename(filePath));
    if (title) formData.append('title', title);
    if (DROPEMBED_FOLDER_ID) formData.append('folder_id', DROPEMBED_FOLDER_ID);

    const res = await fetch(`${DROPEMBED_API}/videos/upload`, {
      method: 'POST',
      headers: { 'X-API-Key': DROPEMBED_API_KEY },
      body: formData
    });

    const json = await res.json();
    if (json.success && json.video_id) {
      return json.video_id;
    }
    throw new Error(`Direct upload failed: ${JSON.stringify(json)}`);
  }

  // Strategy B: If > 95 MB, remote upload via Cloudflare Quick Tunnel
  if (tunnelUrl) {
    console.log(`   🌐 Remote Upload via Tunnel URL: ${tunnelUrl}/${path.basename(filePath)} (${sizeMb} MB)...`);
    const publicUrl = `${tunnelUrl}/${path.basename(filePath)}`;

    const res = await fetch(`${DROPEMBED_API}/videos/remote-upload`, {
      method: 'POST',
      headers: {
        'X-API-Key': DROPEMBED_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ urls: [publicUrl], folder_id: DROPEMBED_FOLDER_ID || 0 })
    });

    const json = await res.json();
    const videoId = json?.tasks?.[0]?.video_id || json?.video_id || json?.data?.[0]?.id;

    if (videoId) {
      if (title) {
        try {
          await fetch(`${DROPEMBED_API}/videos/${videoId}`, {
            method: 'PATCH',
            headers: {
              'X-API-Key': DROPEMBED_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title })
          });
        } catch {}
      }
      return videoId;
    }
    throw new Error(`Remote upload returned invalid response: ${JSON.stringify(json)}`);
  }

  throw new Error(`File is > 95MB and Cloudflare tunnel is not active.`);
}

// ── Database Updater ──
async function updateEpisodeInDb(pool, tmdbId, season, episode, filecode, animeTitle) {
  const embedUrl = `https://dropembed.com/e/${filecode}`;
  const watchUrl = `https://dropembed.com/v/${filecode}`;

  // Check if row exists
  const [existing] = await pool.execute(
    'SELECT id FROM dropembed_anime_episodes WHERE tmdb_id = ? AND season = ? AND episode = ?',
    [tmdbId, season, episode]
  );

  if (existing.length > 0) {
    await pool.execute(`
      UPDATE dropembed_anime_episodes
      SET stream_type = 'MP4',
          filecode = ?,
          embed_url = ?,
          watch_url = ?,
          quality = '1080p',
          updated_at = NOW()
      WHERE id = ?
    `, [filecode, embedUrl, watchUrl, existing[0].id]);
    console.log(`   💾 Database row #${existing[0].id} UPDATED (S${season}E${episode} -> ${filecode})`);

    // Ensure NO duplicates ever exist for the same season and episode
    if (existing.length > 1) {
      const extraIds = existing.slice(1).map(x => x.id);
      const placeholders = extraIds.map(() => '?').join(',');
      await pool.execute(`DELETE FROM dropembed_anime_episodes WHERE id IN (${placeholders})`, extraIds);
      console.log(`   🧹 Cleaned up ${extraIds.length} duplicate row(s) for S${season}E${episode}`);
    }
  } else {
    await pool.execute(`
      INSERT INTO dropembed_anime_episodes
        (tmdb_id, season, episode, anime_title, quality, stream_type, dub_type, filecode, embed_url, watch_url, updated_at)
      VALUES
        (?, ?, ?, ?, '1080p', 'MP4', 'Official', ?, ?, ?, NOW())
    `, [tmdbId, season, episode, animeTitle || `Anime TMDB ${tmdbId}`, filecode, embedUrl, watchUrl]);
    console.log(`   💾 Database row INSERTED (S${season}E${episode} -> ${filecode})`);
  }

  // Auto-update total_episodes and total_seasons in series table
  try {
    const [counts] = await pool.execute(
      'SELECT COUNT(*) as ep_cnt, MAX(season) as max_s FROM dropembed_anime_episodes WHERE tmdb_id = ?',
      [tmdbId]
    );
    if (counts.length > 0) {
      await pool.execute(
        'UPDATE dropembed_anime_series SET total_episodes = GREATEST(total_episodes, ?), total_seasons = GREATEST(total_seasons, ?) WHERE tmdb_id = ?',
        [counts[0].ep_cnt, counts[0].max_s, tmdbId]
      );
      console.log(`   📊 Series stats updated: total_episodes=${counts[0].ep_cnt}, total_seasons=${counts[0].max_s}`);
    }
  } catch (err) {
    console.warn(`   ⚠️ Could not update series counts: ${err.message}`);
  }
}

// ── MAIN RUNNER ──
async function main() {
  if (!MAGNET_URI) {
    console.error('❌ Error: MAGNET_URI is required. Provide it as environment variable or argument.');
    process.exit(1);
  }

  if (!TMDB_ID || TMDB_ID <= 0) {
    console.error('❌ Error: TMDB_ID is required to link episodes to the database.');
    process.exit(1);
  }

  const pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    connectionLimit: 3,
    connectTimeout: 20000
  });

  // Verify Series Title in DB
  let animeTitle = '';
  try {
    const [series] = await pool.execute('SELECT title FROM dropembed_anime_series WHERE tmdb_id = ?', [TMDB_ID]);
    if (series.length > 0) animeTitle = series[0].title;
    console.log(`📺 Target Series: "${animeTitle || 'TMDB ' + TMDB_ID}" (TMDB ID: ${TMDB_ID})`);
  } catch (err) {
    console.warn(`Warning reading series title: ${err.message}`);
  }

  // 1. Start Local File Server & Tunnel
  await initLocalServerAndTunnel();

  // 2. Download Torrent via aria2c
  await downloadTorrent(MAGNET_URI);

  // 3. Find Downloaded Video Files
  const videoFiles = findVideoFiles(DOWNLOADS_DIR);
  console.log(`\nFound ${videoFiles.length} video files in torrent download.`);

  if (videoFiles.length === 0) {
    console.error('❌ No valid video files (.mkv, .mp4, etc.) found in downloaded torrent.');
    process.exit(1);
  }

  // 4. Process each file
  let processedCount = 0;

  for (const videoPath of videoFiles) {
    const rawFilename = path.basename(videoPath);
    console.log(`\n──────────────────────────────────────────────────────`);
    console.log(`▶ Processing: ${rawFilename}`);

    // Parse Season & Episode from filename
    const detected = extractEpisodeInfo(rawFilename, TARGET_SEASON);
    let sNum = detected.season || TARGET_SEASON;
    let epNum = detected.episode;

    // Handle single-file torrent vs multi-file batch torrent
    if (videoFiles.length === 1 && TARGET_EPISODE !== 'AUTO' && !isNaN(parseInt(TARGET_EPISODE, 10))) {
      // Single file download: respect explicitly requested episode
      epNum = parseInt(TARGET_EPISODE, 10);
      sNum = TARGET_SEASON;
    } else if (TARGET_EPISODE !== 'AUTO' && !isNaN(parseInt(TARGET_EPISODE, 10))) {
      // Multi-file batch: only process the specifically requested episode
      if (epNum !== parseInt(TARGET_EPISODE, 10) || (TARGET_SEASON && sNum !== TARGET_SEASON)) {
        console.log(`   ⏭️ Skipping file (Detected S${sNum}E${epNum}, but target is S${TARGET_SEASON}E${TARGET_EPISODE})`);
        continue;
      }
    }

    console.log(`   🎯 Selected Target: Season ${sNum}, Episode ${epNum}`);

    // Check if this episode is already playable MP4 in DB (unless explicitly targeted)
    if (TARGET_EPISODE === 'AUTO') {
      const [existing] = await pool.execute(
        "SELECT id, filecode FROM dropembed_anime_episodes WHERE tmdb_id = ? AND season = ? AND episode = ? AND stream_type = 'MP4' AND filecode IS NOT NULL AND LENGTH(filecode) > 6",
        [TMDB_ID, sNum, epNum]
      );
      if (existing.length > 0) {
        console.log(`   ⏭️ S${sNum}E${epNum} already has active DropEmbed MP4 (${existing[0].filecode}). Skipping!`);
        continue;
      }
    }

    const safeTitle = `${animeTitle || 'Anime'} S${String(sNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')} [1080p]`;
    const cleanOutputName = `tmdb_${TMDB_ID}_s${sNum}e${epNum}_${Date.now()}.mp4`;
    const outputPath = path.join(PROCESSED_DIR, cleanOutputName);

    try {
      // Remux to clean MP4
      await remuxToFastWebMp4(videoPath, outputPath);

      // Upload to DropEmbed
      console.log(`   🚀 Uploading to DropEmbed...`);
      const filecode = await uploadToDropEmbed(outputPath, safeTitle);
      console.log(`   🎉 Uploaded! DropEmbed Filecode: ${filecode}`);

      // Update MySQL
      await updateEpisodeInDb(pool, TMDB_ID, sNum, epNum, filecode, animeTitle);
      processedCount++;

      // Cleanup processed mp4 file to preserve disk
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (err) {
      console.error(`   ❌ Failed processing ${rawFilename}: ${err.message}`);
    }
  }

  console.log(`\n======================================================`);
  console.log(`🏁 INGESTION COMPLETE: ${processedCount} / ${videoFiles.length} episodes processed!`);
  console.log(`======================================================\n`);

  if (tunnelProc) tunnelProc.kill('SIGTERM');
  fileServer.close();
  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Fatal error in torrent ingest pipeline:', err);
  process.exit(1);
});
