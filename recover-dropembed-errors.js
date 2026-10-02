import mysql from 'mysql2/promise';

const DROPEMBED_API_KEY = 'dpe_live_c9bbcfeff68964f97bf935152ffe040b';
const baseDURL = 'https://hugh.cdn.rumble.cloud/video/';
const qualityCodes = ['oaa', 'baa', 'caa', 'gaa', 'haa'];
const qualityLabels = ['240p', '360p', '480p', '720p', '1080p'];

function parseStreamUrl(data) {
  if (!data || !data.dataId) return null;

  if (data.format === 'M3U8' && data.ranges) {
    const rangeLines = data.ranges.split('\n').map(l => l.trim()).filter(Boolean);
    const rangeMap = {};
    rangeLines.forEach(l => {
      const match = l.match(/^(\d+-\d+)\s*\(([^)]+)\)/);
      if (match) rangeMap[match[2].trim()] = match[1];
    });

    const qualityList = [];
    qualityLabels.forEach((label, i) => {
      if (rangeMap[label]) {
        qualityList.push({ label, code: qualityCodes[i], range: rangeMap[label] });
      }
    });

    if (qualityList.length > 0) {
      const best = qualityList[qualityList.length - 1];
      return {
        url: `${baseDURL}${data.dataId}.${best.code}.tar?r_file=chunklist.m3u8&r_type=application%2Fvnd.apple.mpegurl&r_range=${best.range}`,
        quality: best.label,
        format: 'MP4' // DropEmbed converts to MP4
      };
    }
  }

  // MP4 fallback
  const maxQualityIndex = Math.min(data.qid || qualityLabels.length, qualityLabels.length) - 1;
  const bestCode = qualityCodes[maxQualityIndex] || 'caa';
  const bestLabel = qualityLabels[maxQualityIndex] || '480p';
  return {
    url: `${baseDURL}${data.dataId}.${bestCode}.mp4`,
    quality: bestLabel,
    format: 'MP4'
  };
}

