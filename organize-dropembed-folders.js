import mysql from 'mysql2/promise';

const DROPEMBED_API_KEY = process.env.DROPEMBED_API_KEY || 'dpe_live_c9bbcfeff68964f97bf935152ffe040b';

const FOLDER_FAN_DUB     = 9;  // Hindi Dub Fan
const FOLDER_OFFICIAL_DUB = 10; // Hindi Dub Official
const FOLDER_MOVIE        = 11; // Hindi Movie

const DB_CONFIG = {
  host: process.env.DB_HOST || '37.27.232.161',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'jeevanka_user',
  password: process.env.DB_PASSWORD || 'MyAnimePass@2026!',
  database: process.env.DB_NAME || 'jeevanka_anime'
};

const CONCURRENCY = 2; // Optimal concurrency to avoid rate limits
const PACING_DELAY_MS = 80;
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function updateVideoFolder(filecode, folderId, maxRetries = 4) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const res = await fetch(`https://dropembed.com/api/videos/${filecode}`, {
        method: 'PATCH',
        headers: {
          'X-API-Key': DROPEMBED_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        },
        body: JSON.stringify({ folder_id: folderId })
      });

      if (res.status === 200) {
        return { success: true };
      }

      if (res.status === 429) {
        const waitTime = attempt * 1500;
        await sleep(waitTime);
        continue;
      }

      const text = await res.text();
      return { success: false, status: res.status, error: text };
    } catch (err) {
      if (attempt >= maxRetries) return { success: false, error: err.message };
      await sleep(1000 * attempt);
    }
  }
  return { success: false, error: 'Max retries reached' };
}

