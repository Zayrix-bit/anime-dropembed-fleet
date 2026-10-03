import fs from 'fs';
import path from 'path';
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
const FOLDER_FAN_DUB     = 9;  // Hindi Dub Fan
const FOLDER_OFFICIAL_DUB = 10; // Hindi Dub Official
const FOLDER_MOVIE        = 11; // Hindi Movie

function getFolderId(ep, series) {
  if (DROPEMBED_FOLDER_ID) return DROPEMBED_FOLDER_ID;
  if (ep?.format === 'Movie' || series?.format === 'Movie' || series?.type === 'Movie') return FOLDER_MOVIE;
  if (ep?.dub_type === 'FanDub' || series?.dub_type === 'FanDub' || (series?.tmdb_id === 105009 && ep?.season >= 2)) return FOLDER_FAN_DUB;
  return FOLDER_OFFICIAL_DUB;
}

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

async function uploadToDropEmbedViaRemote(streamUrl, title, folderId = null, maxRetries = 3) {
  const remoteUrl = 'https://dropembed.com/api/videos/remote-upload';
  const targetFolder = folderId || DROPEMBED_FOLDER_ID;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const separator = streamUrl.includes('?') ? '&' : '?';
      const saltedUrl = `${streamUrl}${separator}ts=${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      const res = await fetch(remoteUrl, {
        method: 'POST',
        headers: {
          'X-API-Key': DROPEMBED_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ urls: [saltedUrl] })
      });

      const resText = await res.text();
      let json = null;
      try { json = JSON.parse(resText); } catch {}

      if (res.status === 429) {
        const waitSec = attempt * 10;
        console.warn(`   ⏳ [DropEmbed Remote] Rate Limited (429). Pausing ${waitSec}s...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }

      if (!res.ok) {
        throw new Error(`Remote upload HTTP ${res.status}: ${resText.slice(0, 150)}`);
      }

      if (resText.includes('already queued') || json?.message?.includes('already queued')) {
        console.log(`   ℹ️ [DropEmbed Remote] URL already queued on DropEmbed, fetching existing video ID...`);
        try {
          const listRes = await fetch('https://dropembed.com/api/videos?page=1&limit=50', {
            headers: { 'X-API-Key': DROPEMBED_API_KEY }
          });
          const listJson = await listRes.json();
          const items = listJson.videos || listJson.data || [];
          const existing = items.find(v => v.description && v.description.includes(streamUrl));
          if (existing?.id) {
            if (title) {
              fetch(`https://dropembed.com/api/videos/${existing.id}`, {
                method: 'PATCH',
                headers: {
                  'X-API-Key': DROPEMBED_API_KEY,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ title, folder_id: targetFolder || 0 })
              }).catch(() => {});
            }
            return {
              videoId: String(existing.id).trim(),
              embedUrl: `https://dropembed.com/v/${existing.id}`,
              watchUrl: `https://dropembed.com/v/${existing.id}`
            };
          }
        } catch (findErr) {
          console.warn(`   ⚠️ Existing video lookup warning: ${findErr.message}`);
        }
      }

      const task = json?.tasks?.[0];
      const videoId = task?.video_id || json?.video_id;
      if (!videoId) {
        throw new Error(`No video_id returned in remote upload: ${resText.slice(0, 200)}`);
      }

      // Update title and folder if specified
      if (title) {
        try {
          const patchBody = { title };
          if (targetFolder) patchBody.folder_id = targetFolder;

          await fetch(`https://dropembed.com/api/videos/${videoId}`, {
            method: 'PATCH',
            headers: {
              'X-API-Key': DROPEMBED_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(patchBody)
          });
        } catch (patchErr) {
          console.warn(`   ⚠️ Title PATCH warning: ${patchErr.message}`);
        }
      }

      return {
        videoId: String(videoId).trim(),
        embedUrl: `https://dropembed.com/v/${videoId}`,
        watchUrl: `https://dropembed.com/v/${videoId}`
      };
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const waitSec = attempt * 5;
      console.warn(`   ⚠️ [DropEmbed Remote] Attempt ${attempt} failed: ${err.message}. Retrying in ${waitSec}s...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
  }

  throw new Error(`Failed remote upload to DropEmbed after ${maxRetries} attempts`);
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
  console.log(`🚀 ANIME DROPEMBED FLEET WORKER (ULTRA-FAST REMOTE CLOUD)`);
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

  try {
    while (true) {
      if (IS_TEST && processedCount >= 1) break;
      if (MAX_EPISODES > 0 && processedCount >= MAX_EPISODES) {
        console.log(`🎯 Reached MAX_EPISODES limit (${MAX_EPISODES}). Stopping.`);
        break;
      }

      // Fetch next HLS episode assigned to this shard from dropembed_anime_episodes
      let query = `
        SELECT id, tmdb_id, anime_title, format, dub_type, season, episode, quality, filecode, qualities_json
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

      // Cascading Quality Candidate: 1080p -> 720p -> 480p -> 360p -> 240p
      let successfulCandidate = null;
      let finalSpec = null;
      let finalStreamUrl = null;
      let finalUploadTitle = null;

      for (const spec of QUALITY_SPECS) {
        const range = ranges[spec.label.toLowerCase()];
        let streamUrl = null;

        if (range) {
          const rangeParam = `&r_range=${encodeURIComponent(range)}`;
          streamUrl = `https://hugh.cdn.rumble.cloud/video/${dataId}.${spec.code}.tar?r_file=chunklist.m3u8&r_type=application%2Fvnd.apple.mpegurl${rangeParam}`;
        } else if (Object.keys(ranges).length === 0) {
          streamUrl = `https://hugh.cdn.rumble.cloud/video/${dataId}.${spec.code}.mp4`;
        } else {
          continue;
        }

        console.log(`   🔍 Checking quality candidate: ${spec.label}...`);
        const isReachable = await checkStreamReachable(streamUrl);
        if (!isReachable) {
          console.log(`   ⏩ [${spec.label}] not accessible, checking next lower quality...`);
          continue;
        }

        console.log(`   ✅ Quality ${spec.label} reachable!`);
        successfulCandidate = spec;
        finalSpec = spec;
        finalStreamUrl = streamUrl;
        const cleanTitle = (ep.anime_title || 'Anime').replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 50);
        finalUploadTitle = `${cleanTitle} - S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')} [${spec.label}]`;
        break;
      }

      if (!successfulCandidate || !finalStreamUrl) {
        console.error(`   ❌ All qualities failed for episode #${ep.id}`);
        await pool.query(`UPDATE dropembed_anime_episodes SET stream_type = 'HLS_ERROR' WHERE id = ?`, [ep.id]);
        continue;
      }

      // Submit to DropEmbed via Cloud Remote Upload
      try {
        console.log(`   🚀 Dispatching Remote Upload to DropEmbed: "${finalUploadTitle}"...`);
        const upStart = Date.now();
        const targetFolder = getFolderId(ep);
        const dropembedResult = await uploadToDropEmbedViaRemote(finalStreamUrl, finalUploadTitle, targetFolder);
        const upSec = ((Date.now() - upStart) / 1000).toFixed(1);

        console.log(`   ✅ Upload Queued in ${upSec}s! Video ID: ${dropembedResult.videoId} (Folder #${targetFolder})`);
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
            qualities_json = ?,
            dropembed_folder_id = ?
          WHERE id = ?
        `, [
          dropembedResult.videoId,
          dropembedResult.embedUrl,
          dropembedResult.watchUrl,
          finalSpec.label,
          qualitiesPayload,
          targetFolder,
          ep.id
        ]);

        console.log(`   💾 Database updated: MP4 stream linked (${finalSpec.label})!`);
        processedCount++;

        // Brief 1-second pause to prevent aggressive API rate-limiting
        await new Promise(r => setTimeout(r, 1000));
      } catch (uploadErr) {
        console.error(`   ❌ Remote Upload failed for episode #${ep.id}: ${uploadErr.message}`);
        await pool.query(`UPDATE dropembed_anime_episodes SET stream_type = 'UPLOAD_ERROR' WHERE id = ?`, [ep.id]);
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
