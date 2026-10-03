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

const BATCH_SIZE = 100;
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function bulkMoveVideos(filecodes, targetFolderId, maxRetries = 5) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const res = await fetch('https://dropembed.com/files', {
        method: 'POST',
        headers: {
          'X-API-Key': DROPEMBED_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        body: JSON.stringify({
          action: 'move',
          folder_id: targetFolderId,
          video_filecodes: filecodes,
          folder_ids: []
        })
      });

      if (res.status === 200) {
        const data = await res.json().catch(() => ({ success: true }));
        if (data.success !== false) {
          return { success: true };
        }
        return { success: false, error: data.error || 'API reported false' };
      }

      if (res.status === 429) {
        console.warn(`   ⏳ Rate limit on bulk move, waiting ${attempt * 3}s...`);
        await sleep(attempt * 3000);
        continue;
      }

      const text = await res.text();
      return { success: false, status: res.status, error: text.slice(0, 200) };
    } catch (err) {
      if (attempt >= maxRetries) return { success: false, error: err.message };
      await sleep(2000 * attempt);
    }
  }
  return { success: false, error: 'Max retries exhausted' };
}

async function processCategory(pool, categoryName, folderId, items) {
  console.log(`\n📂 Processing Category: "${categoryName}" (Folder #${folderId}) — Total items: ${items.length}`);
  if (items.length === 0) {
    console.log(`   ✨ No items to move for "${categoryName}".`);
    return { moved: 0, errors: 0 };
  }

  let moved = 0;
  let errors = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const filecodes = batch.map(b => b.filecode);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(items.length / BATCH_SIZE);

    process.stdout.write(`   Batch [${batchNum}/${totalBatches}] (${filecodes.length} videos)... `);
    const start = Date.now();
    const res = await bulkMoveVideos(filecodes, folderId);

    if (res.success) {
      const ms = Date.now() - start;
      console.log(`✅ Success in ${ms}ms`);

      // Update Database in bulk
      const placeholders = filecodes.map(() => '?').join(',');
      await pool.execute(
        `UPDATE dropembed_anime_episodes SET dropembed_folder_id = ? WHERE filecode IN (${placeholders})`,
        [folderId, ...filecodes]
      );
      moved += filecodes.length;
    } else {
      console.log(`❌ Failed: ${res.error}`);
      errors += filecodes.length;
    }

    // Small polite pause between bulk requests
    await sleep(250);
  }

  return { moved, errors };
}

async function main() {
  console.log('=============================================================');
  console.log('⚡ DROPEMBED ULTRA-FAST BULK REORGANIZATION ENGINE');
  console.log('📁 Folders configured:');
  console.log(`   - Hindi Movie:        #${FOLDER_MOVIE}`);
  console.log(`   - Hindi Dub Fan:      #${FOLDER_FAN_DUB}`);
  console.log(`   - Hindi Dub Official: #${FOLDER_OFFICIAL_DUB}`);
  console.log('=============================================================\n');

  console.log('🔍 Connecting to database to fetch all catalog episodes...');
  const pool = mysql.createPool({ ...DB_CONFIG, connectionLimit: 5 });

  const [rows] = await pool.execute(`
    SELECT e.id, e.filecode, e.season, e.episode, e.dropembed_folder_id,
           s.tmdb_id, s.title as series_title, s.type as series_type, s.format as series_format, s.dub_type as series_dub_type,
           e.format as ep_format, e.dub_type as ep_dub_type
    FROM dropembed_anime_episodes e
    JOIN dropembed_anime_series s ON e.tmdb_id = s.tmdb_id
    WHERE e.stream_type = 'MP4' AND e.filecode IS NOT NULL AND e.filecode != ''
  `);

  console.log(`Total playable episodes in DB: ${rows.length}`);

  const movieItems = [];
  const fanItems = [];
  const officialItems = [];

  for (const item of rows) {
    let targetFolderId;

    if (item.ep_format === 'Movie' || item.series_type === 'Movie' || item.series_format === 'Movie') {
      targetFolderId = FOLDER_MOVIE;
      if (item.dropembed_folder_id !== targetFolderId) movieItems.push(item);
    } else if (item.ep_dub_type === 'FanDub' || item.series_dub_type === 'FanDub' || (item.tmdb_id === 105009 && item.season >= 2)) {
      targetFolderId = FOLDER_FAN_DUB;
      if (item.dropembed_folder_id !== targetFolderId) fanItems.push(item);
    } else {
      targetFolderId = FOLDER_OFFICIAL_DUB;
      if (item.dropembed_folder_id !== targetFolderId) officialItems.push(item);
    }
  }

  console.log(`\n📊 Classification Summary (Need moving):`);
  console.log(`   🎬 Hindi Movie:        ${movieItems.length} videos`);
  console.log(`   🎧 Hindi Dub Fan:      ${fanItems.length} videos`);
  console.log(`   🎙️ Hindi Dub Official: ${officialItems.length} videos`);

  const startTime = Date.now();

  // 1. Process Movies
  const rMovie = await processCategory(pool, 'Hindi Movie', FOLDER_MOVIE, movieItems);

  // 2. Process FanDubs
  const rFan = await processCategory(pool, 'Hindi Dub Fan', FOLDER_FAN_DUB, fanItems);

  // 3. Process Official Dubs
  const rOfficial = await processCategory(pool, 'Hindi Dub Official', FOLDER_OFFICIAL_DUB, officialItems);

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n=============================================================');
  console.log(`🎉 BULK REORGANIZATION FINISHED in ${durationSec}s!`);
  console.log(`🎬 Hindi Movie:        ${rMovie.moved} moved (${rMovie.errors} errors)`);
  console.log(`🎧 Hindi Dub Fan:      ${rFan.moved} moved (${rFan.errors} errors)`);
  console.log(`🎙️ Hindi Dub Official: ${rOfficial.moved} moved (${rOfficial.errors} errors)`);
  console.log('=============================================================\n');

  // Verify updated folder status from DropEmbed API
  console.log('📊 Verifying DropEmbed Live Folder Counts:');
  try {
    const fRes = await fetch('https://dropembed.com/api/folders', {
      headers: { 'X-API-Key': DROPEMBED_API_KEY, 'User-Agent': 'Mozilla/5.0' }
    });
    const fData = await fRes.json();
    console.table(fData.folders);
  } catch (err) {
    console.error('Failed to verify folder counts:', err.message);
  }

  // Also update series table dropembed_folder_id
  console.log('Syncing dropembed_folder_id on series table...');
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
  console.log('✅ Series table dropembed_folder_id synced successfully.');

  await pool.end();
}

main().catch(console.error);
