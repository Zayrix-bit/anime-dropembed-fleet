/**
 * ==============================================================================
 * 🚀 DROPEMBED FLEET CLOUD ENGINE DASHBOARD - CLIENT CONTROLLER
 * ==============================================================================
 */

let qualityChartInstance = null;
let allSeriesData = [];
let syncInterval = null;
let countdownSec = 5;

// DOM Elements
const syncTimerSec = document.getElementById('syncTimerSec');
const manualRefreshBtn = document.getElementById('manualRefreshBtn');
const connStatusText = document.getElementById('connStatusText');

// Account Elements
const accStatusBadge = document.getElementById('accStatusBadge');
const accUsername = document.getElementById('accUsername');
const accEmail = document.getElementById('accEmail');
const accTotalVideos = document.getElementById('accTotalVideos');
const accStorageUsed = document.getElementById('accStorageUsed');
const accStorageMb = document.getElementById('accStorageMb');
const accBalance = document.getElementById('accBalance');

// Hero Progress Elements
const bannerPct = document.getElementById('bannerPct');
const bannerMp4Count = document.getElementById('bannerMp4Count');
const bannerHlsCount = document.getElementById('bannerHlsCount');
const bannerTotalCount = document.getElementById('bannerTotalCount');
const bannerProgressBar = document.getElementById('bannerProgressBar');
const pendingQueueVal = document.getElementById('pendingQueueVal');
const upstreamDeadVal = document.getElementById('upstreamDeadVal');

// Metrics Row
const metricMp4Total = document.getElementById('metricMp4Total');
const metricHlsTotal = document.getElementById('metricHlsTotal');
const metricSeriesComplete = document.getElementById('metricSeriesComplete');
const metricErrorTotal = document.getElementById('metricErrorTotal');

// Grids & Tables
const shardsGrid = document.getElementById('shardsGrid');
const liveActivityList = document.getElementById('liveActivityList');
const seriesTableBody = document.getElementById('seriesTableBody');
const seriesSearchInput = document.getElementById('seriesSearchInput');
const qualityLegend = document.getElementById('qualityLegend');

/* ==============================================================================
   1. INITIALIZATION & SYNC TIMER
   ============================================================================== */
async function initFleet() {
  setupEventListeners();
  await fetchLiveFleetStatus();
  startSyncCountdown();
}

function startSyncCountdown() {
  countdownSec = 5;
  if (syncInterval) clearInterval(syncInterval);

  syncInterval = setInterval(async () => {
    countdownSec--;
    if (syncTimerSec) syncTimerSec.textContent = `${countdownSec}s`;

    if (countdownSec <= 0) {
      countdownSec = 5;
      await fetchLiveFleetStatus();
    }
  }, 1000);
}

function setupEventListeners() {
  manualRefreshBtn.addEventListener('click', async () => {
    countdownSec = 5;
    manualRefreshBtn.style.opacity = '0.5';
    await fetchLiveFleetStatus();
    manualRefreshBtn.style.opacity = '1';
  });

  seriesSearchInput.addEventListener('input', (e) => {
    filterSeriesTable(e.target.value.trim().toLowerCase());
  });
}

/* ==============================================================================
   2. FETCH LIVE STATUS FROM API
   ============================================================================== */
async function fetchLiveFleetStatus() {
  try {
    const res = await fetch('/api/fleet/live-status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.success) {
      connStatusText.textContent = 'DB: 37.27.232.161 (Connected)';
      updateAccountInfo(data.dropembed_account);
      updateSummaryBanner(data.summary);
      updateQualityChart(data.quality_distribution || []);
      updateLiveActivity(data.recent_conversions || []);
      updateShardsGrid(data.shards || []);
      updateSeriesTable(data.series_progress || []);
    }
  } catch (err) {
    connStatusText.textContent = 'DB: Reconnecting...';
    console.warn('Live fleet sync warning:', err.message);
  }
}

/* ==============================================================================
   3. UPDATE SECTIONS
   ============================================================================== */
function updateAccountInfo(acc) {
  if (!acc) return;
  accUsername.textContent = acc.username || 'elfen0909';
  accEmail.textContent = acc.email || 'rk18109ry@gmail.com';
  accTotalVideos.textContent = Number(acc.total_videos || 5633).toLocaleString();
  accStorageUsed.textContent = `${Math.round(acc.used_gb || 345)} GB`;
  accStorageMb.textContent = `${Number(acc.used_mb || 344984).toLocaleString()} MB (Unlimited Cloud)`;
  accBalance.textContent = `$${Number(acc.balance || 0.5018).toFixed(4)}`;
  accStatusBadge.textContent = acc.status_badge || 'ACTIVE & UNLIMITED';
}

function updateSummaryBanner(sum) {
  if (!sum) return;
  const pct = Number(sum.progress_percentage || 0).toFixed(1);
  bannerPct.textContent = `${pct}%`;
  bannerProgressBar.style.width = `${pct}%`;

  bannerMp4Count.textContent = Number(sum.mp4_count || 0).toLocaleString();
  bannerHlsCount.textContent = Number(sum.hls_count || 0).toLocaleString();
  bannerTotalCount.textContent = Number(sum.total_episodes || 0).toLocaleString();

  pendingQueueVal.textContent = `${sum.hls_count || 0} Episodes`;
  upstreamDeadVal.textContent = `${sum.error_count || 0} Streams`;

  metricMp4Total.textContent = Number(sum.mp4_count || 0).toLocaleString();
  metricHlsTotal.textContent = Number(sum.hls_count || 0).toLocaleString();
  metricSeriesComplete.textContent = `${sum.completed_series || 0}`;
  metricErrorTotal.textContent = Number(sum.error_count || 0).toLocaleString();
}

