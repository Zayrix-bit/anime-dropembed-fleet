/**
 * ==============================================================================
 * 🚀 DROPEMBED ANIME STREAMING PORTAL - CLIENT APPLICATION
 * ==============================================================================
 */

// Application State
const state = {
  currentFilters: {
    search: '',
    format: 'ALL',
    type: 'ALL',
    dub_type: 'ALL',
    status: 'ALL',
    status_type: 'ALL',
    sort: 'rating',
    page: 1,
    limit: 48
  },
  featuredItems: [],
  currentFeaturedIdx: 0,
  featuredTimer: null,
  activeAnime: null,
  activeSeason: 1,
  activeEpisodeIndex: 0,
  allEpisodesFlat: [],
  isTheaterMode: false
};

// DOM Elements
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const animeGrid = document.getElementById('animeGrid');
const catalogCount = document.getElementById('catalogCount');
const sortSelect = document.getElementById('sortSelect');
const paginationBar = document.getElementById('paginationBar');
const pageIndicator = document.getElementById('pageIndicator');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');

// Nav Stats
const statMp4 = document.getElementById('statMp4');
const statStorage = document.getElementById('statStorage');

// Hero Billboard
const heroSection = document.getElementById('heroSection');
const heroBackdrop = document.getElementById('heroBackdrop');
const heroTitle = document.getElementById('heroTitle');
const heroTitleHindi = document.getElementById('heroTitleHindi');
const heroSynopsis = document.getElementById('heroSynopsis');
const heroSeasons = document.getElementById('heroSeasons');
const heroEpisodes = document.getElementById('heroEpisodes');
const heroGenres = document.getElementById('heroGenres');
const heroFormatBadge = document.getElementById('heroFormatBadge');
const heroStatusBadge = document.getElementById('heroStatusBadge');
const heroDubBadge = document.getElementById('heroDubBadge');
const heroRatingBadge = document.getElementById('heroRatingBadge');
const heroWatchBtn = document.getElementById('heroWatchBtn');
const heroDetailsBtn = document.getElementById('heroDetailsBtn');
const heroCarouselNav = document.getElementById('heroCarouselNav');

// Player Modal
const playerModal = document.getElementById('playerModal');
const modalBackdrop = document.getElementById('modalBackdrop');
const closeModalBtn = document.getElementById('closeModalBtn');
const theaterModeBtn = document.getElementById('theaterModeBtn');
const videoIframe = document.getElementById('videoIframe');
const playerLoader = document.getElementById('playerLoader');
const modalAnimeTitle = document.getElementById('modalAnimeTitle');
const modalStatusBadge = document.getElementById('modalStatusBadge');
const modalDubBadge = document.getElementById('modalDubBadge');
const modalFormatBadge = document.getElementById('modalFormatBadge');
const modalEpIndicator = document.getElementById('modalEpIndicator');
const seasonTabs = document.getElementById('seasonTabs');
const episodesGrid = document.getElementById('episodesGrid');
const diagDot = document.getElementById('diagDot');
const diagTitle = document.getElementById('diagTitle');
const diagSub = document.getElementById('diagSub');
const copyEmbedBtn = document.getElementById('copyEmbedBtn');
const copyEmbedText = document.getElementById('copyEmbedText');
const openSourceBtn = document.getElementById('openSourceBtn');
const reloadPlayerBtn = document.getElementById('reloadPlayerBtn');
const prevEpBtn = document.getElementById('prevEpBtn');
const nextEpBtn = document.getElementById('nextEpBtn');
const currPlayingLabel = document.getElementById('currPlayingLabel');
const modalSynopsis = document.getElementById('modalSynopsis');
const metaTmdbLink = document.getElementById('metaTmdbLink');
const metaTmdbId = document.getElementById('metaTmdbId');
const metaAnilistLink = document.getElementById('metaAnilistLink');
const metaAnilistId = document.getElementById('metaAnilistId');
const metaMalLink = document.getElementById('metaMalLink');
const metaMalId = document.getElementById('metaMalId');

/* ==============================================================================
   1. APP INITIALIZATION
   ============================================================================== */
async function initApp() {
  setupEventListeners();
  await loadStats();
  await loadFeatured();
  await loadCatalog();
}

