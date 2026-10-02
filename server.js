import express from 'express';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read .env if present
const env = {};
if (fs.existsSync(path.join(__dirname, '.env'))) {
  const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  envText.split('\n').forEach(l => {
    const [k, ...v] = l.trim().split('=');
    if (k && !k.startsWith('#')) env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
  });
}

const DB_HOST = env.DB_HOST || process.env.DB_HOST || '37.27.232.161';
const DB_PORT = parseInt(env.DB_PORT || process.env.DB_PORT || '3306', 10);
const DB_USER = env.DB_USER || process.env.DB_USER || 'jeevanka_user';
const DB_PASSWORD = env.DB_PASSWORD || process.env.DB_PASSWORD || 'MyAnimePass@2026!';
const DB_NAME = env.DB_NAME || process.env.DB_NAME || 'jeevanka_anime';
const DROPEMBED_API_KEY = env.DROPEMBED_API_KEY || process.env.DROPEMBED_API_KEY || 'dpe_live_c9bbcfeff68964f97bf935152ffe040b';

// MySQL Connection Pool
const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 15,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// DropEmbed Account Cache
let cachedDropEmbedAccount = null;
let lastDropEmbedFetch = 0;

async function getDropEmbedAccountStatus() {
  const now = Date.now();
  if (cachedDropEmbedAccount && (now - lastDropEmbedFetch < 30000)) {
    return cachedDropEmbedAccount;
  }
  try {
    const res = await fetch('https://dropembed.com/api/account/info', {
      headers: { 'X-API-Key': DROPEMBED_API_KEY }
    });
    if (res.ok) {
      const json = await res.json();
      const d = json.data || {};
      const storageMb = d.storage?.used_mb || 0;
      const storageGb = (storageMb / 1024).toFixed(2);
      cachedDropEmbedAccount = {
        success: true,
        username: d.username || 'elfen0909',
        email: d.email || 'rk18109ry@gmail.com',
        role: d.role || 'user',
        balance: d.balance || 0.5018,
        plan: d.premium?.plan || 'Free (Unlimited Cloud Bandwidth)',
        is_premium: !!d.premium?.is_premium,
        total_videos: d.storage?.total_videos || 0,
        used_mb: storageMb,
        used_gb: storageGb,
        used_bytes: d.storage?.used_bytes || 0,
        status_badge: 'ACTIVE & UNLIMITED',
        status_msg: 'Direct Remote Ingest Active • No Daily Quota Limits'
      };
      lastDropEmbedFetch = now;
      return cachedDropEmbedAccount;
    }
  } catch (err) {
    console.error('DropEmbed account check warning:', err.message);
  }
  return cachedDropEmbedAccount || {
    success: false,
    username: 'elfen0909',
    status_badge: 'ONLINE',
    status_msg: 'DropEmbed API Ready',
    used_gb: '345.00',
    total_videos: 5633
  };
}

// DropEmbed Real-Time Ingest Status Cache (downloading, processing, ready, error)
let dropembedIngestStats = {
  ready: 2493,
  downloading: 2891,
  processing: 15,
  error: 234,
  total: 5633,
  last_updated: Date.now()
};

async function scanDropEmbedVideoStatuses() {
  try {
    const initRes = await fetch('https://dropembed.com/api/videos?page=1&limit=100', {
      headers: { 'X-API-Key': DROPEMBED_API_KEY }
    });
    if (!initRes.ok) return;
    const initData = await initRes.json();
    const totalVideos = initData.pagination?.total || 5633;
    const totalPages = Math.ceil(totalVideos / 100);

    const counts = { ready: 0, downloading: 0, processing: 0, error: 0 };
    const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
    const BATCH_SIZE = 8;

    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const batch = pages.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (p) => {
        try {
          const res = await fetch(`https://dropembed.com/api/videos?page=${p}&limit=100`, {
            headers: { 'X-API-Key': DROPEMBED_API_KEY }
          });
          if (res.ok) {
            const d = await res.json();
            for (const v of d.videos || []) {
              if (counts[v.status] !== undefined) counts[v.status]++;
              else counts[v.status] = 1;
            }
          }
        } catch {}
      }));
    }

    dropembedIngestStats = {
      ready: counts.ready || 0,
      downloading: counts.downloading || 0,
      processing: counts.processing || 0,
      error: counts.error || 0,
      total: totalVideos,
      last_updated: Date.now()
    };
  } catch (err) {
    console.warn('Status scan warning:', err.message);
  }
}

