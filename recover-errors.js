import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Config ──
const DB_HOST = process.env.DB_HOST || '37.27.232.161';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER || 'jeevanka_user';
const DB_PASSWORD = process.env.DB_PASSWORD || 'MyAnimePass@2026!';
const DB_NAME = process.env.DB_NAME || 'jeevanka_anime';
const DROPEMBED_API_KEY = process.env.DROPEMBED_API_KEY || 'dpe_live_c9bbcfeff68964f97bf935152ffe040b';
const DROPEMBED_FOLDER_ID = process.env.DROPEMBED_FOLDER_ID ? parseInt(process.env.DROPEMBED_FOLDER_ID, 10) : null;
const DROPEMBED_API = 'https://dropembed.com/api';

const SHARD_INDEX = parseInt(process.env.SHARD_INDEX || '0', 10);
const TOTAL_SHARDS = parseInt(process.env.TOTAL_SHARDS || '1', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '0', 10);

const TEMP_DIR = path.join(__dirname, 'temp_media');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Local HTTP Server + Cloudflare Quick Tunnel (For Files > 95 MB) ──
let tunnelUrl = null;
let tunnelProc = null;
const HTTP_PORT = 8080 + (SHARD_INDEX % 10);

const fileServer = http.createServer((req, res) => {
  const cleanUrl = req.url.split('?')[0].replace(/^\/+/, '');
  const filePath = path.join(TEMP_DIR, cleanUrl);

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
            console.log(`ℹ️ Cloudflare tunnel not started or timeout (will use direct upload)`);
            resolve(null);
          }
        }, 8000);
      } catch (err) {
        console.log(`ℹ️ cloudflared not available: ${err.message}`);
        resolve(null);
      }
    });
  });
}

// ── Blakite Stream URL Resolution ──
const QUALITY_CODES = ['oaa', 'baa', 'caa', 'gaa', 'haa'];
const QUALITY_LABELS = ['240p', '360p', '480p', '720p', '1080p'];

