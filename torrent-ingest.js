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

// ── Torrent Downloader using aria2c ──
async function downloadTorrent(magnetOrUrl) {
  console.log(`\n======================================================`);
  console.log(`🧲 STARTING TORRENT DOWNLOAD VIA ARIA2C`);
  console.log(`Source: ${magnetOrUrl.slice(0, 100)}...`);
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
    '--bt-tracker=' + trackers,
    '--dir=' + DOWNLOADS_DIR,
    magnetOrUrl
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
function extractEpisodeInfo(filename, defaultSeason = 1, defaultEpisode = 'AUTO') {
  if (defaultEpisode !== 'AUTO' && !isNaN(parseInt(defaultEpisode, 10))) {
    return {
      season: defaultSeason,
      episode: parseInt(defaultEpisode, 10)
    };
  }

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

// ── Fast Remux to Streamable Web MP4 ──
async function remuxToFastWebMp4(inputPath, outputPath) {
  console.log(`   ⚙️ Fast Remuxing to MP4 (copy video, audio aac): ${path.basename(inputPath)}`);
  const args = [
    '-y',
    '-i', inputPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  ];

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
  } else {
    await pool.execute(`
      INSERT INTO dropembed_anime_episodes
        (tmdb_id, season, episode, anime_title, quality, stream_type, dub_type, filecode, embed_url, watch_url, updated_at)
      VALUES
        (?, ?, ?, ?, '1080p', 'MP4', 'Official', ?, ?, ?, NOW())
    `, [tmdbId, season, episode, animeTitle || `Anime TMDB ${tmdbId}`, filecode, embedUrl, watchUrl]);
    console.log(`   💾 Database row INSERTED (S${season}E${episode} -> ${filecode})`);
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

    // Parse Season & Episode
    const info = extractEpisodeInfo(rawFilename, TARGET_SEASON, TARGET_EPISODE);
    console.log(`   🎯 Detected: Season ${info.season}, Episode ${info.episode}`);

    const safeTitle = `${animeTitle || 'Anime'} S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')} [1080p]`;
    const cleanOutputName = `tmdb_${TMDB_ID}_s${info.season}e${info.episode}_${Date.now()}.mp4`;
    const outputPath = path.join(PROCESSED_DIR, cleanOutputName);

    try {
      // Remux to clean MP4
      await remuxToFastWebMp4(videoPath, outputPath);

      // Upload to DropEmbed
      console.log(`   🚀 Uploading to DropEmbed...`);
      const filecode = await uploadToDropEmbed(outputPath, safeTitle);
      console.log(`   🎉 Uploaded! DropEmbed Filecode: ${filecode}`);

      // Update MySQL
      await updateEpisodeInDb(pool, TMDB_ID, info.season, info.episode, filecode, animeTitle);
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
