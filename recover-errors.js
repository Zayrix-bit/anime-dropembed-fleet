import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Config (env vars for GitHub Actions, fallback for local) ──
const DB_HOST = process.env.DB_HOST || '37.27.232.161';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER || 'jeevanka_user';
const DB_PASSWORD = process.env.DB_PASSWORD || 'MyAnimePass@2026!';
const DB_NAME = process.env.DB_NAME || 'jeevanka_anime';
const DROPEMBED_API_KEY = process.env.DROPEMBED_API_KEY || 'dpe_live_c9bbcfeff68964f97bf935152ffe040b';
const DROPEMBED_API = 'https://dropembed.com/api';

const SHARD_INDEX = parseInt(process.env.SHARD_INDEX || '0', 10);
const TOTAL_SHARDS = parseInt(process.env.TOTAL_SHARDS || '1', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '0', 10); // 0 = unlimited
const CONCURRENCY = parseInt(process.env.SEGMENT_CONCURRENCY || '20', 10);

const TEMP_DIR = path.join(__dirname, 'temp', 'recovery');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Get Vidara HLS stream URL ──
async function getVidaraStreamUrl(filecode) {
  try {
    const res = await fetch('https://vidara.to/api/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': `https://vidara.to/e/${filecode}`,
        'Origin': 'https://vidara.to'
      },
      body: JSON.stringify({ filecode, device: 'web', codecs: [] })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.streaming_url || null;
  } catch (e) {
    console.warn(`   ⚠️ Vidara API error: ${e.message}`);
    return null;
  }
}