async function getBlakiteStream(tmdbId, season, episode) {
  const tryIds = [String(tmdbId), '0' + String(tmdbId)];
  for (const tid of tryIds) {
    try {
      const res = await fetch(`https://blakiteapi.xyz/api/get.php?id=${season}-${episode}&tmdbId=${tid}`, {
        headers: { 'Referer': `https://blakiteapi.xyz/embed/${tid}/${season}-${episode}` },
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (!json.success || !json.data || !json.data.dataId) continue;

      const data = json.data;

      // Case 1: M3U8 with ranges
      if (data.format === 'M3U8' && data.ranges) {
        const rangeMap = {};
        data.ranges.split('\n').forEach(line => {
          const m = line.match(/^(\d+-\d+)\s*\(([^)]+)\)/);
          if (m) rangeMap[m[2].trim().toLowerCase()] = m[1];
        });

        // Try highest to lowest quality
        for (let q = QUALITY_LABELS.length - 1; q >= 0; q--) {
          const label = QUALITY_LABELS[q];
          const range = rangeMap[label.toLowerCase()];
          if (!range) continue;

          const testUrl = `https://hugh.cdn.rumble.cloud/video/${data.dataId}.${QUALITY_CODES[q]}.tar?r_file=chunklist.m3u8&r_type=application%2Fvnd.apple.mpegurl&r_range=${range}`;

          try {
            const check = await fetch(testUrl, { signal: AbortSignal.timeout(5000) });
            if (check.status === 200) {
              const playlistText = await check.text();
              if (playlistText.includes('#EXTM3U')) {
                return {
                  type: 'HLS_REWRITE',
                  dataId: data.dataId,
                  quality: label,
                  playlistText: playlistText,
                  baseUrl: `https://hugh.cdn.rumble.cloud/video/${data.dataId.substring(0, data.dataId.lastIndexOf('/') + 1)}`
                };
              }
            }
          } catch {}
        }
      }

      // Case 2: Direct MP4
      const maxQ = Math.min(data.qid || QUALITY_LABELS.length, QUALITY_LABELS.length) - 1;
      const mp4Code = QUALITY_CODES[maxQ] || 'caa';
      const mp4Label = QUALITY_LABELS[maxQ] || '480p';
      const mp4Url = `https://hugh.cdn.rumble.cloud/video/${data.dataId}.${mp4Code}.mp4`;

      try {
        const head = await fetch(mp4Url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        if (head.status === 200 || head.status === 206) {
          return { type: 'DIRECT_MP4', url: mp4Url, quality: mp4Label };
        }
      } catch {}
    } catch {}
  }
  return null;
}

// ── Vidara Stream URL Resolution Fallback ──
async function getVidaraStream(origEmbed) {
  if (!origEmbed || !origEmbed.includes('vidara.to')) return null;
  const match = origEmbed.match(/vidara\.to\/e\/([a-z0-9]+)/i);
  if (!match) return null;
  const filecode = match[1];

  try {
    const res = await fetch('https://vidara.to/api/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': `https://vidara.to/e/${filecode}`,
        'Origin': 'https://vidara.to'
      },
      body: JSON.stringify({ filecode, device: 'web', codecs: [] }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.streaming_url) {
      return { type: 'VIDARA_HLS', url: json.streaming_url, referer: `https://vidara.to/e/${filecode}` };
    }
  } catch {}
  return null;
}

// ── Convert HLS to MP4 using native FFmpeg ──
function convertHlsToMp4(streamInfo, outputPath) {
  let inputTarget = '';
  let tempPlaylistPath = null;
  const ffmpegHeaders = [];

  if (streamInfo.type === 'HLS_REWRITE') {
    // Rewrite segment lines so FFmpeg recognizes .ts extension cleanly
    tempPlaylistPath = outputPath.replace('.mp4', '_playlist.m3u8');
    const rewritten = streamInfo.playlistText.split('\n').map(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('http')) {
        return `${streamInfo.baseUrl}${trimmed}&ext=.ts`;
      }
      return line;
    }).join('\n');

    fs.writeFileSync(tempPlaylistPath, rewritten);
    inputTarget = tempPlaylistPath;
  } else if (streamInfo.type === 'VIDARA_HLS') {
    inputTarget = streamInfo.url;
    if (streamInfo.referer) {
      ffmpegHeaders.push(`Referer: ${streamInfo.referer}\r\nOrigin: https://vidara.to\r\n`);
    }
  }

  // Attempt 1: Fast stream copy (instant, 0 quality loss)
  const args1 = [
    '-y',
    '-loglevel', 'warning',
    '-err_detect', 'ignore_err',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto'
  ];
  if (ffmpegHeaders.length > 0) args1.push('-headers', ffmpegHeaders[0]);
  args1.push(
    '-i', inputTarget,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    outputPath
  );

  const res1 = spawnSync('ffmpeg', args1, { timeout: 600000 });
  if (res1.status === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100000) {
    if (tempPlaylistPath && fs.existsSync(tempPlaylistPath)) fs.unlinkSync(tempPlaylistPath);
    return fs.statSync(outputPath).size;
  }

  // Attempt 2: Copy video, re-encode audio to AAC (handles any timestamp/audio glitches)
  const args2 = [
    '-y',
    '-loglevel', 'warning',
    '-err_detect', 'ignore_err',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto'
  ];
  if (ffmpegHeaders.length > 0) args2.push('-headers', ffmpegHeaders[0]);
  args2.push(
    '-i', inputTarget,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  );

  const res2 = spawnSync('ffmpeg', args2, { timeout: 600000 });
  if (tempPlaylistPath && fs.existsSync(tempPlaylistPath)) fs.unlinkSync(tempPlaylistPath);

  if (res2.status === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100000) {
    return fs.statSync(outputPath).size;
  }

  throw new Error(`FFmpeg remux failed: ${res2.stderr ? res2.stderr.toString().slice(-200) : 'Unknown error'}`);
}

