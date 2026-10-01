import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import mysql from 'mysql2/promise';

// Load .env if present locally
if (fs.existsSync('.env')) {
  const envText = fs.readFileSync('.env', 'utf8');
  envText.split('\n').forEach(l => {
    const [k, ...v] = l.trim().split('=');
    if (k && !k.startsWith('#') && !process.env[k.trim()]) {
      process.env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
    }
  });
}

const DB_HOST = process.env.DB_HOST || '37.27.232.161';
const DB_PORT = parseInt(process.env.DB_PORT || '3306');
const DB_USER = process.env.DB_USER || 'jeevanka_user';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'jeevanka_anime';

const DROPEMBED_API_KEY = process.env.DROPEMBED_API_KEY || 'dpe_live_c9bbcfeff68964f97bf935152ffe040b';
const DROPEMBED_FOLDER_ID = process.env.DROPEMBED_FOLDER_ID ? parseInt(process.env.DROPEMBED_FOLDER_ID, 10) : null;

const SHARD_INDEX = parseInt(process.env.SHARD_INDEX || '0', 10);
const TOTAL_SHARDS = parseInt(process.env.TOTAL_SHARDS || '1', 10);
const MAX_EPISODES = parseInt(process.env.MAX_EPISODES || '0', 10); // 0 = unlimited
const TARGET_TMDB_ID = process.env.TARGET_TMDB_ID ? parseInt(process.env.TARGET_TMDB_ID, 10) : null;
const IS_TEST = process.argv.includes('--test') || process.env.TEST_MODE === 'true';

const QUALITY_SPECS = [
  { label: '1080p', code: 'haa' },
  { label: '720p',  code: 'gaa' },
  { label: '480p',  code: 'caa' },
  { label: '360p',  code: 'baa' },
  { label: '240p',  code: 'oaa' }
];

function parseRanges(rangesStr) {
  const map = {};
  if (!rangesStr) return map;
  const lines = rangesStr.split('\n');
  for (const line of lines) {
    const m = line.trim().match(/^(\d+-\d+)\s*\(([^)]+)\)/);
    if (m) {
      map[m[2].trim().toLowerCase()] = m[1].trim();
    }
  }
  return map;
}