// ── Download HLS segments → concatenate → convert to MP4 ──
async function downloadVidaraToMp4(hlsUrl, outputMp4Path) {
  const baseUrl = hlsUrl.substring(0, hlsUrl.lastIndexOf('/') + 1);
  const headers = { 'Referer': 'https://vidara.to/', 'Origin': 'https://vidara.to', 'User-Agent': 'Mozilla/5.0' };

  // Fetch master playlist
  const masterRes = await fetch(hlsUrl, { headers });
  if (!masterRes.ok) throw new Error(`Master playlist: HTTP ${masterRes.status}`);
  const masterText = await masterRes.text();

  // Get variant URL (pick first/best quality)
  const variantPath = masterText.split('\n').find(l => l.trim() && !l.startsWith('#'));
  if (!variantPath) throw new Error('No variant in master playlist');
  const variantUrl = variantPath.startsWith('http') ? variantPath : baseUrl + variantPath;

  // Fetch variant playlist → get segment list
  const varRes = await fetch(variantUrl, { headers });
  if (!varRes.ok) throw new Error(`Variant playlist: HTTP ${varRes.status}`);
  const varText = await varRes.text();
  const segments = varText.split('\n').filter(l => l.trim() && !l.startsWith('#'));

  if (segments.length === 0) throw new Error('No segments found');

  // Download all segments and concatenate into a TS file
  const tsPath = outputMp4Path.replace('.mp4', '.ts');
  const writeStream = fs.createWriteStream(tsPath);
  let downloaded = 0;
  let totalBytes = 0;

  for (let i = 0; i < segments.length; i += CONCURRENCY) {
    const batch = segments.slice(i, i + CONCURRENCY);
    const buffers = await Promise.all(batch.map(async (seg, idx) => {
      const segUrl = seg.startsWith('http') ? seg : baseUrl + seg;
      for (let retry = 0; retry < 3; retry++) {
        try {
          const res = await fetch(segUrl, { headers, signal: AbortSignal.timeout(25000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return Buffer.from(await res.arrayBuffer());
        } catch (e) {
          if (retry === 2) throw new Error(`Segment ${i + idx} failed after 3 retries: ${e.message}`);
          await sleep(1000 * (retry + 1));
        }
      }
    }));

    for (const buf of buffers) {
      writeStream.write(buf);
      totalBytes += buf.length;
      downloaded++;
    }

    // Progress every 100 segments
    if (downloaded % 100 === 0 || downloaded === segments.length) {
      const mb = (totalBytes / 1024 / 1024).toFixed(1);
      process.stdout.write(`\r      Segments: ${downloaded}/${segments.length} (${mb} MB)`);
    }
  }

  writeStream.end();
  await new Promise(r => writeStream.on('finish', r));
  console.log(); // newline

  const tsSize = fs.statSync(tsPath).size;
  if (tsSize < 50000) {
    fs.unlinkSync(tsPath);
    throw new Error(`TS file too small: ${tsSize} bytes`);
  }

  // Convert TS → MP4 via ffmpeg
  // Try 1: stream copy (fastest)
  // Try 2: re-encode if copy fails (handles corrupt segments)
  let ffmpegSuccess = false;

  const cmds = [
    `ffmpeg -y -f mpegts -i "${tsPath}" -c copy -bsf:a aac_adtstoasc -movflags +faststart "${outputMp4Path}"`,
    `ffmpeg -y -f mpegts -err_detect ignore_err -i "${tsPath}" -c copy -bsf:a aac_adtstoasc "${outputMp4Path}"`,
    `ffmpeg -y -f mpegts -err_detect ignore_err -i "${tsPath}" -c:v copy -c:a aac -b:a 128k "${outputMp4Path}"`
  ];

  for (let ci = 0; ci < cmds.length; ci++) {
    try {
      execSync(cmds[ci], { timeout: 600000, stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
      if (fs.existsSync(outputMp4Path) && fs.statSync(outputMp4Path).size > 50000) {
        ffmpegSuccess = true;
        break;
      }
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString().slice(-300) : e.message;
      console.log(`      ffmpeg attempt ${ci + 1}/3 failed: ${stderr.replace(/\n/g, ' ').slice(0, 150)}`);
      try { if (fs.existsSync(outputMp4Path)) fs.unlinkSync(outputMp4Path); } catch {}
    }
  }

  // Cleanup TS
  try { fs.unlinkSync(tsPath); } catch {}

  if (!ffmpegSuccess || !fs.existsSync(outputMp4Path)) {
    throw new Error('All ffmpeg conversion attempts failed');
  }
  return fs.statSync(outputMp4Path).size;
}

// ── Upload MP4 to DropEmbed (direct file upload) ──
async function uploadToDropEmbed(filePath, title, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const blob = await fs.openAsBlob(filePath, { type: 'video/mp4' });
      const formData = new FormData();
      formData.append('video', blob, path.basename(filePath));
      if (title) formData.append('title', title);

      const res = await fetch(`${DROPEMBED_API}/videos/upload`, {
        method: 'POST',
        headers: { 'X-API-Key': DROPEMBED_API_KEY },
        body: formData
      });

      if (res.status === 429) {
        const waitSec = attempt * 15;
        console.warn(`   ⏳ Rate limited (429). Waiting ${waitSec}s...`);
        await sleep(waitSec * 1000);
        continue;
      }

      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return json;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn(`   ⚠️ Upload attempt ${attempt} failed: ${err.message}. Retrying...`);
      await sleep(5000 * attempt);
    }
  }
}

// ── Main Recovery ──
async function main() {
  const pool = mysql.createPool({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
    waitForConnections: true, connectionLimit: 5, enableKeepAlive: true, keepAliveInitialDelay: 10000
  });

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  🔧 RECOVERY: Vidara HLS → Segments → MP4 → DropEmbed Upload  ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`   Shard: ${SHARD_INDEX}/${TOTAL_SHARDS} | Concurrency: ${CONCURRENCY} | Batch: ${BATCH_SIZE || 'unlimited'}\n`);

  // Get error episodes with Vidara sources, filtered by shard
  const [allEpisodes] = await pool.execute(`
    SELECT 
      d.id, d.anime_title, d.season, d.episode, d.anilist_id, d.tmdb_id, d.stream_type,
      a.embed_url as orig_embed, a.quality as orig_quality
    FROM dropembed_anime_episodes d
    INNER JOIN anime_episodes a 
      ON d.anilist_id = a.anilist_id AND d.season = a.season AND d.episode = a.episode
    WHERE d.stream_type IN ('ERROR', 'HLS_ERROR')
      AND a.embed_url LIKE '%vidara.to%'
    ORDER BY d.id ASC
  `);

  // Shard filtering: each shard gets every Nth episode
  const episodes = allEpisodes.filter((_, i) => i % TOTAL_SHARDS === SHARD_INDEX);
  const limited = BATCH_SIZE > 0 ? episodes.slice(0, BATCH_SIZE) : episodes;

  console.log(`📋 Total recoverable: ${allEpisodes.length} | This shard: ${limited.length}\n`);

  // Show current DB status
  const [counts] = await pool.execute('SELECT stream_type, COUNT(*) as cnt FROM dropembed_anime_episodes GROUP BY stream_type ORDER BY cnt DESC');
  console.log('📊 Current DB:');
  for (const r of counts) console.log(`   ${r.stream_type === 'MP4' ? '✅' : '❌'} ${r.stream_type}: ${r.cnt}`);
  console.log();

  let recovered = 0, failed = 0;
  const startTime = Date.now();
  const errors = [];

  for (let i = 0; i < limited.length; i++) {
    const ep = limited[i];
    const label = `[${i + 1}/${limited.length}] ${ep.anime_title} S${ep.season}E${ep.episode}`;
    const title = `${ep.anime_title} S${ep.season}E${ep.episode}`;

    // Extract Vidara filecode
    const match = ep.orig_embed.match(/vidara\.to\/e\/([a-z0-9]+)/i);
    if (!match) {
      console.log(`⏭️  ${label} — No Vidara filecode`);
      failed++;
      continue;
    }

    const vidaraCode = match[1];
    const mp4Path = path.join(TEMP_DIR, `${vidaraCode}.mp4`);

    try {
      console.log(`🔄 ${label}`);

      // Step 1: Get Vidara stream URL
      process.stdout.write('   📡 Vidara stream...');
      const hlsUrl = await getVidaraStreamUrl(vidaraCode);
      if (!hlsUrl) throw new Error('No stream URL from Vidara');
      console.log(' OK');

      // Step 2: Download segments → MP4
      console.log('   📥 Downloading segments → MP4...');
      const fileSize = await downloadVidaraToMp4(hlsUrl, mp4Path);
      const sizeMb = (fileSize / 1024 / 1024).toFixed(1);
      console.log(`   📦 MP4: ${sizeMb} MB`);

      // Step 3: Upload to DropEmbed
      process.stdout.write('   ☁️  Uploading to DropEmbed...');
      const result = await uploadToDropEmbed(mp4Path, title);

      if (result.success && result.video_id) {
        const videoId = result.video_id;
        const embedUrl = `https://dropembed.com/e/${videoId}`;
        const watchUrl = result.url || `https://dropembed.com/v/${videoId}`;
        const quality = ep.orig_quality || '720p';

        await pool.execute(
          `UPDATE dropembed_anime_episodes 
           SET stream_type = 'MP4', quality = ?, filecode = ?, embed_url = ?, watch_url = ?, updated_at = NOW() 
           WHERE id = ?`,
          [quality, videoId, embedUrl, watchUrl, ep.id]
        );

        console.log(` ✅ Done! (${videoId})\n`);
        recovered++;
      } else {
        throw new Error(result.error || JSON.stringify(result).slice(0, 200));
      }
    } catch (err) {
      console.log(` ❌ ${err.message}\n`);
      errors.push({ id: ep.id, title: ep.anime_title, ep: `S${ep.season}E${ep.episode}`, error: err.message });
      failed++;
    } finally {
      // Cleanup temp files
      try { if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path); } catch {}
      try { const tsPath = mp4Path.replace('.mp4', '.ts'); if (fs.existsSync(tsPath)) fs.unlinkSync(tsPath); } catch {}
    }

    // Delay between episodes
    if (i < limited.length - 1) await sleep(2000);
  }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);

  // Final summary
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                    📊 RECOVERY COMPLETE                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`   Shard:     ${SHARD_INDEX}/${TOTAL_SHARDS}`);
  console.log(`   ✅ Recovered: ${recovered}`);
  console.log(`   ❌ Failed:    ${failed}`);
  console.log(`   📦 Total:     ${limited.length}`);
  console.log(`   ⏱️  Time:      ${elapsed} minutes`);

  if (errors.length > 0) {
    console.log('\n   Failed episodes:');
    for (const e of errors.slice(0, 30)) {
      console.log(`   - [${e.id}] ${e.title} ${e.ep}: ${e.error.substring(0, 100)}`);
    }
  }

  // Final DB status
  const [finalCounts] = await pool.execute('SELECT stream_type, COUNT(*) as cnt FROM dropembed_anime_episodes GROUP BY stream_type ORDER BY cnt DESC');
  console.log('\n📊 Final DB Status:');
  for (const r of finalCounts) console.log(`   ${r.stream_type === 'MP4' ? '✅' : '❌'} ${r.stream_type}: ${r.cnt}`);

  await pool.end();

  // Exit with error if all failed
  if (recovered === 0 && limited.length > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