async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
      if (res.ok) return res;
      if (res.status === 404) return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function main() {
  console.log('================================================================');
  console.log('🔄 DROPEMBED ERROR RECOVERY: Delete Old Errors & Re-upload Fresh');
  console.log('================================================================');

  const conn = await mysql.createConnection({
    host: '37.27.232.161',
    user: 'jeevanka_user',
    password: 'MyAnimePass@2026!',
    database: 'jeevanka_anime'
  });

  // 1. Fetch error videos from DropEmbed
  console.log('Fetching error videos list from DropEmbed API...');
  let errorVideos = [];
  let page = 1;
  while (true) {
    try {
      const res = await fetch(`https://dropembed.com/api/videos?status=error&page=${page}&limit=50`, {
        headers: { 'X-API-Key': DROPEMBED_API_KEY },
        signal: AbortSignal.timeout(15000)
      });
      const json = await res.json();
      const items = json.data || [];
      if (items.length === 0) break;
      errorVideos.push(...items);
      console.log(`  Fetched page ${page}: ${items.length} error videos.`);
      if (items.length < 50) break;
      page++;
    } catch (err) {
      console.warn(`  Warning fetching page ${page}: ${err.message}`);
      break;
    }
  }

  console.log(`\nTotal error videos to recover: ${errorVideos.length}\n`);
  if (errorVideos.length === 0) {
    console.log('✅ No error videos found on DropEmbed!');
    await conn.end();
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < errorVideos.length; i++) {
    const v = errorVideos[i];
    console.log(`----------------------------------------------------------------`);
    console.log(`[${i + 1}/${errorVideos.length}] Processing: "${v.title}" (Old ID: ${v.id})`);

    // Step A: Match DB Record
    let dbRow = null;
    const [byCode] = await conn.query(
      'SELECT id, tmdb_id, anime_title, season, episode, dub_type, stream_type, filecode FROM dropembed_anime_episodes WHERE filecode = ?',
      [v.id]
    );

    if (byCode.length > 0) {
      dbRow = byCode[0];
    } else {
      const m = v.title.match(/^(.*?)(?:\s*\(.*?\))?\s*-\s*S0*(\d+)E0*(\d+)/i);
      if (m) {
        const cleanTitle = m[1].replace(/Hindi Dubbed|Hindi Fan Dubbed/gi, '').trim();
        const season = parseInt(m[2], 10);
        const episode = parseInt(m[3], 10);

        const [byTitle] = await conn.query(
          'SELECT id, tmdb_id, anime_title, season, episode, dub_type, stream_type, filecode FROM dropembed_anime_episodes WHERE anime_title LIKE ? AND season = ? AND episode = ?',
          ['%' + cleanTitle + '%', season, episode]
        );
        if (byTitle.length > 0) dbRow = byTitle[0];
      }
    }

    if (!dbRow) {
      console.log(`  ⚠️ Could not match DB record for "${v.title}". Skipping.`);
      failCount++;
      continue;
    }

    console.log(`  📍 Matched DB: ID=${dbRow.id}, Title="${dbRow.anime_title}", S=${dbRow.season}, E=${dbRow.episode}, TMDB=${dbRow.tmdb_id}`);

    // Step B: Fetch Fresh URL from Blakite
    let streamUrlInfo = null;
    try {
      const rawTmdb = String(dbRow.tmdb_id);
      let blakiteRes = await fetchWithRetry(`https://blakiteapi.xyz/api/get.php?id=${dbRow.season}-${dbRow.episode}&tmdbId=${rawTmdb}`, {
        headers: { 'Referer': `https://blakiteapi.xyz/embed/${rawTmdb}/${dbRow.season}-${dbRow.episode}` }
      });
      let blakiteJson = await blakiteRes.json();

      if (!blakiteJson.success || !blakiteJson.data) {
        // Fallback for FanDub
        const padded = '0' + rawTmdb;
        blakiteRes = await fetchWithRetry(`https://blakiteapi.xyz/api/get.php?id=${dbRow.season}-${dbRow.episode}&tmdbId=${padded}`, {
          headers: { 'Referer': `https://blakiteapi.xyz/embed/${padded}/${dbRow.season}-${dbRow.episode}` }
        });
        blakiteJson = await blakiteRes.json();
      }

      if (blakiteJson.success && blakiteJson.data) {
        streamUrlInfo = parseStreamUrl(blakiteJson.data);
      }
    } catch (bErr) {
      console.log(`  ❌ Blakite API error: ${bErr.message}`);
    }

    if (!streamUrlInfo) {
      console.log(`  ⚠️ Could not fetch fresh stream URL from Blakite. Skipping.`);
      failCount++;
      continue;
    }

    console.log(`  📡 Fresh Stream URL (${streamUrlInfo.quality}): ${streamUrlInfo.url.slice(0, 80)}...`);

    // Step C: Delete Old Error Video on DropEmbed
    try {
      await fetch(`https://dropembed.com/api/videos/${v.id}`, {
        method: 'DELETE',
        headers: { 'X-API-Key': DROPEMBED_API_KEY }
      });
      console.log(`  🗑️ Deleted old error video ${v.id} from DropEmbed.`);
    } catch (delErr) {
      console.warn(`  ⚠️ Delete warning: ${delErr.message}`);
    }

    // Step D: Re-upload via Remote Upload
    let newVideoId = null;
    try {
      const upRes = await fetch('https://dropembed.com/api/videos/remote-upload', {
        method: 'POST',
        headers: {
          'X-API-Key': DROPEMBED_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          urls: [streamUrlInfo.url],
          folder_id: 0
        })
      });
      const upJson = await upRes.json();
      newVideoId = upJson.tasks?.[0]?.video_id || upJson.data?.[0]?.id || upJson.data?.[0]?.filecode || upJson.filecode || upJson.id;
      if (upJson.tasks?.[0]) {
        console.log(`  📤 Queued in DropEmbed: status = ${upJson.tasks[0].status}`);
      }

      if (newVideoId) {
        // Rename video title
        await fetch(`https://dropembed.com/api/videos/${newVideoId}`, {
          method: 'PATCH',
          headers: {
            'X-API-Key': DROPEMBED_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ title: v.title })
        });
      }
    } catch (upErr) {
      console.log(`  ❌ Remote upload error: ${upErr.message}`);
    }

    if (!newVideoId) {
      console.log(`  ❌ Failed to obtain new video ID from DropEmbed.`);
      failCount++;
      continue;
    }

    console.log(`  ✅ Successfully Re-uploaded: New ID = ${newVideoId}`);

    // Step E: Update Database
    const newEmbedUrl = `https://dropembed.com/v/${newVideoId}`;
    await conn.query(
      'UPDATE dropembed_anime_episodes SET filecode = ?, embed_url = ?, watch_url = ?, stream_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newVideoId, newEmbedUrl, newEmbedUrl, streamUrlInfo.format, dbRow.id]
    );
    console.log(`  💾 Database updated for ID ${dbRow.id}!`);

    successCount++;
    await new Promise(r => setTimeout(r, 600)); // Respect DropEmbed rate limits
  }

  await conn.end();
  console.log('\n================================================================');
  console.log(`🎉 RECOVERY COMPLETE!`);
  console.log(`   ✅ Successfully Re-uploaded: ${successCount}`);
  console.log(`   ❌ Failed / Skipped:         ${failCount}`);
  console.log('================================================================');
}

main().catch(console.error);