/* ==============================================================================
   2. LOAD LIVE STATS
   ============================================================================== */
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.stats) {
      const s = data.stats;
      if (statMp4 && s.mp4_episodes) {
        statMp4.textContent = Number(s.mp4_episodes).toLocaleString();
      }
      if (statStorage && s.dropembed_account?.used_gb) {
        statStorage.textContent = `${Math.round(s.dropembed_account.used_gb)} GB`;
      }
    }
  } catch (err) {
    console.warn('Failed to load stats:', err.message);
  }
}

/* ==============================================================================
   3. LOAD FEATURED BILLBOARD TITLES
   ============================================================================== */
async function loadFeatured() {
  try {
    const res = await fetch('/api/featured');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.featured && data.featured.length > 0) {
      state.featuredItems = data.featured;
      renderFeaturedCarouselNav();
      displayFeaturedItem(0);
      startFeaturedTimer();
    }
  } catch (err) {
    console.warn('Failed to load featured:', err.message);
  }
}

function renderFeaturedCarouselNav() {
  heroCarouselNav.innerHTML = '';
  state.featuredItems.forEach((_, idx) => {
    const dot = document.createElement('div');
    dot.className = `carousel-dot ${idx === 0 ? 'active' : ''}`;
    dot.addEventListener('click', () => {
      displayFeaturedItem(idx);
      resetFeaturedTimer();
    });
    heroCarouselNav.appendChild(dot);
  });
}