async function main() {
  console.log('=============================================================');
  console.log('🚀 DROPEMBED FOLDER REORGANIZATION SUITE (SMOOTH PACED)');
  console.log('📁 Folders configured:');
  console.log(`   - Hindi Dub Fan:      #${FOLDER_FAN_DUB}`);
  console.log(`   - Hindi Dub Official: #${FOLDER_OFFICIAL_DUB}`);
  console.log(`   - Hindi Movie:        #${FOLDER_MOVIE}`);
  console.log('=============================================================\n');

  console.log('Connecting to database...');
  const pool = mysql.createPool({ ...DB_CONFIG, connectionLimit: 6 });

  const [rows] = await pool.execute(`
    SELECT e.id, e.filecode, e.season, e.episode, e.dropembed_folder_id,
           s.tmdb_id, s.title as series_title, s.type as series_type, s.format as series_format, s.dub_type as series_dub_type,
           e.format as ep_format, e.dub_type as ep_dub_type
    FROM dropembed_anime_episodes e
    JOIN dropembed_anime_series s ON e.tmdb_id = s.tmdb_id
    WHERE e.stream_type = 'MP4' AND e.filecode IS NOT NULL AND e.filecode != ''
  `);

  console.log(`Total playable episodes fetched from DB: ${rows.length}`);

  // Classify each item
  const queue = [];
  let alreadyMoved = 0;

  for (const item of rows) {
    let targetFolderId;
    let targetName;

    if (item.ep_format === 'Movie' || item.series_type === 'Movie' || item.series_format === 'Movie') {
      targetFolderId = FOLDER_MOVIE;
      targetName = 'Hindi Movie';
    } else if (item.ep_dub_type === 'FanDub' || item.series_dub_type === 'FanDub' || (item.tmdb_id === 105009 && item.season >= 2)) {
      targetFolderId = FOLDER_FAN_DUB;
      targetName = 'Hindi Dub Fan';
    } else {
      targetFolderId = FOLDER_OFFICIAL_DUB;
      targetName = 'Hindi Dub Official';
    }

    if (item.dropembed_folder_id === targetFolderId) {
      alreadyMoved++;
    } else {
      queue.push({
        id: item.id,
        filecode: item.filecode,
        targetFolderId,
        targetName,
        title: `${item.series_title} S${item.season}E${item.episode}`
      });
    }
  }

  console.log(`Already verified in correct folder: ${alreadyMoved}`);
  console.log(`Pending items to organize on DropEmbed: ${queue.length}\n`);

  if (queue.length === 0) {
    console.log('✅ All videos are already organized into their respective DropEmbed folders!');
    await pool.end();
    return;
  }

  let countFan = 0;
  let countOfficial = 0;
  let countMovie = 0;
  let errors = 0;
  let processed = 0;
  const total = queue.length;
  const startTime = Date.now();

  async function worker(workerId) {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      const res = await updateVideoFolder(item.filecode, item.targetFolderId);
      if (res.success) {
        if (item.targetFolderId === FOLDER_FAN_DUB) countFan++;
        else if (item.targetFolderId === FOLDER_OFFICIAL_DUB) countOfficial++;
        else countMovie++;

        try {
          await pool.execute(
            'UPDATE dropembed_anime_episodes SET dropembed_folder_id = ? WHERE id = ?',
            [item.targetFolderId, item.id]
          );
        } catch (dbErr) {
          console.error(`DB Update Error for ${item.id}:`, dbErr.message);
        }
      } else {
        errors++;
      }

      processed++;
      if (processed % 50 === 0 || processed === total) {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const rate = (processed / elapsedSec).toFixed(1);
        const overallDone = alreadyMoved + processed;
        const totalAll = rows.length;
        const pct = ((overallDone / totalAll) * 100).toFixed(1);
        console.log(`[${pct}%] ${overallDone}/${totalAll} (Pending batch: ${processed}/${total}) • Fan: ${countFan} | Official: ${countOfficial} | Movie: ${countMovie} | Errors: ${errors} • ${rate} vids/s`);
      }

      await sleep(PACING_DELAY_MS);
    }
  }

  console.log(`⚡ Launching ${CONCURRENCY} workers with ${PACING_DELAY_MS}ms pacing...`);
  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n=============================================================');
  console.log(`🎉 FINISHED in ${totalTime}s!`);
  console.log(`📁 Hindi Dub Fan:      ${countFan} videos moved to Folder #${FOLDER_FAN_DUB}`);
  console.log(`📁 Hindi Dub Official: ${countOfficial} videos moved to Folder #${FOLDER_OFFICIAL_DUB}`);
  console.log(`📁 Hindi Movie:        ${countMovie} videos moved to Folder #${FOLDER_MOVIE}`);
  console.log(`❌ Errors:             ${errors}`);
  console.log('=============================================================\n');

  // Verify updated folder stats from DropEmbed API
  console.log('📊 Verifying folder status with DropEmbed API...');
  try {
    const fRes = await fetch('https://dropembed.com/api/folders', {
      headers: { 'X-API-Key': DROPEMBED_API_KEY, 'User-Agent': 'Mozilla/5.0' }
    });
    const fData = await fRes.json();
    console.log(JSON.stringify(fData, null, 2));
  } catch (err) {
    console.error('Failed to query folder API:', err.message);
  }

  // Also update dropembed_folder_id on series table
  console.log('Syncing dropembed_folder_id on dropembed_anime_series table...');
  await pool.execute(`
    UPDATE dropembed_anime_series
    SET dropembed_folder_id = ${FOLDER_MOVIE}
    WHERE format = 'Movie' OR type = 'Movie'
  `);
  await pool.execute(`
    UPDATE dropembed_anime_series
    SET dropembed_folder_id = ${FOLDER_FAN_DUB}
    WHERE dub_type = 'FanDub' AND (format != 'Movie' AND type != 'Movie')
  `);
  await pool.execute(`
    UPDATE dropembed_anime_series
    SET dropembed_folder_id = ${FOLDER_OFFICIAL_DUB}
    WHERE dub_type = 'Official' AND (format != 'Movie' AND type != 'Movie')
  `);
  console.log('✅ Series table dropembed_folder_id synced.');

  await pool.end();
}

main().catch(console.error);
