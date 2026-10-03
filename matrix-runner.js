import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'http://nyaa.tracker.wf:7777/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce'
].map(t => '&tr=' + encodeURIComponent(t)).join('');

function makeMagnet(btih, name) {
  return `magnet:?xt=urn:btih:${btih}&dn=${encodeURIComponent(name)}${TRACKERS}`;
}

async function main() {
  const shardId = parseInt(process.env.SHARD_ID ?? '0', 10);
  const queuePath = process.env.QUEUE_FILE || path.join(__dirname, 'mega-matrix-queue.json');

  console.log('======================================================');
  console.log(`🚀 10-RUNNER MATRIX WORKER: SHARD #${shardId + 1} / 10`);
  console.log(`Queue File: ${queuePath}`);
  console.log('======================================================\n');

  if (!fs.existsSync(queuePath)) {
    console.error(`❌ Queue file not found: ${queuePath}`);
    process.exit(1);
  }

  const rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const item = rawQueue.find(q => q.shard === shardId) || rawQueue[shardId % rawQueue.length];

  if (!item) {
    console.warn(`⚠️ No queue item found for shard ${shardId}. Exiting.`);
    process.exit(0);
  }

  console.log(`📦 Assigned Task for Shard #${shardId + 1}:`);
  console.log(`   Anime:   "${item.title}"`);
  console.log(`   TMDB ID: ${item.tmdb_id}`);
  console.log(`   Season:  ${item.season}`);
  console.log(`   Episode: ${item.episode}`);
  console.log(`   BTIH:    ${item.btih}\n`);

  const magnet = makeMagnet(item.btih, item.title);

  // Invoke torrent-ingest.js with arguments
  const args = [
    path.join(__dirname, 'torrent-ingest.js'),
    magnet,
    String(item.tmdb_id),
    String(item.season),
    String(item.episode),
    item.title
  ];

  const env = {
    ...process.env,
    MAGNET_URI: magnet,
    TMDB_ID: String(item.tmdb_id),
    TARGET_SEASON: String(item.season),
    TARGET_EPISODE: String(item.episode),
    EPISODE_TITLE: item.title
  };

  const startTime = Date.now();
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });

  child.on('close', (code) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (code === 0) {
      console.log(`\n🎉 Shard #${shardId + 1} ("${item.title}") COMPLETED SUCCESSFULLY in ${elapsed}s!`);
      process.exit(0);
    } else {
      console.error(`\n❌ Shard #${shardId + 1} failed with exit code ${code} after ${elapsed}s.`);
      process.exit(code || 1);
    }
  });

  child.on('error', (err) => {
    console.error(`\n❌ Failed to launch child process: ${err.message}`);
    process.exit(1);
  });
}

main().catch(err => {
  console.error('Fatal shard runner error:', err);
  process.exit(1);
});