function displayFeaturedItem(idx) {
  state.currentFeaturedIdx = idx;
  const anime = state.featuredItems[idx];
  if (!anime) return;

  // Backdrop transition
  if (anime.backdrop_url) {
    heroBackdrop.style.opacity = '0';
    setTimeout(() => {
      heroBackdrop.style.backgroundImage = `url('${anime.backdrop_url}')`;
      heroBackdrop.style.opacity = '1';
    }, 200);
  }

  heroTitle.textContent = anime.title || 'Featured Anime';
  heroTitleHindi.textContent = anime.title_hindi || '';
  heroSynopsis.textContent = anime.synopsis || 'Explore episodes and stream in high quality on DropEmbed.';

  const sCount = anime.total_seasons || 1;
  const eCount = anime.total_episodes || 0;
  heroSeasons.textContent = `${sCount} Season${sCount > 1 ? 's' : ''}`;
  heroEpisodes.textContent = `${eCount} Episode${eCount > 1 ? 's' : ''}`;
  heroGenres.textContent = anime.genres ? anime.genres.replace(/[[\]"]/g, '').split(',').slice(0, 3).join(', ') : 'Action, Anime';

  heroRatingBadge.textContent = `★ ${anime.rating ? Number(anime.rating).toFixed(1) : '8.5'}`;
  heroDubBadge.textContent = anime.dub_type === 'Both' ? '🎙️ Official & 🎧 FanDub' : (anime.dub_type === 'Official' ? '🎙️ Official Dub' : '🎧 Fan Dub');
  heroStatusBadge.textContent = anime.status === 'Ongoing' ? '⚡ Ongoing' : '✓ Completed';

  // Update Dots
  const dots = heroCarouselNav.querySelectorAll('.carousel-dot');
  dots.forEach((d, i) => {
    d.classList.toggle('active', i === idx);
  });

  // Action buttons
  heroWatchBtn.onclick = () => openPlayerModal(anime.tmdb_id);
  heroDetailsBtn.onclick = () => openPlayerModal(anime.tmdb_id);
}

function startFeaturedTimer() {
  state.featuredTimer = setInterval(() => {
    if (state.featuredItems.length === 0) return;
    const nextIdx = (state.currentFeaturedIdx + 1) % state.featuredItems.length;
    displayFeaturedItem(nextIdx);
  }, 7000);
}

function resetFeaturedTimer() {
  clearInterval(state.featuredTimer);
  startFeaturedTimer();
}

/* ==============================================================================
   4. LOAD ANIME CATALOG (CARDS GRID)
   ============================================================================== */
async function loadCatalog() {
  try {
    animeGrid.innerHTML = `
      <div class="grid-skeleton">
        <div class="skeleton-card"></div>
        <div class="skeleton-card"></div>
        <div class="skeleton-card"></div>
        <div class="skeleton-card"></div>
      </div>
    `;

    const params = new URLSearchParams(state.currentFilters);
    const res = await fetch(`/api/anime?${params.toString()}`);
    if (!res.ok) throw new Error('API network error');
    const data = await res.json();

    if (data.success) {
      renderCatalog(data.items, data.total, data.page, data.totalPages);
    }
  } catch (err) {
    animeGrid.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: #94a3b8;">
        <p style="font-size: 1.2rem; font-weight: 600;">Failed to load anime library</p>
        <p style="font-size: 0.9rem; margin-top: 6px;">${err.message}</p>
      </div>
    `;
  }
}

function renderCatalog(items, total, page, totalPages) {
  catalogCount.textContent = `Showing ${items.length} of ${total} Titles`;

  if (!items || items.length === 0) {
    animeGrid.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 60px 20px; text-align: center; color: #94a3b8;">
        <div style="font-size: 3rem; margin-bottom: 12px;">🔍</div>
        <p style="font-size: 1.2rem; font-weight: 700; color: #f8fafc;">No anime found</p>
        <p style="font-size: 0.9rem; margin-top: 6px;">Try adjusting your search query or stream filters</p>
      </div>
    `;
    paginationBar.style.display = 'none';
    return;
  }

  animeGrid.innerHTML = items.map(anime => {
    const poster = anime.poster_url || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400&q=80';
    const rating = anime.rating ? Number(anime.rating).toFixed(1) : '8.0';
    const dubTag = anime.dub_type === 'Both' ? '🎙️ Official & 🎧 FanDub' : (anime.dub_type === 'Official' ? '🎙️ Official' : '🎧 FanDub');
    
    const playable = Number(anime.playable_episodes || 0);
    const totalDb = Number(anime.total_db_episodes || anime.total_episodes || 0);
    const isPlayable = playable > 0;
    const isFullyPlayable = isPlayable && (playable >= totalDb);

    let statusBadge = '';
    if (isFullyPlayable) {
      statusBadge = `<span class="badge" style="background: rgba(16,185,129,0.22); border: 1px solid rgba(16,185,129,0.45); color: #34d399; font-weight: 700;">🟢 ${playable} MP4 Ready</span>`;
    } else if (isPlayable) {
      statusBadge = `<span class="badge" style="background: rgba(59,130,246,0.22); border: 1px solid rgba(59,130,246,0.45); color: #60a5fa; font-weight: 700;">🟢 ${playable}/${totalDb} Ready</span>`;
    } else {
      statusBadge = `<span class="badge" style="background: rgba(239,68,68,0.22); border: 1px solid rgba(239,68,68,0.45); color: #f87171; font-weight: 700;">⚠️ Expired</span>`;
    }

    return `
      <div class="anime-card ${!isPlayable ? 'card-expired' : ''}" onclick="openPlayerModal(${anime.tmdb_id})">
        <div class="card-poster-wrap">
          <img src="${poster}" alt="${escapeHtml(anime.title)}" class="card-poster" loading="lazy">
          <div class="card-badges">
            ${statusBadge}
            <span class="badge badge-dub">${dubTag}</span>
          </div>
          <span class="card-rating-badge">★ ${rating}</span>
          <div class="card-hover-overlay">
            <div class="card-play-btn">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
          </div>
        </div>
        <div class="card-info">
          <h3 class="card-title">${escapeHtml(anime.title)}</h3>
          <h4 class="card-title-hindi">${escapeHtml(anime.title_hindi || '')}</h4>
          <div class="card-meta">
            <span>${totalDb || anime.total_episodes || 0} Eps • ${anime.format || 'TV'}</span>
            <span class="card-stream-tag" style="${isPlayable ? 'color: #34d399;' : 'color: #f87171;'}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
              ${isPlayable ? `${playable} MP4 Streamable` : 'Expired'}
            </span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Pagination
  if (totalPages > 1) {
    paginationBar.style.display = 'flex';
    pageIndicator.textContent = `Page ${page} of ${totalPages}`;
    prevPageBtn.disabled = (page <= 1);
    nextPageBtn.disabled = (page >= totalPages);
  } else {
    paginationBar.style.display = 'none';
  }
}

/* ==============================================================================
   5. PLAYER MODAL & DROPEMBED EMBED LOADER
   ============================================================================== */
async function openPlayerModal(tmdbId) {
  try {
    playerModal.style.display = 'flex';
    playerLoader.style.opacity = '1';
    playerLoader.style.display = 'flex';
    videoIframe.src = '';

    const res = await fetch(`/api/anime/${tmdbId}`);
    if (!res.ok) throw new Error('Episode data not found');
    const data = await res.json();

    if (!data.success || !data.anime) throw new Error(data.error || 'Failed to load');

    state.activeAnime = data.anime;
    state.activeAnime.seasons = data.seasons || {};

    // Flatten all episodes for easy prev/next navigation
    state.allEpisodesFlat = [];
    Object.keys(data.seasons).forEach(sNum => {
      data.seasons[sNum].forEach(ep => {
        state.allEpisodesFlat.push(ep);
      });
    });

    // Populate modal title & badges
    modalAnimeTitle.textContent = data.anime.title || 'Anime Stream';
    modalStatusBadge.textContent = data.anime.status || 'Series';
    modalDubBadge.textContent = data.anime.dub_type === 'Both' ? '🎙️ Official & 🎧 FanDub' : (data.anime.dub_type === 'Official' ? '🎙️ Official Dub' : '🎧 Fan Dub');
    modalSynopsis.textContent = data.anime.synopsis || 'No synopsis provided.';

    // External DB Links
    metaTmdbId.textContent = data.anime.tmdb_id || '-';
    metaTmdbLink.href = `https://www.themoviedb.org/tv/${data.anime.tmdb_id}`;
    metaAnilistId.textContent = data.anime.anilist_id || '-';
    metaAnilistLink.href = data.anime.anilist_id ? `https://anilist.co/anime/${data.anime.anilist_id}` : '#';
    metaMalId.textContent = data.anime.mal_id || '-';
    metaMalLink.href = data.anime.mal_id ? `https://myanimelist.net/anime/${data.anime.mal_id}` : '#';

    // Populate Season Tabs
    renderSeasonTabs(data.seasons);

    // Pick first available season and episode (prioritize playable episode)
    const firstPlayableIdx = state.allEpisodesFlat.findIndex(e => e.is_playable || (e.stream_type === 'MP4' && e.filecode));
    const targetIdx = firstPlayableIdx !== -1 ? firstPlayableIdx : 0;
    const startEp = state.allEpisodesFlat[targetIdx];
    const initialSeason = startEp ? startEp.season : (Object.keys(data.seasons)[0] || 1);

    switchSeason(parseInt(initialSeason, 10));

    // Play first episode
    if (state.allEpisodesFlat.length > 0) {
      playEpisodeByIndex(targetIdx);
    }
  } catch (err) {
    alert(`Could not load anime player: ${err.message}`);
    closePlayerModal();
  }
}

function renderSeasonTabs(seasons) {
  seasonTabs.innerHTML = '';
  const sKeys = Object.keys(seasons).sort((a, b) => Number(a) - Number(b));
  sKeys.forEach(sNum => {
    const btn = document.createElement('button');
    btn.className = `btn-season ${Number(sNum) === state.activeSeason ? 'active' : ''}`;
    btn.textContent = `Season ${sNum} (${seasons[sNum].length})`;
    btn.addEventListener('click', () => switchSeason(parseInt(sNum, 10)));
    seasonTabs.appendChild(btn);
  });
}

function switchSeason(seasonNum) {
  state.activeSeason = seasonNum;

  // Highlight active season button
  const btns = seasonTabs.querySelectorAll('.btn-season');
  btns.forEach(b => {
    b.classList.toggle('active', b.textContent.startsWith(`Season ${seasonNum} `));
  });

  // Render episodes grid for this season
  const eps = state.activeAnime?.seasons?.[seasonNum] || [];
  episodesGrid.innerHTML = eps.map(ep => {
    const epIdx = state.allEpisodesFlat.findIndex(e => e.id === ep.id);
    const isCurrent = (epIdx === state.activeEpisodeIndex);
    const quality = ep.quality || '1080p';
    const isPlayable = ep.is_playable || (ep.stream_type === 'MP4' && !!ep.filecode);

    return `
      <div class="ep-btn ${isCurrent ? 'active' : ''} ${!isPlayable ? 'ep-unplayable' : ''}" 
           data-index="${epIdx}" 
           onclick="playEpisodeByIndex(${epIdx})">
        <span class="ep-num">Episode ${ep.episode}</span>
        <span class="ep-quality" style="${isPlayable ? 'color: #34d399;' : 'color: #f87171;'}">
          ${isPlayable ? `🟢 Ready • ${quality}` : `⚠️ Expired`}
        </span>
      </div>
    `;
  }).join('');
}

function playEpisodeByIndex(index) {
  if (index < 0 || index >= state.allEpisodesFlat.length) return;
  state.activeEpisodeIndex = index;
  const ep = state.allEpisodesFlat[index];
  if (!ep) return;

  // Update active season if needed
  if (ep.season !== state.activeSeason) {
    switchSeason(ep.season);
  }

  // Update Episode Grid buttons active state
  const epButtons = episodesGrid.querySelectorAll('.ep-btn');
  epButtons.forEach(btn => {
    btn.classList.toggle('active', Number(btn.getAttribute('data-index')) === index);
  });

  // Badges & Labels
  modalEpIndicator.textContent = `S${String(ep.season).padStart(2, '0')} E${String(ep.episode).padStart(2, '0')}`;
  modalFormatBadge.textContent = `DropEmbed MP4 [${ep.quality || '1080p'}]`;
  currPlayingLabel.textContent = `Playing S${ep.season} Episode ${ep.episode} (${ep.quality || '1080p'})`;

  // Embed URL resolution: ensure clean /e/ URL
  let embedUrl = ep.embed_url;
  if (!embedUrl && ep.filecode) {
    embedUrl = `https://dropembed.com/e/${ep.filecode}`;
  } else if (embedUrl && embedUrl.includes('/v/')) {
    embedUrl = embedUrl.replace('/v/', '/e/');
  }

  const isPlayable = ep.is_playable || (ep.stream_type === 'MP4' && !!ep.filecode);

  if (isPlayable && embedUrl) {
    playerLoader.style.display = 'flex';
    playerLoader.style.opacity = '1';
    playerLoader.innerHTML = `<div class="spinner"></div><span>Loading DropEmbed Cloud Stream...</span>`;

    // DropEmbed responsive iframe embed with exact user requested attributes
    videoIframe.setAttribute('width', '640');
    videoIframe.setAttribute('height', '360');
    videoIframe.setAttribute('frameborder', '0');
    videoIframe.setAttribute('allowfullscreen', 'true');
    videoIframe.setAttribute('allow', 'autoplay; fullscreen');
    videoIframe.src = embedUrl;

    videoIframe.onload = () => {
      setTimeout(() => {
        playerLoader.style.opacity = '0';
        setTimeout(() => { playerLoader.style.display = 'none'; }, 300);
      }, 500);
    };

    openSourceBtn.href = ep.watch_url || `https://dropembed.com/v/${ep.filecode || ''}`;
    openSourceBtn.style.display = 'inline-flex';

    diagTitle.textContent = `Stream: DropEmbed Cloud MP4 (${ep.quality || '1080p'})`;
    diagSub.textContent = `ID: ${ep.filecode ? ep.filecode.slice(0, 14) + '...' : 'Live'}`;
    diagDot.className = 'diag-dot dot-green';
  } else {
    videoIframe.src = '';
    playerLoader.style.display = 'flex';
    playerLoader.style.opacity = '1';
    playerLoader.innerHTML = `
      <span style="color:#ef4444; font-weight: 700; font-size: 1.1rem;">⚠️ Stream Not Available</span>
      <p style="color:#94a3b8; font-size: 0.85rem; margin-top: 6px; text-align: center; max-width: 400px;">
        This episode's source file was removed on Rumble CDN (403 AccessDenied). Please select a playable episode marked with 🟢 Ready.
      </p>
    `;
    diagTitle.textContent = `Stream: Expired / Unavailable`;
    diagSub.textContent = `Status: Rumble 403`;
    diagDot.className = 'diag-dot dot-red';
  }

  // Setup Copy Embed Button
  if (copyEmbedBtn) {
    copyEmbedBtn.onclick = () => {
      if (!embedUrl) {
        alert('No embed URL available for this episode.');
        return;
      }
      const embedCode = `<iframe src="${embedUrl}" width="640" height="360" frameborder="0" allowfullscreen allow="autoplay; fullscreen"></iframe>`;
      navigator.clipboard.writeText(embedCode).then(() => {
        copyEmbedBtn.classList.add('copied');
        if (copyEmbedText) copyEmbedText.textContent = 'Copied! ✓';
        setTimeout(() => {
          copyEmbedBtn.classList.remove('copied');
          if (copyEmbedText) copyEmbedText.textContent = 'Copy Embed';
        }, 2000);
      }).catch(() => {
        prompt('DropEmbed iframe code:', embedCode);
      });
    };
  }

  // Prev / Next button states
  prevEpBtn.disabled = (index <= 0);
  nextEpBtn.disabled = (index >= state.allEpisodesFlat.length - 1);
}

function closePlayerModal() {
  playerModal.style.display = 'none';
  videoIframe.src = '';
  state.activeAnime = null;
}

function toggleTheaterMode() {
  state.isTheaterMode = !state.isTheaterMode;
  const dialog = document.querySelector('.modal-dialog');
  if (state.isTheaterMode) {
    dialog.style.maxWidth = '98vw';
    dialog.style.height = '98vh';
  } else {
    dialog.style.maxWidth = '1120px';
    dialog.style.height = 'auto';
  }
}

/* ==============================================================================
   6. EVENT LISTENERS
   ============================================================================== */
function setupEventListeners() {
  // Search input debounce
  let searchTimeout = null;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const val = e.target.value.trim();
    clearSearchBtn.style.display = val ? 'block' : 'none';

    searchTimeout = setTimeout(() => {
      state.currentFilters.search = val;
      state.currentFilters.page = 1;
      loadCatalog();
    }, 300);
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    state.currentFilters.search = '';
    state.currentFilters.page = 1;
    loadCatalog();
  });

  // Filter Pills (Format, Type, Status)
  document.querySelectorAll('#formatFilters .pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      document.querySelectorAll('#formatFilters .pill').forEach(p => p.classList.remove('active'));
      e.target.classList.add('active');

      const filterType = e.target.getAttribute('data-filter');
      const filterVal = e.target.getAttribute('data-val');

      if (filterType === 'status_type') {
        state.currentFilters.status_type = filterVal;
        state.currentFilters.type = 'ALL';
        state.currentFilters.format = 'ALL';
      } else if (filterType === 'type') {
        state.currentFilters.type = filterVal;
        state.currentFilters.status_type = 'ALL';
        state.currentFilters.format = 'ALL';
      } else if (filterType === 'format') {
        state.currentFilters.format = filterVal;
        state.currentFilters.status_type = 'ALL';
        state.currentFilters.type = 'ALL';
      }

      state.currentFilters.page = 1;
      loadCatalog();
    });
  });

  // Dub Type Pills
  document.querySelectorAll('#dubFilters .pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      document.querySelectorAll('#dubFilters .pill').forEach(p => p.classList.remove('active'));
      e.target.classList.add('active');
      state.currentFilters.dub_type = e.target.getAttribute('data-val');
      state.currentFilters.page = 1;
      loadCatalog();
    });
  });

  // Sort selector
  sortSelect.addEventListener('change', (e) => {
    state.currentFilters.sort = e.target.value;
    state.currentFilters.page = 1;
    loadCatalog();
  });

  // Pagination buttons
  prevPageBtn.addEventListener('click', () => {
    if (state.currentFilters.page > 1) {
      state.currentFilters.page--;
      loadCatalog();
      window.scrollTo({ top: document.querySelector('.catalog-header').offsetTop - 80, behavior: 'smooth' });
    }
  });

  nextPageBtn.addEventListener('click', () => {
    state.currentFilters.page++;
    loadCatalog();
    window.scrollTo({ top: document.querySelector('.catalog-header').offsetTop - 80, behavior: 'smooth' });
  });

  // Modal interactions
  closeModalBtn.addEventListener('click', closePlayerModal);
  modalBackdrop.addEventListener('click', closePlayerModal);
  theaterModeBtn.addEventListener('click', toggleTheaterMode);

  reloadPlayerBtn.addEventListener('click', () => {
    if (state.allEpisodesFlat[state.activeEpisodeIndex]) {
      playEpisodeByIndex(state.activeEpisodeIndex);
    }
  });

  prevEpBtn.addEventListener('click', () => {
    if (state.activeEpisodeIndex > 0) {
      playEpisodeByIndex(state.activeEpisodeIndex - 1);
    }
  });

  nextEpBtn.addEventListener('click', () => {
    if (state.activeEpisodeIndex < state.allEpisodesFlat.length - 1) {
      playEpisodeByIndex(state.activeEpisodeIndex + 1);
    }
  });

  // Global Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (playerModal.style.display !== 'none') {
      if (e.key === 'Escape') closePlayerModal();
      if (e.key === 'ArrowRight') nextEpBtn.click();
      if (e.key === 'ArrowLeft') prevEpBtn.click();
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Global scope initialization
window.addEventListener('DOMContentLoaded', initApp);
window.openPlayerModal = openPlayerModal;
window.playEpisodeByIndex = playEpisodeByIndex;