async function checkStreamReachable(streamUrl) {
  try {
    const isDirectMp4 = streamUrl.endsWith('.mp4');
    const res = await fetch(streamUrl, {
      method: isDirectMp4 ? 'HEAD' : 'GET',
      headers: {
        'Origin': 'https://blakiteapi.xyz',
        'Referer': 'https://blakiteapi.xyz/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

function remuxStreamWithFfmpeg(streamUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const headers = 'Origin: https://blakiteapi.xyz\r\nReferer: https://blakiteapi.xyz/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n';
    const args = [
      '-headers', headers,
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-allowed_extensions', 'ALL',
      '-allowed_segment_extensions', 'ALL',
      '-extension_picky', '0',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', streamUrl,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
      '-y'
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    // 8-minute watchdog to prevent stalling forever
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('FFmpeg remux timed out after 8 minutes'));
    }, 480000);

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}. Stderr: ${stderr.slice(-500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function uploadToDropEmbed(filePath, title, maxRetries = 4) {
  const uploadUrl = 'https://dropembed.com/api/videos/upload';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const fileBuffer = fs.readFileSync(filePath);
      const blob = new Blob([fileBuffer], { type: 'video/mp4' });

      const formData = new FormData();
      formData.append('video', blob, path.basename(filePath));
      if (title) formData.append('title', title);
      if (DROPEMBED_FOLDER_ID) formData.append('folder_id', String(DROPEMBED_FOLDER_ID));

      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'X-API-Key': DROPEMBED_API_KEY
        },
        body: formData
      });

      const resText = await res.text();
      let json = null;
      try { json = JSON.parse(resText); } catch {}

      if (res.status === 429) {
        const waitSec = attempt * 12;
        console.warn(`   ⏳ [DropEmbed] Rate Limited (429). Pausing ${waitSec}s (Attempt ${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }

      if (res.status === 502 || res.status === 503) {
        const waitSec = attempt * 10;
        console.warn(`   ⏳ [DropEmbed] HTTP ${res.status}. Pausing ${waitSec}s (Attempt ${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }

      if (!res.ok) {
        throw new Error(`DropEmbed upload HTTP ${res.status}: ${resText.slice(0, 150)}`);
      }

      const videoId = json?.video_id || json?.data?.video_id || json?.id;
      if (!videoId) {
        throw new Error(`DropEmbed response missing video_id: ${resText.slice(0, 200)}`);
      }

      return {
        videoId: String(videoId).trim(),
        embedUrl: `https://dropembed.com/v/${videoId}`,
        watchUrl: `https://dropembed.com/v/${videoId}`
      };
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const waitSec = attempt * 5;
      console.warn(`   ⚠️ [DropEmbed] Upload attempt ${attempt} error: ${err.message}. Retrying in ${waitSec}s...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
  }

  throw new Error(`Failed to upload to DropEmbed after ${maxRetries} attempts`);
}

async function getEpisodeDataIdAndRanges(ep, pool) {
  let qData = ep.qualities_json;
  if (typeof qData === 'string') {
    try { qData = JSON.parse(qData); } catch {}
  }

  if (qData?.dataId) {
    return { dataId: qData.dataId, ranges: qData.ranges || '' };
  }

  if (ep.filecode && typeof ep.filecode === 'string' && ep.filecode.includes('/')) {
    return { dataId: ep.filecode, ranges: qData?.ranges || '' };
  }

  // Fallback: Resolve live from Blakite API
  try {
    const isMovie = (ep.format && String(ep.format).toLowerCase().trim() === 'movie');
    const fetchUrl = isMovie
      ? `https://blakiteapi.xyz/api/get.php?tmdbId=${ep.tmdb_id}`
      : `https://blakiteapi.xyz/api/get.php?id=${ep.season}-${ep.episode}&tmdbId=${ep.tmdb_id}`;

    const refUrl = isMovie
      ? `https://blakiteapi.xyz/embed/${ep.tmdb_id}`
      : `https://blakiteapi.xyz/embed/${ep.tmdb_id}/${ep.season}-${ep.episode}`;

    const res = await fetch(fetchUrl, { headers: { 'Referer': refUrl } });
    if (res.ok) {
      const json = await res.json();
      if (json?.data?.dataId) {
        const fetchedDataId = json.data.dataId;
        const fetchedRanges = json.data.ranges || '';
        // Cache back into dropembed_anime_episodes
        const cachedJson = JSON.stringify({
          format: json.data.format || 'M3U8',
          dataId: fetchedDataId,
          ranges: fetchedRanges,
          qid: json.data.qid
        });
        await pool.query(
          `UPDATE dropembed_anime_episodes SET qualities_json = ? WHERE id = ?`,
          [cachedJson, ep.id]
        );
        return { dataId: fetchedDataId, ranges: fetchedRanges };
      }
    }
  } catch (err) {
    console.warn(`   ⚠️ Live Blakite lookup failed for ep #${ep.id}: ${err.message}`);
  }

  return null;
}

async function main() {
  console.log(`=============================================================`);
  console.log(`🚀 ANIME DROPEMBED FLEET WORKER`);
  console.log(`⚙️  Shard: [${SHARD_INDEX + 1} / ${TOTAL_SHARDS}] (Mod: id % ${TOTAL_SHARDS} = ${SHARD_INDEX})`);
  if (IS_TEST) console.log(`🧪 Running in TEST mode (1 episode only)`);
  if (TARGET_TMDB_ID) console.log(`🎯 Target TMDB ID: ${TARGET_TMDB_ID}`);
  console.log(`=============================================================\n`);

  if (!DROPEMBED_API_KEY) {
    console.error('❌ DROPEMBED_API_KEY is missing!');
    process.exit(1);
  }

  // Probe DropEmbed Account Info
  try {
    const accRes = await fetch('https://dropembed.com/api/account/info', {
      headers: { 'X-API-Key': DROPEMBED_API_KEY }
    });
    if (accRes.ok) {
      const acc = await accRes.json();
      const d = acc.data || {};
      console.log(`👤 DropEmbed Account: User=${d.username || 'unknown'} | Videos=${d.storage?.total_videos || 0} | Used=${d.storage?.used_mb || 0} MB`);
    } else {
      console.warn(`⚠️ DropEmbed account check returned HTTP ${accRes.status}`);
    }
  } catch (e) {
    console.warn(`⚠️ Warning: DropEmbed probe failed: ${e.message}`);
  }

  const pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 3,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  });

  let processedCount = 0;
  const tempDir = path.resolve('./temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  try {
    while (true) {
      if (IS_TEST && processedCount >= 1) break;
      if (MAX_EPISODES > 0 && processedCount >= MAX_EPISODES) {
        console.log(`🎯 Reached MAX_EPISODES limit (${MAX_EPISODES}). Stopping.`);
        break;
      }

      // Fetch next HLS episode assigned to this shard from dropembed_anime_episodes
      let query = `
        SELECT id, tmdb_id, anime_title, format, season, episode, quality, filecode, qualities_json
        FROM dropembed_anime_episodes
        WHERE stream_type = 'HLS'
      `;
      const params = [];

      if (TARGET_TMDB_ID) {
        query += ` AND tmdb_id = ?`;
        params.push(TARGET_TMDB_ID);
      }

      if (TOTAL_SHARDS > 1) {
        query += ` AND (id % ?) = ?`;
        params.push(TOTAL_SHARDS, SHARD_INDEX);
      }

      query += ` ORDER BY id ASC LIMIT 1`;

      const [rows] = await pool.query(query, params);
      if (!rows || rows.length === 0) {
        console.log(`✨ No remaining HLS episodes found for this shard. Worker finished!`);
        break;
      }

      const ep = rows[0];
      const epLabel = `[#${ep.id}] ${ep.anime_title} S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
      console.log(`\n▶️  Processing ${epLabel}...`);

      const sourceInfo = await getEpisodeDataIdAndRanges(ep, pool);
      if (!sourceInfo?.dataId) {
        console.error(`❌ Missing dataId for episode #${ep.id}. Skipping.`);
        await pool.query(`UPDATE dropembed_anime_episodes SET stream_type = 'ERROR' WHERE id = ?`, [ep.id]);
        continue;
      }

      const dataId = sourceInfo.dataId;
      const ranges = parseRanges(sourceInfo.ranges);

      // Cascading Fallback: 1080p -> 720p -> 480p -> 360p -> 240p
      let successfulRemux = false;
      let finalSpec = null;
      let finalTempFile = null;
      let finalUploadTitle = null;

      for (const spec of QUALITY_SPECS) {
        const range = ranges[spec.label.toLowerCase()];
        let streamUrl = null;

        if (range) {
          // HLS tar archive with byte range
          const rangeParam = `&r_range=${encodeURIComponent(range)}`;
          streamUrl = `https://hugh.cdn.rumble.cloud/video/${dataId}.${spec.code}.tar?r_file=chunklist.m3u8&r_type=application%2Fvnd.apple.mpegurl${rangeParam}`;
        } else if (Object.keys(ranges).length === 0) {
          // Direct MP4 stream (e.g. movies or standalone MP4 streams)
          streamUrl = `https://hugh.cdn.rumble.cloud/video/${dataId}.${spec.code}.mp4`;
        } else {
          // If ranges are defined but this quality is not present in ranges, skip
          continue;
        }

        console.log(`   🔍 Checking quality candidate: ${spec.label}...`);
        const isReachable = await checkStreamReachable(streamUrl);
        if (!isReachable) {
          console.log(`   ⏩ [${spec.label}] not accessible or forbidden, checking next lower quality...`);
          continue;
        }

        console.log(`   ⏳ Remuxing (${spec.label}) via FFmpeg...`);
        const cleanTitle = (ep.anime_title || 'Anime').replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 50);
        const tempFile = path.join(tempDir, `ep_${ep.id}_${cleanTitle.replace(/\s+/g, '_')}_s${ep.season}e${ep.episode}_${spec.label}.mp4`);
        const startTime = Date.now();

        try {
          await remuxStreamWithFfmpeg(streamUrl, tempFile);
          const remuxSec = ((Date.now() - startTime) / 1000).toFixed(1);
          const fileSizeMB = (fs.statSync(tempFile).size / (1024 * 1024)).toFixed(1);
          console.log(`   ✅ Remuxed ${spec.label} (${fileSizeMB} MB in ${remuxSec}s)`);

          successfulRemux = true;
          finalSpec = spec;
          finalTempFile = tempFile;
          finalUploadTitle = `${cleanTitle} - S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')} [${spec.label}]`;
          break;
        } catch (ffmpegErr) {
          console.log(`   ⚠️ FFmpeg failed on ${spec.label}: ${ffmpegErr.message}. Trying next lower quality...`);
          if (fs.existsSync(tempFile)) {
            try { fs.unlinkSync(tempFile); } catch {}
          }
        }
      }

      if (!successfulRemux || !finalTempFile) {
        console.error(`   ❌ All qualities failed for episode #${ep.id}`);
        await pool.query(`UPDATE dropembed_anime_episodes SET stream_type = 'HLS_ERROR' WHERE id = ?`, [ep.id]);
        continue;
      }

      try {
        console.log(`   📤 Uploading to DropEmbed: "${finalUploadTitle}"...`);
        const upStart = Date.now();
        const dropembedResult = await uploadToDropEmbed(finalTempFile, finalUploadTitle);
        const upSec = ((Date.now() - upStart) / 1000).toFixed(1);

        console.log(`   ✅ Uploaded in ${upSec}s! Video ID: ${dropembedResult.videoId}`);
        console.log(`      🔗 Embed URL: ${dropembedResult.embedUrl}`);

        const qualitiesPayload = JSON.stringify({
          [finalSpec.label]: {
            quality: finalSpec.label,
            filecode: dropembedResult.videoId,
            embed_url: dropembedResult.embedUrl,
            watch_url: dropembedResult.watchUrl
          }
        });

        // Update Database table dropembed_anime_episodes
        await pool.query(`
          UPDATE dropembed_anime_episodes
          SET
            stream_type = 'MP4',
            filecode = ?,
            embed_url = ?,
            watch_url = ?,
            quality = ?,
            qualities_json = ?
          WHERE id = ?
        `, [
          dropembedResult.videoId,
          dropembedResult.embedUrl,
          dropembedResult.watchUrl,
          finalSpec.label,
          qualitiesPayload,
          ep.id
        ]);

        console.log(`   💾 Database updated: MP4 stream linked (${finalSpec.label})!`);
        processedCount++;

        // Clean up remuxed temp file
        if (fs.existsSync(finalTempFile)) {
          try { fs.unlinkSync(finalTempFile); } catch {}
        }
      } catch (uploadErr) {
        console.error(`   ❌ Upload failed for episode #${ep.id}: ${uploadErr.message}`);
        if (finalTempFile && fs.existsSync(finalTempFile)) {
          try { fs.unlinkSync(finalTempFile); } catch {}
        }
      }
    }
  } finally {
    console.log(`\n=============================================================`);
    console.log(`🏁 Worker completed. Processed ${processedCount} episodes in this run.`);
    console.log(`=============================================================`);
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