// ── Upload MP4 to DropEmbed ──
async function uploadToDropEmbed(filePath, title, quality) {
  const stat = fs.statSync(filePath);
  const sizeMb = (stat.size / 1024 / 1024).toFixed(1);

  // Strategy A: If <= 95 MB, upload directly via multipart/form-data (fast & bypasses Cloudflare body limits)
  if (stat.size <= 95 * 1024 * 1024) {
    console.log(`   📤 Direct Upload (${sizeMb} MB <= 95 MB)...`);
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
      return {
        videoId: json.video_id,
        embedUrl: `https://dropembed.com/v/${json.video_id}`,
        watchUrl: `https://dropembed.com/v/${json.video_id}`
      };
    }
    throw new Error(`Direct upload failed: ${JSON.stringify(json)}`);
  }

  // Strategy B: If > 95 MB and Cloudflare Quick Tunnel is active, use Remote Ingest
  if (tunnelUrl) {
    console.log(`   🌐 Remote Ingest via Tunnel (${sizeMb} MB > 95 MB)...`);
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
      // Patch video title
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

      // Wait a few seconds for DropEmbed to start streaming through the tunnel
      await sleep(5000);

      return {
        videoId: videoId,
        embedUrl: `https://dropembed.com/v/${videoId}`,
        watchUrl: `https://dropembed.com/v/${videoId}`
      };
    }
  }

  // Strategy C: Fallback quick re-encode to fit under 95 MB if tunnel is unavailable
  console.log(`   🗜️ Compressing (${sizeMb} MB) to fit under 95 MB for Cloudflare Direct Upload...`);
  const compressedPath = filePath.replace('.mp4', '_compressed.mp4');
  const compArgs = [
    '-y', '-loglevel', 'warning',
    '-i', filePath,
    '-c:v', 'libx264', '-crf', '26', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    compressedPath
  ];
  spawnSync('ffmpeg', compArgs, { timeout: 600000 });

  if (fs.existsSync(compressedPath)) {
    const compStat = fs.statSync(compressedPath);
    console.log(`   📤 Direct Upload Compressed (${(compStat.size / 1024 / 1024).toFixed(1)} MB)...`);

    const blob = await fs.openAsBlob(compressedPath, { type: 'video/mp4' });
    const formData = new FormData();
    formData.append('video', blob, path.basename(compressedPath));
    if (title) formData.append('title', title);
    if (DROPEMBED_FOLDER_ID) formData.append('folder_id', DROPEMBED_FOLDER_ID);

    const res = await fetch(`${DROPEMBED_API}/videos/upload`, {
      method: 'POST',
      headers: { 'X-API-Key': DROPEMBED_API_KEY },
      body: formData
    });
    try { fs.unlinkSync(compressedPath); } catch {}

    const json = await res.json();
    if (json.success && json.video_id) {
      return {
        videoId: json.video_id,
        embedUrl: `https://dropembed.com/v/${json.video_id}`,
        watchUrl: `https://dropembed.com/v/${json.video_id}`
      };
    }
  }

  throw new Error(`Upload failed for ${title}`);
}

