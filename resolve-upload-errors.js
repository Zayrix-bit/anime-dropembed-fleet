import mysql from 'mysql2/promise';

const DROPEMBED_API_KEY = 'dpe_live_c9bbcfeff68964f97bf935152ffe040b';

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
    const isDirectMp4 = streamUrl.includes('.mp4');
    const res = await fetch(streamUrl, {
      method: isDirectMp4 ? 'HEAD' : 'GET',
      headers: {
        'Origin': 'https://blakiteapi.xyz',
        'Referer': 'https://blakiteapi.xyz/',
        'User-Agent': 'Mozilla/5.0'
      }
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function uploadToDropEmbed(streamUrl, title) {
  // Append timestamp salt to avoid DropEmbed deduplication / already-queued collisions
  const separator = streamUrl.includes('?') ? '&' : '?';
  const saltedUrl = `${streamUrl}${separator}ts=${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://dropembed.com/api/videos/remote-upload', {
        method: 'POST',
        headers: {
          'X-API-Key': DROPEMBED_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ urls: [saltedUrl] })
      });

      if (res.status === 429) {
        await new Promise(r => setTimeout(r, attempt * 10000));
        continue;
      }

      const json = await res.json();
      const task = json?.tasks?.[0];
      const videoId = task?.video_id || json?.video_id;

      if (!videoId) {
        throw new Error(`No video_id returned: ${JSON.stringify(json)}`);
      }

      if (title) {
        try {
          await fetch(`https://dropembed.com/api/videos/${videoId}`, {
            method: 'PATCH',
            headers: {
              'X-API-Key': DROPEMBED_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title })
          });
        } catch {}
      }

      return {
        videoId: String(videoId).trim(),
        embedUrl: `https://dropembed.com/v/${videoId}`,
        watchUrl: `https://dropembed.com/v/${videoId}`
      };
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  throw new Error('Upload failed after retries');
}

async function main() {
  const pool = mysql.createPool({
    host: '37.27.232.161',
    user: 'jeevanka_user',
    password: 'MyAnimePass@2026!',
    database: 'jeevanka_anime',
    waitForConnections: true,
    connectionLimit: 3
  });

  const [episodes] = await pool.query(`
    SELECT id, tmdb_id, anime_title, format, season, episode, qualities_json
    FROM dropembed_anime_episodes
    WHERE stream_type = 'UPLOAD_ERROR'
    ORDER BY id ASC
  `);

  console.log(`Found ${episodes.length} UPLOAD_ERROR episodes to resolve...`);

  let resolved = 0;
  let failed = 0;

  for (const ep of episodes) {
    let qData = ep.qualities_json;
    if (typeof qData === 'string') {
      try { qData = JSON.parse(qData); } catch {}
    }

    const dataId = qData?.dataId;
    if (!dataId) {
      console.warn(`[#${ep.id}] No dataId, skipping`);
      failed++;
      continue;
    }

    const ranges = parseRanges(qData.ranges);
    let chosenSpec = null;
    let chosenUrl = null;

    for (const spec of QUALITY_SPECS) {
      const range = ranges[spec.label.toLowerCase()];
      let streamUrl = null;

      if (range) {
        streamUrl = `https://hugh.cdn.rumble.cloud/video/${dataId}.${spec.code}.tar?r_file=chunklist.m3u8&r_type=application%2Fvnd.apple.mpegurl&r_range=${encodeURIComponent(range)}`;
      } else if (Object.keys(ranges).length === 0) {
        streamUrl = `https://hugh.cdn.rumble.cloud/video/${dataId}.${spec.code}.mp4`;
      } else {
        continue;
      }

      const ok = await checkStreamReachable(streamUrl);
      if (ok) {
        chosenSpec = spec;
        chosenUrl = streamUrl;
        break;
      }
    }

    if (!chosenSpec || !chosenUrl) {
      console.error(`[#${ep.id}] ${ep.anime_title} S${ep.season}E${ep.episode} - No quality reachable, marking HLS_ERROR`);
      await pool.query(`UPDATE dropembed_anime_episodes SET stream_type = 'HLS_ERROR' WHERE id = ?`, [ep.id]);
      failed++;
      continue;
    }

    const cleanTitle = (ep.anime_title || 'Anime').replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 50);
    const title = `${cleanTitle} - S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')} [${chosenSpec.label}]`;

    try {
      console.log(`[#${ep.id}] Uploading ${title} (${chosenSpec.label})...`);
      const result = await uploadToDropEmbed(chosenUrl, title);

      const qualitiesPayload = JSON.stringify({
        [chosenSpec.label]: {
          quality: chosenSpec.label,
          filecode: result.videoId,
          embed_url: result.embedUrl,
          watch_url: result.watchUrl
        }
      });

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
        result.videoId,
        result.embedUrl,
        result.watchUrl,
        chosenSpec.label,
        qualitiesPayload,
        ep.id
      ]);

      console.log(`   ✅ Success! ID: ${result.videoId} -> ${result.embedUrl}`);
      resolved++;
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      console.error(`   ❌ Failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n===========================================`);
  console.log(`Resolved: ${resolved} | Failed/HLS_ERROR: ${failed}`);
  console.log(`===========================================`);

  const [summary] = await pool.query(`
    SELECT stream_type, COUNT(*) as count
    FROM dropembed_anime_episodes
    GROUP BY stream_type
  `);
  console.table(summary);

  await pool.end();
}

main().catch(console.error);
