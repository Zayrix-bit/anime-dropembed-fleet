import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
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
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '0', 10); // 0 = unlimited

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: Get Vidara HLS stream URL ──
async function getVidaraStreamUrl(filecode) {
  try {
    const res = await fetch('https://vidara.to/api/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': `https://vidara.to/e/${filecode}`,
        'Origin': 'https://vidara.to'
      },
      body: JSON.stringify({ filecode, device: 'web', codecs: [] }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.streaming_url || null;
  } catch (e) {
    console.warn(`   ⚠️ Vidara API error: ${e.message}`);
    return null;
  }
}

// ── Step 2: Remote Upload directly to DropEmbed (No local download, No Cloudflare 413) ──
async function uploadToDropEmbedViaRemote(streamUrl, title, maxRetries = 3) {
  const remoteUrl = `${DROPEMBED_API}/videos/remote-upload`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(remoteUrl, {
        method: 'POST',
        headers: {
          'X-API-Key': DROPEMBED_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ urls: [streamUrl] }),
        signal: AbortSignal.timeout(20000)
      });

      const resText = await res.text();
      let json = null;
      try { json = JSON.parse(resText); } catch {}

      if (res.status === 429) {
        const waitSec = attempt * 10;
        console.warn(`   ⏳ Rate Limited (429). Pausing ${waitSec}s...`);
        await sleep(waitSec * 1000);
        continue;
      }

      if (!res.ok) {
        throw new Error(`Remote upload HTTP ${res.status}: ${resText.slice(0, 150)}`);
      }

      // Check if already queued
      if (resText.includes('already queued') || json?.message?.includes('already queued')) {
        try {
          const listRes = await fetch(`${DROPEMBED_API}/videos?page=1&limit=50`, {
            headers: { 'X-API-Key': DROPEMBED_API_KEY }
          });
          const listJson = await listRes.json();
          const items = listJson.videos || listJson.data || [];
          const existing = items.find(v => v.description && v.description.includes(streamUrl));
          if (existing?.id) {
            return {
              videoId: String(existing.id).trim(),
              embedUrl: `https://dropembed.com/e/${existing.id}`,
              watchUrl: `https://dropembed.com/v/${existing.id}`
            };
          }
        } catch {}
      }

      const task = json?.tasks?.[0];
      const videoId = task?.video_id || json?.video_id;
      if (!videoId) {
        throw new Error(`No video_id returned: ${resText.slice(0, 200)}`);
      }

      // Update title on DropEmbed
      if (title) {
        try {
          const patchBody = { title };
          if (DROPEMBED_FOLDER_ID) patchBody.folder_id = DROPEMBED_FOLDER_ID;
          await fetch(`${DROPEMBED_API}/videos/${videoId}`, {
            method: 'PATCH',
            headers: {
              'X-API-Key': DROPEMBED_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(patchBody),
            signal: AbortSignal.timeout(10000)
          });
        } catch {}
      }

      return {
        videoId: String(videoId).trim(),
        embedUrl: `https://dropembed.com/e/${videoId}`,
        watchUrl: `https://dropembed.com/v/${videoId}`
      };
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const waitSec = attempt * 4;
      console.warn(`   ⚠️ Attempt ${attempt} failed: ${err.message}. Retrying in ${waitSec}s...`);
      await sleep(waitSec * 1000);
    }
  }

  throw new Error(`Failed remote upload after ${maxRetries} attempts`);
}

// ── Main Recovery Loop ──
async function main() {
  const pool = mysql.createPool({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
    waitForConnections: true, connectionLimit: 5, enableKeepAlive: true, keepAliveInitialDelay: 10000
  });

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  ⚡ RECOVERY: Vidara Stream → DropEmbed Direct Remote Ingest  ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`   Shard: ${SHARD_INDEX}/${TOTAL_SHARDS} | Batch: ${BATCH_SIZE || 'unlimited'}\n`);

  // Get error episodes with Vidara sources
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

  let recovered = 0, failed = 0;
  const startTime = Date.now();
  const errors = [];

  for (let i = 0; i < limited.length; i++) {
    const ep = limited[i];
    const label = `[${i + 1}/${limited.length}] ${ep.anime_title} S${ep.season}E${ep.episode} (#${ep.id})`;
    const title = `${ep.anime_title} - S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')} [${ep.orig_quality || '720p'}]`;

    // Extract Vidara filecode
    const match = ep.orig_embed.match(/vidara\.to\/e\/([a-z0-9]+)/i);
    if (!match) {
      console.log(`⏭️  ${label} — No Vidara filecode`);
      failed++;
      continue;
    }

    const vidaraCode = match[1];

    try {
      console.log(`🔄 ${label}`);

      // 1. Get Vidara stream URL
      process.stdout.write('   📡 Getting Vidara stream URL...');
      const hlsUrl = await getVidaraStreamUrl(vidaraCode);
      if (!hlsUrl) throw new Error('No stream URL from Vidara');
      console.log(' OK');

      // 2. Direct remote upload to DropEmbed
      process.stdout.write('   ☁️  Remote ingest to DropEmbed...');
      const result = await uploadToDropEmbedViaRemote(hlsUrl, title);

      if (result?.videoId) {
        const quality = ep.orig_quality || '720p';

        await pool.execute(
          `UPDATE dropembed_anime_episodes 
           SET stream_type = 'MP4', quality = ?, filecode = ?, embed_url = ?, watch_url = ?, updated_at = NOW() 
           WHERE id = ?`,
          [quality, result.videoId, result.embedUrl, result.watchUrl, ep.id]
        );

        console.log(` ✅ Done! (${result.videoId})\n`);
        recovered++;
      } else {
        throw new Error('Failed to get videoId from DropEmbed');
      }
    } catch (err) {
      console.log(` ❌ ${err.message}\n`);
      errors.push({ id: ep.id, title: ep.anime_title, ep: `S${ep.season}E${ep.episode}`, error: err.message });
      failed++;
    }

    // Small delay between requests to avoid rate limits
    if (i < limited.length - 1) await sleep(1500);
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
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