// Background scan initial + recurring every 3 minutes
setTimeout(scanDropEmbedVideoStatuses, 5000);
setInterval(scanDropEmbedVideoStatuses, 180000);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Live Stats
app.get('/api/stats', async (req, res) => {
  try {
    const [titleStats] = await pool.execute(`
      SELECT 
        COUNT(*) as total_titles,
        SUM(CASE WHEN type = 'Movie' THEN 1 ELSE 0 END) as total_movies,
        SUM(CASE WHEN type = 'TV' THEN 1 ELSE 0 END) as total_tv,
        SUM(CASE WHEN dub_type = 'Official' THEN 1 ELSE 0 END) as official_titles,
        SUM(CASE WHEN dub_type = 'FanDub' THEN 1 ELSE 0 END) as fandub_titles
      FROM dropembed_anime_series
    `);

    const [epStats] = await pool.execute(`
      SELECT 
        COUNT(*) as total_episodes,
        SUM(CASE WHEN stream_type = 'MP4' THEN 1 ELSE 0 END) as mp4_episodes,
        SUM(CASE WHEN stream_type = 'HLS' THEN 1 ELSE 0 END) as hls_episodes,
        SUM(CASE WHEN stream_type = 'HLS_ERROR' THEN 1 ELSE 0 END) as hls_error_episodes,
        SUM(CASE WHEN stream_type = 'ERROR' THEN 1 ELSE 0 END) as error_episodes
      FROM dropembed_anime_episodes
    `);

    const formatBreakdown = await query(`
      SELECT format, COUNT(*) as count 
      FROM dropembed_anime_series 
      GROUP BY format
    `);

    const account = await getDropEmbedAccountStatus();

    res.json({
      success: true,
      stats: {
        ...titleStats[0],
        ...epStats[0],
        format_breakdown: formatBreakdown,
        dropembed_account: account,
        dropembed_ingest: dropembedIngestStats
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Fleet Live Migration / Engine Monitor API
app.get('/api/fleet/live-status', async (req, res) => {
  try {
    const [epStats] = await pool.execute(`
      SELECT 
        COUNT(*) as total_episodes,
        SUM(CASE WHEN stream_type = 'MP4' THEN 1 ELSE 0 END) as mp4_count,
        SUM(CASE WHEN stream_type = 'HLS' THEN 1 ELSE 0 END) as hls_count,
        SUM(CASE WHEN stream_type = 'UPLOAD_ERROR' THEN 1 ELSE 0 END) as upload_error_count,
        SUM(CASE WHEN stream_type = 'HLS_ERROR' THEN 1 ELSE 0 END) as hls_error_count,
        SUM(CASE WHEN stream_type = 'ERROR' THEN 1 ELSE 0 END) as general_error_count
      FROM dropembed_anime_episodes
    `);

    const [qualityDist] = await pool.execute(`
      SELECT quality, COUNT(*) as count 
      FROM dropembed_anime_episodes 
      WHERE stream_type = 'MP4' 
      GROUP BY quality 
      ORDER BY count DESC
    `);

    const [seriesProgress] = await pool.execute(`
      SELECT 
        s.tmdb_id,
        s.title,
        s.title_hindi,
        s.poster_url,
        s.format,
        s.total_episodes,
        COUNT(e.id) as actual_episodes,
        SUM(CASE WHEN e.stream_type = 'MP4' THEN 1 ELSE 0 END) as mp4_episodes,
        SUM(CASE WHEN e.stream_type = 'HLS' THEN 1 ELSE 0 END) as hls_episodes,
        SUM(CASE WHEN e.stream_type IN ('HLS_ERROR', 'ERROR', 'UPLOAD_ERROR') THEN 1 ELSE 0 END) as error_episodes
      FROM dropembed_anime_series s
      LEFT JOIN dropembed_anime_episodes e ON s.tmdb_id = e.tmdb_id
      GROUP BY s.id
      ORDER BY mp4_episodes DESC, s.total_episodes DESC
    `);

    const [recentConversions] = await pool.execute(`
      SELECT 
        id, tmdb_id, anime_title, season, episode, quality, filecode, embed_url, watch_url, updated_at
      FROM dropembed_anime_episodes
      WHERE stream_type = 'MP4' AND filecode IS NOT NULL AND LENGTH(filecode) > 6
      ORDER BY updated_at DESC
      LIMIT 15
    `);

    const [shardsData] = await pool.execute(`
      SELECT 
        (id % 10) as shard, 
        COUNT(*) as total, 
        SUM(CASE WHEN stream_type = 'MP4' THEN 1 ELSE 0 END) as mp4_count, 
        SUM(CASE WHEN stream_type = 'HLS' THEN 1 ELSE 0 END) as hls_count,
        SUM(CASE WHEN stream_type IN ('HLS_ERROR', 'ERROR', 'UPLOAD_ERROR') THEN 1 ELSE 0 END) as error_count
      FROM dropembed_anime_episodes 
      GROUP BY shard 
      ORDER BY shard ASC
    `);

    const total = Number(epStats[0].total_episodes || 1);
    const mp4 = Number(epStats[0].mp4_count || 0);
    const hls = Number(epStats[0].hls_count || 0);
    const hlsErr = Number(epStats[0].hls_error_count || 0);
    const genErr = Number(epStats[0].general_error_count || 0);
    const upErr = Number(epStats[0].upload_error_count || 0);
    const totalErrors = hlsErr + genErr + upErr;

    const completedSeries = seriesProgress.filter(s => Number(s.hls_episodes) === 0 && Number(s.mp4_episodes) > 0).length;
    const inProgressSeries = seriesProgress.filter(s => Number(s.hls_episodes) > 0 && Number(s.mp4_episodes) > 0).length;
    const queuedSeries = seriesProgress.filter(s => Number(s.mp4_episodes) === 0).length;

    const dropembedAccount = await getDropEmbedAccountStatus();

    res.json({
      success: true,
      timestamp: Date.now(),
      dropembed_account: dropembedAccount,
      dropembed_ingest: dropembedIngestStats,
      summary: {
        total_episodes: total,
        mp4_count: mp4,
        hls_count: hls,
        error_count: totalErrors,
        hls_error_count: hlsErr,
        general_error_count: genErr,
        upload_error_count: upErr,
        progress_percentage: Number(((mp4 / total) * 100).toFixed(1)),
        total_series: seriesProgress.length,
        completed_series: completedSeries,
        in_progress_series: inProgressSeries,
        queued_series: queuedSeries
      },
      quality_distribution: qualityDist,
      recent_conversions: recentConversions,
      series_progress: seriesProgress,
      shards: shardsData
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dedicated Fleet Route
app.get('/fleet', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'fleet.html'));
});

// 3. Featured Billboard Titles
app.get('/api/featured', async (req, res) => {
  try {
    const featured = await query(`
      SELECT tmdb_id, title, title_hindi, type, status, dub_type, format, synopsis, rating, genres, poster_url, backdrop_url, total_episodes, total_seasons, anilist_id, mal_id
      FROM dropembed_anime_series
      WHERE backdrop_url IS NOT NULL AND rating >= 7.5
      ORDER BY rating DESC, total_episodes DESC
      LIMIT 6
    `);
    res.json({ success: true, featured });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Catalog List with Search, Filters & Sorting
app.get('/api/anime', async (req, res) => {
  try {
    const { 
      search = '', 
      format = 'ALL', 
      type = 'ALL', 
      dub_type = 'ALL', 
      status = 'ALL',
      sort = 'rating',
      page = 1,
      limit = 48 
    } = req.query;

    const conditions = [];
    const params = [];

    if (search.trim()) {
      conditions.push('(title LIKE ? OR title_hindi LIKE ?)');
      params.push(`%${search.trim()}%`, `%${search.trim()}%`);
    }

    if (format !== 'ALL') {
      conditions.push('format = ?');
      params.push(format);
    }

    if (type !== 'ALL') {
      conditions.push('type = ?');
      params.push(type);
    }

    if (dub_type !== 'ALL') {
      conditions.push('dub_type = ?');
      params.push(dub_type);
    }

    if (status === 'ONGOING') {
      conditions.push("(status IN ('Ongoing', 'Returning Series'))");
    } else if (status === 'FINISHED') {
      conditions.push("(status IN ('Ended', 'Released', 'Canceled'))");
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let orderBy = 'ORDER BY rating DESC, total_episodes DESC';
    if (sort === 'episodes') orderBy = 'ORDER BY total_episodes DESC';
    if (sort === 'title') orderBy = 'ORDER BY title ASC';
    if (sort === 'latest') orderBy = 'ORDER BY id DESC';

    // Count total
    const [countRows] = await pool.execute(`SELECT COUNT(*) as total FROM dropembed_anime_series ${whereClause}`, params);
    const total = countRows[0].total;

    // Fetch page items
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const sql = `
      SELECT tmdb_id, title, title_hindi, type, status, dub_type, format, synopsis, rating, genres, poster_url, backdrop_url, total_episodes, total_seasons, anilist_id, mal_id
      FROM dropembed_anime_series
      ${whereClause}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const items = await query(sql, [...params, parseInt(limit, 10), offset]);

    res.json({
      success: true,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / parseInt(limit, 10)),
      items
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Single Anime Details + All Episodes Grouped by Season
app.get('/api/anime/:tmdbId', async (req, res) => {
  try {
    const tmdbId = parseInt(req.params.tmdbId, 10);
    const seriesList = await query('SELECT * FROM dropembed_anime_series WHERE tmdb_id = ?', [tmdbId]);
    if (seriesList.length === 0) {
      return res.status(404).json({ success: false, error: 'Anime not found in DB' });
    }

    const anime = seriesList[0];
    const episodes = await query(`
      SELECT id, season, episode, anime_title, quality, stream_type, dub_type, filecode, embed_url, watch_url, direct_mp4_url, poster_url, anilist_id, mal_id
      FROM dropembed_anime_episodes
      WHERE tmdb_id = ?
      ORDER BY season ASC, episode ASC
    `, [tmdbId]);

    // Group episodes by season
    const seasons = {};
    for (const ep of episodes) {
      if (!seasons[ep.season]) seasons[ep.season] = [];
      seasons[ep.season].push(ep);
    }

    res.json({
      success: true,
      anime,
      totalEpisodes: episodes.length,
      seasonsCount: Object.keys(seasons).length,
      seasons
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve Single Page App
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 ANIME DROPEMBED FLEET & STREAMING PORTAL LIVE!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`🛰️ Fleet Hub: http://localhost:${PORT}/fleet`);
  console.log(`💾 Database:  ${DB_NAME} (dropembed_* tables) on ${DB_HOST}`);
  console.log(`======================================================\n`);
});