// ── Main Recovery Process ──
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  ⚡ RECOVERY: Cloud HLS/MP4 Remux & DropEmbed Ingestion Fleet   ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`   Shard: ${SHARD_INDEX}/${TOTAL_SHARDS} | Batch: ${BATCH_SIZE || 'unlimited'}\n`);

  await initLocalServerAndTunnel();

  const pool = mysql.createPool({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
    waitForConnections: true, connectionLimit: 1, enableKeepAlive: true, keepAliveInitialDelay: 10000
  });

  const [allEpisodes] = await pool.execute(`
    SELECT 
      d.id, d.anime_title, d.season, d.episode, d.anilist_id, d.tmdb_id, d.stream_type,
      d.format, a.embed_url as orig_embed, a.quality as orig_quality
    FROM dropembed_anime_episodes d
    LEFT JOIN anime_episodes a 
      ON d.anilist_id = a.anilist_id AND d.season = a.season AND d.episode = a.episode
    WHERE d.stream_type IN ('ERROR', 'HLS_ERROR')
    ORDER BY d.id ASC
  `);

  const episodes = allEpisodes.filter((_, i) => i % TOTAL_SHARDS === SHARD_INDEX);
  const limited = BATCH_SIZE > 0 ? episodes.slice(0, BATCH_SIZE) : episodes;

  console.log(`📋 Total recoverable: ${allEpisodes.length} | This shard: ${limited.length}\n`);

  let recovered = 0;
  let failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < limited.length; i++) {
    const ep = limited[i];
    const label = `[${i + 1}/${limited.length}] ${ep.anime_title} S${ep.season}E${ep.episode} (#${ep.id})`;
    const title = `${ep.anime_title} - S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
    const mp4FileName = `ep_${ep.id}_${Date.now()}.mp4`;
    const mp4Path = path.join(TEMP_DIR, mp4FileName);

    console.log(`----------------------------------------------------------------`);
    console.log(`🔄 ${label}`);

    try {
      // Step 1: Discover Source
      let streamInfo = null;

      if (ep.tmdb_id) {
        process.stdout.write('   📡 Probing Blakite stream...');
        streamInfo = await getBlakiteStream(ep.tmdb_id, ep.season, ep.episode);
        if (streamInfo) console.log(` OK (${streamInfo.type} - ${streamInfo.quality || 'auto'})`);
      }

      if (!streamInfo && ep.orig_embed) {
        process.stdout.write('   📡 Probing Vidara stream...');
        streamInfo = await getVidaraStream(ep.orig_embed);
        if (streamInfo) console.log(` OK (${streamInfo.type})`);
      }

      if (!streamInfo) {
        throw new Error('No working stream found from Blakite or Vidara');
      }

      let dropembedResult = null;
      let finalQuality = streamInfo.quality || ep.orig_quality || '720p';

      // Step 2: Handle Direct MP4 vs HLS
      if (streamInfo.type === 'DIRECT_MP4') {
        console.log(`   ☁️ Remote Uploading Direct MP4 to DropEmbed...`);
        const res = await fetch(`${DROPEMBED_API}/videos/remote-upload`, {
          method: 'POST',
          headers: {
            'X-API-Key': DROPEMBED_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ urls: [streamInfo.url], folder_id: DROPEMBED_FOLDER_ID || 0 })
        });
        const json = await res.json();
        const videoId = json?.tasks?.[0]?.video_id || json?.video_id;
        if (videoId) {
          dropembedResult = {
            videoId,
            embedUrl: `https://dropembed.com/v/${videoId}`,
            watchUrl: `https://dropembed.com/v/${videoId}`
          };
        } else {
          throw new Error(`Remote upload direct MP4 failed: ${JSON.stringify(json)}`);
        }
      } else {
        // Step 2B: Remux HLS to MP4
        console.log(`   ⚙️ Remuxing HLS stream to MP4 via native FFmpeg...`);
        const remuxStart = Date.now();
        const fileSize = convertHlsToMp4(streamInfo, mp4Path);
        const remuxSec = ((Date.now() - remuxStart) / 1000).toFixed(1);
        console.log(`   📦 MP4 Created in ${remuxSec}s: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);

        // Step 3: Ingest to DropEmbed
        dropembedResult = await uploadToDropEmbed(mp4Path, `${title} [${finalQuality}]`, finalQuality);
      }

      if (dropembedResult?.videoId) {
        await pool.execute(
          `UPDATE dropembed_anime_episodes 
           SET stream_type = 'MP4', quality = ?, filecode = ?, embed_url = ?, watch_url = ?, updated_at = NOW() 
           WHERE id = ?`,
          [finalQuality, dropembedResult.videoId, dropembedResult.embedUrl, dropembedResult.watchUrl, ep.id]
        );
        console.log(`   ✅ SUCCESS: DropEmbed ID = ${dropembedResult.videoId}`);
        recovered++;
      }
    } catch (err) {
      console.log(`   ❌ ERROR: ${err.message}`);
      failed++;
    } finally {
      try { if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path); } catch {}
    }

    await sleep(1000);
  }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log('\n================================================================');
  console.log(`🎉 RECOVERY COMPLETE FOR SHARD ${SHARD_INDEX}/${TOTAL_SHARDS}`);
  console.log(`   ✅ Recovered: ${recovered}`);
  console.log(`   ❌ Failed:    ${failed}`);
  console.log(`   ⏱️ Time:      ${elapsed} minutes`);
  console.log('================================================================');

  if (tunnelProc) {
    try { tunnelProc.kill(); } catch {}
  }
  fileServer.close();
  await pool.end();
}

main().catch(err => {
  console.error('Fatal recovery error:', err);
  process.exit(1);
});