/* ==============================================================================
   4. QUALITY DISTRIBUTION CHART (CHART.JS)
   ============================================================================== */
function updateQualityChart(qualities) {
  const ctx = document.getElementById('qualityChart');
  if (!ctx) return;

  const labels = qualities.map(q => q.quality || 'Unknown');
  const values = qualities.map(q => Number(q.count));
  const colors = [
    '#6366f1', // 1080p
    '#06b6d4', // 720p
    '#10b981', // 480p
    '#f59e0b', // 360p
    '#ec4899'  // 240p
  ];

  if (!qualityChartInstance) {
    qualityChartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: colors.slice(0, labels.length),
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        cutout: '72%'
      }
    });
  } else {
    qualityChartInstance.data.labels = labels;
    qualityChartInstance.data.datasets[0].data = values;
    qualityChartInstance.update();
  }

  // Update Custom HTML Legend
  qualityLegend.innerHTML = qualities.map((q, i) => `
    <div class="legend-item">
      <div class="legend-color" style="background: ${colors[i % colors.length]};"></div>
      <span><strong>${q.quality || 'Other'}</strong>: ${Number(q.count).toLocaleString()}</span>
    </div>
  `).join('');
}

/* ==============================================================================
   5. LIVE ACTIVITY FEED
   ============================================================================== */
function updateLiveActivity(items) {
  if (!items || items.length === 0) {
    liveActivityList.innerHTML = `<p style="padding:20px; text-align:center; color:#64748b;">No recent activity</p>`;
    return;
  }

  liveActivityList.innerHTML = items.map(ep => {
    const title = ep.anime_title || 'Episode';
    const epLabel = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
    const embedUrl = ep.embed_url || `https://dropembed.com/v/${ep.filecode}`;

    return `
      <div class="activity-item">
        <div class="activity-left">
          <div>
            <div class="activity-title">${escapeHtml(title)}</div>
            <div class="activity-ep">${epLabel} • DropEmbed Ingest</div>
          </div>
        </div>
        <div class="activity-right">
          <span class="activity-tag">${ep.quality || '1080p'}</span>
          <a href="${embedUrl}" target="_blank" rel="noopener" class="btn-watch-link">Watch ↗</a>
        </div>
      </div>
    `;
  }).join('');
}

/* ==============================================================================
   6. 10-SHARD PARALLEL MATRIX
   ============================================================================== */
function updateShardsGrid(shards) {
  if (!shards || shards.length === 0) return;

  shardsGrid.innerHTML = shards.map(s => {
    const total = Number(s.total || 0);
    const mp4 = Number(s.mp4_count || 0);
    const pct = total > 0 ? ((mp4 / total) * 100).toFixed(1) : 0;

    return `
      <div class="shard-card">
        <div class="shard-header">
          <span class="shard-num">Shard #${s.shard}</span>
          <span class="shard-pct font-mono">${pct}%</span>
        </div>
        <div class="shard-val font-mono">${mp4} / ${total}</div>
        <div class="shard-mini-bar">
          <div class="shard-fill" style="width: ${pct}%;"></div>
        </div>
      </div>
    `;
  }).join('');
}

/* ==============================================================================
   7. SERIES PROGRESS TABLE & FILTER
   ============================================================================== */
function updateSeriesTable(series) {
  allSeriesData = series;
  renderFilteredSeries(series);
}

function filterSeriesTable(queryStr) {
  if (!queryStr) {
    renderFilteredSeries(allSeriesData);
    return;
  }
  const filtered = allSeriesData.filter(s => 
    (s.title && s.title.toLowerCase().includes(queryStr)) ||
    (s.title_hindi && s.title_hindi.toLowerCase().includes(queryStr))
  );
  renderFilteredSeries(filtered);
}

function renderFilteredSeries(series) {
  if (!series || series.length === 0) {
    seriesTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:#64748b;">No matching series</td></tr>`;
    return;
  }

  seriesTableBody.innerHTML = series.slice(0, 50).map(s => {
    const total = Number(s.total_episodes || s.actual_episodes || 0);
    const mp4 = Number(s.mp4_episodes || 0);
    const hls = Number(s.hls_episodes || 0);
    const err = Number(s.error_episodes || 0);
    const pct = total > 0 ? Math.min(100, Math.round((mp4 / total) * 100)) : (mp4 > 0 ? 100 : 0);
    const poster = s.poster_url || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=100&q=80';

    const statusBadge = (pct >= 100 && hls === 0) 
      ? '<span class="badge badge-green">100% Live</span>'
      : (mp4 > 0 ? '<span class="badge badge-cyan">Streaming</span>' : '<span class="badge badge-gold">Queued</span>');

    return `
      <tr>
        <td>
          <div class="table-series-title">
            <img src="${poster}" alt="${escapeHtml(s.title)}" class="table-series-poster" loading="lazy">
            <div>
              <div>${escapeHtml(s.title)}</div>
              <div style="font-size:0.75rem; color:#06b6d4;">${escapeHtml(s.title_hindi || '')}</div>
            </div>
          </div>
        </td>
        <td><span class="badge badge-dropembed">${s.format || 'TV'}</span></td>
        <td class="font-mono"><strong>${total}</strong></td>
        <td class="font-mono text-green"><strong>${mp4}</strong></td>
        <td class="font-mono text-cyan">${hls}</td>
        <td class="font-mono" style="color:#ef4444;">${err}</td>
        <td>
          <div class="table-bar-track">
            <div class="table-bar-fill" style="width: ${pct}%;"></div>
          </div>
          <span class="font-mono" style="font-size:0.78rem;">${pct}%</span>
        </td>
        <td>${statusBadge}</td>
      </tr>
    `;
  }).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.addEventListener('DOMContentLoaded', initFleet);
