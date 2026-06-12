/* ============================================================
   BaseballNow — main.js

   Three views / interaction layers:
   1. Games Grid        — all today's games as logo cards
   2. Card Expand       — click a card to drop down a compact
                          inline view with mini pitch zone + count
   3. Full Gameday      — opened from the expand's button;
                          large pitch zone, full box score, lineup

   Pitch tracking: MLB live game feed (/api/v1.1/game/{pk}/feed/live)
   updates after every pitch. Polling at 4s for live games gives
   near-real-time pitch tracking — new pitches animate into the zone.
   Non-live games poll slower (15s) to conserve API calls.

   Data sources:
   - MLB Stats API (free, no auth, CORS-open)
   - Baseball Savant / BR: deep-link only (CORS-blocked)
   ============================================================ */

'use strict';

// ── API endpoints ──────────────────────────────────────────────
const MLB_API   = 'https://statsapi.mlb.com/api/v1';
const MLB_API_1 = 'https://statsapi.mlb.com/api/v1.1';
const SAVANT    = 'https://baseballsavant.mlb.com';
const BR        = 'https://www.baseball-reference.com';

// Proxy base: empty when running locally, Render URL when deployed to GitHub Pages.
// Update this after deploying to Render.
const PROXY_BASE = window.location.hostname.endsWith('github.io')
  ? 'https://mlb-ag.onrender.com'
  : '';

const CUR_SEASON  = new Date().getFullYear();
const PREV_SEASON = CUR_SEASON - 1;

// ── Favorite team ────────────────────────────────────────────
const ALL_TEAMS = [
  { id: 109, abbr: 'ARI' }, { id: 144, abbr: 'ATL' }, { id: 110, abbr: 'BAL' },
  { id: 111, abbr: 'BOS' }, { id: 112, abbr: 'CHC' }, { id: 145, abbr: 'CWS' },
  { id: 113, abbr: 'CIN' }, { id: 114, abbr: 'CLE' }, { id: 115, abbr: 'COL' },
  { id: 116, abbr: 'DET' }, { id: 117, abbr: 'HOU' }, { id: 118, abbr: 'KC'  },
  { id: 108, abbr: 'LAA' }, { id: 119, abbr: 'LAD' }, { id: 146, abbr: 'MIA' },
  { id: 158, abbr: 'MIL' }, { id: 142, abbr: 'MIN' }, { id: 121, abbr: 'NYM' },
  { id: 147, abbr: 'NYY' }, { id: 133, abbr: 'OAK' }, { id: 143, abbr: 'PHI' },
  { id: 134, abbr: 'PIT' }, { id: 135, abbr: 'SD'  }, { id: 137, abbr: 'SF'  },
  { id: 136, abbr: 'SEA' }, { id: 138, abbr: 'STL' }, { id: 139, abbr: 'TB'  },
  { id: 140, abbr: 'TEX' }, { id: 141, abbr: 'TOR' }, { id: 120, abbr: 'WSH' },
];

function getFavoriteTeamId() {
  const v = localStorage.getItem('mlbag_fav_team');
  return v ? parseInt(v) : null;
}

function applyFavoriteTeamMeta(teamId) {
  const logoUrl = teamId ? TEAM_LOGO(teamId) : 'icon.svg';
  const touchIcon = document.getElementById('apple-touch-icon-link');
  if (touchIcon) touchIcon.href = logoUrl;
  const favImg = document.getElementById('fav-team-logo');
  if (favImg) { favImg.src = logoUrl; favImg.onerror = () => { favImg.src = 'icon.svg'; }; }
}

function setFavoriteTeam(teamId) {
  const isNew = getFavoriteTeamId() !== teamId;
  localStorage.setItem('mlbag_fav_team', teamId);
  applyFavoriteTeamMeta(teamId);
  document.querySelectorAll('.tp-team').forEach(el => {
    el.classList.toggle('tp-selected', parseInt(el.dataset.id) === teamId);
  });
  if (isNew) showToast('Remove and re-add the app to your home screen to update the icon');
}

function openTeamPicker() {
  const overlay = document.getElementById('team-picker-overlay');
  const grid = document.getElementById('team-picker-grid');
  const favId = getFavoriteTeamId();
  grid.innerHTML = ALL_TEAMS.map(t => `
    <button class="tp-team${t.id === favId ? ' tp-selected' : ''}" data-id="${t.id}"
            onclick="setFavoriteTeam(${t.id})">
      <img src="${TEAM_LOGO(t.id)}" alt="${t.abbr}" onerror="this.style.opacity=0.3" />
      <span>${t.abbr}</span>
    </button>`).join('');
  overlay.classList.remove('hidden');
}

function closeTeamPicker() {
  document.getElementById('team-picker-overlay')?.classList.add('hidden');
}

function estimateTeamGamesPlayed() {
  const start = new Date(CUR_SEASON + '-03-27');
  const days  = Math.max(0, (new Date() - start) / 86400000);
  return Math.min(162, Math.round(days * 0.885));
}

function calcFIP(s) {
  const ip = parseFloat(s?.inningsPitched) || 0;
  if (ip < 1) return null;
  const hr  = parseInt(s?.homeRuns)    || 0;
  const bb  = parseInt(s?.baseOnBalls) || 0;
  const hbp = parseInt(s?.hitBatsmen)  || 0;
  const k   = parseInt(s?.strikeOuts)  || 0;
  return ((13*hr + 3*(bb+hbp) - 2*k) / ip + 3.15).toFixed(2);
}

function compMatchColor(pct) {
  if (pct >= 80) return '#48bb78';
  if (pct >= 65) {
    const t = (pct - 65) / 15;
    return `rgb(${Math.round(240+t*(72-240))},${Math.round(180+t*(187-180))},${Math.round(50+t*(120-50))})`;
  }
  if (pct >= 50) {
    const t = (pct - 50) / 15;
    return `rgb(240,${Math.round(140+t*(180-140))},50)`;
  }
  return 'rgb(240,140,50)';
}

// Park factors by MLB team ID (5-yr avg, 100 = neutral).
// Used for OPS+ / ERA+ park adjustment.
const PARK_FACTORS = {
  108:103, 109:100, 110:102, 111:106, 112:100, 113:108, 114: 99,
  115:115, 116: 95, 117:101, 118: 99, 119:100, 120: 96, 121: 97,
  133: 95, 134: 99, 135: 94, 136: 97, 137: 98, 138:102, 139: 95,
  140:101, 141:100, 142:101, 143:107, 144:103, 145: 97, 146: 96,
  147:106, 158: 97,
};

const TEAM_LOGO = id =>
  `https://www.mlbstatic.com/team-logos/${id}.svg`;

const HEADSHOT = id =>
  `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${id}/headshot/67/current`;

// MLB team ID → abbreviation (for split team objects that lack abbreviation)
const TEAM_ABBR = {
  109:'ARI',110:'BAL',111:'BOS',112:'CHC',113:'CIN',114:'CLE',115:'COL',
  116:'DET',117:'HOU',118:'KC', 119:'LAD',120:'WSH',121:'NYM',133:'OAK',
  134:'PIT',135:'SD', 136:'SEA',137:'SF', 138:'STL',139:'TB', 140:'TEX',
  141:'TOR',142:'MIN',143:'PHI',144:'ATL',145:'CWS',146:'MIA',147:'NYY',
  158:'MIL',108:'LAA'
};
const teamAbbr = t => t?.abbreviation || TEAM_ABBR[t?.id] || t?.name?.split(' ').pop()?.substring(0,4) || '—';

const TEAM_COLORS = {
  108:'#BA0021',109:'#A71930',110:'#DF4601',111:'#BD3039',112:'#0E3386',
  113:'#C6011F',114:'#00385D',115:'#33006F',116:'#0C2340',117:'#002D62',
  118:'#004687',119:'#005A9C',120:'#AB0003',121:'#002D72',133:'#003831',
  134:'#FDB827',135:'#2F241D',136:'#005C5C',137:'#FD5A1E',138:'#C41E3A',
  139:'#092C5C',140:'#003278',141:'#134A8E',142:'#002B5C',143:'#E81828',
  144:'#CE1141',145:'#27251F',146:'#FF6600',147:'#003087',158:'#12284B',
};

// ── Pitch type definitions ─────────────────────────────────────
const PITCH_TYPES = {
  FF: { label: '4-Seam',   color: '#ef4444' },
  FT: { label: '2-Seam',   color: '#f97316' },
  SI: { label: 'Sinker',   color: '#fb923c' },
  FC: { label: 'Cutter',   color: '#a855f7' },
  FS: { label: 'Splitter', color: '#92400e' },
  FO: { label: 'Forkball', color: '#78350f' },
  SL: { label: 'Slider',   color: '#eab308' },
  ST: { label: 'Sweeper',  color: '#ca8a04' },
  CU: { label: 'Curve',    color: '#06b6d4' },
  KC: { label: 'K-Curve',  color: '#0891b2' },
  CH: { label: 'Change',   color: '#22c55e' },
  KN: { label: 'Knuckle',  color: '#f0c040' },
  EP: { label: 'Eephus',   color: '#6366f1' },
  PO: { label: 'Pitchout', color: '#6b7280' },
};
const pitchInfo = code => PITCH_TYPES[code] || { label: code || '?', color: '#9ca3af' };

// ── Pitch zone render configs ──────────────────────────────────
// "full" is used in the gameday detail; "mini" is used in card expands.
// scale = pixels per foot; cx/floor define the origin in SVG space.
const ZONE = {
  full: { scale: 75,  cx: 170, floor: 370, hw: 0.708, dotR: 9,   svgW: 340, svgH: 400 },
  mini: { scale: 38,  cx: 100, floor: 207, hw: 0.708, dotR: 6,   svgW: 200, svgH: 220 },
};

// Convert pitch coordinates (feet) to SVG pixel space
function toSvg(pX, pZ, cfg) {
  return {
    x: cfg.cx + pX  * cfg.scale,
    y: cfg.floor - pZ * cfg.scale,
  };
}
function szY(feet, cfg) { return cfg.floor - feet * cfg.scale; }

// ── App state ──────────────────────────────────────────────────
const state = {
  currentDate:      todayStr(),
  games:            [],

  // Games grid
  gridPollTimer:    null,

  // Card expand (one card open at a time)
  expandedCardPk:   null,
  miniPollTimer:    null,
  miniPitchCounts:  {},   // gamePk → number of pitches last rendered

  // Full gameday view
  selectedGamePk:   null,
  gdTab:            'live',
  gdMode:           null,  // 'preview' | 'live' — tracks current mode to avoid tab reset on poll
  gdData:           null,
  gdPollTimer:      null,
  gdPitchCount:     0,    // pitches rendered last cycle — detects new arrivals
  gdBatterId:       null, // track matchup to avoid re-fetching stats every poll
  gdPitcherId:      null,
  lastAbIdx:        null, // track at-bat index for banner persistence
  lastPlayResult:   null, // last completed AB description to show between pitches

  // Player panel
  activePlayer:     null,
  playerHistory:    [],   // stack of {id, name, gamePk} for back navigation
  activeTab:        'today',
  searchTimer:      null,
};

// ── DOM refs ───────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const appEl         = $('app');
const gamesSection  = $('games-section');
const gamesGrid     = $('games-grid');
const gamedayDetail = $('gameday-detail');
const playerPanel   = $('player-panel');
const liveBadge     = $('live-badge');
const liveBadgeText = $('live-badge-text');
const searchInput   = $('player-search');
const searchResults = $('search-results');
const currentDateLbl= $('current-date-label');

// ============================================================
// UTILITIES
// ============================================================

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

function shiftDate(str, days) {
  const d = new Date(str + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function friendlyDate(str) {
  const [y,m,d] = str.split('-').map(Number);
  const dt = new Date(y,m-1,d);
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((dt - today) / 86400000);
  if (diff === 0)  return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1)  return 'Tomorrow';
  return dt.toLocaleDateString('en-US', { month:'short', day:'numeric' });
}

function fmt(v, dec=0) {
  if (v == null || v === '') return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return '—';
  return dec > 0 ? n.toFixed(dec) : String(n);
}
function fmtAvg(v) {
  if (v == null || v === '') return '.---';
  const n = parseFloat(v);
  if (isNaN(n)) return '.---';
  return n.toFixed(3).replace('0.', '.');
}

async function apiFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ============================================================
// GAMES GRID
// ============================================================

async function loadSchedule(dateStr) {
  const url = `${MLB_API}/schedule?sportId=1&date=${dateStr}`
    + `&hydrate=linescore,probablePitcher,team,lineups`;
  const data = await apiFetch(url);
  return data.dates?.[0]?.games || [];
}

async function refreshGrid() {
  try {
    const games = await loadSchedule(state.currentDate);
    state.games = games;
    renderGames(games);
    updateLiveBadge(games);
  } catch {
    gamesGrid.innerHTML = `<div class="empty-state"><strong>Couldn't load schedule</strong></div>`;
  }
}

function startGridPoll() {
  stopGridPoll();
  state.gridPollTimer = setInterval(refreshGrid, 45_000);
}
function stopGridPoll() {
  if (state.gridPollTimer) clearInterval(state.gridPollTimer);
}

function updateLiveBadge(games) {
  const live = games.filter(g => g.status?.abstractGameState === 'Live');
  if (live.length) {
    liveBadge.classList.add('live');
    liveBadgeText.textContent = `${live.length} live`;
  } else {
    liveBadge.classList.remove('live');
    liveBadgeText.textContent = games.length === 0 ? 'No games'
      : games.filter(g => g.status?.abstractGameState === 'Final').length === games.length
        ? `${games.length} final` : `${games.length} games`;
  }
  renderLiveGamesBanner(games);
}

function renderLiveGamesBanner(games) {
  const banner = $('live-games-banner');
  if (!banner) return;
  if (!games.length) {
    banner.innerHTML = '';
    return;
  }
  const sorted = [...games].sort((a, b) => {
    const order = g => g.status?.abstractGameState === 'Live' ? 0 : g.status?.abstractGameState === 'Final' ? 2 : 1;
    return order(a) - order(b);
  });
  banner.innerHTML = sorted.map(g => {
    const awayId   = g.teams?.away?.team?.id;
    const homeId   = g.teams?.home?.team?.id;
    const aScore   = g.linescore?.teams?.away?.runs ?? null;
    const hScore   = g.linescore?.teams?.home?.runs ?? null;
    const abs      = g.status?.abstractGameState || '';
    const isLive   = abs === 'Live';
    const isFinal  = abs === 'Final';
    const isSelected = g.gamePk === state.selectedGamePk;

    let inningBadge = '';
    let scorePart   = '';

    if (isLive) {
      inningBadge = `<span class="lgb-inning">${getInningStr(g)}</span>`;
      scorePart   = `<span class="lgb-score-num">${aScore??0}-${hScore??0}</span>`;
    } else if (isFinal) {
      inningBadge = `<span class="lgb-inning" style="color:var(--text-muted)">F</span>`;
      scorePart   = `<span class="lgb-score-num">${aScore??0}-${hScore??0}</span>`;
    } else {
      // Preview — show scheduled time
      const t = g.gameDate ? new Date(g.gameDate) : null;
      const timeLabel = t ? t.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) : '—';
      inningBadge = `<span class="lgb-inning lgb-pre-time">${timeLabel}</span>`;
      scorePart   = '';
    }

    return `<div class="lgb-chip${isLive?' lgb-live':''}${isSelected?' lgb-active':''}" data-pk="${g.gamePk}">
      <img src="${TEAM_LOGO(awayId)}" onerror="this.style.display='none'"/>
      ${scorePart}
      <img src="${TEAM_LOGO(homeId)}" onerror="this.style.display='none'"/>
      ${inningBadge}
    </div>`;
  }).join('');

  banner.querySelectorAll('.lgb-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const pk = parseInt(chip.dataset.pk);
      const game = games.find(g => g.gamePk === pk);
      if (!game) return;
      $('standings-section')?.classList.add('hidden');
      $('games-section')?.classList.add('hidden');
      openGamedayView(pk, game);
    });
  });
}

function getStatusInfo(game) {
  const abs = game.status?.abstractGameState || '';
  const det = game.status?.detailedState  || '';
  if (abs === 'Live')  return { label: 'LIVE',  cls: 'live' };
  if (abs === 'Final') return { label: 'FINAL', cls: 'final' };
  if (/delay|postpone/i.test(det)) return { label: det.substring(0,8).toUpperCase(), cls: 'delay' };
  if (game.gameDate) {
    const t = new Date(game.gameDate);
    return { label: t.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }), cls: 'pre' };
  }
  return { label: 'PREVIEW', cls: 'pre' };
}

function getInningStr(game) {
  const ls = game.linescore;
  if (!ls?.currentInning) return '';
  return `${ls.inningHalf === 'Top' ? '▲' : '▼'}${ls.currentInning}`;
}

function renderGames(games) {
  if (!games.length) {
    gamesGrid.innerHTML = `<div class="empty-state"><strong>No games scheduled</strong>Try a different date.</div>`;
    return;
  }
  const live     = games.filter(g => g.status?.abstractGameState === 'Live');
  const final    = games.filter(g => g.status?.abstractGameState === 'Final');
  const upcoming = games.filter(g => !['Live','Final'].includes(g.status?.abstractGameState || ''));

  const savedScrollY = window.scrollY;
  gamesGrid.innerHTML = '';

  function appendSection(label, list) {
    if (!list.length) return;
    const d = document.createElement('div');
    d.className = 'games-section-divider';
    d.dataset.section = label.toLowerCase();
    d.textContent = `${label} · ${list.length} game${list.length !== 1 ? 's' : ''}`;
    gamesGrid.appendChild(d);
    list.forEach(g => gamesGrid.appendChild(buildGameCard(g)));
  }

  appendSection('Live', live);
  appendSection('Final', final);
  appendSection('Upcoming', upcoming);
  window.scrollTo(0, savedScrollY);
}

// ── Game Card ──────────────────────────────────────────────────
function buildGameCard(game) {
  const away = game.teams?.away;
  const home = game.teams?.home;
  const ls   = game.linescore;
  const pk   = game.gamePk;
  const { label, cls } = getStatusInfo(game);
  const isLive  = cls === 'live';
  const isFinal = cls === 'final';

  const awayId   = away?.team?.id;
  const homeId   = home?.team?.id;
  const awayRuns = ls?.teams?.away?.runs ?? '';
  const homeRuns = ls?.teams?.home?.runs ?? '';
  const awayWin  = isFinal && awayRuns > homeRuns;
  const homeWin  = isFinal && homeRuns > awayRuns;

  const awayPP   = away?.probablePitcher?.fullName || '';
  const homePP   = home?.probablePitcher?.fullName || '';
  const awayPPid = away?.probablePitcher?.id;
  const homePPid = home?.probablePitcher?.id;

  const card = document.createElement('div');
  card.className = `game-card${isLive ? ' live' : ''}`;
  card.dataset.gamePk = pk;

  card.innerHTML = `
    <div class="gc-clickable">
      <div class="gc-status-row">
        <span class="game-status ${cls}">${label}</span>
        <span class="gc-inning">${getInningStr(game)}</span>
      </div>

      <div class="gc-matchup">
        <div class="gc-team away">
          ${awayId ? `<img class="team-logo" src="${TEAM_LOGO(awayId)}" alt="${away?.team?.abbreviation||''}" onerror="this.style.display='none'" />` : ''}
          <div class="gc-team-text">
            <span class="gc-abbr">${away?.team?.abbreviation || '?'}</span>
            <span class="gc-record">${away?.leagueRecord ? `${away.leagueRecord.wins}-${away.leagueRecord.losses}` : ''}</span>
          </div>
        </div>

        <div class="gc-score-block">
          ${(isLive || isFinal) ? `
            <div class="gc-scores">
              <span class="gc-score${isFinal && !awayWin ? ' dim' : ''}">${fmt(awayRuns)}</span>
              <span class="gc-dash">–</span>
              <span class="gc-score${isFinal && !homeWin ? ' dim' : ''}">${fmt(homeRuns)}</span>
            </div>` : `
            <div class="gc-scores" style="opacity:.3">
              <span class="gc-score">0</span><span class="gc-dash">–</span><span class="gc-score">0</span>
            </div>`}
        </div>

        <div class="gc-team home">
          <div class="gc-team-text" style="align-items:flex-end">
            <span class="gc-abbr">${home?.team?.abbreviation || '?'}</span>
            <span class="gc-record">${home?.leagueRecord ? `${home.leagueRecord.wins}-${home.leagueRecord.losses}` : ''}</span>
          </div>
          ${homeId ? `<img class="team-logo" src="${TEAM_LOGO(homeId)}" alt="${home?.team?.abbreviation||''}" onerror="this.style.display='none'" />` : ''}
        </div>
      </div>

      <div class="gc-footer">
        <div class="gc-pitchers">
          ${awayPP ? `<span class="gc-pitcher-name" data-pid="${awayPPid}">${awayPP.split(' ').pop()}</span>` : '<span>TBD</span>'}
          <span style="color:var(--text-muted)"> vs </span>
          ${homePP ? `<span class="gc-pitcher-name" data-pid="${homePPid}">${homePP.split(' ').pop()}</span>` : '<span>TBD</span>'}
        </div>
        <span class="gc-cta" id="gc-cta-${pk}">▼ Expand</span>
        <button class="gc-full-btn" data-pk="${pk}" id="gc-full-btn-${pk}">${cls === 'pre' ? 'Preview ↗' : 'Full ↗'}</button>
      </div>
    </div>

    <!-- Expand section: compact inline gameday -->
    <div class="gc-detail" id="gc-detail-${pk}">
      <div class="gc-detail-inner">
        <div class="loading-state" style="padding:20px"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>
      </div>
    </div>
  `;

  // Clicking the top part (gc-clickable) toggles the expand
  const clickable = card.querySelector('.gc-clickable');
  clickable.style.cursor = 'pointer';
  clickable.addEventListener('click', e => {
    if (e.target.classList.contains('gc-pitcher-name')) return;
    toggleCardExpand(pk, card, game);
  });

  // Direct "Full Gameday" button on card face
  const fullBtn = card.querySelector('.gc-full-btn');
  if (fullBtn) {
    fullBtn.addEventListener('click', e => {
      e.stopPropagation();
      const gd = state.games.find(g => g.gamePk === pk);
      openGamedayView(pk, gd);
    });
  }

  // Pitcher name clicks
  card.querySelectorAll('.gc-pitcher-name').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const pid = parseInt(el.dataset.pid);
      if (pid) openPlayerProfile(pid, el.closest('.game-card').querySelector('.gc-abbr')?.textContent || '', pk);
    });
  });

  return card;
}

// ============================================================
// CARD EXPAND — mini inline gameday
// ============================================================

// Returns all game-cards in the same section divider group as `card`
function getSectionCards(card) {
  const siblings = Array.from(gamesGrid.children);
  const idx = siblings.indexOf(card);
  let start = 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (siblings[i].classList.contains('games-section-divider')) { start = i + 1; break; }
  }
  let end = siblings.length;
  for (let i = idx + 1; i < siblings.length; i++) {
    if (siblings[i].classList.contains('games-section-divider')) { end = i; break; }
  }
  return siblings.slice(start, end).filter(el => el.classList.contains('game-card'));
}

function toggleCardExpand(pk, card, gameData) {
  const detail = card.querySelector(`#gc-detail-${pk}`);
  const isOpen = detail.classList.contains('open');

  // Expand/collapse the entire section row together
  const sectionCards = getSectionCards(card);

  if (isOpen) {
    // Close all in section
    sectionCards.forEach(c => {
      const cpk = parseInt(c.dataset.gamePk);
      c.querySelector(`#gc-detail-${cpk}`)?.classList.remove('open');
      const cta = c.querySelector(`#gc-cta-${cpk}`);
      if (cta) cta.textContent = '▼ Expand';
      stopMiniCardPoll(cpk);
    });
    return;
  }

  // Open all cards in section simultaneously
  sectionCards.forEach(c => {
    const cpk = parseInt(c.dataset.gamePk);
    const cdetail = c.querySelector(`#gc-detail-${cpk}`);
    const cta     = c.querySelector(`#gc-cta-${cpk}`);
    if (!cdetail) return;
    cdetail.classList.add('open');
    if (cta) cta.textContent = '▲ Close';
    const cgame = state.games.find(g => g.gamePk === cpk);
    fetchAndRenderMini(cpk, cdetail, cgame);
    startMiniCardPoll(cpk, cdetail, cgame);
  });
}

// Per-card poll timers stored in state.miniCardPolls = { pk: intervalId }
function startMiniCardPoll(pk, detail, gameData) {
  stopMiniCardPoll(pk);
  if (!state.miniCardPolls) state.miniCardPolls = {};
  const isLive = gameData?.status?.abstractGameState === 'Live';
  state.miniCardPolls[pk] = setInterval(() => fetchAndRenderMini(pk, detail, gameData), isLive ? 5_000 : 20_000);
}
function stopMiniCardPoll(pk) {
  if (state.miniCardPolls?.[pk]) {
    clearInterval(state.miniCardPolls[pk]);
    delete state.miniCardPolls[pk];
  }
}
function stopMiniPoll() {
  // Stop all per-card polls (called when navigating away)
  if (state.miniCardPolls) {
    Object.values(state.miniCardPolls).forEach(clearInterval);
    state.miniCardPolls = {};
  }
  if (state.miniPollTimer) { clearInterval(state.miniPollTimer); state.miniPollTimer = null; }
}

async function fetchAndRenderMini(pk, detail, gameData) {
  const abs = gameData?.status?.abstractGameState || '';
  try {
    const data = await apiFetch(`${MLB_API_1}/game/${pk}/feed/live`);
    renderMiniGameday(pk, detail, data, gameData);
  } catch {
    detail.innerHTML = `<div class="gc-detail-inner">
      <div style="color:var(--text-muted);font-size:0.75rem;text-align:center">Couldn't load game data</div>
      ${openFullBtn(pk)}
    </div>`;
  }
}

// Build the "Open Full Gameday" button HTML
function openFullBtn(pk, isPreview = false) {
  return `<button class="gc-open-full-btn" data-pk="${pk}">${isPreview ? 'Open Preview →' : 'Open Full Gameday →'}</button>`;
}

function renderMiniGameday(pk, detail, data, gameData) {
  const abs     = data.gameData?.status?.abstractGameState || '';
  const ls      = data.liveData?.linescore;
  const plays   = data.liveData?.plays;
  const current = plays?.currentPlay;

  let html = '<div class="gc-detail-inner">';

  if (abs === 'Live' || (abs === 'Final' && current)) {
    // Play description
    const desc = current?.result?.description || current?.result?.event || ls?.note || '—';
    html += `<div class="gc-mini-desc">${desc}</div>`;

    // Batter vs Pitcher names
    const batterName  = current?.matchup?.batter?.fullName  || '';
    const pitcherName = current?.matchup?.pitcher?.fullName || '';
    const batterId    = current?.matchup?.batter?.id;
    const pitcherId   = current?.matchup?.pitcher?.id;

    if (batterName || pitcherName) {
      html += `<div class="gc-mini-matchup">
        ${batterId  ? `<span class="gc-mini-player" data-pid="${batterId}">${batterName}</span>`   : `<span>${batterName}</span>`}
        <span class="gc-mini-vs">vs</span>
        ${pitcherId ? `<span class="gc-mini-player" data-pid="${pitcherId}">${pitcherName}</span>` : `<span>${pitcherName}</span>`}
      </div>`;
    }

    // Mini pitch zone SVG
    const pitchEvents = (current?.playEvents || []).filter(e => e.type === 'pitch');
    const lastPitch   = pitchEvents.filter(e => e.pitchData?.coordinates?.pZ).pop();
    const szTop = lastPitch?.pitchData?.strikeZoneTop    || 3.4;
    const szBot = lastPitch?.pitchData?.strikeZoneBottom || 1.5;

    const prevCount = state.miniPitchCounts[pk] || 0;
    state.miniPitchCounts[pk] = pitchEvents.length;

    const pitcherDisplay = pitcherName ? pitcherName.split(' ').pop() : '';
    const pitchCount = getPitcherPitchCount(data, pitcherId);
    html += `<div class="gc-mini-zone-wrap">
      <div class="gc-mini-pitcher-label">${pitcherDisplay}${pitchCount ? ` · ${pitchCount}P` : ''}</div>
      ${buildMiniZoneSVG(pitchEvents, szTop, szBot, prevCount)}
      <div class="gc-mini-legend">${buildLegendHtml(pitchEvents)}</div>
    </div>`;

    // Mini count
    const count = current?.count || {};
    html += buildMiniCountHtml(count.balls||0, count.strikes||0, count.outs||0);

  } else if (abs === 'Preview' || abs === '') {
    // Pre-game
    const gameTime = data.gameData?.datetime?.dateTime;
    const timeStr  = gameTime
      ? new Date(gameTime).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZoneName:'short' })
      : 'TBD';
    const awayPP = data.gameData?.probablePitchers?.away?.fullName  || 'TBD';
    const homePP = data.gameData?.probablePitchers?.home?.fullName  || 'TBD';
    const awayAb = data.gameData?.teams?.away?.abbreviation || '';
    const homeAb = data.gameData?.teams?.home?.abbreviation || '';

    html += `<div class="gc-mini-pregame">
      <div class="gametime">${timeStr}</div>
      <div class="probable">${awayAb} ${awayPP.split(' ').pop()} vs ${homeAb} ${homePP.split(' ').pop()}</div>
    </div>`;

  } else if (abs === 'Final') {
    const awayR = ls?.teams?.away?.runs ?? 0;
    const homeR = ls?.teams?.home?.runs ?? 0;
    const awayA = data.gameData?.teams?.away?.abbreviation || '';
    const homeA = data.gameData?.teams?.home?.abbreviation || '';

    // Try to extract W/L decisions from boxscore info
    const info = data.liveData?.boxscore?.info || [];
    const winInfo = info.find(i => /win/i.test(i.label));
    const losInfo = info.find(i => /los/i.test(i.label));

    html += `<div class="gc-mini-final">
      <div class="result-line" style="font-size:0.95rem;font-weight:800">${awayA} ${awayR} — ${homeR} ${homeA}</div>
      ${winInfo ? `<div class="result-line">W: ${winInfo.value}</div>` : ''}
      ${losInfo ? `<div class="result-line">L: ${losInfo.value}</div>` : ''}
    </div>`;
  }

  html += openFullBtn(pk);
  html += '</div>';

  detail.innerHTML = html;

  // Wire "Open Full Gameday" button
  detail.querySelectorAll('.gc-open-full-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      stopMiniPoll();
      detail.classList.remove('open');
      state.expandedCardPk = null;
      const gd = state.games.find(g => g.gamePk === parseInt(btn.dataset.pk));
      openGamedayView(parseInt(btn.dataset.pk), gd);
    });
  });

  // Wire player name clicks in mini view
  detail.querySelectorAll('.gc-mini-player[data-pid]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openPlayerProfile(parseInt(el.dataset.pid), el.textContent, pk);
    });
  });
}

function buildMiniCountHtml(balls, strikes, outs) {
  const dot = (on, cls) => `<span class="cdot${on ? ' '+cls : ''}"></span>`;
  return `<div class="gc-mini-count">
    <div class="count-group">
      <div class="count-label">B</div>
      <div class="count-dots">
        ${[0,1,2,3].map(i => dot(i<balls,'on-ball')).join('')}
      </div>
    </div>
    <div class="count-divider"></div>
    <div class="count-group">
      <div class="count-label">S</div>
      <div class="count-dots">
        ${[0,1,2].map(i => dot(i<strikes,'on-strike')).join('')}
      </div>
    </div>
    <div class="count-divider"></div>
    <div class="count-group">
      <div class="count-label">O</div>
      <div class="count-dots">
        ${[0,1,2].map(i => dot(i<outs,'on-out')).join('')}
      </div>
    </div>
  </div>`;
}

// ── Mini pitch zone SVG (built as HTML string) ──────────────────
function buildMiniZoneSVG(pitchEvents, szTop, szBot, prevCount) {
  const cfg = ZONE.mini;
  const szLeft  = cfg.cx - cfg.hw * cfg.scale;
  const szRight = cfg.cx + cfg.hw * cfg.scale;
  const szW     = szRight - szLeft;
  const top     = szY(szTop, cfg);
  const bot     = szY(szBot, cfg);
  const szH     = bot - top;

  // 9-zone grid lines
  const thW = szW / 3, thH = szH / 3;
  let gridLines = '';
  for (let i=1; i<=2; i++) {
    const lx = szLeft + thW*i, ly = top + thH*i;
    gridLines += `<line x1="${lx.toFixed(1)}" y1="${top.toFixed(1)}" x2="${lx.toFixed(1)}" y2="${bot.toFixed(1)}" stroke="#4a90d9" stroke-opacity="0.2" stroke-width="0.6" stroke-dasharray="2,2"/>`;
    gridLines += `<line x1="${szLeft.toFixed(1)}" y1="${ly.toFixed(1)}" x2="${szRight.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="#4a90d9" stroke-opacity="0.2" stroke-width="0.6" stroke-dasharray="2,2"/>`;
  }

  // Pitch dots
  let dots = '';
  pitchEvents.forEach((event, idx) => {
    const coords = event.pitchData?.coordinates;
    if (coords?.pX == null || coords?.pZ == null) return;
    const pX = parseFloat(coords.pX), pZ = parseFloat(coords.pZ);
    if (isNaN(pX) || isNaN(pZ)) return;

    const {x, y} = toSvg(pX, pZ, cfg);
    const { color } = pitchInfo(event.details?.type?.code || '');
    const opacity = 0.45 + (idx / Math.max(pitchEvents.length,1)) * 0.55;
    const isNew = idx >= prevCount;
    const isLatest = idx === pitchEvents.length - 1;
    const result = event.details?.call?.description || '';
    const speed  = event.pitchData?.startSpeed;

    if (isLatest) {
      // Glow ring on most recent pitch
      dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${cfg.dotR+4}" fill="none" stroke="${color}" stroke-width="1.5" stroke-opacity="0.35" class="pitch-latest-ring"/>`;
    }

    dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${cfg.dotR}" fill="${color}" fill-opacity="${opacity.toFixed(2)}" stroke="#000" stroke-width="0.8" ${isNew ? 'class="pitch-new"' : ''}>
      <title>#${idx+1} ${event.details?.type?.code||'?'}${speed ? ' '+speed.toFixed(1)+'mph' : ''} — ${result}</title>
    </circle>`;
    dots += `<text x="${x.toFixed(2)}" y="${(y+2.5).toFixed(2)}" text-anchor="middle" fill="#fff" font-size="5.5" font-weight="bold" pointer-events="none">${idx+1}</text>`;
  });

  return `<svg class="gc-mini-svg" viewBox="0 0 ${cfg.svgW} ${cfg.svgH}" width="${cfg.svgW}" height="${cfg.svgH}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <clipPath id="mini-field-clip"><rect x="3" y="3" width="${cfg.svgW-6}" height="${cfg.svgH-6}" rx="2"/></clipPath>
      <radialGradient id="mini-vignette" cx="50%" cy="60%" r="70%">
        <stop offset="0%" stop-color="rgba(0,0,0,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0.45)"/>
      </radialGradient>
    </defs>
    <rect x="3" y="3" width="${cfg.svgW-6}" height="${cfg.svgH-6}" fill="#1a5c1e" rx="2"/>
    <image href="Softball_Field_image_large.jpg" x="-28" y="-8" width="256" height="278"
           preserveAspectRatio="xMidYMid slice" clip-path="url(#mini-field-clip)"/>
    <rect x="3" y="3" width="${cfg.svgW-6}" height="${cfg.svgH-6}" fill="url(#mini-vignette)" rx="2" clip-path="url(#mini-field-clip)"/>
    ${gridLines}
    <rect x="${szLeft.toFixed(1)}" y="${top.toFixed(1)}" width="${szW.toFixed(1)}" height="${szH.toFixed(1)}" fill="rgba(0,5,18,0.28)" stroke="rgba(255,255,255,0.85)" stroke-width="1.2"/>
    ${dots}
  </svg>`;
}

// Build pitch legend HTML (used in both mini and full)
function buildLegendHtml(pitchEvents) {
  const seen = new Map();
  pitchEvents.forEach(e => {
    const code = e.details?.type?.code || '';
    if (code && !seen.has(code)) seen.set(code, pitchInfo(code));
  });
  return [...seen.entries()].map(([code, {label, color}]) =>
    `<div class="legend-item"><span class="legend-dot" style="background:${color}"></span>${label}</div>`
  ).join('');
}

// Extract a pitcher's total pitch count from the boxscore
function getPitcherPitchCount(data, pitcherId) {
  if (!pitcherId) return null;
  const teams = data.liveData?.boxscore?.teams;
  if (!teams) return null;
  for (const side of ['away','home']) {
    const p = teams[side]?.players?.[`ID${pitcherId}`];
    if (p?.stats?.pitching?.numberOfPitches != null) return p.stats.pitching.numberOfPitches;
  }
  return null;
}

// ============================================================
// FULL GAMEDAY VIEW
// ============================================================

async function openGamedayView(gamePk, gameData) {
  state.selectedGamePk = gamePk;
  renderLiveGamesBanner(state.games); // update active chip immediately
  state.gdPitchCount   = 0;
  state.gdBatterId     = null;
  state.gdPitcherId    = null;
  state.gdTab          = 'live';
  state.gdMode         = null;  // reset so setGdPreviewMode rebuilds tabs for the new game
  state.lastAbIdx      = null;
  state.lastPlayResult = null;

  gamesSection.classList.add('hidden');
  gamedayDetail.classList.remove('hidden');
  history.pushState(null, '', `#game/${gamePk}/${state.gdTab || 'live'}/${state.currentDate}`);

  document.querySelectorAll('.game-card').forEach(c =>
    c.classList.toggle('selected', parseInt(c.dataset.gamePk) === gamePk));

  if (gameData) populateGdHeader(gameData);
  updateGameNavButtons();

  setGdTab('live');
  setGdLiveLoading();
  $('gd-boxscore-content').innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';

  await fetchAndRenderGameday(gamePk);
  startGamedayPoll(gamePk);
}

function closeGamedayView() {
  stopGamedayPoll();
  state.selectedGamePk = null;
  state.gdData         = null;
  state.gdBatterId     = null;
  state.gdPitcherId    = null;
  gamedayDetail.classList.add('hidden');
  gamesSection.classList.remove('hidden');
  document.querySelectorAll('.game-card').forEach(c => c.classList.remove('selected'));
  pushHash();
}

function navigateGame(delta) {
  const games = state.games;
  if (!games?.length) return;
  const idx = games.findIndex(g => g.gamePk === state.selectedGamePk);
  if (idx < 0) return;
  const next = games[idx + delta];
  if (!next) return;
  stopGamedayPoll();
  state.gdBatterId  = null;
  state.gdPitcherId = null;
  openGamedayView(next.gamePk, next);
}

function updateGameNavButtons() {
  const games = state.games || [];
  const idx = games.findIndex(g => g.gamePk === state.selectedGamePk);
  const prev = $('gd-prev-game'), next = $('gd-next-game');
  if (prev) prev.disabled = idx <= 0;
  if (next) next.disabled = idx < 0 || idx >= games.length - 1;
}

function populateGdHeader(game) {
  const away = game.teams?.away;
  const home = game.teams?.home;
  const setLogo = (id, el) => { if (id) { el.src = TEAM_LOGO(id); el.onerror = () => el.style.display='none'; } };
  setLogo(away?.team?.id, $('gd-away-logo'));
  setLogo(home?.team?.id, $('gd-home-logo'));
  $('gd-away-abbr').textContent   = away?.team?.abbreviation || '?';
  $('gd-home-abbr').textContent   = home?.team?.abbreviation || '?';
  $('gd-away-record').textContent = away?.leagueRecord ? `${away.leagueRecord.wins}-${away.leagueRecord.losses}` : '';
  $('gd-home-record').textContent = home?.leagueRecord ? `${home.leagueRecord.wins}-${home.leagueRecord.losses}` : '';
  $('gd-away-score').textContent  = game.linescore?.teams?.away?.runs ?? '0';
  $('gd-home-score').textContent  = game.linescore?.teams?.home?.runs ?? '0';
  const { label, cls } = getStatusInfo(game);
  const badge = $('gd-status-badge');
  badge.textContent = label; badge.className = `game-status ${cls}`;
  $('gd-inning-display').textContent = getInningStr(game);
  const isLive = cls === 'live';
  $('gd-live-chip').classList.toggle('hidden', !isLive);
  const watchBtn = $('gd-watch-btn');
  if (watchBtn) {
    watchBtn.classList.toggle('hidden', !isLive);
    if (isLive && state.selectedGamePk) {
      watchBtn.href = `https://www.mlb.com/gameday/${state.selectedGamePk}`;
    }
  }
}

// ── Adaptive polling via recursive setTimeout ─────────────────
// Using setTimeout instead of setInterval prevents callbacks from
// stacking if a fetch takes longer than the interval.
function scheduleGamedayPoll(gamePk) {
  if (state.selectedGamePk !== gamePk) return; // navigated away
  const isLive = state.gdData?.gameData?.status?.abstractGameState === 'Live';
  const delay  = isLive ? 4_000 : 15_000;
  state.gdPollTimer = setTimeout(async () => {
    if (state.selectedGamePk !== gamePk) return;
    await fetchAndRenderGameday(gamePk);
    scheduleGamedayPoll(gamePk);
  }, delay);
}
function startGamedayPoll(gamePk) {
  stopGamedayPoll();
  scheduleGamedayPoll(gamePk);
}
function stopGamedayPoll() {
  if (state.gdPollTimer) clearTimeout(state.gdPollTimer);
}

async function fetchAndRenderGameday(gamePk) {
  try {
    const data = await apiFetch(`${MLB_API_1}/game/${gamePk}/feed/live`);
    state.gdData = data;
    renderGdHeader(data);
    const abs = data.gameData?.status?.abstractGameState || '';
    if (abs === 'Preview' || abs === '') {
      setGdPreviewMode(true);
      renderGdPreview(data);
    } else {
      setGdPreviewMode(false);
      if (state.gdTab === 'live')      renderGdLive(data);
      if (state.gdTab === 'boxscore')  renderGdBoxScore(data);
      if (state.gdTab === 'postgame')  renderPostGame(data);
    }
  } catch (err) {
    console.error('Gameday fetch:', err);
  }
}

function setGdPreviewMode(isPreview) {
  const tabBar = $('gd-tabs');
  if (!tabBar) return;
  const newMode = isPreview ? 'preview' : 'live';
  const modeChanged = state.gdMode !== newMode;
  state.gdMode = newMode;
  if (isPreview) {
    if (modeChanged) {
      tabBar.innerHTML = `
        <button class="gd-tab active" data-gdtab="overview">Game Preview</button>
        <button class="gd-tab" data-gdtab="teamstats">Matchup Information</button>`;
      document.querySelectorAll('.gd-pane').forEach(p => p.classList.remove('active'));
      const ov = $('gd-pane-overview'); if (ov) ov.classList.add('active');
      state.gdTab = 'overview';
      tabBar.querySelectorAll('.gd-tab').forEach(btn =>
        btn.addEventListener('click', () => setGdTab(btn.dataset.gdtab)));
    }
  } else {
    if (modeChanged) {
      const isFinalGame = state.gdData?.gameData?.status?.abstractGameState === 'Final';
      if (isFinalGame) {
        tabBar.innerHTML = `
          <button class="gd-tab active" data-gdtab="postgame">Post Game</button>
          <button class="gd-tab" data-gdtab="boxscore">Box Score</button>`;
        document.querySelectorAll('.gd-pane').forEach(p => p.classList.remove('active'));
        const pg = $('gd-pane-postgame'); if (pg) pg.classList.add('active');
        state.gdTab = 'postgame';
      } else {
        tabBar.innerHTML = `
          <button class="gd-tab active" data-gdtab="live">Live</button>
          <button class="gd-tab" data-gdtab="boxscore">Box Score</button>`;
        document.querySelectorAll('.gd-pane').forEach(p => p.classList.remove('active'));
        const lv = $('gd-pane-live'); if (lv) lv.classList.add('active');
        state.gdTab = 'live';
      }
      tabBar.querySelectorAll('.gd-tab').forEach(btn =>
        btn.addEventListener('click', () => setGdTab(btn.dataset.gdtab)));
    }
  }
}

async function renderGdPreview(data) {
  const gd   = data.gameData;
  const away = gd?.teams?.away;
  const home = gd?.teams?.home;
  if (!away || !home) return;

  const awayId  = away.id;
  const homeId  = home.id;
  const awayPit = gd.probablePitchers?.away;
  const homePit = gd.probablePitchers?.home;

  // Immediately render overview shell (only if on overview tab)
  if (state.gdTab === 'overview') {
    renderPreviewOverview(data, null, null, null, null, null, null, null, null, null, null);
  }

  // Build news query from team names
  const awayName = away.teamName || away.name?.split(' ').slice(-1)[0] || away.abbreviation;
  const homeName = home.teamName || home.name?.split(' ').slice(-1)[0] || home.abbreviation;
  const newsQ = encodeURIComponent(`${awayName} ${homeName}`);

  // Kick off all async loads in parallel
  const [
    awayPitStatRes, homePitStatRes,
    awayBatTeamRes, homeBatTeamRes,
    awayPitTeamRes, homePitTeamRes,
    awayPitSvRes,   homePitSvRes,
    lgBatRes,
    boxRes,
    allTeamsBatRes,
    allTeamsPitRes,
    seasonSeriesRes,
    newsRes,
  ] = await Promise.allSettled([
    awayPit?.id ? apiFetch(`${MLB_API}/people/${awayPit.id}/stats?stats=season&group=pitching&season=${CUR_SEASON}`) : Promise.resolve(null),
    homePit?.id ? apiFetch(`${MLB_API}/people/${homePit.id}/stats?stats=season&group=pitching&season=${CUR_SEASON}`) : Promise.resolve(null),
    apiFetch(`${MLB_API}/teams/${awayId}/stats?stats=season&group=hitting&season=${CUR_SEASON}`),
    apiFetch(`${MLB_API}/teams/${homeId}/stats?stats=season&group=hitting&season=${CUR_SEASON}`),
    apiFetch(`${MLB_API}/teams/${awayId}/stats?stats=season&group=pitching&season=${CUR_SEASON}`),
    apiFetch(`${MLB_API}/teams/${homeId}/stats?stats=season&group=pitching&season=${CUR_SEASON}`),
    awayPit?.id ? apiFetch(`${PROXY_BASE}/proxy/savant?type=pitcher&year=${CUR_SEASON}&id=${awayPit.id}`) : Promise.resolve(null),
    homePit?.id ? apiFetch(`${PROXY_BASE}/proxy/savant?type=pitcher&year=${CUR_SEASON}&id=${homePit.id}`) : Promise.resolve(null),
    apiFetch(`${PROXY_BASE}/proxy/league-avg?season=${CUR_SEASON}`).catch(() => null),
    apiFetch(`${MLB_API}/game/${gd.game?.pk || state.selectedGamePk}/boxscore`).catch(() => null),
    apiFetch(`${MLB_API}/teams/stats?stats=season&group=hitting&season=${CUR_SEASON}&sportId=1`).catch(() => null),
    apiFetch(`${MLB_API}/teams/stats?stats=season&group=pitching&season=${CUR_SEASON}&sportId=1`).catch(() => null),
    apiFetch(`${MLB_API}/schedule?teamId=${awayId}&opponentId=${homeId}&sportId=1&gameType=R&season=${CUR_SEASON}&hydrate=linescore,team`).catch(() => null),
    apiFetch(`${PROXY_BASE}/proxy/news?q=${newsQ}`).catch(() => null),
  ]);

  const awayPitStat  = awayPitStatRes.value?.stats?.[0]?.splits?.[0]?.stat || null;
  const homePitStat  = homePitStatRes.value?.stats?.[0]?.splits?.[0]?.stat || null;
  const awayBatTeam  = awayBatTeamRes.value?.stats?.[0]?.splits?.[0]?.stat || null;
  const homeBatTeam  = homeBatTeamRes.value?.stats?.[0]?.splits?.[0]?.stat || null;
  const awayPitTeam  = awayPitTeamRes.value?.stats?.[0]?.splits?.[0]?.stat || null;
  const homePitTeam  = homePitTeamRes.value?.stats?.[0]?.splits?.[0]?.stat || null;
  const awayPitSv    = awayPitSvRes.value  || null;
  const homePitSv    = homePitSvRes.value  || null;
  const lgAvg        = lgBatRes.value      || null;
  const box          = boxRes.value        || null;
  const allTeamsBat  = allTeamsBatRes.value?.stats?.[0]?.splits || [];
  const allTeamsPit  = allTeamsPitRes.value?.stats?.[0]?.splits || [];
  const seasonSeries = seasonSeriesRes.value || null;
  const newsData     = newsRes.value || null;

  // Render overview with lineups embedded (only if on overview tab)
  if (state.gdTab === 'overview') {
    renderPreviewOverview(data, awayPitStat, homePitStat, awayPitSv, homePitSv, box, awayBatTeam, homeBatTeam, awayPitTeam, homePitTeam, lgAvg);
  }

  // Team stats tab — always update
  renderPreviewTeamStats(data, awayBatTeam, homeBatTeam, awayPitTeam, homePitTeam, lgAvg, allTeamsBat, allTeamsPit, seasonSeries, newsData);

  // Recent games section
  loadRecentGames(data, awayId, homeId, away, home);

  // H2H matchup tab
  if (awayPit?.id || homePit?.id) {
    renderPreviewMatchups(data, box, awayPitStat, homePitStat, awayPitSv, homePitSv);
  } else {
    const el = $('gd-preview-matchups');
    if (el) el.innerHTML = '<div class="preview-empty">Probable pitchers not yet announced.</div>';
  }
}

function renderPreviewOverview(data, awayPitStat, homePitStat, awayPitSv, homePitSv, boxRes, awayBatTeam, homeBatTeam, awayPitTeam, homePitTeam, lgAvg) {
  const gd   = data.gameData;
  const away = gd?.teams?.away;
  const home = gd?.teams?.home;
  const awayPit = gd?.probablePitchers?.away;
  const homePit = gd?.probablePitchers?.home;
  const venue   = gd?.venue;
  const weather = gd?.weather;

  const fmtEra  = s => s?.era  ? parseFloat(s.era).toFixed(2)             : '—';
  const fmtWhip = s => s?.whip ? parseFloat(s.whip).toFixed(2)            : '—';
  const fmtWL   = s => s?.wins != null ? `${s.wins}-${s.losses}`          : '—';
  const fmtK9   = s => s?.strikeoutsPer9Inn ? parseFloat(s.strikeoutsPer9Inn).toFixed(1) : '—';
  const pctCell = (sv, key) => {
    if (!sv || sv[key] == null) return '<span class="pv-pct-na">—</span>';
    const c = barColor(sv[key]);
    return `<span class="pv-pct-pip" style="background:${c}">${sv[key]}</span>`;
  };

  const pitcherCard = (pit, stat, sv, side) => {
    if (!pit) return `<div class="pv-pitcher-card pv-pitcher-card--tbd"><div class="pv-pitcher-tbd">${side} Pitcher TBD</div></div>`;
    const bf = parseInt(stat?.battersFaced)||1;
    const kpct = stat?.strikeOuts ? (parseInt(stat.strikeOuts)/bf*100).toFixed(1)+'%' : '—';
    const fip = calcFIP(stat) ?? '—';
    const hasStat = stat != null;
    return `<div class="pv-pitcher-card" data-pid="${pit.id}" onclick="openPlayerProfile(${pit.id},'${pit.fullName}',null)">
      <div class="pv-pitcher-left">
        <img class="pv-pitcher-hs" src="${HEADSHOT(pit.id)}" onerror="this.style.display='none'" />
        <div class="pv-pitcher-id">
          <div class="pv-pitcher-side">${side} STARTER</div>
          <div class="pv-pitcher-name">${pit.fullName || '—'}</div>
        </div>
      </div>
      <div class="pv-pitcher-right">
        ${hasStat ? `<div class="pv-pitcher-pills">
          <div class="pv-pit-pill"><div class="pv-pit-val">${fmtEra(stat)}</div><div class="pv-pit-lbl">ERA</div></div>
          <div class="pv-pit-pill"><div class="pv-pit-val">${fip}</div><div class="pv-pit-lbl">FIP</div></div>
          <div class="pv-pit-pill"><div class="pv-pit-val">${fmtWhip(stat)}</div><div class="pv-pit-lbl">WHIP</div></div>
          <div class="pv-pit-pill"><div class="pv-pit-val">${fmtWL(stat)}</div><div class="pv-pit-lbl">W-L</div></div>
          <div class="pv-pit-pill"><div class="pv-pit-val">${fmtK9(stat)}</div><div class="pv-pit-lbl">K/9</div></div>
          <div class="pv-pit-pill"><div class="pv-pit-val">${kpct}</div><div class="pv-pit-lbl">K%</div></div>
        </div>` : '<div class="pv-pit-no-stat">No season stats</div>'}
        ${sv ? `<div class="pv-pitcher-sv">
          <span class="pv-sv-item">${pctCell(sv,'fb_velo')} FB Velo${sv?.fb_velo_val != null ? ' '+sv.fb_velo_val.toFixed(1)+' mph' : ''}</span>
          <span class="pv-sv-item">${pctCell(sv,'whiff')} Whiff%</span>
          <span class="pv-sv-item">${pctCell(sv,'chase')} Chase%</span>
          <span class="pv-sv-item">${pctCell(sv,'k_pct')} K%</span>
          <span class="pv-sv-item">${pctCell(sv,'xera')} xERA</span>
        </div>` : ''}
      </div>
    </div>`;
  };

  // Lineup from boxRes
  const boxTeams  = boxRes?.teams;
  const awayOrder = boxTeams?.away?.battingOrder || [];
  const homeOrder = boxTeams?.home?.battingOrder || [];
  const awayRost  = boxTeams?.away?.players || {};
  const homeRost  = boxTeams?.home?.players || {};

  const lineupCol = (order, roster, abbr, pitId) => {
    if (!order.length) return `<div class="pv-lineup-tbd">Lineup TBD</div>`;
    return `<div class="pv-lineup-header">${abbr} Lineup</div>` +
      order.slice(0,9).map((id, i) => {
        const p   = roster[`ID${id}`]?.person;
        const s   = roster[`ID${id}`]?.seasonStats?.batting;
        const pos = roster[`ID${id}`]?.position?.abbreviation || '';
        const avg = s?.avg ? parseFloat(s.avg).toFixed(3).replace('0.','.') : '—';
        const ops = s?.ops ? parseFloat(s.ops).toFixed(3).replace('0.','.') : '—';
        const hr  = s?.homeRuns ?? '—';
        const rbi = s?.rbi ?? '—';
        const sb  = s?.stolenBases ?? '—';
        const pa  = s?.plateAppearances ?? '';
        return `<div class="pv-lineup-row" onclick="openPlayerProfile(${id},'${p?.fullName||''}',null)">
          <span class="pv-lineup-num">${i+1}</span>
          <img class="pv-lineup-hs" src="${HEADSHOT(id)}" onerror="this.style.display='none'" />
          <div class="pv-lineup-info">
            <span class="pv-lineup-name">${p?.fullName || '—'}</span>
            <span class="pv-lineup-pos">${pos}${pa ? ' · '+pa+' PA' : ''}</span>
          </div>
          <div class="pv-lineup-stats">
            <span class="pv-ls">${avg} / ${ops}</span>
            <span class="pv-ls">${hr} HR · ${rbi} RBI${sb !== '—' && sb > 0 ? ' · '+sb+' SB' : ''}</span>
          </div>
        </div>`;
      }).join('');
  };

  const startTime  = gd?.datetime?.dateTime;
  const timeStr    = startTime ? new Date(startTime).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZoneName:'short'}) : '';
  const weatherStr = weather?.condition ? `${weather.condition}${weather.temp?' · '+weather.temp+'°F':''}${weather.wind?' · '+weather.wind:''}` : '';
  const venueStr   = venue?.name ? venue.name : '';
  const awayLR  = away?.record?.leagueRecord || away?.leagueRecord;
  const homeLR  = home?.record?.leagueRecord || home?.leagueRecord;
  const awayRec = awayLR ? `${awayLR.wins}-${awayLR.losses}` : '';
  const homeRec = homeLR ? `${homeLR.wins}-${homeLR.losses}` : '';

  const fi = venue?.fieldInfo;
  const ballparkInfoHtml = fi ? `
    <div class="pv-bp-chips">
      ${fi.turfType  ? `<span class="pv-bp-chip">${fi.turfType}</span>`  : ''}
      ${fi.roofType  ? `<span class="pv-bp-chip">${fi.roofType} Roof</span>` : ''}
      ${fi.capacity  ? `<span class="pv-bp-chip">${fi.capacity.toLocaleString()} cap</span>` : ''}
    </div>
    <div class="pv-bp-dims">
      ${fi.leftLine  ? `<span class="pv-dim-chip">LF ${fi.leftLine}'</span>` : ''}
      ${fi.leftCenter? `<span class="pv-dim-chip">LC ${fi.leftCenter}'</span>` : ''}
      ${fi.center    ? `<span class="pv-dim-chip">CF ${fi.center}'</span>` : ''}
      ${fi.rightCenter?`<span class="pv-dim-chip">RC ${fi.rightCenter}'</span>` : ''}
      ${fi.rightLine ? `<span class="pv-dim-chip">RF ${fi.rightLine}'</span>` : ''}
    </div>` : '';

  const el = $('gd-preview-overview');
  if (!el) return;

  // Pregame win probability — Pythagorean model + pitcher ERA adjustment + home field
  const awayW = awayLR?.wins  ?? 0;
  const awayL = awayLR?.losses ?? 0;
  const homeW = homeLR?.wins  ?? 0;
  const homeL = homeLR?.losses ?? 0;
  {
    // Pythagorean win% (RS^1.83 / (RS^1.83 + RA^1.83)) — more accurate than raw W/L
    const pyth = (rs, ra) => {
      if (!rs || !ra) return null;
      const rsp = Math.pow(rs, 1.83), rap = Math.pow(ra, 1.83);
      return rsp / (rsp + rap);
    };
    let awayWP = pyth(awayBatTeam?.runs, awayPitTeam?.runs)
              ?? ((awayW + awayL > 0) ? awayW / (awayW + awayL) : 0.5);
    let homeWP = pyth(homeBatTeam?.runs, homePitTeam?.runs)
              ?? ((homeW + homeL > 0) ? homeW / (homeW + homeL) : 0.5);

    // Starter ERA adjustment: good/bad starter shifts prob ±5% max
    const lgERA = parseFloat(lgAvg?.lgERA) || 4.20;
    const pitAdj = (stat) => {
      const era = parseFloat(stat?.era);
      const ip  = parseFloat(stat?.inningsPitched) || 0;
      if (!era || ip < 10) return 0;
      return Math.max(-0.05, Math.min(0.05, (lgERA - era) / lgERA * 0.20));
    };
    awayWP = Math.max(0.05, Math.min(0.95, awayWP + pitAdj(awayPitStat)));
    homeWP = Math.max(0.05, Math.min(0.95, homeWP + pitAdj(homePitStat)));

    // Home field advantage (~53.5% for equal teams)
    homeWP = Math.min(0.95, homeWP * 1.04);
    awayWP = Math.min(0.95, awayWP);

    const homeProb = (homeWP * (1 - awayWP)) / (homeWP * (1 - awayWP) + awayWP * (1 - homeWP));
    const awayProb = 1 - homeProb;
    const awayPct = Math.round(awayProb * 100);
    const homePct = 100 - awayPct;
    const awayColor = TEAM_COLORS[away?.id] || '#4299e1';
    const homeColor = TEAM_COLORS[home?.id] || '#48bb78';
    var winProbHtml = `<div class="pv-winprob-wrap">
      <div class="pv-wp-label-row">
        <div class="pv-wp-side">
          <img class="pv-wp-logo" src="${TEAM_LOGO(away?.id)}" onerror="this.style.display='none'"/>
          <span class="pv-wp-abbr">${away?.abbreviation||'?'}</span>
          <span class="pv-wp-pct">${awayPct}%</span>
        </div>
        <div class="pv-wp-model-label">WIN PROBABILITY</div>
        <div class="pv-wp-side home">
          <img class="pv-wp-logo" src="${TEAM_LOGO(home?.id)}" onerror="this.style.display='none'"/>
          <span class="pv-wp-abbr">${home?.abbreviation||'?'}</span>
          <span class="pv-wp-pct">${homePct}%</span>
        </div>
      </div>
      <div class="pv-wp-splitbar">
        <div class="pv-wp-away-fill" style="width:${awayPct}%;background:${awayColor}"></div>
        <div class="pv-wp-home-fill" style="background:${homeColor}"></div>
        <div class="pv-wp-split-dot" style="left:${awayPct}%"></div>
      </div>
    </div>`;
  }

  el.innerHTML = `
    <div class="pv-combined-layout">

      <!-- LEFT: pitchers + lineups -->
      <div class="pv-left-col">
        <div class="pv-game-info">
          ${timeStr    ? `<span class="pv-info-chip">🕐 ${timeStr}</span>` : ''}
          ${weatherStr ? `<span class="pv-info-chip">🌤 ${weatherStr}</span>` : ''}
        </div>
        ${winProbHtml}
        <div class="pv-section-title">PROBABLE PITCHERS</div>
        <div class="pv-pitchers-col">
          ${pitcherCard(awayPit, awayPitStat, awayPitSv, 'AWAY')}
          ${pitcherCard(homePit, homePitStat, homePitSv, 'HOME')}
        </div>

        <div class="pv-section-title" style="margin-top:16px">EXPECTED LINEUPS</div>
        <div class="pv-lineups-split">
          <div class="pv-lineup-col">
            ${lineupCol(awayOrder, awayRost, away?.abbreviation||'AWAY', homePit?.id)}
          </div>
          <div class="pv-lineup-col">
            ${lineupCol(homeOrder, homeRost, home?.abbreviation||'HOME', awayPit?.id)}
          </div>
        </div>
        <div id="pv-recent-games"></div>
      </div>

      <!-- RIGHT: ballpark info + SVG -->
      <div class="pv-right-col">
        ${venueStr ? `<div class="pv-venue-name">🏟 ${venueStr}</div>` : ''}
        ${ballparkInfoHtml}
        <div class="pv-park-svg-wrap">
          ${renderBallparkFieldSVG(fi, venueStr)}
        </div>
      </div>

    </div>`;
}

function renderPreviewLineups(data, boxRes) {
  const el = $('gd-preview-lineups');
  if (!el) return;
  const gd   = data.gameData;
  const away = gd?.teams?.away;
  const home = gd?.teams?.home;

  const boxTeams   = boxRes?.teams;
  const awayBox    = boxTeams?.away;
  const homeBox    = boxTeams?.home;
  const awayOrder  = awayBox?.battingOrder || [];
  const homeOrder  = homeBox?.battingOrder || [];
  const awayRoster = awayBox?.players || {};
  const homeRoster = homeBox?.players || {};

  const lineupHtml = (order, roster, teamAbbr) => {
    if (!order.length) return `<div class="pv-lineup-tbd">Lineup TBD</div>`;
    return order.map((id, i) => {
      const p = roster[`ID${id}`]?.person;
      const s = roster[`ID${id}`]?.seasonStats?.batting;
      const pos = roster[`ID${id}`]?.position?.abbreviation || '';
      const avg = s?.avg ? parseFloat(s.avg).toFixed(3).replace('0.','.') : '—';
      const ops = s?.ops ? parseFloat(s.ops).toFixed(3).replace('0.','.') : '—';
      const hr  = s?.homeRuns ?? '—';
      return `<div class="pv-lineup-row" data-pid="${id}" onclick="openPlayerProfile(${id},'${p?.fullName||''}',null)">
        <span class="pv-lineup-num">${i+1}</span>
        <img class="pv-lineup-hs" src="${HEADSHOT(id)}" onerror="this.style.display='none'" />
        <div class="pv-lineup-info">
          <span class="pv-lineup-name">${p?.fullName || '—'}</span>
          <span class="pv-lineup-pos">${pos}</span>
        </div>
        <div class="pv-lineup-stats">
          <span class="pv-ls">${avg} AVG</span>
          <span class="pv-ls">${ops} OPS</span>
          <span class="pv-ls">${hr} HR</span>
        </div>
      </div>`;
    }).join('');
  };

  el.innerHTML = `
    <div class="pv-lineups-wrap">
      <div class="pv-lineup-col">
        <div class="pv-lineup-header">${away?.abbreviation || 'AWAY'}</div>
        ${lineupHtml(awayOrder, awayRoster, away?.abbreviation)}
      </div>
      <div class="pv-lineup-col">
        <div class="pv-lineup-header">${home?.abbreviation || 'HOME'}</div>
        ${lineupHtml(homeOrder, homeRoster, home?.abbreviation)}
      </div>
    </div>`;
}

async function renderPreviewMatchups(data, boxRes, awayPitStat, homePitStat, awayPitSv, homePitSv) {
  // Now renders into the H2H sidebar inside the team stats pane
  const el = $('pvt-h2h-sidebar');
  if (!el) return;
  const gd   = data.gameData;
  const away = gd?.teams?.away;
  const home = gd?.teams?.home;
  const awayPit = gd?.probablePitchers?.away;
  const homePit = gd?.probablePitchers?.home;

  const boxTeams  = boxRes?.teams;
  const awayOrder = boxTeams?.away?.battingOrder || [];
  const homeOrder = boxTeams?.home?.battingOrder || [];
  const awayRost  = boxTeams?.away?.players || {};
  const homeRost  = boxTeams?.home?.players || {};

  // Fetch H2H data for each batter vs opposing pitcher
  const fetchH2H = async (batterId, pitcherId) => {
    if (!batterId || !pitcherId) return null;
    return apiFetch(`${MLB_API}/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}`).catch(() => null);
  };

  el.innerHTML = '<div class="pv-section-title">HEAD-TO-HEAD</div><div class="loading-state" style="padding:16px 0"><div class="spinner"></div></div>';

  const awayH2H = await Promise.allSettled(awayOrder.slice(0,9).map(id => fetchH2H(id, homePit?.id)));
  const homeH2H = await Promise.allSettled(homeOrder.slice(0,9).map(id => fetchH2H(id, awayPit?.id)));

  const h2hRow = (id, roster, h2hRes, pitName) => {
    const p  = roster[`ID${id}`]?.person;
    const h2h = h2hRes?.value?.stats?.[0]?.splits?.[0]?.stat;
    const name = p?.fullName || '—';
    const lastName = name.split(' ').slice(-1)[0];
    const h2hAB  = h2h?.atBats  ?? null;
    const h2hH   = h2h?.hits    ?? null;
    const h2hHR  = h2h?.homeRuns ?? null;
    const h2hAvg = h2h?.avg ? parseFloat(h2h.avg).toFixed(3).replace('0.','.') : null;
    const hasData = h2hAB != null && parseInt(h2hAB) > 0;
    return `<div class="pv-h2h-sb-row" data-pid="${id}" onclick="openPlayerProfile(${id},'${name}',null)">
      <span class="pv-h2h-sb-name">${lastName}</span>
      <span class="pv-h2h-sb-val">${hasData ? `${h2hH}-${h2hAB}${h2hHR ? ' · '+h2hHR+' HR' : ''}${h2hAvg ? ' · '+h2hAvg : ''}` : 'No H2H data'}</span>
    </div>`;
  };

  const awaySection = awayOrder.length && homePit ? `
    <div class="pv-h2h-sb-section">
      <div class="pv-h2h-sb-header">${away?.abbreviation||'AWAY'} vs ${homePit.fullName?.split(' ').pop()||'?'}</div>
      ${awayOrder.slice(0,9).map((id,i) => h2hRow(id, awayRost, awayH2H[i], homePit?.fullName)).join('')}
    </div>` : '<div class="preview-empty">Away lineup TBD</div>';

  const homeSection = homeOrder.length && awayPit ? `
    <div class="pv-h2h-sb-section">
      <div class="pv-h2h-sb-header">${home?.abbreviation||'HOME'} vs ${awayPit.fullName?.split(' ').pop()||'?'}</div>
      ${homeOrder.slice(0,9).map((id,i) => h2hRow(id, homeRost, homeH2H[i], awayPit?.fullName)).join('')}
    </div>` : '<div class="preview-empty">Home lineup TBD</div>';

  el.innerHTML = `<div class="pv-section-title">HEAD-TO-HEAD</div><div class="pv-h2h-sb">${awaySection}${homeSection}</div>`;
}

function renderPreviewTeamStats(data, awayBat, homeBat, awayPit, homePit, lgAvg, allTeamsBat = [], allTeamsPit = [], seasonSeries = null, newsData = null) {
  const el = $('gd-preview-teamstats');
  if (!el) return;
  const gd   = data.gameData;
  const away = gd?.teams?.away;
  const home = gd?.teams?.home;
  const awayId = away?.id, homeId = home?.id;

  const fmtAvg = v => { const n = parseFloat(v); return isNaN(n) ? '—' : n.toFixed(3).replace('0.','.'); };
  const fmt2   = v => { const n = parseFloat(v); return isNaN(n) ? '—' : n.toFixed(2); };
  const fmt1   = v => { const n = parseFloat(v); return isNaN(n) ? '—' : n.toFixed(1); };
  const kpct   = s => s?.strikeOuts && s?.plateAppearances ? (parseInt(s.strikeOuts)/parseInt(s.plateAppearances)*100).toFixed(1)+'%' : '—';
  const rpg    = s => {
    const r = parseFloat(s?.runsPerGame ?? s?.runs);
    const g = parseFloat(s?.gamesPlayed);
    if (!isNaN(r) && s?.runsPerGame != null) return r.toFixed(2);
    if (!isNaN(r) && !isNaN(g) && g > 0) return (r/g).toFixed(2);
    return '—';
  };

  const rankColor = (rank, total) => {
    if (!rank || !total) return null;
    const t = (rank - 1) / Math.max(total - 1, 1); // 0=best (green), 1=worst (red)
    const h = Math.round(120 * (1 - t));            // hue: 120=green → 0=red
    return { fg: `hsl(${h},55%,62%)`, bg: `hsl(${h},55%,62%,0.15)` };
  };

  const teamStatRow = (label, awayVal, homeVal, awayPct, homePct, higherBetter=true, awayRank=null, homeRank=null) => {
    const aNum = parseFloat(awayVal), hNum = parseFloat(homeVal);
    const awayWins = !isNaN(aNum) && !isNaN(hNum) && (higherBetter ? aNum > hNum : aNum < hNum);
    const homeWins = !isNaN(aNum) && !isNaN(hNum) && (higherBetter ? hNum > aNum : hNum < aNum);
    const aw = Math.min(100, Math.max(0, Math.round(awayPct || 0)));
    const hw = Math.min(100, Math.max(0, Math.round(homePct || 0)));
    const awC = awayWins ? 'var(--accent-green)' : 'var(--accent-blue)';
    const hwC = homeWins ? 'var(--accent-green)' : 'var(--accent-blue)';
    const n = leagueSize || 30;
    const mkBadge = r => {
      if (!r) return '';
      const c = rankColor(r, n);
      return c ? `<span class="pvt-rank-badge" style="color:${c.fg};background:${c.bg}">#${r}</span>` : '';
    };
    return `<div class="pvt-row">
      <div class="pvt-away-bar">
        <div class="pvt-val-rank">
          <span class="pvt-val${awayWins?' pvt-winner':''}">${awayVal}</span>
          ${mkBadge(awayRank)}
        </div>
        ${awayPct != null ? `<div class="pvt-bar-wrap away"><div class="pvt-bar" style="width:${aw}%;background:${awC}"></div></div>` : ''}
      </div>
      <div class="pvt-label">${label}</div>
      <div class="pvt-home-bar">
        ${homePct != null ? `<div class="pvt-bar-wrap home"><div class="pvt-bar" style="width:${hw}%;background:${hwC}"></div></div>` : ''}
        <div class="pvt-val-rank">
          ${mkBadge(homeRank)}
          <span class="pvt-val${homeWins?' pvt-winner':''}">${homeVal}</span>
        </div>
      </div>
    </div>`;
  };

  const awayAbbr = away?.abbreviation||'AWAY', homeAbbr = home?.abbreviation||'HOME';
  const teamHeader = `<div class="pvt-header"><span>${awayAbbr}</span><span></span><span>${homeAbbr}</span></div>`;

  const bbpct  = s => s?.plateAppearances&&s?.baseOnBalls ? (parseInt(s.baseOnBalls)/parseInt(s.plateAppearances)*100).toFixed(1)+'%':'—';
  const iso    = s => { const slg=parseFloat(s?.slg), avg=parseFloat(s?.avg); return (!isNaN(slg)&&!isNaN(avg)) ? (slg-avg).toFixed(3).replace('0.','.') : '—'; };
  const hpg    = s => { const h=parseInt(s?.hits),g=parseInt(s?.gamesPlayed); return (h&&g) ? (h/g).toFixed(2):'—'; };
  const kipct  = ap => ap?.strikeOuts&&ap?.battersFaced ? (parseInt(ap.strikeOuts)/parseInt(ap.battersFaced)*100).toFixed(1)+'%':'—';
  const bbipct = ap => ap?.baseOnBalls&&ap?.battersFaced ? (parseInt(ap.baseOnBalls)/parseInt(ap.battersFaced)*100).toFixed(1)+'%':'—';
  const fipRow = (ap,hp) => {
    const af=calcFIP(ap), hf=calcFIP(hp);
    if (!af && !hf) return '';
    const aFipPct = af ? leaderPct(af, allTeamsPit, s=>{ const v=calcFIP(s); return v?parseFloat(v):null; }, false) : null;
    const hFipPct = hf ? leaderPct(hf, allTeamsPit, s=>{ const v=calcFIP(s); return v?parseFloat(v):null; }, false) : null;
    const aFipRk  = af ? rankOf(allTeamsPit, awayId, s=>{ const v=calcFIP(s); return v?parseFloat(v):null; }, false) : null;
    const hFipRk  = hf ? rankOf(allTeamsPit, homeId, s=>{ const v=calcFIP(s); return v?parseFloat(v):null; }, false) : null;
    return teamStatRow('FIP', af??'—', hf??'—', aFipPct, hFipPct, false, aFipRk, hFipRk);
  };

  // ── League-leader bar scaling ──
  // For each stat, bar fills to (teamVal / leagueLeader) * 100%
  // For lower-is-better stats, bar fills to (leagueLeader / teamVal) * 100%
  const leaderPct = (rawVal, splits, getter, higherBetter = true) => {
    const v = parseFloat(rawVal);
    if (isNaN(v) || v <= 0) return null;
    const vals = splits.map(sp => parseFloat(getter(sp.stat))).filter(x => !isNaN(x) && x > 0);
    if (!vals.length) return null;
    const leader = higherBetter ? Math.max(...vals) : Math.min(...vals);
    if (!leader || leader === 0) return null;
    return Math.min(100, higherBetter ? (v / leader) * 100 : (leader / v) * 100);
  };

  // ── League ranking helpers ──
  // allTeamsBat/allTeamsPit are arrays of {team:{id}, stat:{...}}
  const leagueSize = allTeamsBat.length || 30;
  const rankOf = (splits, teamId, getter, higherBetter = true) => {
    if (!splits.length || !teamId) return null;
    const vals = splits
      .map(sp => ({ id: sp.team?.id, v: parseFloat(getter(sp.stat)) }))
      .filter(x => !isNaN(x.v));
    if (!vals.length) return null;
    vals.sort((a,b) => higherBetter ? b.v - a.v : a.v - b.v);
    const idx = vals.findIndex(x => x.id === teamId);
    return idx >= 0 ? idx + 1 : null;
  };
  const rankBadge = (rank, total) => {
    if (!rank) return '';
    const tier = rank <= 5 ? 'rank-top' : rank >= total - 4 ? 'rank-bot' : 'rank-mid';
    return `<span class="pvts-rank ${tier}">#${rank}</span>`;
  };

  // Center column stat row: shows both teams' value + rank
  const totRow = (label, awayVal, homeVal, awayRank, homeRank) => {
    const n = leagueSize || 30;
    return `<div class="pvtc-row">
      <div class="pvtc-team-col away-col">
        <span class="pvtc-val">${awayVal}</span>
        ${rankBadge(awayRank, n)}
      </div>
      <div class="pvtc-label">${label}</div>
      <div class="pvtc-team-col home-col">
        <span class="pvtc-val">${homeVal}</span>
        ${rankBadge(homeRank, n)}
      </div>
    </div>`;
  };

  const battingHtml = (awayBat && homeBat) ? `
    <div class="pv-section-title">TEAM BATTING</div>${teamHeader}
    <div class="pvt-table">
      ${teamStatRow('AVG',  fmtAvg(awayBat?.avg), fmtAvg(homeBat?.avg),
          leaderPct(awayBat?.avg, allTeamsBat, s=>s?.avg),
          leaderPct(homeBat?.avg, allTeamsBat, s=>s?.avg), true,
          rankOf(allTeamsBat, awayId, s=>s?.avg),
          rankOf(allTeamsBat, homeId, s=>s?.avg))}
      ${teamStatRow('OBP',  fmtAvg(awayBat?.obp), fmtAvg(homeBat?.obp),
          leaderPct(awayBat?.obp, allTeamsBat, s=>s?.obp),
          leaderPct(homeBat?.obp, allTeamsBat, s=>s?.obp), true,
          rankOf(allTeamsBat, awayId, s=>s?.obp),
          rankOf(allTeamsBat, homeId, s=>s?.obp))}
      ${teamStatRow('SLG',  fmtAvg(awayBat?.slg), fmtAvg(homeBat?.slg),
          leaderPct(awayBat?.slg, allTeamsBat, s=>s?.slg),
          leaderPct(homeBat?.slg, allTeamsBat, s=>s?.slg), true,
          rankOf(allTeamsBat, awayId, s=>s?.slg),
          rankOf(allTeamsBat, homeId, s=>s?.slg))}
      ${teamStatRow('OPS',  fmtAvg(awayBat?.ops), fmtAvg(homeBat?.ops),
          leaderPct(awayBat?.ops, allTeamsBat, s=>s?.ops),
          leaderPct(homeBat?.ops, allTeamsBat, s=>s?.ops), true,
          rankOf(allTeamsBat, awayId, s=>s?.ops),
          rankOf(allTeamsBat, homeId, s=>s?.ops))}
      ${teamStatRow('ISO',  iso(awayBat), iso(homeBat),
          leaderPct(iso(awayBat), allTeamsBat, s=>{ const sl=parseFloat(s?.slg),av=parseFloat(s?.avg); return (!isNaN(sl)&&!isNaN(av))?sl-av:null; }),
          leaderPct(iso(homeBat), allTeamsBat, s=>{ const sl=parseFloat(s?.slg),av=parseFloat(s?.avg); return (!isNaN(sl)&&!isNaN(av))?sl-av:null; }), true,
          rankOf(allTeamsBat, awayId, s=>{ const sl=parseFloat(s?.slg),av=parseFloat(s?.avg); return (!isNaN(sl)&&!isNaN(av))?sl-av:null; }),
          rankOf(allTeamsBat, homeId, s=>{ const sl=parseFloat(s?.slg),av=parseFloat(s?.avg); return (!isNaN(sl)&&!isNaN(av))?sl-av:null; }))}
      ${teamStatRow('HR',   awayBat?.homeRuns??'—', homeBat?.homeRuns??'—',
          leaderPct(awayBat?.homeRuns, allTeamsBat, s=>s?.homeRuns),
          leaderPct(homeBat?.homeRuns, allTeamsBat, s=>s?.homeRuns), true,
          rankOf(allTeamsBat, awayId, s=>s?.homeRuns),
          rankOf(allTeamsBat, homeId, s=>s?.homeRuns))}
      ${teamStatRow('SB',   awayBat?.stolenBases??'—', homeBat?.stolenBases??'—',
          leaderPct(awayBat?.stolenBases, allTeamsBat, s=>s?.stolenBases),
          leaderPct(homeBat?.stolenBases, allTeamsBat, s=>s?.stolenBases), true,
          rankOf(allTeamsBat, awayId, s=>s?.stolenBases),
          rankOf(allTeamsBat, homeId, s=>s?.stolenBases))}
      ${teamStatRow('K%',   kpct(awayBat), kpct(homeBat),
          leaderPct(kpct(awayBat), allTeamsBat, s=>s?.strikeOuts&&s?.plateAppearances?parseInt(s.strikeOuts)/parseInt(s.plateAppearances)*100:0, false),
          leaderPct(kpct(homeBat), allTeamsBat, s=>s?.strikeOuts&&s?.plateAppearances?parseInt(s.strikeOuts)/parseInt(s.plateAppearances)*100:0, false), false,
          rankOf(allTeamsBat, awayId, s=>s?.strikeOuts&&s?.plateAppearances?parseInt(s.strikeOuts)/parseInt(s.plateAppearances):0, false),
          rankOf(allTeamsBat, homeId, s=>s?.strikeOuts&&s?.plateAppearances?parseInt(s.strikeOuts)/parseInt(s.plateAppearances):0, false))}
      ${teamStatRow('BB%',  bbpct(awayBat), bbpct(homeBat),
          leaderPct(bbpct(awayBat), allTeamsBat, s=>s?.baseOnBalls&&s?.plateAppearances?parseInt(s.baseOnBalls)/parseInt(s.plateAppearances)*100:0),
          leaderPct(bbpct(homeBat), allTeamsBat, s=>s?.baseOnBalls&&s?.plateAppearances?parseInt(s.baseOnBalls)/parseInt(s.plateAppearances)*100:0), true,
          rankOf(allTeamsBat, awayId, s=>s?.baseOnBalls&&s?.plateAppearances?parseInt(s.baseOnBalls)/parseInt(s.plateAppearances):0),
          rankOf(allTeamsBat, homeId, s=>s?.baseOnBalls&&s?.plateAppearances?parseInt(s.baseOnBalls)/parseInt(s.plateAppearances):0))}
      ${teamStatRow('R/G',  rpg(awayBat), rpg(homeBat),
          leaderPct(rpg(awayBat), allTeamsBat, s=>s?.runs&&s?.gamesPlayed?parseInt(s.runs)/parseInt(s.gamesPlayed):0),
          leaderPct(rpg(homeBat), allTeamsBat, s=>s?.runs&&s?.gamesPlayed?parseInt(s.runs)/parseInt(s.gamesPlayed):0), true,
          rankOf(allTeamsBat, awayId, s=>s?.runs&&s?.gamesPlayed?parseInt(s.runs)/parseInt(s.gamesPlayed):0),
          rankOf(allTeamsBat, homeId, s=>s?.runs&&s?.gamesPlayed?parseInt(s.runs)/parseInt(s.gamesPlayed):0))}
    </div>` : '';

  const pitchingHtml = (awayPit && homePit) ? `
    <div class="pv-section-title">TEAM PITCHING</div>${teamHeader}
    <div class="pvt-table">
      ${teamStatRow('ERA',  fmt2(awayPit?.era), fmt2(homePit?.era),
          leaderPct(awayPit?.era, allTeamsPit, s=>s?.era, false),
          leaderPct(homePit?.era, allTeamsPit, s=>s?.era, false), false,
          rankOf(allTeamsPit, awayId, s=>s?.era, false),
          rankOf(allTeamsPit, homeId, s=>s?.era, false))}
      ${fipRow(awayPit, homePit)}
      ${teamStatRow('WHIP', fmt2(awayPit?.whip), fmt2(homePit?.whip),
          leaderPct(awayPit?.whip, allTeamsPit, s=>s?.whip, false),
          leaderPct(homePit?.whip, allTeamsPit, s=>s?.whip, false), false,
          rankOf(allTeamsPit, awayId, s=>s?.whip, false),
          rankOf(allTeamsPit, homeId, s=>s?.whip, false))}
      ${teamStatRow('K/9',  fmt1(awayPit?.strikeoutsPer9Inn), fmt1(homePit?.strikeoutsPer9Inn),
          leaderPct(awayPit?.strikeoutsPer9Inn, allTeamsPit, s=>s?.strikeoutsPer9Inn),
          leaderPct(homePit?.strikeoutsPer9Inn, allTeamsPit, s=>s?.strikeoutsPer9Inn), true,
          rankOf(allTeamsPit, awayId, s=>s?.strikeoutsPer9Inn),
          rankOf(allTeamsPit, homeId, s=>s?.strikeoutsPer9Inn))}
      ${teamStatRow('BB/9', fmt1(awayPit?.walksPer9Inn), fmt1(homePit?.walksPer9Inn),
          leaderPct(awayPit?.walksPer9Inn, allTeamsPit, s=>s?.walksPer9Inn, false),
          leaderPct(homePit?.walksPer9Inn, allTeamsPit, s=>s?.walksPer9Inn, false), false,
          rankOf(allTeamsPit, awayId, s=>s?.walksPer9Inn, false),
          rankOf(allTeamsPit, homeId, s=>s?.walksPer9Inn, false))}
      ${teamStatRow('K%',   kipct(awayPit), kipct(homePit),
          leaderPct(kipct(awayPit), allTeamsPit, s=>s?.strikeOuts&&s?.battersFaced?parseInt(s.strikeOuts)/parseInt(s.battersFaced)*100:0),
          leaderPct(kipct(homePit), allTeamsPit, s=>s?.strikeOuts&&s?.battersFaced?parseInt(s.strikeOuts)/parseInt(s.battersFaced)*100:0), true,
          rankOf(allTeamsPit, awayId, s=>s?.strikeOuts&&s?.battersFaced?parseInt(s.strikeOuts)/parseInt(s.battersFaced):0),
          rankOf(allTeamsPit, homeId, s=>s?.strikeOuts&&s?.battersFaced?parseInt(s.strikeOuts)/parseInt(s.battersFaced):0))}
      ${teamStatRow('BB%',  bbipct(awayPit), bbipct(homePit),
          leaderPct(bbipct(awayPit), allTeamsPit, s=>s?.baseOnBalls&&s?.battersFaced?parseInt(s.baseOnBalls)/parseInt(s.battersFaced)*100:0, false),
          leaderPct(bbipct(homePit), allTeamsPit, s=>s?.baseOnBalls&&s?.battersFaced?parseInt(s.baseOnBalls)/parseInt(s.battersFaced)*100:0, false), false,
          rankOf(allTeamsPit, awayId, s=>s?.baseOnBalls&&s?.battersFaced?parseInt(s.baseOnBalls)/parseInt(s.battersFaced):0, false),
          rankOf(allTeamsPit, homeId, s=>s?.baseOnBalls&&s?.battersFaced?parseInt(s.baseOnBalls)/parseInt(s.battersFaced):0, false))}
      ${teamStatRow('HR/9', fmt2(awayPit?.homeRunsPer9), fmt2(homePit?.homeRunsPer9),
          leaderPct(awayPit?.homeRunsPer9, allTeamsPit, s=>s?.homeRunsPer9, false),
          leaderPct(homePit?.homeRunsPer9, allTeamsPit, s=>s?.homeRunsPer9, false), false,
          rankOf(allTeamsPit, awayId, s=>s?.homeRunsPer9, false),
          rankOf(allTeamsPit, homeId, s=>s?.homeRunsPer9, false))}
      ${teamStatRow('SHO',  awayPit?.shutouts??'—', homePit?.shutouts??'—', null, null)}
      ${teamStatRow('SV',   awayPit?.saves??'—', homePit?.saves??'—', null, null)}
    </div>` : '';

  // ── Center column: per-team stat cards (two columns, one per team) ──
  const rankTier = (rank, total = 30) => {
    if (!rank) return 'rank-mid';
    return rank <= 5 ? 'rank-top' : rank >= total - 4 ? 'rank-bot' : 'rank-mid';
  };
  const teamStatCard = (label, val, rank) => {
    const n = leagueSize || 30;
    const tierClass = rankTier(rank, n);
    const rankHtml = rank ? `<span class="pvts-stat-rank ${tierClass}">#${rank}</span>` : '';
    return `<div class="pvts-stat-card">
      <div class="pvts-stat-label">${label}</div>
      <div class="pvts-stat-val-row">
        <span class="pvts-stat-val">${val}</span>
        ${rankHtml}
      </div>
    </div>`;
  };
  const kipct2 = ap => ap?.strikeOuts&&ap?.battersFaced ? (parseInt(ap.strikeOuts)/parseInt(ap.battersFaced)*100).toFixed(1)+'%':'—';

  const buildTeamPanel = (isAway) => {
    const bat = isAway ? awayBat : homeBat;
    const pit = isAway ? awayPit : homePit;
    const tid = isAway ? awayId  : homeId;
    const lgo = TEAM_LOGO(tid);
    const abb = isAway ? awayAbbr : homeAbbr;
    const batCards = bat ? `
      <div class="pvts-group-title">BATTING</div>
      ${teamStatCard('OPS',  fmtAvg(bat?.ops),     rankOf(allTeamsBat, tid, s=>s?.ops))}
      ${teamStatCard('AVG',  fmtAvg(bat?.avg),     rankOf(allTeamsBat, tid, s=>s?.avg))}
      ${teamStatCard('OBP',  fmtAvg(bat?.obp),     rankOf(allTeamsBat, tid, s=>s?.obp))}
      ${teamStatCard('SLG',  fmtAvg(bat?.slg),     rankOf(allTeamsBat, tid, s=>s?.slg))}
      ${teamStatCard('HR',   bat?.homeRuns??'—',   rankOf(allTeamsBat, tid, s=>s?.homeRuns))}
      ${teamStatCard('R/G',  rpg(bat),             rankOf(allTeamsBat, tid, s=>parseFloat(s?.runsPerGame??0)||0))}
      ${teamStatCard('K%',   kpct(bat),            rankOf(allTeamsBat, tid, s=>s?.strikeOuts&&s?.plateAppearances?parseInt(s.strikeOuts)/parseInt(s.plateAppearances):0, false))}
      ${teamStatCard('BB%',  bbpct(bat),           rankOf(allTeamsBat, tid, s=>s?.baseOnBalls&&s?.plateAppearances?parseInt(s.baseOnBalls)/parseInt(s.plateAppearances):0))}` : '';
    const pitCards = pit ? `
      <div class="pvts-group-title">PITCHING</div>
      ${teamStatCard('ERA',  fmt2(pit?.era),               rankOf(allTeamsPit, tid, s=>s?.era, false))}
      ${teamStatCard('WHIP', fmt2(pit?.whip),              rankOf(allTeamsPit, tid, s=>s?.whip, false))}
      ${teamStatCard('K/9',  fmt1(pit?.strikeoutsPer9Inn), rankOf(allTeamsPit, tid, s=>s?.strikeoutsPer9Inn))}
      ${teamStatCard('FIP',  calcFIP(pit)??'—',            null)}
      ${teamStatCard('HR/9', fmt2(pit?.homeRunsPer9),      rankOf(allTeamsPit, tid, s=>s?.homeRunsPer9, false))}
      ${teamStatCard('BB/9', fmt1(pit?.walksPer9Inn),      rankOf(allTeamsPit, tid, s=>s?.walksPer9Inn, false))}
      ${teamStatCard('K%',   kipct2(pit),                  rankOf(allTeamsPit, tid, s=>s?.strikeOuts&&s?.battersFaced?parseInt(s.strikeOuts)/parseInt(s.battersFaced):0))}
      ${teamStatCard('SV',   pit?.saves??'—',              rankOf(allTeamsPit, tid, s=>s?.saves))}` : '';
    return `<div class="pvts-team-panel">
      <div class="pvts-team-header">
        <img src="${lgo}" onerror="this.style.display='none'"/>
        <div class="pvts-team-header-abbr">${abb}</div>
      </div>
      ${batCards}
      ${pitCards}
    </div>`;
  };

  // ── New combined left column: logos + stat pills with rankings ──
  const statPill = (label, val, rank) => {
    const n = leagueSize || 30;
    const tier = !rank ? '' : rank <= 5 ? 'rank-top' : rank >= n - 4 ? 'rank-bot' : 'rank-mid';
    const badge = rank ? `<span class="pvts-pill-rank ${tier}">#${rank}</span>` : '';
    return `<div class="pvts-pill"><span class="pvts-pill-lbl">${label}</span><span class="pvts-pill-val">${val}</span>${badge}</div>`;
  };

  const buildTeamSide = (isAway) => {
    const bat = isAway ? awayBat : homeBat;
    const pit = isAway ? awayPit : homePit;
    const tid = isAway ? awayId  : homeId;
    const abb = isAway ? (away?.abbreviation||'AWAY') : (home?.abbreviation||'HOME');
    const rec = isAway
      ? (away?.record?.leagueRecord || away?.leagueRecord)
      : (home?.record?.leagueRecord || home?.leagueRecord);
    const recStr = rec ? `${rec.wins}-${rec.losses}` : '';

    const batPills = bat ? `
      <div class="pvts-side-group">BATTING</div>
      ${statPill('OPS',  fmtAvg(bat.ops),  rankOf(allTeamsBat, tid, s=>s?.ops))}
      ${statPill('AVG',  fmtAvg(bat.avg),  rankOf(allTeamsBat, tid, s=>s?.avg))}
      ${statPill('OBP',  fmtAvg(bat.obp),  rankOf(allTeamsBat, tid, s=>s?.obp))}
      ${statPill('SLG',  fmtAvg(bat.slg),  rankOf(allTeamsBat, tid, s=>s?.slg))}
      ${statPill('HR',   bat.homeRuns??'—', rankOf(allTeamsBat, tid, s=>s?.homeRuns))}
      ${statPill('R/G',  rpg(bat),          rankOf(allTeamsBat, tid, s=>parseFloat(s?.runsPerGame||0)||0))}
      ${statPill('K%',   kpct(bat),         rankOf(allTeamsBat, tid, s=>s?.strikeOuts&&s?.plateAppearances?parseInt(s.strikeOuts)/parseInt(s.plateAppearances):0, false))}
      ${statPill('BB%',  bbpct(bat),        rankOf(allTeamsBat, tid, s=>s?.baseOnBalls&&s?.plateAppearances?parseInt(s.baseOnBalls)/parseInt(s.plateAppearances):0))}` : '';
    const pitPills = pit ? `
      <div class="pvts-side-group">PITCHING</div>
      ${statPill('ERA',  fmt2(pit.era),               rankOf(allTeamsPit, tid, s=>s?.era, false))}
      ${statPill('WHIP', fmt2(pit.whip),              rankOf(allTeamsPit, tid, s=>s?.whip, false))}
      ${statPill('K/9',  fmt1(pit.strikeoutsPer9Inn), rankOf(allTeamsPit, tid, s=>s?.strikeoutsPer9Inn))}
      ${statPill('FIP',  calcFIP(pit)??'—',           null)}
      ${statPill('K%',   kipct2(pit),                  rankOf(allTeamsPit, tid, s=>s?.strikeOuts&&s?.battersFaced?parseInt(s.strikeOuts)/parseInt(s.battersFaced):0))}
      ${statPill('BB/9', fmt1(pit.walksPer9Inn),      rankOf(allTeamsPit, tid, s=>s?.walksPer9Inn, false))}
      ${statPill('HR/9', fmt2(pit.homeRunsPer9),      rankOf(allTeamsPit, tid, s=>s?.homeRunsPer9, false))}
      ${statPill('SV',   pit.saves??'—',              rankOf(allTeamsPit, tid, s=>s?.saves))}` : '';

    if (!batPills && !pitPills) return `<div class="pvts-team-side">
      <div class="pvts-side-hdr">
        <img src="${TEAM_LOGO(tid)}" onerror="this.style.display='none'"/>
        <div>
          <div class="pvts-side-abbr">${abb}</div>
          ${recStr ? `<div class="pvts-side-rec">${recStr}</div>` : ''}
        </div>
      </div>
      <div class="preview-empty" style="padding:12px 0 0">Stats loading…</div>
    </div>`;

    return `<div class="pvts-team-side">
      <div class="pvts-side-hdr">
        <img src="${TEAM_LOGO(tid)}" onerror="this.style.display='none'"/>
        <div>
          <div class="pvts-side-abbr">${abb}</div>
          ${recStr ? `<div class="pvts-side-rec">${recStr}</div>` : ''}
        </div>
      </div>
      ${batPills}${pitPills}
    </div>`;
  };

  const teamsColHtml = `<div class="pvts-teams-split">
    ${buildTeamSide(true)}
    <div class="pvts-side-divider"></div>
    ${buildTeamSide(false)}
  </div>`;

  // ── Middle column: season series + news ──
  let seriesHtml = '';
  if (seasonSeries) {
    const allGames  = (seasonSeries.dates || []).flatMap(d => d.games || []);
    const completed = allGames.filter(g => g.status?.abstractGameState === 'Final');
    let awayW = 0, homeW = 0;
    const recentRows = completed.slice(-5).reverse().map(g => {
      const aTeam = g.teams?.away, hTeam = g.teams?.home;
      const aScore = aTeam?.score ?? '?', hScore = hTeam?.score ?? '?';
      const aAbbr  = aTeam?.team?.abbreviation || '?', hAbbr = hTeam?.team?.abbreviation || '?';
      const aId = aTeam?.team?.id;
      const aWon = parseInt(aScore) > parseInt(hScore);
      if (aId === awayId) { if (aWon) awayW++; else homeW++; }
      else { if (!aWon) awayW++; else homeW++; }
      const date = g.officialDate ? new Date(g.officialDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '';
      return `<div class="pvts-series-row">
        <span class="pvts-series-date">${date}</span>
        <span class="pvts-series-score">${aAbbr} ${aScore}, ${hAbbr} ${hScore}</span>
      </div>`;
    }).join('');
    // Re-count from scratch for accuracy
    awayW = 0; homeW = 0;
    completed.forEach(g => {
      const aId = g.teams?.away?.team?.id;
      const aScore = parseInt(g.teams?.away?.score??0), hScore = parseInt(g.teams?.home?.score??0);
      if (aId === awayId) { if (aScore > hScore) awayW++; else homeW++; }
      else { if (hScore > aScore) awayW++; else homeW++; }
    });
    const awayAbbr = away?.abbreviation||'AWAY', homeAbbr = home?.abbreviation||'HOME';
    const noGames = completed.length === 0;
    seriesHtml = `
      <div class="pv-section-title">${CUR_SEASON} SERIES</div>
      ${noGames
        ? `<div class="pvts-series-nodata">No prior meetings this season</div>`
        : `<div class="pvts-series-record">
            <span class="pvts-rec-team ${awayW > homeW ? 'pvts-rec-lead':''}">${awayAbbr} ${awayW}</span>
            <span class="pvts-rec-dash">–</span>
            <span class="pvts-rec-team ${homeW > awayW ? 'pvts-rec-lead':''}">${homeW} ${homeAbbr}</span>
          </div>
          <div class="pvts-series-list">${recentRows}</div>`
      }`;
  }

  let newsHtml = '';
  const articles = newsData?.articles || [];
  if (articles.length) {
    newsHtml = `
      <div class="pv-section-title" style="margin-top:14px">PREVIEW &amp; NEWS</div>
      <div class="pvts-news-list">
        ${articles.map(a => `
          <a class="pvts-news-item" href="${a.url}" target="_blank" rel="noopener">
            <div class="pvts-news-title">${a.title}</div>
            <div class="pvts-news-meta">${a.source}${a.pubDate ? ' · ' + new Date(a.pubDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : ''}</div>
          </a>`).join('')}
      </div>`;
  }

  const storylinesHtml = (seriesHtml || newsHtml)
    ? `<div class="pvts-storylines">${seriesHtml}${newsHtml}</div>`
    : '<div class="pvts-storylines"><div class="preview-empty" style="padding:20px 0">Loading storylines…</div></div>';

  el.innerHTML = `<div class="pvts-layout">
    <div class="pvts-middle">
      ${storylinesHtml}
    </div>
    <div class="pvts-stats">
      <div class="pvt-wrap">
        ${battingHtml}
        ${pitchingHtml}
        ${!battingHtml && !pitchingHtml ? '<div class="preview-empty" style="padding:20px">Team stats loading…</div>' : ''}
      </div>
    </div>
    <div class="pvts-sidebar" id="pvt-h2h-sidebar">
      <div class="pv-section-title">HEAD-TO-HEAD</div>
      <div class="loading-state" style="padding:16px 0"><div class="spinner"></div></div>
    </div>
  </div>`;
}

function renderGdHeader(data) {
  const ls  = data.liveData?.linescore;
  const gd  = data.gameData;
  if (!ls) return;

  $('gd-away-score').textContent = ls.teams?.away?.runs ?? '0';
  $('gd-home-score').textContent = ls.teams?.home?.runs ?? '0';

  const awayId = gd?.teams?.away?.id;
  const homeId = gd?.teams?.home?.id;
  if (awayId) { const l=$('gd-away-logo'); if (!l.src.includes(awayId)) { l.src=TEAM_LOGO(awayId); l.onerror=()=>l.style.display='none'; } }
  if (homeId) { const l=$('gd-home-logo'); if (!l.src.includes(homeId)) { l.src=TEAM_LOGO(homeId); l.onerror=()=>l.style.display='none'; } }

  $('gd-away-abbr').textContent = gd?.teams?.away?.abbreviation || $('gd-away-abbr').textContent;
  $('gd-home-abbr').textContent = gd?.teams?.home?.abbreviation || $('gd-home-abbr').textContent;

  const abs = gd?.status?.abstractGameState || '';
  const det = gd?.status?.detailedState || '';
  let statusLabel='PREVIEW', statusCls='pre';
  if (abs==='Live')  { statusLabel='LIVE';  statusCls='live';  }
  if (abs==='Final') { statusLabel='FINAL'; statusCls='final'; }
  if (/delay|postpone/i.test(det)) { statusLabel=det.substring(0,8).toUpperCase(); statusCls='delay'; }

  const badge=$('gd-status-badge'); badge.textContent=statusLabel; badge.className=`game-status ${statusCls}`;

  const inn = ls.currentInning;
  $('gd-inning-display').textContent = inn ? `${ls.inningHalf==='Top'?'▲':'▼'}${inn}` : '';
  const isLiveGame = abs === 'Live';
  $('gd-live-chip').classList.toggle('hidden', !isLiveGame);
  const watchBtn2 = $('gd-watch-btn');
  if (watchBtn2) {
    watchBtn2.classList.toggle('hidden', !isLiveGame);
    if (isLiveGame && state.selectedGamePk) watchBtn2.href = `https://www.mlb.com/gameday/${state.selectedGamePk}`;
  }
}

// ── Live Tab ───────────────────────────────────────────────────
function setGdLiveLoading() {
  $('gd-play-desc').textContent    = 'Loading…';
  $('gd-zone-label').textContent   = '—';
  $('gd-batter-name').textContent  = '—';
  $('gd-pitcher-name').textContent = '—';
  $('gd-batter-meta').textContent  = '';
  $('gd-pitcher-card-meta').textContent = '';
  $('gd-batter-savant').innerHTML  = '';
  $('gd-pitcher-savant').innerHTML = '';
  if ($('gd-matchup-history')) $('gd-matchup-history').innerHTML = '';
  if ($('gd-atbat-desc'))   $('gd-atbat-desc').textContent = '';
  if ($('gd-atbat-events')) $('gd-atbat-events').innerHTML = '';
  $('pitch-seq-list').innerHTML    = '';
  $('pitch-legend').innerHTML      = '';
  $('gd-plays-list').innerHTML     = '';
  $('pitch-dots').innerHTML        = '';
  updateCountDisplay(0,0,0);
  updateBases({});
}

function renderGdLive(data) {
  const ls      = data.liveData?.linescore;
  const plays   = data.liveData?.plays;
  const current = plays?.currentPlay;
  const all     = plays?.allPlays || [];
  const gd      = data.gameData;

  if (!current) {
    $('gd-play-desc').textContent = gd?.status?.detailedState || 'Game not yet started';
    $('gd-zone-label').innerHTML  = 'No game data';
    renderFullPitchZone([], 3.4, 1.5, 0);
    updateCountDisplay(0,0,0);
    updateBases({});
    return;
  }

  // Play description: keep last AB result visible until first pitch of new AB
  const currentAbIdx = current.about?.atBatIndex ?? -1;
  const curPitches   = (current.playEvents || []).filter(e => e.type === 'pitch');
  if (currentAbIdx !== state.lastAbIdx) {
    // New at-bat started — save the last completed AB result
    const lastCompleted = all.slice(0, -1).reverse().find(p => p.result?.description || p.result?.event);
    if (lastCompleted) state.lastPlayResult = lastCompleted.result?.description || lastCompleted.result?.event;
    state.lastAbIdx = currentAbIdx;
  }
  // Show current desc if pitches have been thrown; otherwise show last result
  const playDescEl = $('gd-play-desc');
  if (curPitches.length > 0 || !state.lastPlayResult) {
    playDescEl.textContent = current.result?.description || current.result?.event || '—';
  } else {
    playDescEl.textContent = state.lastPlayResult;
  }

  // Matchup
  const batterId  = current.matchup?.batter?.id;
  const pitcherId = current.matchup?.pitcher?.id;
  const bName = current.matchup?.batter?.fullName  || '—';
  const pName = current.matchup?.pitcher?.fullName || '—';
  $('gd-batter-name').textContent  = bName;
  $('gd-pitcher-name').textContent = pName;
  $('gd-batter-meta').textContent  = current.matchup?.batSide?.code   ? `Bats ${current.matchup.batSide.code}`   : '';
  $('gd-pitcher-card-meta').textContent = current.matchup?.pitchHand?.code ? `Throws ${current.matchup.pitchHand.code}` : '';

  if (batterId)  { $('gd-batter-hs').src  = HEADSHOT(batterId);  $('gd-batter-hs').onerror  = ()=>{}; }
  if (pitcherId) { $('gd-pitcher-hs').src = HEADSHOT(pitcherId); $('gd-pitcher-hs').onerror = ()=>{}; }

  // Click whole card to open player profile (but NOT through the count/bar areas)
  $('gd-batter-card').onclick  = batterId  ? ()=>openPlayerProfile(batterId,  bName, state.selectedGamePk) : null;
  $('gd-pitcher-card').onclick = pitcherId ? ()=>openPlayerProfile(pitcherId, pName, state.selectedGamePk) : null;

  // Pitcher pitch count from boxscore
  const pc = getPitcherPitchCount(data, pitcherId);
  $('gd-pitcher-name-label').textContent = pName;
  $('gd-pitch-count-label').textContent  = pc ? `${pc}P` : '';

  // Count / outs / bases
  const count = current.count || {};
  updateCountDisplay(count.balls||0, count.strikes||0, count.outs||0);
  updateBases(ls?.offense || {});

  // ── Pitch zone: use current at-bat pitches; fall back to last
  //    at-bat with tracked pitches if current has none yet.
  let pitchEvents = (current.playEvents || []).filter(e => e.type === 'pitch');
  let zoneLabel   = '';
  const isLiveGame = gd?.status?.abstractGameState === 'Live';

  if (pitchEvents.length === 0 && all.length > 1) {
    // Scan backwards for a previous at-bat that has pitch coordinates
    for (let i = all.length - 2; i >= 0; i--) {
      const prev = (all[i].playEvents || []).filter(e =>
        e.type === 'pitch' && e.pitchData?.coordinates?.pX != null);
      if (prev.length > 0) {
        pitchEvents = prev;
        const btr = all[i].matchup?.batter?.fullName?.split(' ').pop() || '';
        zoneLabel  = `Last at-bat${btr ? ` · ${btr}` : ''}`;
        break;
      }
    }
  } else if (pitchEvents.length > 0) {
    const trackedCount = pitchEvents.filter(e => e.pitchData?.coordinates?.pX != null).length;
    zoneLabel = isLiveGame
      ? `<span class="live-tag">● LIVE</span> · ${trackedCount} pitch${trackedCount !== 1 ? 'es' : ''}`
      : `At-bat · ${trackedCount} pitch${trackedCount !== 1 ? 'es' : ''}`;
  } else {
    zoneLabel = isLiveGame ? '<span class="live-tag">● LIVE</span> · Waiting for first pitch…' : 'No pitch data';
  }
  $('gd-zone-label').innerHTML = zoneLabel;

  const lastPitch = pitchEvents.filter(e => e.pitchData?.coordinates?.pZ).pop();
  const szTop = lastPitch?.pitchData?.strikeZoneTop    || 3.4;
  const szBot = lastPitch?.pitchData?.strikeZoneBottom || 1.5;

  const prevCount = state.gdPitchCount;
  state.gdPitchCount = pitchEvents.length;

  renderFullPitchZone(pitchEvents, szTop, szBot, prevCount);
  renderPitchSequence(pitchEvents);
  renderAtBatLog(current);
  const recentPlays = all.slice(-8).reverse();
  renderRecentPlays(recentPlays);
  if (state.selectedGamePk) {
    attachPlayVideos(state.selectedGamePk, recentPlays);
  }

  // Hand labels
  const batSide   = current.matchup?.batSide?.code   || '';
  const pitchHand = current.matchup?.pitchHand?.code || '';
  $('gd-batter-hand-label').textContent  = batSide   === 'L' ? '← L' : batSide   === 'R' ? 'R →' : '';
  $('gd-pitcher-hand-label').textContent = pitchHand === 'L' ? '← L' : pitchHand === 'R' ? 'R →' : '';

  // ── Savant-style season stats — only re-fetch when matchup changes
  const homeTeamId = data.gameData?.teams?.home?.id || null;
  if (batterId !== state.gdBatterId || pitcherId !== state.gdPitcherId) {
    state.gdBatterId  = batterId;
    state.gdPitcherId = pitcherId;
    loadMatchupStats(batterId, pitcherId, homeTeamId);
  }
}

// ── Full matchup stats panel ───────────────────────────────────
async function fetchSavantPercentiles(playerId, type) {
  try {
    const data = await apiFetch(`${PROXY_BASE}/proxy/savant?type=${type}&year=${CUR_SEASON}&id=${playerId}`);
    return data && !data.error && Object.keys(data).length ? data : null;
  } catch {
    return null;
  }
}

async function fetchWar(playerId, type) {
  try {
    const data = await apiFetch(`${PROXY_BASE}/proxy/fangraphs?type=${type}&year=${CUR_SEASON}&id=${playerId}`);
    return (data && data.war != null) ? data.war : null;
  } catch {
    return null;
  }
}

async function loadMatchupStats(batterId, pitcherId, homeTeamId = null) {
  const bEl   = $('gd-batter-savant');
  const pEl   = $('gd-pitcher-savant');
  const h2hEl = $('gd-matchup-history');
  if (bEl)   bEl.innerHTML = '<span class="sm-no-data">Loading stats…</span>';
  if (pEl)   pEl.innerHTML = '<span class="sm-no-data">Loading stats…</span>';
  if (h2hEl) h2hEl.innerHTML = '';

  const safe = p => p || Promise.resolve(null);

  const results = await Promise.allSettled([
    safe(batterId  ? apiFetch(`${MLB_API}/people/${batterId}/stats?stats=season&group=hitting&season=${CUR_SEASON}`) : null),
    safe(batterId  ? apiFetch(`${MLB_API}/people/${batterId}/stats?stats=season&group=hitting&season=${PREV_SEASON}`) : null),
    safe(batterId  ? apiFetch(`${MLB_API}/people/${batterId}/stats?stats=career&group=hitting`) : null),
    safe(batterId  ? apiFetch(`${MLB_API}/people/${batterId}/stats?stats=season&group=hitting&season=${CUR_SEASON}&sitCodes=vl,vr`) : null),
    safe(pitcherId ? apiFetch(`${MLB_API}/people/${pitcherId}/stats?stats=season&group=pitching&season=${CUR_SEASON}`) : null),
    safe(pitcherId ? apiFetch(`${MLB_API}/people/${pitcherId}/stats?stats=season&group=pitching&season=${PREV_SEASON}`) : null),
    safe(pitcherId ? apiFetch(`${MLB_API}/people/${pitcherId}/stats?stats=career&group=pitching`) : null),
    safe(pitcherId ? apiFetch(`${MLB_API}/people/${pitcherId}/stats?stats=season&group=pitching&season=${CUR_SEASON}&sitCodes=vl,vr`) : null),
    safe((batterId && pitcherId) ? apiFetch(`${MLB_API}/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}`) : null),
    safe(batterId  ? fetchSavantPercentiles(batterId,  'batter')  : null),
    safe(pitcherId ? fetchSavantPercentiles(pitcherId, 'pitcher') : null),
    apiFetch(`${PROXY_BASE}/proxy/league-avg?season=${CUR_SEASON}`).catch(() => null),
    safe(batterId  ? fetchWar(batterId,  'batter')  : null),
    safe(pitcherId ? fetchWar(pitcherId, 'pitcher') : null),
  ]);

  const [bs25r, bs24r, bcarr, bsplr, ps25r, ps24r, pcarr, psplr, h2hr, bSvr, pSvr, lgAvgR, bWarR, pWarR] = results.map(r => r.value);

  const bs25 = bs25r?.stats?.[0]?.splits?.[0]?.stat;
  const bs24 = bs24r?.stats?.[0]?.splits?.[0]?.stat;
  const bcar = bcarr?.stats?.[0]?.splits?.[0]?.stat;
  const bspl = bsplr?.stats || [];
  const ps25 = ps25r?.stats?.[0]?.splits?.[0]?.stat;
  const ps24 = ps24r?.stats?.[0]?.splits?.[0]?.stat;
  const pcar = pcarr?.stats?.[0]?.splits?.[0]?.stat;
  const pspl = psplr?.stats || [];
  const h2h  = h2hr?.stats?.[0]?.splits?.[0]?.stat;

  if (bEl) bEl.innerHTML = renderFullBatterStats(bs25, bs24, bcar, bspl, bSvr, lgAvgR, homeTeamId);
  if (pEl) pEl.innerHTML = renderFullPitcherStats(ps25, ps24, pcar, pspl, pSvr, lgAvgR, homeTeamId);

  // Populate WAR badges in player card headers
  const setWarBadge = (elId, war) => {
    const el = $(elId);
    if (!el) return;
    if (war != null) {
      const c = warColor(war);
      el.innerHTML = `<span class="war-val" style="color:${c}">${war.toFixed(1)}</span><span class="war-lbl" style="color:${c}">bWAR</span>`;
      el.style.borderColor = c;
      el.style.background = c + '18';
      el.style.display = '';
    } else { el.style.display = 'none'; }
  };
  setWarBadge('gd-batter-war', bWarR);
  setWarBadge('gd-pitcher-war', pWarR);

  if (h2hEl && (h2h || batterId)) {
    const bName = $('gd-batter-name')?.textContent  || 'Batter';
    const pName = $('gd-pitcher-name')?.textContent || 'Pitcher';
    h2hEl.innerHTML = renderH2H(h2h, bName, pName);
  }
}

// Normalize a raw stat value to 0-100 scale given lo/hi bounds.
// `invert` = true for stats where lower is better (ERA, K%, etc.).
function normStat(val, lo, hi, invert = false) {
  const n = parseFloat(val);
  if (isNaN(n) || val == null) return null;
  let pct = (n - lo) / (hi - lo) * 100;
  if (invert) pct = 100 - pct;
  return Math.max(0, Math.min(100, pct));
}

// Blue→grey→red: 0=blue, 50=grey, 100=red (matching Savant's 3-zone gradient)
function barColor(pct) {
  if (pct === null) return '#4a5568';
  const p = Math.max(0, Math.min(100, pct));
  if (p < 50) {
    const t = p / 50;
    return `rgb(${Math.round(74+t*(115-74))},${Math.round(144+t*(115-144))},${Math.round(217+t*(115-217))})`;
  } else {
    const t = (p - 50) / 50;
    return `rgb(${Math.round(115+t*(210-115))},${Math.round(115+t*(50-115))},${Math.round(115+t*(50-115))})`;
  }
}

// WAR color: red (< 0) → grey (0-2) → green (2+)
function warColor(war) {
  if (war == null || isNaN(war)) return 'var(--accent-blue)';
  if (war < 0) {
    const t = Math.max(0, Math.min(1, war / -2));
    return `rgb(${Math.round(130+t*(215-130))},${Math.round(130+t*(45-130))},${Math.round(130+t*(45-130))})`;
  } else {
    const t = Math.max(0, Math.min(1, war / 5));
    return `rgb(${Math.round(130+t*(30-130))},${Math.round(130+t*(210-130))},${Math.round(130+t*(75-130))})`;
  }
}

function statBar(label, val, display, pct) {
  const color = barColor(pct);
  const w = pct !== null ? `${pct.toFixed(0)}%` : '0%';
  return `<div class="sm-row">
    <span class="sm-label">${label}</span>
    <div class="sm-bar-wrap"><div class="sm-bar" style="width:${w};background:${color}"></div></div>
    <span class="sm-value">${display}</span>
  </div>`;
}

// ── Full batter stats panel (col 3) ───────────────────────────
function calcOpsPlus(s, lgAvg, homeTeamId) {
  const obp = parseFloat(s?.obp || s?.onBasePercentage);
  const slg = parseFloat(s?.slg || s?.sluggingPercentage);
  if (!lgAvg || isNaN(obp) || isNaN(slg)) return null;
  const bpf = (PARK_FACTORS[homeTeamId] ?? 100) / 100;
  return Math.round(100 * (obp / lgAvg.lgOBP + slg / lgAvg.lgSLG - 1) / bpf);
}

function calcEraPlus(s, lgAvg, homeTeamId) {
  const era = parseFloat(s?.era);
  if (!lgAvg || isNaN(era) || era === 0) return null;
  const bpf = (PARK_FACTORS[homeTeamId] ?? 100) / 100;
  return Math.round(100 * (lgAvg.lgERA / era) / bpf);
}

function renderFullBatterStats(s25, s24, scar, splitsArr, savant = null, lgAvg = null, homeTeamId = null, war = null) {
  let html = '';

  // 2025 Season bars
  if (s25) {
    const pa  = parseInt(s25.plateAppearances) || 0;
    const gp  = parseInt(s25.gamesPlayed) || 0;
    const avg = parseFloat(s25.avg);
    const obp = parseFloat(s25.obp || s25.onBasePercentage);
    const slg = parseFloat(s25.slg || s25.sluggingPercentage);
    const ops = parseFloat(s25.ops);
    const so  = parseInt(s25.strikeOuts)  || 0;
    const bb  = parseInt(s25.baseOnBalls) || 0;
    const hr  = parseInt(s25.homeRuns)    || 0;
    const rbi = parseInt(s25.rbi)         || 0;
    const sb  = parseInt(s25.stolenBases) || 0;
    const kPct  = pa > 0 ? so/pa : null;
    const bbPct = pa > 0 ? bb/pa : null;

    const opsPlus = calcOpsPlus(s25, lgAvg, homeTeamId);
    const fAvg = v => isNaN(v) ? '—' : v.toFixed(3).replace('0.','.');
    html += `<div class="ms-section">
      <div class="ms-section-title">${CUR_SEASON} SEASON · ${gp}G · ${pa} PA</div>
      <div class="stat-grid">
        <div class="stat-box"><div class="val">${fAvg(avg)}</div><div class="lbl">AVG</div></div>
        <div class="stat-box"><div class="val">${fAvg(obp)}</div><div class="lbl">OBP</div></div>
        <div class="stat-box"><div class="val">${fAvg(slg)}</div><div class="lbl">SLG</div></div>
        <div class="stat-box"><div class="val">${isNaN(ops)?'—':ops.toFixed(3).replace('0.','.')}</div><div class="lbl">OPS</div></div>
        <div class="stat-box"><div class="val">${opsPlus ?? '—'}</div><div class="lbl">OPS+</div></div>
        <div class="stat-box"><div class="val">${hr}</div><div class="lbl">HR</div></div>
      </div>
    </div>`;

    html += renderBatterPercentileProfile(s25, savant);
  } else {
    html += `<div class="ms-section"><div class="ms-section-title">${CUR_SEASON} SEASON</div><span class="sm-no-data">No stats yet</span></div>`;
  }

  // 2024 Season compact
  if (s24) {
    const avg24 = parseFloat(s24.avg), ops24 = parseFloat(s24.ops);
    html += `<div class="ms-section">
      <div class="ms-section-title">${PREV_SEASON} SEASON</div>
      <div class="ms-stat-line">${isNaN(avg24)?'—':avg24.toFixed(3).replace('0.','.')} AVG · ${isNaN(ops24)?'—':ops24.toFixed(3).replace('0.','.')} OPS · ${s24.homeRuns||0} HR · ${s24.rbi||0} RBI · ${s24.gamesPlayed||0}G</div>
    </div>`;
  }

  // Career compact
  if (scar) {
    const avgC = parseFloat(scar.avg), opsC = parseFloat(scar.ops);
    html += `<div class="ms-section">
      <div class="ms-section-title">CAREER</div>
      <div class="ms-stat-line">${isNaN(avgC)?'—':avgC.toFixed(3).replace('0.','.')} AVG · ${isNaN(opsC)?'—':opsC.toFixed(3).replace('0.','.')} OPS · ${scar.homeRuns||0} HR · ${scar.rbi||0} RBI · ${scar.gamesPlayed||0}G</div>
    </div>`;
  }

  // Splits vs L/R
  const allSplits = splitsArr.flatMap(s => s.splits || []);
  if (allSplits.length) html += renderSplitsTable(allSplits, 'hitting');

  return html || '<span class="sm-no-data">Stats unavailable</span>';
}

function renderBatterPercentileProfile(s, sv = null) {
  const pa  = parseInt(s.plateAppearances) || 0;
  const avg = parseFloat(s.avg);
  const obp = parseFloat(s.obp || s.onBasePercentage);
  const slg = parseFloat(s.slg || s.sluggingPercentage);
  const ops = parseFloat(s.ops);
  const so  = parseInt(s.strikeOuts)  || 0;
  const bb  = parseInt(s.baseOnBalls) || 0;
  const kPct  = pa > 0 ? so/pa : null;
  const bbPct = pa > 0 ? bb/pa : null;

  // Prefer real Savant percentiles; fall back to normStat approximation
  const p = (key, fallback) => sv?.[key] ?? fallback;

  const fmt3v = v => v != null ? v.toFixed(3).replace('0.','.') : '—';
  const fmtPct = v => v != null ? `${v.toFixed(1)}%` : '—';
  const kPctV  = kPct  !== null ? kPct*100  : null;
  const bbPctV = bbPct !== null ? bbPct*100 : null;
  const rows = [
    { label:'xwOBA',        pct: p('xwoba',   normStat(ops,.500,1.100)),  val: fmt3v(sv?.xwoba_val) },
    { label:'xBA',          pct: p('xba',     normStat(avg,.150,.380)),   val: fmt3v(sv?.xba_val) },
    { label:'xSLG',         pct: p('xslg',    normStat(slg,.250,.680)),   val: fmt3v(sv?.xslg_val) },
    { label:'Avg Exit Velo',pct: p('ev',      null), val: sv?.ev_val != null ? sv.ev_val.toFixed(1)+' mph' : '—' },
    { label:'Barrel%',      pct: p('barrel',  null), val: sv?.barrel_val != null ? sv.barrel_val.toFixed(1)+'%' : '—' },
    { label:'Hard Hit%',    pct: p('hard_hit',null), val: sv?.hard_hit_val != null ? sv.hard_hit_val.toFixed(1)+'%' : '—' },
    { label:'Chase%',       pct: p('chase',   null), val: sv?.chase_val != null ? sv.chase_val.toFixed(1)+'%' : '—' },
    { label:'Whiff%',       pct: p('whiff',   null), val: sv?.whiff_val != null ? sv.whiff_val.toFixed(1)+'%' : '—' },
    { label:'K%',           pct: p('k_pct',   kPct!==null?normStat(kPct,.35,.08,true):null), val: sv?.k_pct_val != null ? sv.k_pct_val.toFixed(1)+'%' : fmtPct(kPctV) },
    { label:'BB%',          pct: p('bb_pct',  bbPct!==null?normStat(bbPct,.03,.20):null),    val: sv?.bb_pct_val != null ? sv.bb_pct_val.toFixed(1)+'%' : fmtPct(bbPctV) },
    { label:'Sprint Speed', pct: p('sprint',  null), val: sv?.sprint_val != null ? sv.sprint_val.toFixed(1)+' ft/s' : '—' },
  ].filter(r => r.pct !== null);  // hide rows with no data at all

  const source = sv ? 'SAVANT PERCENTILE PROFILE' : 'PERCENTILE PROFILE (est.)';
  const svHasKeys = sv ? ['xwoba','xba','xslg','ev','barrel','hard_hit'].some(k => sv[k] != null) : false;
  const paCount = parseInt(s.plateAppearances) || 0;
  const smallSample = !svHasKeys && paCount > 0 && paCount < 130;

  return `<div class="ms-section">
    <div class="ms-section-title">${source}</div>
    ${smallSample ? `<div class="sv-sample-note" style="margin:0 0 6px;border-radius:4px">⚠ Small sample (${paCount} PA) — below Savant qualification threshold</div>` : ''}
    <div class="${smallSample ? 'sv-blurred' : ''}">
    ${rows.map(({label,pct,val}) => {
      const c = barColor(pct), p2 = Math.round(pct);
      return `<div class="pct-row">
        <span class="pct-label">${label}</span>
        <div class="pct-bar-wrap"><div class="pct-bar" style="width:${pct}%;background:${c}"><span class="pct-num">${p2}</span></div></div>
        <span class="pct-val">${val}</span>
      </div>`;
    }).join('')}
    </div>
  </div>`;
}

// ── Full pitcher stats panel (col 3) ──────────────────────────
function renderFullPitcherStats(s25, s24, scar, splitsArr, savant = null, lgAvg = null, homeTeamId = null, war = null) {
  let html = '';

  if (s25) {
    const era  = parseFloat(s25.era);
    const whip = parseFloat(s25.whip);
    const k9   = parseFloat(s25.strikeoutsPer9Inn);
    const bb9  = parseFloat(s25.walksPer9Inn);
    const ip   = s25.inningsPitched || '—';
    const bf   = parseInt(s25.battersFaced) || 0;
    const so   = parseInt(s25.strikeOuts)   || 0;
    const bb   = parseInt(s25.baseOnBalls)  || 0;
    const gs   = parseInt(s25.gamesStarted) || 0;
    const sv   = parseInt(s25.saves)         || 0;
    const kPct  = bf > 0 ? so/bf : null;
    const bbPct = bf > 0 ? bb/bf : null;

    const eraPlus = calcEraPlus(s25, lgAvg, homeTeamId);
    html += `<div class="ms-section">
      <div class="ms-section-title">${CUR_SEASON} SEASON · ${ip} IP · ${gs > 0 ? gs+'GS' : sv > 0 ? sv+'SV' : ''}</div>
      <div class="stat-grid">
        <div class="stat-box"><div class="val">${isNaN(era)?'—':era.toFixed(2)}</div><div class="lbl">ERA</div></div>
        <div class="stat-box"><div class="val">${eraPlus ?? '—'}</div><div class="lbl">ERA+</div></div>
        <div class="stat-box"><div class="val">${isNaN(whip)?'—':whip.toFixed(2)}</div><div class="lbl">WHIP</div></div>
        <div class="stat-box"><div class="val">${isNaN(k9)?'—':k9.toFixed(1)}</div><div class="lbl">K/9</div></div>
        <div class="stat-box"><div class="val">${isNaN(bb9)?'—':bb9.toFixed(1)}</div><div class="lbl">BB/9</div></div>
        <div class="stat-box"><div class="val">${s25.wins||0}–${s25.losses||0}</div><div class="lbl">W-L</div></div>
      </div>
    </div>`;

    html += renderPitcherPercentileProfile(s25, savant);
  } else {
    html += `<div class="ms-section"><div class="ms-section-title">${CUR_SEASON} SEASON</div><span class="sm-no-data">No stats yet</span></div>`;
  }

  if (s24) {
    const era24 = parseFloat(s24.era), whip24 = parseFloat(s24.whip);
    html += `<div class="ms-section">
      <div class="ms-section-title">${PREV_SEASON} SEASON</div>
      <div class="ms-stat-line">${isNaN(era24)?'—':era24.toFixed(2)} ERA · ${isNaN(whip24)?'—':whip24.toFixed(2)} WHIP · ${s24.strikeOuts||0} K · ${s24.inningsPitched||0} IP</div>
    </div>`;
  }

  if (scar) {
    const eraC = parseFloat(scar.era), whipC = parseFloat(scar.whip);
    html += `<div class="ms-section">
      <div class="ms-section-title">CAREER</div>
      <div class="ms-stat-line">${isNaN(eraC)?'—':eraC.toFixed(2)} ERA · ${isNaN(whipC)?'—':whipC.toFixed(2)} WHIP · ${scar.strikeOuts||0} K · ${scar.wins||0}–${scar.losses||0} W-L</div>
    </div>`;
  }

  const allSplits = splitsArr.flatMap(s => s.splits || []);
  if (allSplits.length) html += renderSplitsTable(allSplits, 'pitching');

  return html || '<span class="sm-no-data">Stats unavailable</span>';
}

function renderPitcherPercentileProfile(s, sv = null) {
  const era  = parseFloat(s.era);
  const whip = parseFloat(s.whip);
  const k9   = parseFloat(s.strikeoutsPer9Inn);
  const bb9  = parseFloat(s.walksPer9Inn);
  const bf   = parseInt(s.battersFaced) || 0;
  const so   = parseInt(s.strikeOuts)   || 0;
  const bb   = parseInt(s.baseOnBalls)  || 0;
  const kPct  = bf > 0 ? so/bf : null;
  const bbPct = bf > 0 ? bb/bf : null;

  const p = (key, fallback) => sv?.[key] ?? fallback;

  const fmt3v = v => v != null ? v.toFixed(3).replace('0.','.') : '—';
  const fmtPct = v => v != null ? `${v.toFixed(1)}%` : '—';
  const kPctV = kPct !== null ? kPct*100 : null, bbPctV = bbPct !== null ? bbPct*100 : null;
  const rows = [
    { label:'xERA',        pct: p('xera',    null),  val: sv?.xera_val != null ? sv.xera_val.toFixed(2) : '—' },
    { label:'xBA Against', pct: p('xba',     null),  val: fmt3v(sv?.xba_val) },
    { label:'FB Velo',     pct: p('fb_velo', null),  val: sv?.fb_velo_val != null ? sv.fb_velo_val.toFixed(1)+' mph' : '—' },
    { label:'Avg Exit Velo',pct: p('ev',     null),  val: sv?.ev_val != null ? sv.ev_val.toFixed(1)+' mph' : '—' },
    { label:'Chase%',      pct: p('chase',   null),  val: sv?.chase_val != null ? sv.chase_val.toFixed(1)+'%' : '—' },
    { label:'Whiff%',      pct: p('whiff',   null),  val: sv?.whiff_val != null ? sv.whiff_val.toFixed(1)+'%' : '—' },
    { label:'K%',          pct: p('k_pct',   kPct!==null?normStat(kPct,.10,.38):null), val: sv?.k_pct_val != null ? sv.k_pct_val.toFixed(1)+'%' : fmtPct(kPctV) },
    { label:'BB%',         pct: p('bb_pct',  bbPct!==null?normStat(bbPct,.15,.03,true):null), val: sv?.bb_pct_val != null ? sv.bb_pct_val.toFixed(1)+'%' : fmtPct(bbPctV) },
    { label:'Hard Hit%',   pct: p('hard_hit',null),  val: sv?.hard_hit_val != null ? sv.hard_hit_val.toFixed(1)+'%' : '—' },
    { label:'Barrel%',     pct: p('barrel',  null),  val: sv?.barrel_val != null ? sv.barrel_val.toFixed(1)+'%' : '—' },
  ].filter(r => r.pct !== null);

  const source = sv ? 'SAVANT PERCENTILE PROFILE' : 'PERCENTILE PROFILE (est.)';
  const svHasKeysP = sv ? ['era','xera','whiff','chase'].some(k => sv[k] != null) : false;
  const bfCount = parseInt(s.battersFaced) || 0;
  const smallSampleP = !svHasKeysP && bfCount > 0 && bfCount < 50;

  return `<div class="ms-section">
    <div class="ms-section-title">${source}</div>
    ${smallSampleP ? `<div class="sv-sample-note" style="margin:0 0 6px;border-radius:4px">⚠ Small sample (${bfCount} BF) — below Savant qualification threshold</div>` : ''}
    <div class="${smallSampleP ? 'sv-blurred' : ''}">
    ${rows.map(({label,pct,val}) => {
      const c = barColor(pct), p2 = Math.round(pct);
      return `<div class="pct-row">
        <span class="pct-label">${label}</span>
        <div class="pct-bar-wrap"><div class="pct-bar" style="width:${pct}%;background:${c}"><span class="pct-num">${p2}</span></div></div>
        <span class="pct-val">${val}</span>
      </div>`;
    }).join('')}
    </div>
  </div>`;
}

// ── Splits table (vs L/R) ──────────────────────────────────────
function renderSplitsTable(splits, group) {
  const vsL = splits.find(s => s.split?.code === 'vl')?.stat;
  const vsR = splits.find(s => s.split?.code === 'vr')?.stat;
  if (!vsL && !vsR) return '';
  const isHitting = group === 'hitting';

  const fmtEra = v => { const n=parseFloat(v); return isNaN(n)?'—':n.toFixed(2); };
  const row = s => {
    if (!s) return '';
    if (isHitting) {
      const avg=parseFloat(s.avg||s.batting?.avg), obp=parseFloat(s.obp||s.onBasePercentage), slg=parseFloat(s.slg||s.sluggingPercentage), ops=parseFloat(s.ops);
      return `<td>${isNaN(avg)?'—':avg.toFixed(3).replace('0.','.')}</td><td>${isNaN(obp)?'—':obp.toFixed(3).replace('0.','.')}</td><td>${isNaN(slg)?'—':slg.toFixed(3).replace('0.','.')}</td><td>${isNaN(ops)?'—':ops.toFixed(3).replace('0.','.')}</td><td>${s.homeRuns||0}</td>`;
    } else {
      const bf=parseInt(s.battersFaced)||0, so=parseInt(s.strikeOuts)||0;
      return `<td>${fmtEra(s.era)}</td><td>${fmtEra(s.whip)}</td><td>${bf>0?`${(so/bf*100).toFixed(0)}%`:'—'}</td><td>${s.strikeOuts||0}</td>`;
    }
  };

  return `<div class="ms-section">
    <div class="ms-section-title">${CUR_SEASON} SPLITS</div>
    <table class="splits-table">
      <thead><tr><th></th>${isHitting ? '<th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th><th>HR</th>' : '<th>ERA</th><th>WHIP</th><th>K%</th><th>K</th>'}</tr></thead>
      <tbody>
        ${vsL ? `<tr><td>vs L</td>${row(vsL)}</tr>` : ''}
        ${vsR ? `<tr><td>vs R</td>${row(vsR)}</tr>` : ''}
      </tbody>
    </table>
  </div>`;
}

// ── Head-to-head matchup history ───────────────────────────────
function renderH2H(h2h, bName, pName) {
  if (!h2h) {
    return `<div class="h2h-title">H2H: ${bName} vs ${pName}</div><div class="h2h-line" style="color:var(--text-muted);font-size:0.65rem">No career matchup data available</div>`;
  }
  const pa  = h2h.plateAppearances || h2h.atBats || 0;
  const avg = parseFloat(h2h.avg);
  const hr  = h2h.homeRuns || 0;
  const so  = h2h.strikeOuts || 0;
  const bb  = h2h.baseOnBalls || 0;
  const hits= h2h.hits || 0;

  return `<div class="h2h-title">H2H: ${bName} vs ${pName}</div>
    <div class="h2h-line">Career: ${hits}-for-${pa}${pa > 0 ? ` (${isNaN(avg)?'—':avg.toFixed(3).replace('0.','.')})` : ''} · ${hr} HR · ${so} K · ${bb} BB</div>`;
}

// ── Ballpark field SVG (bird's-eye) ───────────────────────────
const PARK_DIMS = {
  'fenway park':              { leftLine:310, left:310, leftCenter:379, center:390, rightCenter:380, right:302, rightLine:302, leftWallHeight:37 },
  'wrigley field':            { leftLine:355, left:368, leftCenter:400, center:400, rightCenter:368, right:353, rightLine:353 },
  'yankee stadium':           { leftLine:318, left:399, leftCenter:399, center:408, rightCenter:385, right:314, rightLine:314 },
  'dodger stadium':           { leftLine:330, left:375, leftCenter:395, center:395, rightCenter:375, right:330, rightLine:330 },
  'oracle park':              { leftLine:339, left:364, leftCenter:404, center:399, rightCenter:365, right:309, rightLine:309 },
  'camden yards':             { leftLine:333, left:364, leftCenter:410, center:400, rightCenter:373, right:320, rightLine:318 },
  'pnc park':                 { leftLine:325, left:383, leftCenter:410, center:399, rightCenter:375, right:320, rightLine:320 },
  'coors field':              { leftLine:347, left:390, leftCenter:420, center:415, rightCenter:390, right:350, rightLine:347 },
  'great american ball park': { leftLine:328, left:370, leftCenter:404, center:404, rightCenter:370, right:325, rightLine:325 },
  'globe life field':         { leftLine:329, left:372, leftCenter:407, center:407, rightCenter:372, right:326, rightLine:329 },
  'chase field':              { leftLine:330, left:376, leftCenter:413, center:407, rightCenter:376, right:335, rightLine:330 },
  'petco park':               { leftLine:334, left:357, leftCenter:402, center:396, rightCenter:391, right:322, rightLine:322 },
  't-mobile park':            { leftLine:331, left:378, leftCenter:390, center:401, rightCenter:381, right:326, rightLine:326 },
  'minute maid park':         { leftLine:315, left:362, leftCenter:404, center:409, rightCenter:373, right:326, rightLine:326 },
  'target field':             { leftLine:339, left:377, leftCenter:411, center:404, rightCenter:367, right:328, rightLine:328 },
  'kauffman stadium':         { leftLine:330, left:387, leftCenter:410, center:410, rightCenter:387, right:330, rightLine:330 },
  'guaranteed rate field':    { leftLine:330, left:377, leftCenter:400, center:400, rightCenter:372, right:335, rightLine:335 },
  'angel stadium':            { leftLine:333, left:347, leftCenter:396, center:396, rightCenter:347, right:350, rightLine:333 },
  'american family field':    { leftLine:344, left:370, leftCenter:398, center:400, rightCenter:374, right:345, rightLine:345 },
  'nationals park':           { leftLine:336, left:377, leftCenter:402, center:402, rightCenter:370, right:335, rightLine:335 },
  'tropicana field':          { leftLine:315, left:370, leftCenter:404, center:404, rightCenter:370, right:322, rightLine:315 },
  'comerica park':            { leftLine:345, left:370, leftCenter:395, center:420, rightCenter:365, right:330, rightLine:330 },
  'busch stadium':            { leftLine:336, left:375, leftCenter:390, center:400, rightCenter:390, right:375, rightLine:335 },
  'citizens bank park':       { leftLine:330, left:374, leftCenter:409, center:401, rightCenter:369, right:330, rightLine:330 },
  'truist park':              { leftLine:335, left:380, leftCenter:400, center:400, rightCenter:375, right:325, rightLine:325 },
  'progressive field':        { leftLine:325, left:370, leftCenter:410, center:405, rightCenter:375, right:325, rightLine:325 },
  'american league ballpark': { leftLine:330, left:375, leftCenter:400, center:400, rightCenter:375, right:330, rightLine:330 },
};

function renderBallparkFieldSVG(fieldInfo, venueName) {
  const name = venueName || '';
  const parkKey = name.toLowerCase();
  const parkDims = PARK_DIMS[parkKey] || {};
  const fi = { ...parkDims, ...(fieldInfo || {}) };

  // Coordinate helpers
  const HX = 210, HY = 355, SCALE = 0.7;
  const toRad = deg => deg * Math.PI / 180;
  const fieldPt = (distFt, angleDeg) => ({
    x: HX + distFt * SCALE * Math.sin(toRad(angleDeg)),
    y: HY - distFt * SCALE * Math.cos(toRad(angleDeg))
  });
  const pt = (p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;

  // Outfield wall points (7 segments)
  const wallAngles = [-45, -37, -22, 0, 22, 37, 45];
  const wallDists  = [
    fi.leftLine    || 330,
    fi.left        || fi.leftLine  || 350,
    fi.leftCenter  || fi.center    || 385,
    fi.center      || 400,
    fi.rightCenter || fi.center    || 385,
    fi.right       || fi.rightLine || 350,
    fi.rightLine   || 330
  ];
  const wallPts    = wallAngles.map((a, i) => fieldPt(wallDists[i], a));

  // Warning track points (~15 ft inside wall)
  const TRACK_IN = 15;
  const trackPts = wallAngles.map((a, i) => fieldPt(Math.max(wallDists[i] - TRACK_IN, 50), a));

  // Build smooth wall path using cubic bezier through 7 points
  // Use catmull-rom style control points
  // Straight-line path — sharp corners at each wall segment
  function sharpPath(pts) {
    if (pts.length < 2) return '';
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${pt(p)}`).join(' ');
  }

  // Fair territory polygon: home → LF pole → wall curve → RF pole → home
  const wallPath  = sharpPath(wallPts);
  const trackPath = sharpPath(trackPts);

  // Full fair territory fill (outfield green)
  const fairPoly = `M ${HX},${HY} L ${pt(wallPts[0])} ${wallPath.substring(wallPath.indexOf(' '))} L ${HX},${HY} Z`;

  // Warning track band: clipped between outer wall and inner track
  const outerPath = wallPath;
  const innerPath = trackPath;
  const trackFill = `${outerPath} L ${pt(trackPts[trackPts.length-1])} ` +
    trackPts.slice().reverse().reduce((acc, p, i) => {
      if (i === 0) return acc + `M ${pt(p)}`;
      return acc + ` L ${pt(p)}`;
    }, '') + ' Z';

  // Warning track as SVG clip + path
  const trackClipPath = trackPts.map((p, i) => i === 0 ? `M ${pt(p)}` : `L ${pt(p)}`).join(' ') + ' Z';
  const wallClipPath  = wallPts.map((p, i) => i === 0 ? `M ${pt(p)}` : `L ${pt(p)}`).join(' ') + ' Z';

  // Infield bases
  const base2  = { x: HX,          y: HY - 90 * SCALE * Math.SQRT2 }; // (210, 266)
  const base1  = fieldPt(90 * Math.SQRT2 / Math.SQRT2, 45);             // fieldPt at 45°, 90ft legs
  const base3  = fieldPt(90 * Math.SQRT2 / Math.SQRT2, -45);
  // Recalculate properly: base path is 90ft per side
  const B1 = { x: HX + 90 * SCALE * Math.sin(toRad(45)),  y: HY - 90 * SCALE * Math.cos(toRad(45)) };
  const B2 = { x: HX,                                       y: HY - 90 * SCALE * Math.SQRT2 };
  const B3 = { x: HX - 90 * SCALE * Math.sin(toRad(45)),  y: HY - 90 * SCALE * Math.cos(toRad(45)) };
  const MOUND = { x: HX, y: HY - 60.5 * SCALE };

  // Infield grass square (slightly larger than base diamond)
  const GRASS_R = 95 * SCALE * Math.SQRT2 / 2; // half-diagonal of 95ft square
  const infieldGrass = [
    { x: HX,          y: HY - GRASS_R * Math.SQRT2 },
    { x: HX + GRASS_R, y: HY - GRASS_R },
    { x: HX,          y: HY },
    { x: HX - GRASS_R, y: HY - GRASS_R }
  ];
  // Actually draw as a square rotated 45 degrees: diamond shape
  const IG_HALF = 95 * SCALE * 0.5; // half-side projected
  const igPts = [
    { x: HX,           y: HY - 95 * SCALE * Math.SQRT2 * 0.5 * Math.SQRT2 },  // top (2nd)
    { x: HX + 95 * SCALE * Math.SQRT2 * 0.5, y: HY },                           // right
    { x: HX,           y: HY + 0 },                                               // bottom (home)
    { x: HX - 95 * SCALE * Math.SQRT2 * 0.5, y: HY }                            // left
  ];
  // Simpler: infield grass is a square 95ft side rotated 45 deg, centered at midpoint of B1-B3
  const IG = 95 * SCALE; // side in pixels
  const igDiag = IG * Math.SQRT2 / 2;
  const igCenter = { x: HX, y: (HY + B2.y) / 2 };
  const infieldGrassPts = [
    { x: igCenter.x,          y: igCenter.y - igDiag },  // top
    { x: igCenter.x + igDiag, y: igCenter.y },            // right
    { x: igCenter.x,          y: igCenter.y + igDiag },   // bottom
    { x: igCenter.x - igDiag, y: igCenter.y }             // left
  ];

  const igPoly = infieldGrassPts.map((p, i) => i === 0 ? `M ${pt(p)}` : `L ${pt(p)}`).join(' ') + ' Z';

  // Dirt oval around the infield (basepath dirt)
  // Centered between home and 2nd, taller oval
  const dirtCX = HX;
  const dirtCY = (HY + B2.y) / 2;
  const dirtRX = igDiag + 18;
  const dirtRY = igDiag + 18;

  // Basepath lines
  const basePaths = [
    `M ${pt({x:HX,y:HY})} L ${pt(B1)}`,
    `M ${pt(B1)} L ${pt(B2)}`,
    `M ${pt(B2)} L ${pt(B3)}`,
    `M ${pt(B3)} L ${pt({x:HX,y:HY})}`
  ].join(' ');

  // Base square helper (6px, rotated 45°)
  function baseSquare(p) {
    const s = 5;
    return `<rect x="${(p.x-s/2).toFixed(1)}" y="${(p.y-s/2).toFixed(1)}" width="${s}" height="${s}" fill="white" transform="rotate(45,${p.x.toFixed(1)},${p.y.toFixed(1)})"/>`;
  }

  // Distance label helper
  function distLabel(distFt, angleDeg, offset = -18) {
    const inner = Math.max(distFt - 20, 50);
    const p = fieldPt(inner, angleDeg);
    return `<text x="${p.x.toFixed(1)}" y="${(p.y + 4).toFixed(1)}" fill="white" font-family="Arial,sans-serif" font-size="10" font-weight="600" text-anchor="middle" opacity="0.9">${distFt}'</text>`;
  }

  // Foul line endpoints (at wall corners)
  const lfPole = wallPts[0];
  const rfPole = wallPts[6];

  // Build SVG
  return `<svg viewBox="0 0 420 380" width="420" height="380" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="bp-fair-clip">
      <path d="M ${HX},${HY} L ${pt(wallPts[0])} ${wallPath.substring(wallPath.indexOf(' '))} L ${HX},${HY} Z"/>
    </clipPath>
    <radialGradient id="bp-vignette" cx="50%" cy="90%" r="70%">
      <stop offset="0%" stop-color="transparent"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.45)"/>
    </radialGradient>
  </defs>

  <!-- Background -->
  <rect width="420" height="380" fill="#0d1f14" rx="8"/>

  <!-- Fair territory (outfield grass) -->
  <path d="M ${HX},${HY} L ${pt(wallPts[0])} ${wallPath.substring(wallPath.indexOf(' '))} L ${HX},${HY} Z"
        fill="#1a4a2e"/>

  <!-- Warning track band -->
  <path d="M ${HX},${HY} L ${pt(trackPts[0])} ${trackPath.substring(trackPath.indexOf(' '))} L ${HX},${HY} Z"
        fill="rgba(70,50,30,0.6)" clip-path="url(#bp-fair-clip)"/>

  <!-- Foul territory corners (dark) behind foul lines -->
  <polygon points="${HX},${HY} ${pt(wallPts[0])} 0,380 420,380 ${pt(wallPts[6])}"
           fill="#0d1f14" opacity="0.0"/>

  <!-- Infield dirt oval -->
  <ellipse cx="${dirtCX}" cy="${dirtCY.toFixed(2)}" rx="${dirtRX.toFixed(1)}" ry="${dirtRY.toFixed(1)}"
           fill="#5c3a1e"/>

  <!-- Infield grass diamond -->
  <path d="${igPoly}" fill="#1f5c38"/>

  <!-- Outfield wall border -->
  <path d="${wallPath}" fill="none" stroke="#2d7a4a" stroke-width="3" stroke-linejoin="miter"/>
  ${fi.leftWallHeight > 20 ? `<!-- Tall left field wall (e.g. Green Monster) -->
  <path d="M ${pt(wallPts[0])} L ${pt(wallPts[1])} L ${pt(wallPts[2])}" fill="none" stroke="#1a8c3a" stroke-width="6" stroke-linecap="round"/>` : ''}

  <!-- Foul lines -->
  <line x1="${HX}" y1="${HY}" x2="${lfPole.x.toFixed(2)}" y2="${lfPole.y.toFixed(2)}"
        stroke="white" stroke-width="1.5" opacity="0.85"/>
  <line x1="${HX}" y1="${HY}" x2="${rfPole.x.toFixed(2)}" y2="${rfPole.y.toFixed(2)}"
        stroke="white" stroke-width="1.5" opacity="0.85"/>

  <!-- Foul poles (yellow tall markers) -->
  <line x1="${lfPole.x.toFixed(2)}" y1="${lfPole.y.toFixed(2)}"
        x2="${lfPole.x.toFixed(2)}" y2="${(lfPole.y - 18).toFixed(2)}"
        stroke="#ffe135" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="${rfPole.x.toFixed(2)}" y1="${rfPole.y.toFixed(2)}"
        x2="${rfPole.x.toFixed(2)}" y2="${(rfPole.y - 18).toFixed(2)}"
        stroke="#ffe135" stroke-width="2.5" stroke-linecap="round"/>

  <!-- Base paths -->
  <path d="${basePaths}" stroke="#c8a96e" stroke-width="2" fill="none" opacity="0.7"/>

  <!-- Pitcher's mound -->
  <circle cx="${MOUND.x}" cy="${MOUND.y.toFixed(2)}" r="9" fill="#5c3a1e"/>
  <circle cx="${MOUND.x}" cy="${MOUND.y.toFixed(2)}" r="3" fill="#7a5030"/>

  <!-- Home plate -->
  <circle cx="${HX}" cy="${HY}" r="5" fill="white" opacity="0.95"/>

  <!-- Bases -->
  ${baseSquare(B1)}
  ${baseSquare(B2)}
  ${baseSquare(B3)}

  <!-- Park-specific features -->
  ${(()=>{
    const pk = name.toLowerCase();
    const lf0 = wallPts[0], lf1 = wallPts[1], lc = wallPts[2], cf = wallPts[3], rc = wallPts[4], rf1 = wallPts[5], rf0 = wallPts[6];
    if (pk === 'fenway park') {
      // Green Monster manual scoreboard
      const sbX = (lf0.x + lf1.x)/2 + 4, sbY = (lf0.y + lf1.y)/2 - 2;
      const rungs = [3,8,13,18,23].map(dy=>`<line x1="${(lf0.x+7).toFixed(1)}" y1="${(lf0.y-dy).toFixed(1)}" x2="${(lf0.x+12).toFixed(1)}" y2="${(lf0.y-dy).toFixed(1)}" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`).join('');
      return `<rect x="${(sbX-15).toFixed(1)}" y="${(sbY-13).toFixed(1)}" width="30" height="20" fill="#0c170c" stroke="#1e3a1e" stroke-width="1.2" rx="1"/>
<line x1="${(sbX-15).toFixed(1)}" y1="${(sbY-5).toFixed(1)}" x2="${(sbX+15).toFixed(1)}" y2="${(sbY-5).toFixed(1)}" stroke="#1e3a1e" stroke-width="0.8"/>
<line x1="${sbX.toFixed(1)}" y1="${(sbY-13).toFixed(1)}" x2="${sbX.toFixed(1)}" y2="${(sbY+7).toFixed(1)}" stroke="#1e3a1e" stroke-width="0.8"/>
<text x="${sbX.toFixed(1)}" y="${(sbY-7).toFixed(1)}" fill="rgba(255,255,255,0.45)" font-family="Arial,sans-serif" font-size="4.5" font-weight="700" text-anchor="middle" letter-spacing="0.3">FENWAY</text>
<line x1="${(lf0.x+7).toFixed(1)}" y1="${(lf0.y-1).toFixed(1)}" x2="${(lf0.x+7).toFixed(1)}" y2="${(lf0.y-26).toFixed(1)}" stroke="rgba(255,255,255,0.28)" stroke-width="1.2"/>
<line x1="${(lf0.x+12).toFixed(1)}" y1="${(lf0.y-1).toFixed(1)}" x2="${(lf0.x+12).toFixed(1)}" y2="${(lf0.y-26).toFixed(1)}" stroke="rgba(255,255,255,0.28)" stroke-width="1.2"/>
${rungs}`;
    }
    if (pk === 'oracle park') {
      // McCovey Cove (SF Bay beyond RF)
      const cx = Math.min(415, rf0.x+12), cy = rf0.y;
      // Glove in LC area (beyond wall, outside fair territory)
      const gx = lc.x - 14, gy = lc.y - 14;
      // Coke bottle near LC
      const bx = lc.x + 4, by = lc.y - 18;
      return `<path d="M ${rf0.x.toFixed(1)},${(rf0.y+4).toFixed(1)} L ${cx.toFixed(1)},${(cy-18).toFixed(1)} L 420,${(cy-8).toFixed(1)} L 420,380 L ${rf0.x.toFixed(1)},${(rf0.y+40).toFixed(1)} Z" fill="rgba(26,90,130,0.52)" stroke="rgba(50,140,190,0.3)" stroke-width="0.8"/>
<text x="${(cx+12).toFixed(1)}" y="${(cy+18).toFixed(1)}" fill="rgba(80,190,255,0.45)" font-family="Arial,sans-serif" font-size="7" font-weight="600" text-anchor="middle" transform="rotate(-38,${(cx+12).toFixed(1)},${(cy+18).toFixed(1)})">McCovey Cove</text>
<ellipse cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" rx="11" ry="8" fill="rgba(195,125,25,0.65)" stroke="rgba(150,85,10,0.6)" stroke-width="1.4"/>
<ellipse cx="${(gx-4).toFixed(1)}" cy="${(gy-7).toFixed(1)}" rx="5" ry="3.5" fill="rgba(195,125,25,0.6)" stroke="rgba(150,85,10,0.55)" stroke-width="1"/>
<rect x="${(bx-2.5).toFixed(1)}" y="${(by).toFixed(1)}" width="5" height="14" rx="2" fill="rgba(200,25,25,0.72)" stroke="rgba(150,10,10,0.55)" stroke-width="1"/>
<ellipse cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" rx="4.5" ry="3" fill="rgba(200,25,25,0.8)"/>
<rect x="${(bx-1.5).toFixed(1)}" y="${(by-4).toFixed(1)}" width="3" height="5" rx="1" fill="rgba(175,15,15,0.7)"/>`;
    }
    if (pk === 'pnc park') {
      // Roberto Clemente Bridge (golden/yellow) beyond RC wall
      const bx = (cf.x + rc.x)/2 + 18, by = (cf.y + rc.y)/2 - 22;
      const cables = [-16,-9,0,9,16].map(dx=>[
        `<line x1="${(bx-22).toFixed(1)}" y1="${(by-18).toFixed(1)}" x2="${(bx-22+dx).toFixed(1)}" y2="${by.toFixed(1)}" stroke="rgba(215,170,25,0.38)" stroke-width="0.8"/>`,
        `<line x1="${(bx+22).toFixed(1)}" y1="${(by-18).toFixed(1)}" x2="${(bx+22-dx).toFixed(1)}" y2="${by.toFixed(1)}" stroke="rgba(215,170,25,0.38)" stroke-width="0.8"/>`
      ].join('')).join('');
      return `<line x1="${(bx-42).toFixed(1)}" y1="${by.toFixed(1)}" x2="${(bx+42).toFixed(1)}" y2="${by.toFixed(1)}" stroke="rgba(215,170,25,0.7)" stroke-width="2.5"/>
<path d="M ${(bx-42).toFixed(1)},${by.toFixed(1)} Q ${bx.toFixed(1)},${(by-30).toFixed(1)} ${(bx+42).toFixed(1)},${by.toFixed(1)}" fill="none" stroke="rgba(215,170,25,0.6)" stroke-width="2"/>
<line x1="${(bx-22).toFixed(1)}" y1="${(by+4).toFixed(1)}" x2="${(bx-22).toFixed(1)}" y2="${(by-21).toFixed(1)}" stroke="rgba(215,170,25,0.75)" stroke-width="2.5"/>
<line x1="${(bx+22).toFixed(1)}" y1="${(by+4).toFixed(1)}" x2="${(bx+22).toFixed(1)}" y2="${(by-21).toFixed(1)}" stroke="rgba(215,170,25,0.75)" stroke-width="2.5"/>
${cables}`;
    }
    if (pk === 'wrigley field') {
      // CF scoreboard + ivy texture dots on wall
      const dots = wallPts.flatMap((wp, i) => {
        if (i >= wallPts.length - 1) return [];
        const nx = wallPts[i+1];
        return [0.25, 0.5, 0.75].map(t => {
          const x = wp.x + t*(nx.x-wp.x), y = wp.y + t*(nx.y-wp.y);
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="rgba(20,80,30,0.7)"/>`;
        });
      }).join('');
      return `<rect x="${(cf.x-22).toFixed(1)}" y="${(cf.y-28).toFixed(1)}" width="44" height="28" fill="#0e1c0e" stroke="#1c3a1c" stroke-width="1.5" rx="1"/>
<rect x="${(cf.x-18).toFixed(1)}" y="${(cf.y-25).toFixed(1)}" width="36" height="11" fill="#0a140a" stroke="#1a2e1a" stroke-width="0.8"/>
<line x1="${cf.x.toFixed(1)}" y1="${(cf.y-25).toFixed(1)}" x2="${cf.x.toFixed(1)}" y2="${(cf.y-14).toFixed(1)}" stroke="#1a2e1a" stroke-width="0.8"/>
<text x="${cf.x.toFixed(1)}" y="${(cf.y-6).toFixed(1)}" fill="rgba(255,255,255,0.4)" font-family="Arial,sans-serif" font-size="4.5" font-weight="700" text-anchor="middle">WRIGLEY FIELD</text>
${dots}`;
    }
    if (pk === 'camden yards') {
      // B&O Warehouse (brick building beyond RF wall)
      const wx = rf0.x + 14, wy = rf0.y - 42;
      const windows = Array.from({length:5}, (_,row) => Array.from({length:3}, (_,col) =>
        `<rect x="${(wx+4+col*9).toFixed(1)}" y="${(wy+3+row*9).toFixed(1)}" width="6" height="5" fill="rgba(190,145,60,0.35)" rx="0.5"/>`
      ).join('')).join('');
      return `<rect x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="34" height="52" fill="rgba(95,48,28,0.68)" stroke="rgba(70,30,12,0.65)" stroke-width="1.5"/>
${windows}
<text x="${(wx+17).toFixed(1)}" y="${(wy+54).toFixed(1)}" fill="rgba(200,140,70,0.45)" font-family="Arial,sans-serif" font-size="5" font-weight="700" text-anchor="middle">B&amp;O</text>`;
    }
    if (pk === 'coors field') {
      // Rocky Mountains silhouette in the background above CF
      const my = cf.y - 12;
      return `<path d="M 0,${my} L 25,${(my-35).toFixed(1)} L 55,${(my-18).toFixed(1)} L 80,${(my-52).toFixed(1)} L 105,${(my-28).toFixed(1)} L 130,${(my-46).toFixed(1)} L 165,${(my-22).toFixed(1)} L 210,${(my-42).toFixed(1)} L 255,${(my-22).toFixed(1)} L 290,${(my-46).toFixed(1)} L 315,${(my-28).toFixed(1)} L 340,${(my-52).toFixed(1)} L 365,${(my-18).toFixed(1)} L 395,${(my-35).toFixed(1)} L 420,${my} L 420,0 L 0,0 Z" fill="rgba(55,58,88,0.32)"/>
<path d="M 80,${(my-52).toFixed(1)} L 88,${(my-64).toFixed(1)} L 96,${(my-50).toFixed(1)} Z" fill="rgba(225,235,255,0.28)"/>
<path d="M 210,${(my-42).toFixed(1)} L 218,${(my-56).toFixed(1)} L 226,${(my-40).toFixed(1)} Z" fill="rgba(225,235,255,0.28)"/>
<path d="M 340,${(my-52).toFixed(1)} L 348,${(my-64).toFixed(1)} L 356,${(my-50).toFixed(1)} Z" fill="rgba(225,235,255,0.28)"/>`;
    }
    if (pk === 'yankee stadium') {
      // Monument Park in deep CF + short porch in RF
      const mpx = cf.x + 6, mpy = cf.y - 14;
      return `<rect x="${(mpx-12).toFixed(1)}" y="${(mpy-6).toFixed(1)}" width="24" height="10" fill="rgba(0,48,135,0.5)" stroke="rgba(80,110,200,0.4)" stroke-width="1" rx="1"/>
<text x="${mpx.toFixed(1)}" y="${(mpy+2).toFixed(1)}" fill="rgba(200,200,255,0.5)" font-family="Arial,sans-serif" font-size="4" font-weight="700" text-anchor="middle">MONUMENT PARK</text>
<line x1="${(mpx-12).toFixed(1)}" y1="${(mpy-6).toFixed(1)}" x2="${(mpx-12).toFixed(1)}" y2="${(mpy+4).toFixed(1)}" stroke="rgba(200,170,50,0.6)" stroke-width="1.5"/>
<line x1="${(mpx+12).toFixed(1)}" y1="${(mpy-6).toFixed(1)}" x2="${(mpx+12).toFixed(1)}" y2="${(mpy+4).toFixed(1)}" stroke="rgba(200,170,50,0.6)" stroke-width="1.5"/>`;
    }
    if (pk === 'dodger stadium') {
      // Pavilion roofs in LF/RF + mountains beyond
      const my = cf.y - 10;
      return `<path d="M 0,${my} L 40,${(my-22).toFixed(1)} L 90,${(my-12).toFixed(1)} L 150,${(my-28).toFixed(1)} L 210,${(my-15).toFixed(1)} L 270,${(my-28).toFixed(1)} L 330,${(my-12).toFixed(1)} L 380,${(my-22).toFixed(1)} L 420,${my} L 420,0 L 0,0 Z" fill="rgba(48,55,80,0.25)"/>
<rect x="${(lf1.x-18).toFixed(1)}" y="${(lf1.y-6).toFixed(1)}" width="36" height="6" fill="rgba(0,90,156,0.45)" stroke="rgba(50,130,200,0.3)" stroke-width="1" rx="1"/>
<rect x="${(rf1.x-18).toFixed(1)}" y="${(rf1.y-6).toFixed(1)}" width="36" height="6" fill="rgba(0,90,156,0.45)" stroke="rgba(50,130,200,0.3)" stroke-width="1" rx="1"/>`;
    }
    if (pk === 't-mobile park') {
      // Retractable roof outline + waterfall in CF
      const rfx = cf.x - 8, rfy = cf.y - 18;
      return `<rect x="${(rfx-20).toFixed(1)}" y="${(rfy).toFixed(1)}" width="16" height="12" fill="rgba(0,92,92,0.5)" stroke="rgba(0,150,150,0.4)" stroke-width="1" rx="1"/>
<text x="${rfx.toFixed(1)}" y="${(rfy+9).toFixed(1)}" fill="rgba(0,200,200,0.45)" font-family="Arial,sans-serif" font-size="4" font-weight="700" text-anchor="middle">🌊</text>
<line x1="${(rfx-20).toFixed(1)}" y1="${(rfy+1).toFixed(1)}" x2="${(rfx-20).toFixed(1)}" y2="${(rfy+6).toFixed(1)}" stroke="rgba(0,200,200,0.4)" stroke-width="1"/>
<line x1="${(rfx-16).toFixed(1)}" y1="${(rfy+1).toFixed(1)}" x2="${(rfx-16).toFixed(1)}" y2="${(rfy+8).toFixed(1)}" stroke="rgba(0,200,200,0.4)" stroke-width="1"/>
<line x1="${(rfx-12).toFixed(1)}" y1="${(rfy+1).toFixed(1)}" x2="${(rfx-12).toFixed(1)}" y2="${(rfy+5).toFixed(1)}" stroke="rgba(0,200,200,0.4)" stroke-width="1"/>`;
    }
    if (pk === 'minute maid park') {
      // Union Station train track in LF (short porch) + retractable roof
      const tx = lf0.x + 10, ty = lf0.y - 10;
      return `<rect x="${(tx-8).toFixed(1)}" y="${(ty-3).toFixed(1)}" width="24" height="8" fill="rgba(0,45,98,0.55)" stroke="rgba(50,100,180,0.35)" stroke-width="1" rx="1"/>
<line x1="${(tx-4).toFixed(1)}" y1="${(ty-3).toFixed(1)}" x2="${(tx+16).toFixed(1)}" y2="${(ty+5).toFixed(1)}" stroke="rgba(255,200,50,0.5)" stroke-width="1.5"/>
<circle cx="${(tx+2).toFixed(1)}" cy="${(ty+3).toFixed(1)}" r="2.5" fill="rgba(255,200,50,0.6)"/>
<text x="${(tx+8).toFixed(1)}" y="${(ty-5).toFixed(1)}" fill="rgba(200,170,50,0.5)" font-family="Arial,sans-serif" font-size="4" font-weight="700" text-anchor="middle">TRAIN</text>`;
    }
    if (pk === 'target field') {
      // Minneapolis skyline beyond LF
      const bx = (lf0.x + cf.x)/2, by = (lf0.y + cf.y)/2 - 20;
      return `<rect x="${(bx-22).toFixed(1)}" y="${(by-22).toFixed(1)}" width="6" height="22" fill="rgba(50,80,140,0.4)" stroke="rgba(80,120,200,0.25)" stroke-width="0.5"/>
<rect x="${(bx-14).toFixed(1)}" y="${(by-14).toFixed(1)}" width="8" height="14" fill="rgba(50,80,140,0.35)" stroke="rgba(80,120,200,0.25)" stroke-width="0.5"/>
<rect x="${(bx-4).toFixed(1)}" y="${(by-18).toFixed(1)}" width="6" height="18" fill="rgba(50,80,140,0.45)" stroke="rgba(80,120,200,0.25)" stroke-width="0.5"/>
<rect x="${(bx+4).toFixed(1)}" y="${(by-10).toFixed(1)}" width="7" height="10" fill="rgba(50,80,140,0.35)" stroke="rgba(80,120,200,0.25)" stroke-width="0.5"/>`;
    }
    if (pk === 'kauffman stadium') {
      // Fountains beyond the RF wall
      const fx = (cf.x + rf0.x)/2 + 8, fy = (cf.y + rf0.y)/2 + 8;
      return `<ellipse cx="${fx.toFixed(1)}" cy="${(fy+4).toFixed(1)}" rx="22" ry="8" fill="rgba(26,90,160,0.4)" stroke="rgba(50,130,220,0.25)" stroke-width="1"/>
<line x1="${(fx-8).toFixed(1)}" y1="${(fy+4).toFixed(1)}" x2="${(fx-8).toFixed(1)}" y2="${(fy-12).toFixed(1)}" stroke="rgba(150,200,255,0.45)" stroke-width="1.5"/>
<line x1="${fx.toFixed(1)}" y1="${(fy+4).toFixed(1)}" x2="${fx.toFixed(1)}" y2="${(fy-16).toFixed(1)}" stroke="rgba(150,200,255,0.5)" stroke-width="2"/>
<line x1="${(fx+8).toFixed(1)}" y1="${(fy+4).toFixed(1)}" x2="${(fx+8).toFixed(1)}" y2="${(fy-12).toFixed(1)}" stroke="rgba(150,200,255,0.45)" stroke-width="1.5"/>
<text x="${fx.toFixed(1)}" y="${(fy+14).toFixed(1)}" fill="rgba(100,180,255,0.4)" font-family="Arial,sans-serif" font-size="4.5" font-weight="700" text-anchor="middle">FOUNTAINS</text>`;
    }
    if (pk === 'angel stadium') {
      // Rock pile beyond CF + California Angels halo sign
      const rx = cf.x + 12, ry = cf.y - 18;
      return `<circle cx="${rx.toFixed(1)}" cy="${(ry+6).toFixed(1)}" r="8" fill="rgba(100,85,70,0.5)" stroke="rgba(130,110,90,0.4)" stroke-width="1"/>
<circle cx="${(rx-5).toFixed(1)}" cy="${(ry+10).toFixed(1)}" r="5" fill="rgba(100,85,70,0.45)" stroke="rgba(130,110,90,0.35)" stroke-width="1"/>
<circle cx="${(rx+6).toFixed(1)}" cy="${(ry+9).toFixed(1)}" r="6" fill="rgba(100,85,70,0.4)" stroke="rgba(130,110,90,0.35)" stroke-width="1"/>
<text x="${rx.toFixed(1)}" y="${(ry-5).toFixed(1)}" fill="rgba(220,50,50,0.6)" font-family="Arial,sans-serif" font-size="7" font-weight="900" text-anchor="middle">A</text>`;
    }
    if (pk === 'american family field') {
      // Retractable roof arches + slide beyond CF
      const sx = cf.x + 14, sy = cf.y - 12;
      return `<path d="M ${(sx-18).toFixed(1)},${sy.toFixed(1)} Q ${sx.toFixed(1)},${(sy-18).toFixed(1)} ${(sx+18).toFixed(1)},${sy.toFixed(1)}" fill="none" stroke="rgba(20,110,50,0.5)" stroke-width="2.5"/>
<line x1="${sx.toFixed(1)}" y1="${(sy-18).toFixed(1)}" x2="${sx.toFixed(1)}" y2="${(sy+14).toFixed(1)}" stroke="rgba(20,110,50,0.4)" stroke-width="1.5"/>
<text x="${sx.toFixed(1)}" y="${(sy+22).toFixed(1)}" fill="rgba(20,180,70,0.4)" font-family="Arial,sans-serif" font-size="4" font-weight="700" text-anchor="middle">SLIDE</text>`;
    }
    if (pk === 'nationals park') {
      // Washington Monument silhouette beyond CF + outfield berm
      const mx = cf.x, my2 = cf.y - 26;
      return `<rect x="${(mx-3).toFixed(1)}" y="${(my2-24).toFixed(1)}" width="6" height="24" fill="rgba(230,230,220,0.2)" stroke="rgba(230,230,220,0.15)" stroke-width="0.8"/>
<polygon points="${mx.toFixed(1)},${(my2-24).toFixed(1)} ${(mx-4.5).toFixed(1)},${my2.toFixed(1)} ${(mx+4.5).toFixed(1)},${my2.toFixed(1)}" fill="rgba(230,230,220,0.22)"/>
<text x="${mx.toFixed(1)}" y="${(my2+14).toFixed(1)}" fill="rgba(200,200,200,0.3)" font-family="Arial,sans-serif" font-size="3.5" text-anchor="middle">MONUMENT</text>`;
    }
    if (pk === 'tropicana field') {
      // Dome ceiling + catwalks (distinctive A-B-C-D rings)
      return `<ellipse cx="${HX}" cy="${cf.y.toFixed(1)}" rx="155" ry="80" fill="none" stroke="rgba(180,180,220,0.12)" stroke-width="1.5" stroke-dasharray="4,4"/>
<ellipse cx="${HX}" cy="${cf.y.toFixed(1)}" rx="115" ry="58" fill="none" stroke="rgba(180,180,220,0.1)" stroke-width="1" stroke-dasharray="4,4"/>
<ellipse cx="${HX}" cy="${cf.y.toFixed(1)}" rx="75" ry="36" fill="none" stroke="rgba(180,180,220,0.1)" stroke-width="1" stroke-dasharray="3,5"/>
<text x="${HX}" y="${(cf.y - 4).toFixed(1)}" fill="rgba(180,180,220,0.2)" font-family="Arial,sans-serif" font-size="5" text-anchor="middle">TROP DOME</text>`;
    }
    if (pk === 'comerica park') {
      // Tiger statues at main entrance (beyond LF) + ferris wheel beyond RF
      const tx = lf0.x + 10, ty2 = lf0.y - 8;
      const fx = rf0.x - 10, fy2 = rf0.y - 14;
      return `<circle cx="${tx.toFixed(1)}" cy="${ty2.toFixed(1)}" r="5" fill="none" stroke="rgba(250,175,0,0.5)" stroke-width="1.5"/>
<text x="${tx.toFixed(1)}" y="${(ty2+2).toFixed(1)}" fill="rgba(250,175,0,0.6)" font-family="Arial,sans-serif" font-size="6" font-weight="900" text-anchor="middle">🐯</text>
<circle cx="${fx.toFixed(1)}" cy="${fy2.toFixed(1)}" r="9" fill="none" stroke="rgba(250,175,0,0.4)" stroke-width="1.5"/>
<line x1="${(fx-9).toFixed(1)}" y1="${fy2.toFixed(1)}" x2="${(fx+9).toFixed(1)}" y2="${fy2.toFixed(1)}" stroke="rgba(250,175,0,0.3)" stroke-width="0.8"/>
<line x1="${fx.toFixed(1)}" y1="${(fy2-9).toFixed(1)}" x2="${fx.toFixed(1)}" y2="${(fy2+9).toFixed(1)}" stroke="rgba(250,175,0,0.3)" stroke-width="0.8"/>
<text x="${(fx+12).toFixed(1)}" y="${(fy2+3).toFixed(1)}" fill="rgba(250,175,0,0.35)" font-family="Arial,sans-serif" font-size="3.5">WHEEL</text>`;
    }
    if (pk === 'busch stadium') {
      // Gateway Arch silhouette beyond CF
      const ax = cf.x, ay = cf.y - 16;
      return `<path d="M ${(ax-20).toFixed(1)},${ay.toFixed(1)} Q ${(ax-14).toFixed(1)},${(ay-32).toFixed(1)} ${ax.toFixed(1)},${(ay-36).toFixed(1)} Q ${(ax+14).toFixed(1)},${(ay-32).toFixed(1)} ${(ax+20).toFixed(1)},${ay.toFixed(1)}" fill="none" stroke="rgba(190,160,100,0.5)" stroke-width="2"/>
<text x="${ax.toFixed(1)}" y="${(ay+8).toFixed(1)}" fill="rgba(190,160,100,0.35)" font-family="Arial,sans-serif" font-size="4" text-anchor="middle">GATEWAY ARCH</text>`;
    }
    if (pk === 'guaranteed rate field') {
      // Exploding scoreboard in RF (White Sox signature)
      const sx = rf1.x + 8, sy2 = rf1.y - 18;
      const sparks = [-10,-5,0,5,10].map(dx=>
        `<line x1="${sx.toFixed(1)}" y1="${(sy2-10).toFixed(1)}" x2="${(sx+dx).toFixed(1)}" y2="${(sy2-20+Math.abs(dx)).toFixed(1)}" stroke="rgba(255,150,50,0.45)" stroke-width="1.2"/>`
      ).join('');
      return `<rect x="${(sx-12).toFixed(1)}" y="${(sy2-8).toFixed(1)}" width="24" height="14" fill="rgba(20,20,20,0.65)" stroke="rgba(80,80,80,0.4)" stroke-width="1" rx="1"/>
<text x="${sx.toFixed(1)}" y="${(sy2+2).toFixed(1)}" fill="rgba(255,150,50,0.55)" font-family="Arial,sans-serif" font-size="4.5" font-weight="900" text-anchor="middle">SCORE</text>
${sparks}`;
    }
    if (pk === 'citizens bank park') {
      // Liberty Bell replica beyond CF + Phanatic mascot area
      const bx = cf.x - 6, by2 = cf.y - 20;
      return `<path d="M ${(bx-6).toFixed(1)},${(by2-2).toFixed(1)} Q ${(bx-8).toFixed(1)},${(by2-16).toFixed(1)} ${bx.toFixed(1)},${(by2-18).toFixed(1)} Q ${(bx+8).toFixed(1)},${(by2-16).toFixed(1)} ${(bx+6).toFixed(1)},${(by2-2).toFixed(1)}" fill="rgba(190,155,65,0.4)" stroke="rgba(190,155,65,0.35)" stroke-width="1.2"/>
<line x1="${(bx-7).toFixed(1)}" y1="${(by2-2).toFixed(1)}" x2="${(bx+7).toFixed(1)}" y2="${(by2-2).toFixed(1)}" stroke="rgba(190,155,65,0.45)" stroke-width="1.5"/>
<line x1="${bx.toFixed(1)}" y1="${(by2-18).toFixed(1)}" x2="${(bx+8).toFixed(1)}" y2="${(by2-24).toFixed(1)}" stroke="rgba(190,155,65,0.35)" stroke-width="1"/>
<text x="${(bx+2).toFixed(1)}" y="${(by2+8).toFixed(1)}" fill="rgba(190,155,65,0.35)" font-family="Arial,sans-serif" font-size="3.5" text-anchor="middle">LIBERTY BELL</text>`;
    }
    if (pk === 'truist park') {
      // Cumberland River area + Battery (mixed-use district) beyond LF
      const dx = (lf0.x + cf.x)/2 + 4, dy = (lf0.y + cf.y)/2 - 10;
      return `<rect x="${(dx-16).toFixed(1)}" y="${(dy-8).toFixed(1)}" width="10" height="12" fill="rgba(0,120,180,0.35)" stroke="rgba(0,160,230,0.25)" stroke-width="0.8" rx="1"/>
<rect x="${(dx-4).toFixed(1)}" y="${(dy-5).toFixed(1)}" width="10" height="9" fill="rgba(0,120,180,0.3)" stroke="rgba(0,160,230,0.25)" stroke-width="0.8" rx="1"/>
<rect x="${(dx+8).toFixed(1)}" y="${(dy-10).toFixed(1)}" width="8" height="14" fill="rgba(0,120,180,0.4)" stroke="rgba(0,160,230,0.25)" stroke-width="0.8" rx="1"/>
<text x="${dx.toFixed(1)}" y="${(dy+12).toFixed(1)}" fill="rgba(0,160,230,0.3)" font-family="Arial,sans-serif" font-size="3.5" text-anchor="middle">THE BATTERY</text>`;
    }
    if (pk === 'progressive field') {
      // Cleveland skyline + Home Run Porch
      const bx2 = (lf0.x + cf.x)/2, by3 = (lf0.y + cf.y)/2 - 18;
      return `<rect x="${(bx2-20).toFixed(1)}" y="${(by3-18).toFixed(1)}" width="5" height="18" fill="rgba(230,60,30,0.35)" stroke="rgba(200,50,20,0.25)" stroke-width="0.5"/>
<rect x="${(bx2-13).toFixed(1)}" y="${(by3-12).toFixed(1)}" width="7" height="12" fill="rgba(230,60,30,0.3)" stroke="rgba(200,50,20,0.25)" stroke-width="0.5"/>
<rect x="${(bx2-4).toFixed(1)}" y="${(by3-20).toFixed(1)}" width="6" height="20" fill="rgba(230,60,30,0.4)" stroke="rgba(200,50,20,0.25)" stroke-width="0.5"/>
<rect x="${(bx2+4).toFixed(1)}" y="${(by3-14).toFixed(1)}" width="5" height="14" fill="rgba(230,60,30,0.3)" stroke="rgba(200,50,20,0.25)" stroke-width="0.5"/>
<rect x="${(bx2+11).toFixed(1)}" y="${(by3-10).toFixed(1)}" width="7" height="10" fill="rgba(230,60,30,0.25)" stroke="rgba(200,50,20,0.25)" stroke-width="0.5"/>`;
    }
    return '';
  })()}

  <!-- Vignette overlay -->
  <rect width="420" height="380" fill="url(#bp-vignette)" rx="8"/>

  <!-- Distance labels -->
  ${distLabel(wallDists[0], -45)}
  ${distLabel(wallDists[3], 0)}
  ${distLabel(wallDists[6], 45)}

  <!-- Venue name -->
  ${name ? `<text x="210" y="20" fill="rgba(255,255,255,0.6)" font-family="Arial,sans-serif" font-size="11" font-weight="600" text-anchor="middle" letter-spacing="1">${name.toUpperCase()}</text>` : ''}

  <!-- Turf type badge -->
  ${fi.turfType ? `<text x="210" y="372" fill="rgba(255,255,255,0.35)" font-family="Arial,sans-serif" font-size="9" text-anchor="middle">${fi.turfType}</text>` : ''}
</svg>`;
}

// ── Full pitch zone SVG ────────────────────────────────────────
// Uses innerHTML strings (same as mini view) to avoid SVG namespace
// issues with createElementNS — this is why the mini view worked
// while the full view wasn't rendering dots.
function renderFullPitchZone(pitchEvents, szTop, szBot, prevCount=0) {
  const cfg = ZONE.full;
  const szLeft  = cfg.cx - cfg.hw * cfg.scale;
  const szRight = cfg.cx + cfg.hw * cfg.scale;
  const szW     = szRight - szLeft;
  const top     = szY(szTop, cfg);
  const bot     = szY(szBot, cfg);
  const szH     = bot - top;

  // Update sz-box position/size
  const szBox = $('sz-box');
  if (szBox) {
    szBox.setAttribute('x',      szLeft.toFixed(1));
    szBox.setAttribute('y',      top.toFixed(1));
    szBox.setAttribute('width',  szW.toFixed(1));
    szBox.setAttribute('height', szH.toFixed(1));
  }

  // 9-zone grid lines as SVG string
  const thW = szW/3, thH = szH/3;
  let gridHtml = '';
  for (let i=1; i<=2; i++) {
    const lx = (szLeft + thW*i).toFixed(1), ly = (top + thH*i).toFixed(1);
    gridHtml += `<line x1="${lx}" y1="${top.toFixed(1)}" x2="${lx}" y2="${bot.toFixed(1)}" stroke="#4a90d9" stroke-opacity="0.22" stroke-width="1" stroke-dasharray="4,4"/>`;
    gridHtml += `<line x1="${szLeft.toFixed(1)}" y1="${ly}" x2="${szRight.toFixed(1)}" y2="${ly}" stroke="#4a90d9" stroke-opacity="0.22" stroke-width="1" stroke-dasharray="4,4"/>`;
  }
  const szGrid = $('sz-grid');
  if (szGrid) szGrid.innerHTML = gridHtml;

  // Pitch dots as SVG string
  const legendTypes = new Map();
  let dotsHtml = '';

  pitchEvents.forEach((event, idx) => {
    const coords = event.pitchData?.coordinates;
    if (coords?.pX == null || coords?.pZ == null) return;
    const pX = parseFloat(coords.pX), pZ = parseFloat(coords.pZ);
    if (isNaN(pX) || isNaN(pZ)) return;

    const {x, y} = toSvg(pX, pZ, cfg);
    const typeCode = event.details?.type?.code || '';
    const { label, color } = pitchInfo(typeCode);
    const result  = event.details?.call?.description || '';
    const speed   = event.pitchData?.startSpeed;
    const opacity = (0.45 + (idx / Math.max(pitchEvents.length, 1)) * 0.55).toFixed(2);
    const isNew    = idx >= prevCount;
    const isLatest = idx === pitchEvents.length - 1;
    legendTypes.set(typeCode || '?', { label, color });

    if (isLatest) {
      dotsHtml += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${cfg.dotR+5}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.5" class="pitch-latest-ring"/>`;
    }
    dotsHtml += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${cfg.dotR}" fill="${color}" fill-opacity="${opacity}" stroke="#000" stroke-width="1.5" style="cursor:pointer"${isNew ? ' class="pitch-new"' : ''}>
      <title>#${idx+1} ${label}${speed ? ' '+speed.toFixed(1)+'mph' : ''} — ${result}</title></circle>`;
    dotsHtml += `<text x="${x.toFixed(2)}" y="${(y+4).toFixed(2)}" text-anchor="middle" fill="#fff" font-size="8" font-weight="bold" pointer-events="none">${idx+1}</text>`;
  });

  const pitchDots = $('pitch-dots');
  if (pitchDots) pitchDots.innerHTML = dotsHtml;

  // Legend
  const legend = $('pitch-legend');
  if (legend) {
    legend.innerHTML = [...legendTypes.entries()].map(([, {label, color}]) =>
      `<div class="legend-item"><span class="legend-dot" style="background:${color}"></span>${label}</div>`
    ).join('');
  }
}

// ── At-bat events log (column 1) ──────────────────────────────
function renderAtBatLog(play) {
  if (!play) {
    if ($('gd-atbat-desc')) $('gd-atbat-desc').textContent = '—';
    if ($('gd-atbat-events')) $('gd-atbat-events').innerHTML = '';
    return;
  }
  const bName = play.matchup?.batter?.fullName?.split(' ').pop()  || '—';
  const pName = play.matchup?.pitcher?.fullName?.split(' ').pop() || '—';
  const desc = $('gd-atbat-desc');
  if (desc) desc.textContent = `${bName} vs ${pName}`;

  const events = (play.playEvents || []).filter(e =>
    (e.type === 'pitch' && e.details?.description) || (e.type === 'action' && e.details?.description)
  );
  const evEl = $('gd-atbat-events');
  if (!evEl) return;
  evEl.innerHTML = events.map((e, i) => {
    const d    = e.details?.description || '';
    const speed = e.pitchData?.startSpeed;
    const isBall   = /^ball/i.test(d) && !/foul/i.test(d);
    const isStrike = /strike|swinging|called|foul/i.test(d);
    const isHit    = /\b(single|double|triple|homer|home run|hit)\b/i.test(d);
    const cls = isHit ? 'ab-hit' : isStrike ? 'ab-strike' : isBall ? 'ab-ball' : 'ab-other';
    // Shorten common descriptions
    const short = d.replace('Swinging Strike', 'Swing K')
                   .replace('Called Strike', 'Called K')
                   .replace('Foul Ball', 'Foul')
                   .replace('Automatic Ball', 'Auto B');
    return `<div class="ab-event ${cls}">
      <span class="ab-num">${i+1}</span>
      <span class="ab-desc" title="${d}">${short}</span>
      ${speed ? `<span class="ab-speed">${speed.toFixed(0)}</span>` : '<span></span>'}
    </div>`;
  }).join('');
}

// ── Count / outs display ───────────────────────────────────────
function updateCountDisplay(balls, strikes, outs) {
  $('count-balls').querySelectorAll('.cdot').forEach((d,i) =>
    d.className = `cdot${i<balls ? ' on-ball' : ''}`);
  $('count-strikes').querySelectorAll('.cdot').forEach((d,i) =>
    d.className = `cdot${i<strikes ? ' on-strike' : ''}`);
  $('count-outs').querySelectorAll('.cdot').forEach((d,i) =>
    d.className = `cdot${i<outs ? ' on-out' : ''}`);
}

// ── Base diamond ───────────────────────────────────────────────
function updateBases(offense) {
  const on1 = !!offense.first, on2 = !!offense.second, on3 = !!offense.third;
  setBaseColor('base-1', on1);
  setBaseColor('base-2', on2);
  setBaseColor('base-3', on3);
  const runners = [];
  if (on3) runners.push(offense.third?.fullName || 'Runner');
  if (on2) runners.push(offense.second?.fullName || 'Runner');
  if (on1) runners.push(offense.first?.fullName  || 'Runner');
  $('gd-bases-label').textContent = runners.length ? runners.join(', ') : 'Bases empty';
}
function setBaseColor(id, occupied) {
  const el = $(id);
  if (el) el.classList.toggle('base-occupied', occupied);
}

// ── Pitch sequence list ────────────────────────────────────────
function renderPitchSequence(pitchEvents) {
  const list = $('pitch-seq-list');
  list.innerHTML = '';
  const total = pitchEvents.length;
  [...pitchEvents].reverse().forEach((event, revIdx) => {
    const idx = total - 1 - revIdx;
    const typeCode = event.details?.type?.code || '';
    const { color } = pitchInfo(typeCode);
    const result = event.details?.call?.description || '—';
    const speed  = event.pitchData?.startSpeed;
    const item = document.createElement('div');
    item.className = 'pitch-seq-item';
    item.innerHTML = `
      <span class="psi-num">${idx+1}</span>
      <span class="psi-type" style="color:${color}">${typeCode||'?'}</span>
      <span class="psi-desc">${result}</span>
      <span class="psi-speed">${speed ? speed.toFixed(1)+'mph' : ''}</span>`;
    list.appendChild(item);
  });
}

// ── Recent plays ───────────────────────────────────────────────
function renderRecentPlays(plays) {
  const list = $('gd-plays-list');
  list.innerHTML = '';
  plays.forEach(play => {
    const event  = play.result?.event || '';
    const desc   = play.result?.description || event || '—';
    const inning = play.about?.inning;
    const half   = play.about?.halfInning === 'top' ? '▲' : '▼';
    const rbi    = play.result?.rbi;
    const isOut  = play.result?.isOut;
    const evtCls = event.includes('Home Run') ? 'play-hr'
                 : /Single|Double|Triple/.test(event) ? 'play-hit'
                 : event.includes('Walk') || event.includes('Hit By') ? 'play-walk'
                 : isOut ? 'play-out' : '';
    const item   = document.createElement('div');
    item.className = `play-item ${evtCls}`;
    item.innerHTML = `
      <span class="play-inning">${inning ? `${half}${inning}` : ''}</span>
      <span class="play-desc">${desc}</span>
      ${rbi > 0 ? `<span class="play-score-delta">+${rbi}</span>` : ''}`;
    list.appendChild(item);
  });
}

async function attachPlayVideos(gamePk, plays) {
  if (!state.gameHighlights) state.gameHighlights = {};
  let highlights;
  if (state.gameHighlights[gamePk]) {
    highlights = state.gameHighlights[gamePk];
  } else {
    highlights = await loadPostGameHighlights(gamePk);
    state.gameHighlights[gamePk] = highlights;
  }
  if (!highlights || !highlights.length) return;

  // Attach to recent plays list (live tab)
  const list = $('gd-plays-list');
  if (list) {
    const items = list.querySelectorAll('.play-item');
    items.forEach((item, idx) => {
      const play = plays[idx];
      if (!play) return;
      const event  = play.result?.event || '';
      const rbi    = play.result?.rbi || 0;
      const batter = play.matchup?.batter?.fullName || '';
      const pid    = play.matchup?.batter?.id;
      const qualify = /Single|Double|Triple|Home Run|Stolen Base|Caught Stealing/.test(event) || rbi > 0;
      if (!qualify) return;
      if (item.querySelector('.play-watch-btn')) return;
      const hl = findHighlightForPlay(highlights, batter, pid, event);
      if (!hl) return;
      const btn = document.createElement('button');
      btn.className = 'play-watch-btn';
      btn.textContent = '▶';
      btn.onclick = e => { e.stopPropagation(); openVideoModal(hl.videoUrl, hl.title); };
      item.appendChild(btn);
    });
  }

  // Attach to box score play-by-play
  const pbpList = $('gd-boxscore-content');
  if (pbpList) {
    pbpList.querySelectorAll('.pbp-play[data-pbp-batter]').forEach(item => {
      if (item.querySelector('.pbp-watch-btn')) return;
      const batter = item.dataset.pbpBatter || '';
      const pid    = item.dataset.pbpPid    || '';
      const event  = item.dataset.pbpEvent  || '';
      const hl = findHighlightForPlay(highlights, batter, pid, event);
      if (!hl) return;
      const btn = document.createElement('button');
      btn.className = 'pbp-watch-btn';
      btn.textContent = '▶';
      btn.title = hl.title;
      btn.onclick = e => { e.stopPropagation(); openVideoModal(hl.videoUrl, hl.title); };
      const row = item.querySelector('.pbp-event-row');
      if (row) row.appendChild(btn);
    });
  }
}

// ── Win probability chart ──────────────────────────────────────
async function fetchWinProbability(gamePk) {
  try {
    const data = await apiFetch(`${MLB_API}/game/${gamePk}/winProbability`);
    if (Array.isArray(data) && data.length >= 3) return data;
    return null;
  } catch { return null; }
}

function buildWpaChart(ls, awayAbbr, homeAbbr, awayId, homeId, wpApiData = null, allPlays = []) {
  if (!ls?.innings?.length) return '';
  const inn = ls.innings;
  const W = 600, H = 120, PAD = 28, INNER_H = H - 10;

  let points;
  if (wpApiData && wpApiData.length >= 3) {
    // Use MLB API win probability data (real model, not approximation)
    points = [{ x: 0, wp: 0.5 }];
    wpApiData.forEach((entry, idx) => {
      const wp = entry.homeTeamWinProbability;
      if (wp == null) return;
      points.push({ x: (idx + 1) / wpApiData.length, wp: parseFloat(wp) / 100 });
    });
  } else {
    // Try extracting WP from play data
    const playsWithWP = allPlays.filter(p =>
      p.about?.homeTeamWinProbability != null ||
      p.about?.homeTeamWinProbabilityAfterPlay != null ||
      p.about?.homeTeamWinProbabilityBeforePlay != null
    );
    if (playsWithWP.length >= 3) {
      points = [{ x: 0, wp: 0.5 }];
      allPlays.forEach((play, idx) => {
        const wp = play.about?.homeTeamWinProbability ??
                   play.about?.homeTeamWinProbabilityAfterPlay ??
                   play.about?.homeTeamWinProbabilityBeforePlay;
        if (wp == null) return;
        points.push({ x: (idx + 1) / allPlays.length, wp: parseFloat(wp) / 100 });
      });
    } else {
      // Fall back to inning-score approximation
      points = [{ x: 0, wp: 0.5 }];
      let aRuns = 0, hRuns = 0, halfIdx = 0;
      const approxWP = (diff, halfInningsRemaining) => {
        const k = Math.max(1, halfInningsRemaining);
        const z = diff * 1.4 / Math.sqrt(k);
        return 0.5 + 0.5 * Math.tanh(z * 0.85);
      };
      const totalHalves = inn.length * 2;
      inn.forEach((inning) => {
        if (inning.away?.runs != null) {
          aRuns += inning.away.runs;
          halfIdx++;
          points.push({ x: halfIdx / totalHalves, wp: approxWP(hRuns - aRuns, totalHalves - halfIdx) });
        }
        if (inning.home?.runs != null) {
          hRuns += inning.home.runs;
          halfIdx++;
          points.push({ x: halfIdx / totalHalves, wp: approxWP(hRuns - aRuns, Math.max(0, totalHalves - halfIdx)) });
        }
      });
    }
  }

  if (points.length < 2) return '';

  const awayColor = TEAM_COLORS[awayId] || '#4299e1';
  const homeColor = TEAM_COLORS[homeId] || '#48bb78';

  const toX = t => PAD + t * (W - PAD * 2);
  const toY = wp => INNER_H * (1 - wp);

  const polyPtsHome = [`${toX(0)},${toY(0.5)}`,
    ...points.map(p => `${toX(p.x).toFixed(1)},${toY(p.wp).toFixed(1)}`),
    `${toX(points[points.length-1].x).toFixed(1)},${toY(0.5)}` ];
  const polyPtsAway = [`${toX(0)},${toY(0.5)}`,
    ...points.map(p => `${toX(p.x).toFixed(1)},${toY(p.wp).toFixed(1)}`),
    `${toX(points[points.length-1].x).toFixed(1)},${toY(0.5)}` ];

  const linePts = points.map(p => `${toX(p.x).toFixed(1)},${toY(p.wp).toFixed(1)}`).join(' ');
  const midY = toY(0.5);

  // Inning dividers
  const dividers = inn.map((_, i) => {
    const x = toX((i + 1) / inn.length);
    return `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${INNER_H}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
  }).join('');

  return `<div class="wpa-chart-wrap">
    <div class="wpa-chart-title">Win Probability</div>
    <svg class="wpa-chart-svg" viewBox="0 0 ${W} ${H}" height="${H}">
      <defs>
        <clipPath id="wpa-above"><rect x="${PAD}" y="0" width="${W-PAD*2}" height="${midY.toFixed(1)}"/></clipPath>
        <clipPath id="wpa-below"><rect x="${PAD}" y="${midY.toFixed(1)}" width="${W-PAD*2}" height="${(INNER_H-midY).toFixed(1)}"/></clipPath>
      </defs>
      <!-- Inning dividers -->
      ${dividers}
      <!-- 50% center line -->
      <line x1="${PAD}" y1="${midY.toFixed(1)}" x2="${(W-PAD).toFixed(1)}" y2="${midY.toFixed(1)}" stroke="rgba(255,255,255,0.2)" stroke-width="1" stroke-dasharray="3,3"/>
      <!-- Home team fill (above 50%) -->
      <polygon points="${polyPtsHome.join(' ')}" fill="${homeColor}" opacity="0.25" clip-path="url(#wpa-above)"/>
      <!-- Away team fill (below 50%) -->
      <polygon points="${polyPtsAway.join(' ')}" fill="${awayColor}" opacity="0.25" clip-path="url(#wpa-below)"/>
      <!-- WP line -->
      <polyline points="${linePts}" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="1.5" stroke-linejoin="round"/>
      <!-- Labels -->
      <text x="4" y="${(midY - 3).toFixed(1)}" fill="${homeColor}" font-family="Arial,sans-serif" font-size="8" font-weight="700">${homeAbbr}</text>
      <text x="4" y="${(midY + 10).toFixed(1)}" fill="${awayColor}" font-family="Arial,sans-serif" font-size="8" font-weight="700">${awayAbbr}</text>
    </svg>
  </div>`;
}

// ============================================================
// BOX SCORE TAB
// ============================================================

function buildLinescoreBanner(data) {
  const ls = data.liveData?.linescore;
  const gd = data.gameData;
  if (!ls) return '';

  const awayId    = gd?.teams?.away?.id;
  const homeId    = gd?.teams?.home?.id;
  const awayName  = gd?.teams?.away?.name || gd?.teams?.away?.abbreviation || 'Away';
  const homeName  = gd?.teams?.home?.name || gd?.teams?.home?.abbreviation || 'Home';
  const awayColor = TEAM_COLORS[awayId] || '#1a2332';
  const homeColor = TEAM_COLORS[homeId] || '#c0392b';

  const played     = ls.innings || [];
  const currentInn = ls.currentInning || 0;
  const isLive     = gd?.status?.abstractGameState === 'Live';
  const isFinal    = gd?.status?.abstractGameState === 'Final';

  const status = isFinal ? 'Final'
               : isLive  ? `${ls.inningHalf === 'Top' ? '▲' : '▼'}${currentInn}`
               : 'Preview';

  // Always show at least 9 columns; expand for extra innings
  const totalInnings = Math.max(9, played.length, currentInn);
  const totCell = val => `<td class="gd-ls-tot">${val ?? 0}</td>`;

  let innHeaders = '', awayRun = '', homeRun = '';
  for (let n = 1; n <= totalInnings; n++) {
    const inn       = played.find(i => +i.num === n);
    const active    = isLive && n === currentInn;
    const activeCls = active ? ' gd-ls-inn-active' : '';

    innHeaders += `<th class="gd-ls-inn-hdr${activeCls}">${n}</th>`;

    if (inn) {
      awayRun += `<td class="gd-ls-cell${activeCls}">${inn.away?.runs ?? (inn.away ? 0 : '')}</td>`;
      homeRun += `<td class="gd-ls-cell${activeCls}">${inn.home?.runs ?? (inn.home ? 'X' : '')}</td>`;
    } else {
      awayRun += `<td class="gd-ls-cell${activeCls}"></td>`;
      homeRun += `<td class="gd-ls-cell${activeCls}"></td>`;
    }
  }

  return `<div class="gd-linescore-banner">
    <table class="gd-ls-table">
      <thead>
        <tr>
          <th class="gd-ls-status">${status}</th>
          ${innHeaders}
          <th class="gd-ls-tot-hdr">R</th>
          <th class="gd-ls-tot-hdr">H</th>
          <th class="gd-ls-tot-hdr">E</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="gd-ls-team-cell" style="background:${awayColor}">
            <img src="${TEAM_LOGO(awayId)}" onerror="this.style.display='none'"/>
            <span>${awayName}</span>
          </td>
          ${awayRun}
          ${totCell(ls.teams?.away?.runs)}
          ${totCell(ls.teams?.away?.hits)}
          ${totCell(ls.teams?.away?.errors)}
        </tr>
        <tr>
          <td class="gd-ls-team-cell" style="background:${homeColor}">
            <img src="${TEAM_LOGO(homeId)}" onerror="this.style.display='none'"/>
            <span>${homeName}</span>
          </td>
          ${homeRun}
          ${totCell(ls.teams?.home?.runs)}
          ${totCell(ls.teams?.home?.hits)}
          ${totCell(ls.teams?.home?.errors)}
        </tr>
      </tbody>
    </table>
  </div>`;
}

function renderGdBoxScore(data) {
  const box = data.liveData?.boxscore, gd = data.gameData;
  const plays = data.liveData?.plays;
  const con = $('gd-boxscore-content');
  if (!box) { con.innerHTML='<div class="empty-state"><strong>Not available</strong></div>'; return; }

  const awayAbbr = gd?.teams?.away?.abbreviation || 'AWY';
  const homeAbbr = gd?.teams?.home?.abbreviation || 'HME';
  const awayId   = gd?.teams?.away?.id;
  const homeId   = gd?.teams?.home?.id;
  const gamePk = state.selectedGamePk;
  const linescoreBanner = buildLinescoreBanner(data);

  // ── Left column: play-by-play ──
  const allPlays = (plays?.allPlays || []).filter(p => p.result?.event);
  // Sort newest → oldest
  const sortedPlays = [...allPlays].reverse();

  let pbpHtml = '';
  let currentInningLabel = '';
  sortedPlays.forEach(play => {
    const inning = play.about?.inning;
    const half   = play.about?.halfInning === 'top' ? '▲' : '▼';
    const label  = `${half} ${inning}`;
    if (label !== currentInningLabel) {
      pbpHtml += `<div class="pbp-inning-divider">${label === '▲ undefined' ? '' : label} INNING</div>`;
      currentInningLabel = label;
    }
    const event  = play.result?.event || '';
    const desc   = play.result?.description || event;
    const isOut  = play.result?.isOut;
    const rbi    = play.result?.rbi || 0;
    const batter = play.matchup?.batter?.fullName || '';
    const pid    = play.matchup?.batter?.id;
    const scored  = play.runners?.some(r => r.movement?.end === 'score') ?? false;
    const evtClass = event.includes('Home Run') ? 'pbp-hr'
                   : event.includes('Single') || event.includes('Double') || event.includes('Triple') ? 'pbp-hit'
                   : /Stolen Base|Caught Stealing/.test(event) ? 'pbp-walk'
                   : isOut ? 'pbp-out'
                   : event.includes('Walk') || event.includes('Hit By') ? 'pbp-walk'
                   : '';
    const qualify = /Single|Double|Triple|Home Run|Stolen Base|Caught Stealing/.test(event) || rbi > 0 || scored;
    pbpHtml += `<div class="pbp-play ${evtClass}"${qualify&&batter?` data-pbp-batter="${batter.replace(/"/g,'&quot;')}" data-pbp-event="${event.replace(/"/g,'&quot;')}"${pid?` data-pbp-pid="${pid}"`:''}`:''}>
      <div class="pbp-event-row">
        <span class="pbp-event">${event}</span>
        ${rbi > 0 ? `<span class="pbp-rbi">${rbi} RBI</span>` : ''}
      </div>
      <div class="pbp-desc">${desc}</div>
      ${batter ? `<div class="pbp-batter"${pid ? ` data-pid="${pid}" data-name="${batter}"` : ''}>${batter}</div>` : ''}
    </div>`;
  });

  if (!pbpHtml) pbpHtml = '<div class="pbp-empty">No plays yet</div>';

  const battingCols = [], pitchingCols = [];
  for (const [side, abbr, teamId] of [['away',awayAbbr,awayId],['home',homeAbbr,homeId]]) {
    const team = box.teams?.[side];
    if (!team) { battingCols.push(''); pitchingCols.push(''); continue; }
    const batters  = buildBattersList(team);
    const pitchers = buildPitchersList(team, box.info);

    let batHtml = '';
    if (batters.length) {
      batHtml = `<div class="bs-section"><div class="bs-section-title">
        ${teamId?`<img class="bs-team-logo-sm" src="${TEAM_LOGO(teamId)}" onerror="this.style.display='none'"/>`:''}
        ${abbr} Batting</div>
        <table class="bs-table"><thead><tr>
          <th style="text-align:left">Player</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>SO</th><th>AVG</th>
        </tr></thead><tbody>
          ${batters.map(p=>`<tr class="${p.isSub?'bs-sub-row':''}">
            <td data-pid="${p.id}" data-name="${p.name}" class="player-link">
              ${p.isSub
                ? `<span class="sub-tag">${p.subType}</span>`
                : (p.order&&p.order<99?`<span style="color:var(--text-muted);font-size:0.62rem;font-family:monospace">${p.order}. </span>`:'')}
              <span style="font-size:0.62rem;color:var(--accent-red);font-weight:700;margin-right:3px">${p.pos}</span>${p.name}
            </td>
            <td>${fmt(p.ab)}</td><td>${fmt(p.r)}</td><td>${fmt(p.h)}</td><td>${fmt(p.rbi)}</td><td>${fmt(p.bb)}</td><td>${fmt(p.so)}</td><td>${fmtAvg(p.avg)}</td>
          </tr>`).join('')}
          <tr class="totals-row"><td>Totals</td>
            <td>${batters.filter(p=>!p.isSub||p.subType==='PH').reduce((s,p)=>s+(p.ab||0),0)}</td>
            <td>${batters.reduce((s,p)=>s+(p.r||0),0)}</td>
            <td>${batters.reduce((s,p)=>s+(p.h||0),0)}</td>
            <td>${batters.reduce((s,p)=>s+(p.rbi||0),0)}</td>
            <td>${batters.reduce((s,p)=>s+(p.bb||0),0)}</td>
            <td>${batters.reduce((s,p)=>s+(p.so||0),0)}</td>
            <td>—</td>
          </tr>
        </tbody></table></div>`;
    }
    battingCols.push(batHtml);

    let pitHtml = '';
    if (pitchers.length) {
      pitHtml = `<div class="bs-section"><div class="bs-section-title">
        ${teamId?`<img class="bs-team-logo-sm" src="${TEAM_LOGO(teamId)}" onerror="this.style.display='none'"/>`:''}
        ${abbr} Pitching</div>
        <table class="bs-table"><thead><tr>
          <th style="text-align:left">Pitcher</th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>SO</th><th>ERA</th>
        </tr></thead><tbody>
          ${pitchers.map(p=>`<tr class="${p.note?p.note+'-pitcher':''}">
            <td data-pid="${p.id}" data-name="${p.name}" class="player-link">${p.name}${p.note?` <span style="font-size:0.6rem;color:var(--text-muted)">${p.note==='winning'?'(W)':p.note==='losing'?'(L)':'(SV)'}</span>`:''}</td>
            <td>${fmt(p.ip)}</td><td>${fmt(p.h)}</td><td>${fmt(p.r)}</td><td>${fmt(p.er)}</td><td>${fmt(p.bb)}</td><td>${fmt(p.so)}</td><td>${p.era}</td>
          </tr>`).join('')}
        </tbody></table></div>`;
    }
    pitchingCols.push(pitHtml);
  }

  // Preserve PBP scroll position across polls
  const prevPbpScroll = $('gd-boxscore-content')?.querySelector('.bs-pbp-list')?.scrollTop ?? 0;

  con.innerHTML = `
    ${linescoreBanner}
    <div class="bs-layout">
      <div class="bs-pbp-col">
        <div class="bs-col-header">PLAY BY PLAY</div>
        <div class="bs-pbp-list">${pbpHtml}</div>
      </div>
      <div class="bs-box-col">
        <div class="bs-teams-grid">
          <div class="bs-team-col">${battingCols[0]||''}</div>
          <div class="bs-team-col">${battingCols[1]||''}</div>
        </div>
        <div class="bs-pitching-grid">
          <div class="bs-team-col">${pitchingCols[0]||''}</div>
          <div class="bs-team-col">${pitchingCols[1]||''}</div>
        </div>
      </div>
    </div>`;

  // Restore PBP scroll position (prevents auto-jump to top on polls)
  if (prevPbpScroll > 0) {
    const pbpEl = con.querySelector('.bs-pbp-list');
    if (pbpEl) pbpEl.scrollTop = prevPbpScroll;
  }

  con.querySelectorAll('.player-link[data-pid]').forEach(el =>
    el.addEventListener('click', () => openPlayerProfile(parseInt(el.dataset.pid), el.dataset.name, state.selectedGamePk)));
  con.querySelectorAll('.pbp-batter[data-pid]').forEach(el =>
    el.addEventListener('click', () => openPlayerProfile(parseInt(el.dataset.pid), el.dataset.name, state.selectedGamePk)));

  // Attach video buttons to qualifying PBP plays
  if (gamePk) {
    const allPlaysList = (plays?.allPlays || []).filter(p => p.result?.event);
    attachPlayVideos(gamePk, allPlaysList);
  }
}

function buildBattersList(team) {
  if (!team?.batters?.length) return [];
  return team.batters.map(pid => {
    const p = team.players?.[`ID${pid}`];
    if (!p) return null;
    const b=p.stats?.batting||{}, s=p.seasonStats?.batting||{};
    const rawOrder = p.battingOrder ? parseInt(p.battingOrder) : 9900;
    const order = Math.floor(rawOrder / 100);
    const subIndex = rawOrder % 100;
    const isSub = subIndex > 0;
    const pos = p.position?.abbreviation || '?';
    const subType = isSub ? (pos === 'PH' ? 'PH' : pos === 'PR' ? 'PR' : 'DEF') : null;
    return { id:pid, name:p.person?.fullName||'Unknown', pos, order, isSub, subType, rawOrder,
      ab:b.atBats, r:b.runs, h:b.hits, rbi:b.rbi, bb:b.baseOnBalls, so:b.strikeOuts, avg:s.avg };
  }).filter(p => p && p.pos !== 'P').sort((a,b)=>a.rawOrder-b.rawOrder);
}

function buildPitchersList(team, boxInfo) {
  if (!team?.pitchers?.length) return [];
  const dec={winning:null,losing:null,saving:null};
  (boxInfo||[]).forEach(item=>{
    const l=(item.label||'').toLowerCase();
    if(l.includes('win'))  dec.winning=item.value;
    if(l.includes('los'))  dec.losing=item.value;
    if(l.includes('save')) dec.saving=item.value;
  });
  return team.pitchers.map(pid=>{
    const p=team.players?.[`ID${pid}`];
    if(!p) return null;
    const pt=p.stats?.pitching||{}, s=p.seasonStats?.pitching||{};
    const name=p.person?.fullName||'Unknown';
    const last=name.split(' ').pop();
    const note=dec.winning?.includes(last)?'winning':dec.losing?.includes(last)?'losing':dec.saving?.includes(last)?'save':'';
    return { id:pid, name, note, ip:pt.inningsPitched, h:pt.hits, r:pt.runs,
      er:pt.earnedRuns, bb:pt.baseOnBalls, so:pt.strikeOuts,
      era:s.era!=null?parseFloat(s.era).toFixed(2):'—' };
  }).filter(Boolean);
}

// ============================================================
// LINEUP TAB
// ============================================================

function renderGdLineup(data) {
  const box=data.liveData?.boxscore, gd=data.gameData;
  const con=$('gd-lineup-content');
  if(!con||!box){if(con)con.innerHTML='<div class="empty-state"><strong>Lineup not available</strong></div>';return;}
  const awayAbbr=gd?.teams?.away?.abbreviation||'AWY';
  const homeAbbr=gd?.teams?.home?.abbreviation||'HME';
  const awayId  =gd?.teams?.away?.id;
  const homeId  =gd?.teams?.home?.id;

  const buildSide=(side,abbr,teamId)=>{
    const team=box.teams?.[side];
    if(!team) return '<p style="color:var(--text-muted)">No data</p>';
    const batters=buildBattersList(team);
    const pitchers=buildPitchersList(team);
    return `<div class="gd-lineup-team">
      <h3>${teamId?`<img class="bs-team-logo-sm" src="${TEAM_LOGO(teamId)}" onerror="this.style.display='none'"/>`:''}${abbr}</h3>
      <ul class="lineup-list">
        ${batters.length?batters.map(p=>`
          <li class="lineup-player" data-pid="${p.id}" data-name="${p.name}">
            <span class="lineup-order">${p.order!==99?p.order+'.':''}</span>
            <span class="lineup-pos">${p.pos}</span>
            <span class="lineup-name">${p.name}</span>
            <span class="lineup-stats">${p.h!=null?`${fmt(p.h)}-${fmt(p.ab)}`:''}</span>
          </li>`).join('')
          :'<li style="padding:6px;color:var(--text-muted);font-size:0.78rem">Lineup pending</li>'}
      </ul>
      ${pitchers.length?`<h3 style="margin-top:14px">Pitching</h3><ul class="lineup-list">
        ${pitchers.map(p=>`<li class="lineup-player" data-pid="${p.id}" data-name="${p.name}">
          <span class="lineup-order"></span>
          <span class="lineup-pos" style="color:var(--accent-blue)">P</span>
          <span class="lineup-name">${p.name}</span>
          <span class="lineup-stats">${fmt(p.ip)} IP</span>
        </li>`).join('')}
      </ul>`:''}
    </div>`;
  };

  con.innerHTML=`<div class="gd-lineup-grid">${buildSide('away',awayAbbr,awayId)}${buildSide('home',homeAbbr,homeId)}</div>`;
  con.querySelectorAll('.lineup-player[data-pid]').forEach(el=>
    el.addEventListener('click',()=>openPlayerProfile(parseInt(el.dataset.pid),el.dataset.name,state.selectedGamePk)));
}

// ── Gameday tab switching ──────────────────────────────────────
function setGdTab(tabId) {
  state.gdTab = tabId;
  document.querySelectorAll('.gd-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.gdtab===tabId));
  document.querySelectorAll('.gd-pane').forEach(pane=>pane.classList.toggle('active',pane.id===`gd-pane-${tabId}`));
  if(state.gdData){
    if(tabId==='boxscore')  renderGdBoxScore(state.gdData);
    if(tabId==='postgame')  renderPostGame(state.gdData);
  }
  pushHash();
}

// ============================================================
// PLAYER PROFILE PANEL
// ============================================================

async function openPlayerProfile(playerId, playerName, gamePk, pushHistory = true) {
  if (pushHistory && state.activePlayer?.id && state.activePlayer.id !== playerId) {
    state.playerHistory.push({ id: state.activePlayer.id, name: state.activePlayer.name, gamePk: state.activePlayer.gamePk });
  }
  state.activePlayer = { id:playerId, name:playerName, gamePk };
  playerPanel.classList.add('open');
  appEl.classList.add('panel-open');
  $('panel-overlay').classList.add('visible');
  $('player-full-name').textContent = playerName;
  $('player-meta').innerHTML = '<span>Loading…</span>';
  const panelWarEl = $('panel-war'); if (panelWarEl) panelWarEl.innerHTML = '';
  const hs=$('player-headshot'); hs.src=HEADSHOT(playerId); hs.onerror=()=>hs.src='';
  updatePanelBackBtn();
  // Always open on Stats; hide/show tabs based on active status below
  document.querySelectorAll('.panel-tab').forEach(t => t.style.display = '');
  setPanelTab('stats');
  ['today','stats','savant','comps'].forEach(t=>setTabContent(t,'<div class="panel-loading"><div class="spinner"></div></div>'));
  try {
    const d=await apiFetch(`${MLB_API}/people/${playerId}?hydrate=currentTeam`);
    const person=d.people?.[0];
    if(person) {
      state.activePlayer={...state.activePlayer,...person};
      renderPlayerHeader(person);
      if (person.active === false) {
        // Retired player — hide Today and Savant tabs (Savant accessible per-year in Stats tab)
        document.querySelectorAll('.panel-tab').forEach(t => {
          if (t.dataset.tab === 'today' || t.dataset.tab === 'savant') t.style.display = 'none';
        });
        setPanelTab('stats');
      }
    }
  } catch {}
  await Promise.allSettled([
    loadTodayTab(playerId, gamePk),
    loadStatsTab(playerId),
    loadSavantTab(playerId, playerName),
    loadCompsTab(playerId),
  ]);
}

function renderPlayerHeader(person) {
  $('player-full-name').textContent=person.fullName;
  const pos=person.primaryPosition?.abbreviation||'';
  const team=person.currentTeam?.name||'';
  const num=person.primaryNumber?`#${person.primaryNumber}`:'';
  const age=person.currentAge?`${person.currentAge} yrs`:'';
  const bats=person.batSide?.code, throws=person.pitchHand?.code;
  $('player-meta').innerHTML=`${pos?`<span class="meta-pos">${pos}</span>`:''}${team?`<span>${team}</span>`:''}${num?`<span>${num}</span>`:''}${age?`<span>${age}</span>`:''}${(bats||throws)?`<span>${bats?'B:'+bats:''} ${throws?'T:'+throws:''}</span>`:''}`;
}

async function loadTodayTab(playerId, gamePk) {
  if (!gamePk) {
    setTabContent('today',`<div class="empty-state" style="padding:24px 0"><strong>No game context</strong>See Stats tab.</div>`);
    return;
  }
  try {
    const data=await apiFetch(`${MLB_API_1}/game/${gamePk}/feed/live`);
    const box=data.liveData?.boxscore;
    let playerBox=null;
    for(const side of ['away','home']){const p=box?.teams?.[side]?.players?.[`ID${playerId}`];if(p){playerBox=p;break;}}
    if(!playerBox){setTabContent('today',`<div class="empty-state" style="padding:24px 0"><strong>Not in today's game</strong></div>`);return;}
    const s=playerBox.stats, pos=playerBox.position?.abbreviation||'';
    const isPitcher=pos==='P'||(s?.pitching&&!s?.batting?.atBats);
    let html='';
    if(isPitcher&&s?.pitching){
      const p=s.pitching;
      html+=`<div class="stat-section"><div class="stat-section-title">Today — Pitching</div><div class="stat-grid">
        <div class="stat-box"><div class="val">${fmt(p.inningsPitched)}</div><div class="lbl">IP</div></div>
        <div class="stat-box"><div class="val">${fmt(p.strikeOuts)}</div><div class="lbl">K</div></div>
        <div class="stat-box"><div class="val">${fmt(p.baseOnBalls)}</div><div class="lbl">BB</div></div>
        <div class="stat-box"><div class="val">${fmt(p.hits)}</div><div class="lbl">H</div></div>
        <div class="stat-box"><div class="val">${fmt(p.earnedRuns)}</div><div class="lbl">ER</div></div>
        <div class="stat-box"><div class="val">${fmt(p.numberOfPitches)}</div><div class="lbl">P</div></div>
      </div></div>`;
    }else if(s?.batting){
      const b=s.batting;
      html+=`<div class="stat-section"><div class="stat-section-title">Today — Batting</div><div class="stat-grid">
        <div class="stat-box"><div class="val">${fmt(b.hits)}–${fmt(b.atBats)}</div><div class="lbl">H–AB</div></div>
        <div class="stat-box"><div class="val">${fmt(b.homeRuns)}</div><div class="lbl">HR</div></div>
        <div class="stat-box"><div class="val">${fmt(b.rbi)}</div><div class="lbl">RBI</div></div>
        <div class="stat-box"><div class="val">${fmt(b.runs)}</div><div class="lbl">R</div></div>
        <div class="stat-box"><div class="val">${fmt(b.strikeOuts)}</div><div class="lbl">K</div></div>
        <div class="stat-box"><div class="val">${fmt(b.baseOnBalls)}</div><div class="lbl">BB</div></div>
      </div></div>`;
    }
    const myPlays=(data.liveData?.plays?.allPlays||[]).filter(pl=>pl.matchup?.batter?.id===playerId||pl.matchup?.pitcher?.id===playerId);
    if(myPlays.length){
      html+=`<div class="stat-section"><div class="stat-section-title">At-Bat Log</div><table class="stat-table">
        <thead><tr><th>Result</th><th>Inn</th><th>RBI</th></tr></thead><tbody>
        ${myPlays.slice(-12).map(pl=>`<tr><td>${pl.result?.description||pl.result?.event||'—'}</td><td>${pl.about?`${pl.about.halfInning==='top'?'▲':'▼'}${pl.about.inning}`:''}</td><td>${pl.result?.rbi??0}</td></tr>`).join('')}
        </tbody></table></div>`;
    }
    setTabContent('today',html||'<div class="empty-state" style="padding:24px 0"><strong>No stats yet</strong></div>');
  }catch(err){setTabContent('today',`<div class="empty-state" style="padding:24px 0"><strong>Error</strong></div>`);}
}

async function loadStatsTab(playerId) {
  try {
    const [hs, hc, hyby, ps, pc, pyby, warB, warP, warBHist, warPHist] = await Promise.allSettled([
      apiFetch(`${MLB_API}/people/${playerId}/stats?stats=season&group=hitting&season=${CUR_SEASON}`),
      apiFetch(`${MLB_API}/people/${playerId}/stats?stats=career&group=hitting`),
      apiFetch(`${MLB_API}/people/${playerId}/stats?stats=yearByYear&group=hitting`),
      apiFetch(`${MLB_API}/people/${playerId}/stats?stats=season&group=pitching&season=${CUR_SEASON}`),
      apiFetch(`${MLB_API}/people/${playerId}/stats?stats=career&group=pitching`),
      apiFetch(`${MLB_API}/people/${playerId}/stats?stats=yearByYear&group=pitching`),
      apiFetch(`${PROXY_BASE}/proxy/fangraphs?type=batter&year=${CUR_SEASON}&id=${playerId}`),
      apiFetch(`${PROXY_BASE}/proxy/fangraphs?type=pitcher&year=${CUR_SEASON}&id=${playerId}`),
      apiFetch(`${PROXY_BASE}/proxy/war-history?type=batter&id=${playerId}`),
      apiFetch(`${PROXY_BASE}/proxy/war-history?type=pitcher&id=${playerId}`),
    ]);

    const hss  = hs.value?.stats?.[0]?.splits?.[0]?.stat;
    const hssTeam = teamAbbr(hs.value?.stats?.[0]?.splits?.[0]?.team);
    const hcs  = hc.value?.stats?.[0]?.splits?.[0]?.stat;
    const hyby_splits = hyby.value?.stats?.[0]?.splits || [];
    const pss  = ps.value?.stats?.[0]?.splits?.[0]?.stat;
    const pssTeam = teamAbbr(ps.value?.stats?.[0]?.splits?.[0]?.team);
    const pcs  = pc.value?.stats?.[0]?.splits?.[0]?.stat;
    const pyby_splits = pyby.value?.stats?.[0]?.splits || [];
    const warBatter  = warB.status === 'fulfilled' ? warB.value?.war ?? null : null;
    const warPitcher = warP.status === 'fulfilled' ? warP.value?.war ?? null : null;
    const warBatHist = warBHist.status === 'fulfilled' ? warBHist.value : {};
    const warPitHist = warPHist.status === 'fulfilled' ? warPHist.value : {};

    // Show WAR in panel header
    const panelWar = $('panel-war');
    if (panelWar) {
      const war = warBatter ?? warPitcher;
      if (war != null) {
        const c = warColor(war);
        panelWar.innerHTML = renderWarBadge(war);
      } else { panelWar.innerHTML = ''; }
    }

    // Only show hitting if the player is a genuine hitter (avoids showing 3 career AB for pitchers).
    // Two-way exception: if they also have substantial pitching AND substantial hitting, show both.
    const careerHitPA  = parseInt(hcs?.plateAppearances)   || 0;
    const curHitPA     = parseInt(hss?.plateAppearances)   || 0;
    const careerPitIP  = parseFloat(pcs?.inningsPitched)   || 0;
    const meaningfulHitter = careerHitPA >= 150 || curHitPA >= 50;
    const meaningfulPitcher = careerPitIP >= 20 || pyby_splits.length > 0;
    const isHitter  = meaningfulHitter && (!meaningfulPitcher || careerHitPA >= 300);
    const isPitcher = pss || pcs || pyby_splits.length;

    let html = '';

    if (isHitter) {
      if (hss) html += renderHittingBlock(`${CUR_SEASON} Season${hssTeam ? ' · '+hssTeam : ''}`, hss, warBatter);
      if (hcs) html += renderHittingBlock('Career Totals', hcs);
      if (hyby_splits.length) html += renderYearByYearHitting(hyby_splits, warBatHist, playerId);
    }
    if (isPitcher) {
      if (pss) html += renderPitchingBlock(`${CUR_SEASON} Season${pssTeam ? ' · '+pssTeam : ''}`, pss, warPitcher);
      if (pcs) html += renderPitchingBlock('Career Totals', pcs);
      if (pyby_splits.length) html += renderYearByYearPitching(pyby_splits, warPitHist, playerId);
    }

    setTabContent('stats', html || '<div class="empty-state" style="padding:24px 0"><strong>No stats found</strong></div>');
  } catch {
    setTabContent('stats', '<div class="empty-state" style="padding:24px 0"><strong>Stats unavailable</strong></div>');
  }
}

function renderYearByYearHitting(splits, warHistory, playerId) {
  if (!splits.length) return '';
  const wh = warHistory || {};
  const rows = [...splits].sort((a, b) => (a.season || 0) - (b.season || 0));
  const peakOps = Math.max(...rows.map(r => parseFloat(r.stat?.ops) || 0));

  const trs = rows.map(r => {
    const s = r.stat || {};
    const ops = parseFloat(s.ops);
    const isPeak = ops && ops === peakOps && peakOps > 0;
    const war = wh[r.season] != null ? parseFloat(wh[r.season]) : null;
    const warStr = war != null ? war.toFixed(1) : '—';
    const warStyle = war != null ? `style="color:${warColor(war)};font-weight:700"` : '';
    const yr = r.season || '';
    const svElig = parseInt(yr) >= 2015;
    return `<tr class="yby-row${isPeak ? ' peak-season' : ''}${svElig ? ' yby-sv-eligible' : ''}"
        data-year="${yr}" data-pid="${playerId||''}" data-role="batter"
        ${svElig ? `onclick="toggleYbySavant(this,'${yr}','batter','${playerId||''}')" title="Click to see ${yr} Statcast card"` : ''}>
      <td class="yby-year-cell">${yr || '—'}${svElig ? ' <span class="yby-sv-dot" title="Has Statcast data">◆</span>' : ''}</td>
      <td>${teamAbbr(r.team)}</td>
      <td>${fmt(s.gamesPlayed)}</td>
      <td>${fmt(s.plateAppearances)}</td>
      <td>${fmtAvg(s.avg)}</td>
      <td>${fmtAvg(s.obp)}</td>
      <td>${fmtAvg(s.slg)}</td>
      <td class="ops-col${isPeak ? ' peak' : ''}">${fmtAvg(s.ops)}</td>
      <td>${fmt(s.homeRuns)}</td>
      <td>${fmt(s.rbi)}</td>
      <td>${fmt(s.stolenBases)}</td>
      <td>${fmt(s.baseOnBalls)}</td>
      <td>${fmt(s.strikeOuts)}</td>
      <td ${warStyle}>${warStr}</td>
    </tr>
    <tr class="yby-sv-expand" id="yby-sv-${yr}-batter-${playerId||''}" style="display:none">
      <td colspan="14" class="yby-sv-cell"></td>
    </tr>`;
  }).join('');

  return `<div class="stat-section">
    <div class="stat-section-title">Year-by-Year — Hitting <span class="yby-note">(★ = peak OPS · ◆ = click for Statcast)</span></div>
    <div class="yby-scroll">
      <table class="yby-table">
        <thead><tr><th>Year</th><th>Tm</th><th>G</th><th>PA</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th><th>HR</th><th>RBI</th><th>SB</th><th>BB</th><th>K</th><th>WAR</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
  </div>`;
}

function renderYearByYearPitching(splits, warHistory, playerId) {
  if (!splits.length) return '';
  const wh = warHistory || {};
  const rows = [...splits].sort((a, b) => (a.season || 0) - (b.season || 0));
  const peakEra = Math.min(...rows.map(r => parseFloat(r.stat?.era) || 99).filter(v => v > 0));

  const trs = rows.map(r => {
    const s = r.stat || {};
    const era = parseFloat(s.era);
    const isPeak = era && era === peakEra && peakEra < 99;
    const war = wh[r.season] != null ? parseFloat(wh[r.season]) : null;
    const warStr = war != null ? war.toFixed(1) : '—';
    const warStyle = war != null ? `style="color:${warColor(war)};font-weight:700"` : '';
    const fip = calcFIP(s) ?? '—';
    const yr = r.season || '';
    const svElig = parseInt(yr) >= 2015;
    return `<tr class="yby-row${isPeak ? ' peak-season' : ''}${svElig ? ' yby-sv-eligible' : ''}"
        data-year="${yr}" data-pid="${playerId||''}" data-role="pitcher"
        ${svElig ? `onclick="toggleYbySavant(this,'${yr}','pitcher','${playerId||''}')" title="Click to see ${yr} Statcast card"` : ''}>
      <td class="yby-year-cell">${yr || '—'}${svElig ? ' <span class="yby-sv-dot">◆</span>' : ''}</td>
      <td>${teamAbbr(r.team)}</td>
      <td>${fmt(s.gamesPlayed)}</td>
      <td>${fmt(s.gamesStarted)}</td>
      <td>${fmt(s.inningsPitched)}</td>
      <td class="ops-col${isPeak ? ' peak' : ''}">${isNaN(era) ? '—' : era.toFixed(2)}</td>
      <td>${fip}</td>
      <td>${s.whip ? parseFloat(s.whip).toFixed(2) : '—'}</td>
      <td>${fmt(s.strikeOuts)}</td>
      <td>${fmt(s.baseOnBalls)}</td>
      <td>${fmt(s.wins)}-${fmt(s.losses)}</td>
      <td>${fmt(s.saves)}</td>
      <td ${warStyle}>${warStr}</td>
    </tr>
    <tr class="yby-sv-expand" id="yby-sv-${yr}-pitcher-${playerId||''}" style="display:none">
      <td colspan="13" class="yby-sv-cell"></td>
    </tr>`;
  }).join('');

  return `<div class="stat-section">
    <div class="stat-section-title">Year-by-Year — Pitching <span class="yby-note">(★ = lowest ERA · ◆ = click for Statcast)</span></div>
    <div class="yby-scroll">
      <table class="yby-table">
        <thead><tr><th>Year</th><th>Tm</th><th>G</th><th>GS</th><th>IP</th><th>ERA</th><th>FIP</th><th>WHIP</th><th>K</th><th>BB</th><th>W-L</th><th>SV</th><th>WAR</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
  </div>`;
}

async function toggleYbySavant(row, year, role, playerId) {
  const expandId = `yby-sv-${year}-${role}-${playerId}`;
  const expandRow = document.getElementById(expandId);
  if (!expandRow) return;

  const isOpen = expandRow.style.display !== 'none';
  // Close all other open expand rows
  document.querySelectorAll('.yby-sv-expand').forEach(r => { r.style.display = 'none'; });
  document.querySelectorAll('.yby-row.yby-open').forEach(r => r.classList.remove('yby-open'));

  if (isOpen) return;

  row.classList.add('yby-open');
  expandRow.style.display = '';
  const cell = expandRow.querySelector('.yby-sv-cell');
  cell.innerHTML = '<div class="panel-loading" style="padding:12px 0"><div class="spinner"></div></div>';

  try {
    const sv = await apiFetch(`${PROXY_BASE}/proxy/savant?type=${role}&year=${year}&id=${playerId}`).catch(() => null);
    const statRes = role === 'batter'
      ? await apiFetch(`${MLB_API}/people/${playerId}/stats?stats=season&group=hitting&season=${year}`).catch(() => null)
      : await apiFetch(`${MLB_API}/people/${playerId}/stats?stats=season&group=pitching&season=${year}`).catch(() => null);
    const stat = statRes?.stats?.[0]?.splits?.[0]?.stat || null;
    const svKeys = sv ? Object.keys(sv).filter(k => k !== 'name').length : 0;
    let html = `<div class="yby-sv-inner"><div class="yby-sv-year-label">${year} Statcast Card</div>`;
    if (stat) {
      html += role === 'batter'
        ? renderBatterPercentileProfile(stat, svKeys > 0 ? sv : null)
        : renderPitcherPercentileProfile(stat, svKeys > 0 ? sv : null);
    } else {
      html += '<div class="sm-no-data">No stat data for this season.</div>';
    }
    html += '</div>';
    cell.innerHTML = html;
  } catch {
    cell.innerHTML = '<div class="sm-no-data">Failed to load Statcast data.</div>';
  }
}

function renderWarBadge(war) {
  if (war == null) return '<div></div>';
  const c = warColor(war);
  return `<div class="war-badge" style="border-color:${c};background:${c}18"><span class="war-val" style="color:${c}">${war.toFixed(1)}</span><span class="war-lbl" style="color:${c}">bWAR</span></div>`;
}

function renderHittingBlock(label, s, war = null){
  return `<div class="stat-section">
    <div class="stat-section-title">${label} — Hitting</div>
    <div class="stat-grid">
      <div class="stat-box"><div class="val">${fmtAvg(s.avg)}</div><div class="lbl">AVG</div></div>
      <div class="stat-box"><div class="val">${fmtAvg(s.obp)}</div><div class="lbl">OBP</div></div>
      <div class="stat-box"><div class="val">${fmtAvg(s.slg)}</div><div class="lbl">SLG</div></div>
      <div class="stat-box"><div class="val">${fmtAvg(s.ops)}</div><div class="lbl">OPS</div></div>
      <div class="stat-box"><div class="val">${fmt(s.homeRuns)}</div><div class="lbl">HR</div></div>
      <div class="stat-box"><div class="val">${fmt(s.rbi)}</div><div class="lbl">RBI</div></div>
    </div>
    <table class="stat-table">
      <thead><tr><th>G</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>RBI</th><th>BB</th><th>SO</th><th>SB</th></tr></thead>
      <tbody><tr><td>${fmt(s.gamesPlayed)}</td><td>${fmt(s.atBats)}</td><td>${fmt(s.runs)}</td><td>${fmt(s.hits)}</td><td>${fmt(s.doubles)}</td><td>${fmt(s.triples)}</td><td>${fmt(s.homeRuns)}</td><td>${fmt(s.rbi)}</td><td>${fmt(s.baseOnBalls)}</td><td>${fmt(s.strikeOuts)}</td><td>${fmt(s.stolenBases)}</td></tr></tbody>
    </table></div>`;
}

function renderPitchingBlock(label, s, war = null){
  const era  = s.era  != null ? parseFloat(s.era).toFixed(2)  : '—';
  const whip = s.whip != null ? parseFloat(s.whip).toFixed(2) : '—';
  const k9   = s.strikeoutsPer9Inn != null ? parseFloat(s.strikeoutsPer9Inn).toFixed(1) : '—';
  const bb9  = s.walksPer9Inn      != null ? parseFloat(s.walksPer9Inn).toFixed(1)      : '—';
  const fip  = calcFIP(s) ?? '—';
  return `<div class="stat-section">
    <div class="stat-section-title">${label} — Pitching</div>
    <div class="stat-grid">
      <div class="stat-box"><div class="val">${era}</div><div class="lbl">ERA</div></div>
      <div class="stat-box"><div class="val">${fip}</div><div class="lbl">FIP</div></div>
      <div class="stat-box"><div class="val">${whip}</div><div class="lbl">WHIP</div></div>
      <div class="stat-box"><div class="val">${fmt(s.wins)}-${fmt(s.losses)}</div><div class="lbl">W-L</div></div>
      <div class="stat-box"><div class="val">${k9}</div><div class="lbl">K/9</div></div>
      <div class="stat-box"><div class="val">${bb9}</div><div class="lbl">BB/9</div></div>
    </div>
    <table class="stat-table">
      <thead><tr><th>G</th><th>GS</th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>SO</th><th>HR</th><th>SV</th></tr></thead>
      <tbody><tr><td>${fmt(s.gamesPlayed)}</td><td>${fmt(s.gamesStarted)}</td><td>${fmt(s.inningsPitched)}</td><td>${fmt(s.hits)}</td><td>${fmt(s.runs)}</td><td>${fmt(s.earnedRuns)}</td><td>${fmt(s.baseOnBalls)}</td><td>${fmt(s.strikeOuts)}</td><td>${fmt(s.homeRuns)}</td><td>${fmt(s.saves)}</td></tr></tbody>
    </table></div>`;
}

async function loadSavantTab(playerId, playerName) {
  const slug = playerName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+/g,'-');

  setTabContent('savant', '<div class="panel-loading"><div class="spinner"></div></div>');

  const [bSvRes, pSvRes, hsRes, psRes, hybyRes, pybyRes] = await Promise.allSettled([
    apiFetch(`${PROXY_BASE}/proxy/savant?type=batter&year=${CUR_SEASON}&id=${playerId}`),
    apiFetch(`${PROXY_BASE}/proxy/savant?type=pitcher&year=${CUR_SEASON}&id=${playerId}`),
    apiFetch(`${MLB_API}/people/${playerId}/stats?stats=season&group=hitting&season=${CUR_SEASON}`),
    apiFetch(`${MLB_API}/people/${playerId}/stats?stats=season&group=pitching&season=${CUR_SEASON}`),
    apiFetch(`${MLB_API}/people/${playerId}/stats?stats=yearByYear&group=hitting`),
    apiFetch(`${MLB_API}/people/${playerId}/stats?stats=yearByYear&group=pitching`),
  ]);

  let bSv = bSvRes.status === 'fulfilled' ? bSvRes.value : null;
  let pSv = pSvRes.status === 'fulfilled' ? pSvRes.value : null;
  const hitStat   = hsRes.status === 'fulfilled' ? hsRes.value?.stats?.[0]?.splits?.[0]?.stat : null;
  const pitchStat = psRes.status === 'fulfilled' ? psRes.value?.stats?.[0]?.splits?.[0]?.stat : null;

  // Determine role from actual season stats, not Savant key presence
  const hitPA  = parseInt(hitStat?.plateAppearances) || 0;
  const pitchIP = parseFloat(pitchStat?.inningsPitched) || 0;
  const isBatterRole  = hitPA  >= 20;
  const isPitcherRole = pitchIP >= 5;
  const isTwoWay = isBatterRole && isPitcherRole;

  let bSvKeys = bSv ? Object.keys(bSv).filter(k => k !== 'name').length : 0;
  let pSvKeys = pSv ? Object.keys(pSv).filter(k => k !== 'name').length : 0;

  // For players with no current-season Savant data, find their BEST Statcast year (2015+)
  let histSavantYear = null;
  if (bSvKeys === 0 && pSvKeys === 0) {
    const hyby = hybyRes.status === 'fulfilled' ? hybyRes.value?.stats?.[0]?.splits || [] : [];
    const pyby = pybyRes.status === 'fulfilled' ? pybyRes.value?.stats?.[0]?.splits || [] : [];
    // Prefer best season: hitters by OPS (min 100 PA), pitchers by IP (most complete season)
    const hitYears = hyby.filter(s => parseInt(s.season) >= 2015 && parseInt(s.season) < CUR_SEASON && parseInt(s.stat?.plateAppearances||0) >= 100);
    const pitYears = pyby.filter(s => parseInt(s.season) >= 2015 && parseInt(s.season) < CUR_SEASON && parseFloat(s.stat?.inningsPitched||0) >= 10);
    let bestYear = null;
    if (hitYears.length) {
      const best = hitYears.reduce((b, s) => (parseFloat(s.stat?.ops||0) > parseFloat(b.stat?.ops||0) ? s : b));
      bestYear = parseInt(best.season);
    } else if (pitYears.length) {
      const best = pitYears.reduce((b, s) => (parseFloat(s.stat?.inningsPitched||0) > parseFloat(b.stat?.inningsPitched||0) ? s : b));
      bestYear = parseInt(best.season);
    }
    const allYears = [...hyby, ...pyby].map(s => parseInt(s.season)).filter(y => y >= 2015 && y < CUR_SEASON);
    if (bestYear || allYears.length) {
      histSavantYear = bestYear || Math.max(...allYears);
      const [hbSvRes, hpSvRes] = await Promise.allSettled([
        apiFetch(`${PROXY_BASE}/proxy/savant?type=batter&year=${histSavantYear}&id=${playerId}`),
        apiFetch(`${PROXY_BASE}/proxy/savant?type=pitcher&year=${histSavantYear}&id=${playerId}`),
      ]);
      bSv = hbSvRes.status === 'fulfilled' ? hbSvRes.value : bSv;
      pSv = hpSvRes.status === 'fulfilled' ? hpSvRes.value : pSv;
      bSvKeys = bSv ? Object.keys(bSv).filter(k => k !== 'name').length : 0;
      pSvKeys = pSv ? Object.keys(pSv).filter(k => k !== 'name').length : 0;
    }
  }

  const batterSv  = bSvKeys > 0 ? bSv : null;
  const pitcherSv = pSvKeys > 0 ? pSv : null;

  const SAVANT_KEY_BAT = ['xwoba','xba','xslg','ev','barrel','hard_hit'];
  const SAVANT_KEY_PIT = ['era','xera','whiff','chase'];
  const hasBatSavant  = batterSv  !== null && SAVANT_KEY_BAT.some(k => batterSv[k]  != null);
  const hasPitSavant  = pitcherSv !== null && SAVANT_KEY_PIT.some(k => pitcherSv[k] != null);

  // Build Savant-style percentile sections for one role
  function buildRoleSection(role, stat, sv, hasSv) {
    if (!stat) return '';
    const isBat = role === 'batter';
    const p = (key, fallback) => sv?.[key] ?? fallback;

    const volume = isBat ? (parseInt(stat.plateAppearances)||0) : (parseInt(stat.battersFaced)||0);
    const threshold = isBat ? 130 : 50;
    const tooSmall = !hasSv && volume > 0 && volume < threshold;

    const fmt3v = v => v != null ? v.toFixed(3).replace('0.','.') : '—';
    const fmtPct = v => v != null ? `${v.toFixed(1)}%` : '—';

    // Compute actual K%/BB% from MLB stats
    let kPctVal = null, bbPctVal = null;
    if (isBat) {
      const pa = parseInt(stat.plateAppearances)||0, so = parseInt(stat.strikeOuts)||0, bb = parseInt(stat.baseOnBalls)||0;
      if (pa > 0) { kPctVal = so/pa*100; bbPctVal = bb/pa*100; }
    } else {
      const bf = parseInt(stat.battersFaced)||0, so = parseInt(stat.strikeOuts)||0, bb = parseInt(stat.baseOnBalls)||0;
      if (bf > 0) { kPctVal = so/bf*100; bbPctVal = bb/bf*100; }
    }

    // Percentile rows grouped by section (matching Baseball Savant percentile page structure)
    const renderRows = rows => rows.filter(r => r.pct !== null).map(({label,pct,val}) => {
      const p2 = Math.round(pct), c = barColor(p2);
      return `<div class="pct-row"><span class="pct-label">${label}</span><div class="pct-bar-wrap"><div class="pct-bar" style="width:${p2}%;background:${c}"><span class="pct-num">${p2}</span></div></div><span class="pct-val">${val}</span></div>`;
    }).join('');

    const renderSection = (title, rows) => {
      const html = renderRows(rows);
      if (!html) return '';
      return `<div class="sv-section-label">${title}</div><div class="sv-pct-list${tooSmall?' sv-blurred':''}">${html}</div>`;
    };

    let out = '';
    if (tooSmall) {
      const teamGames  = estimateTeamGamesPlayed();
      const qualThresh = isBat ? Math.round(2.1 * teamGames) : Math.round(1.25 * teamGames);
      const needed     = Math.max(0, qualThresh - volume);
      let etaStr = '';
      if (needed > 0) {
        if (isBat) {
          const games = Math.ceil(needed / 4);
          etaStr = ` · qualifies in ~${games} more game${games === 1 ? '' : 's'}`;
        } else {
          const gs = parseInt(stat.gamesStarted) || 0;
          const gp = parseInt(stat.gamesPlayed)  || 1;
          const isStarter = gs / gp >= 0.5;
          const bfPerGame = isStarter ? 15 : 3;
          const games     = Math.ceil(needed / bfPerGame);
          etaStr = ` · qualifies in ~${games} more app${games === 1 ? '' : 's'}`;
        }
      }
      out += `<div class="sv-sample-note">⚠ ${volume} ${isBat?'PA':'BF'} — below qualification threshold (${qualThresh})${etaStr}</div>`;
    }

    if (isBat) {
      const avg = parseFloat(stat.avg), slg = parseFloat(stat.slg||stat.sluggingPercentage), ops = parseFloat(stat.ops);
      out += renderSection('BATTING', [
        { label:'xwOBA',        pct: p('xwoba',  normStat(ops,.500,1.100)),  val: fmt3v(sv?.xwoba_val) },
        { label:'xBA',          pct: p('xba',    normStat(avg,.150,.380)),   val: fmt3v(sv?.xba_val) },
        { label:'xSLG',         pct: p('xslg',   normStat(slg,.250,.680)),   val: fmt3v(sv?.xslg_val) },
        { label:'Avg Exit Velo',pct: p('ev',     null), val: sv?.ev_val != null ? sv.ev_val.toFixed(1)+' mph' : '—' },
        { label:'Barrel%',      pct: p('barrel', null), val: sv?.barrel_val != null ? sv.barrel_val.toFixed(1)+'%' : '—' },
        { label:'Hard Hit%',    pct: p('hard_hit',null), val: sv?.hard_hit_val != null ? sv.hard_hit_val.toFixed(1)+'%' : '—' },
        { label:'Chase%',       pct: p('chase',  null), val: sv?.chase_val != null ? sv.chase_val.toFixed(1)+'%' : '—' },
        { label:'Whiff%',       pct: p('whiff',  null), val: sv?.whiff_val != null ? sv.whiff_val.toFixed(1)+'%' : '—' },
        { label:'K%',           pct: p('k_pct',  kPctVal!==null?normStat(kPctVal/100,.35,.08,true):null), val: sv?.k_pct_val != null ? sv.k_pct_val.toFixed(1)+'%' : fmtPct(kPctVal) },
        { label:'BB%',          pct: p('bb_pct', bbPctVal!==null?normStat(bbPctVal/100,.03,.20):null), val: sv?.bb_pct_val != null ? sv.bb_pct_val.toFixed(1)+'%' : fmtPct(bbPctVal) },
        { label:'Bat Speed',    pct: p('bat_speed', null), val: sv?.bat_speed_val != null ? sv.bat_speed_val.toFixed(1)+' mph' : '—' },
      ]);
      out += renderSection('RUNNING', [
        { label:'Sprint Speed', pct: p('sprint', null), val: sv?.sprint_val != null ? sv.sprint_val.toFixed(1)+' ft/s' : '—' },
      ]);
      if (sv?.arm != null) {
        out += renderSection('FIELDING', [
          { label:'Arm Strength', pct: p('arm', null), val: '—' },
        ]);
      }
    } else {
      out += renderSection('PITCHING', [
        { label:'xERA',        pct: p('xera',     null), val: sv?.xera_val != null ? sv.xera_val.toFixed(2) : '—' },
        { label:'xBA Against', pct: p('xba',      null), val: fmt3v(sv?.xba_val) },
        { label:'FB Velo',     pct: p('fb_velo',  null), val: sv?.fb_velo_val != null ? sv.fb_velo_val.toFixed(1)+' mph' : '—' },
        { label:'Avg Exit Velo',pct: p('ev',      null), val: sv?.ev_val != null ? sv.ev_val.toFixed(1)+' mph' : '—' },
        { label:'Chase%',      pct: p('chase',    null), val: sv?.chase_val != null ? sv.chase_val.toFixed(1)+'%' : '—' },
        { label:'Whiff%',      pct: p('whiff',    null), val: sv?.whiff_val != null ? sv.whiff_val.toFixed(1)+'%' : '—' },
        { label:'K%',          pct: p('k_pct',    kPctVal!==null?normStat(kPctVal/100,.10,.38):null), val: sv?.k_pct_val != null ? sv.k_pct_val.toFixed(1)+'%' : fmtPct(kPctVal) },
        { label:'BB%',         pct: p('bb_pct',   bbPctVal!==null?normStat(bbPctVal/100,.15,.03,true):null), val: sv?.bb_pct_val != null ? sv.bb_pct_val.toFixed(1)+'%' : fmtPct(bbPctVal) },
        { label:'Barrel%',     pct: p('barrel',   null), val: sv?.barrel_val != null ? sv.barrel_val.toFixed(1)+'%' : '—' },
        { label:'Hard Hit%',   pct: p('hard_hit', null), val: sv?.hard_hit_val != null ? sv.hard_hit_val.toFixed(1)+'%' : '—' },
      ]);
    }

    return out;
  }

  const savantPlayerType = (isPitcherRole && !isTwoWay) ? 'pitcher' : 'batter';
  const savantUrl = `${SAVANT}/savant-player/${slug}-${playerId}?stats=statcast&playerType=${savantPlayerType}&season=${CUR_SEASON}`;

  // No Statcast data at all — retired or pre-Statcast era player
  const noCurrentSeason = !isBatterRole && !isPitcherRole;
  const noSavantData = bSvKeys === 0 && pSvKeys === 0;
  if (noCurrentSeason && noSavantData) {
    const html = `<div class="sv-tab-wrap">
      <div class="sv-tab-header">
        <div class="sv-tab-title"><span class="badge badge-savant">Statcast</span> · ${CUR_SEASON}</div>
        <a href="${savantUrl}" target="_blank" rel="noopener" class="external-open-btn sv-open-link">Open Savant ↗</a>
      </div>
      <div class="sv-no-data">
        <div class="sv-no-data-icon">📊</div>
        <div class="sv-no-data-title">No Statcast Data Available</div>
        <div class="sv-no-data-body">Statcast tracking began in 2015. This player either retired before the Statcast era or has no ${CUR_SEASON} activity on record.</div>
        <a href="${savantUrl}" target="_blank" rel="noopener" class="sv-no-data-link">Search on Baseball Savant ↗</a>
      </div>
    </div>`;
    setTabContent('savant', html);
    return;
  }

  const displayYear = histSavantYear || CUR_SEASON;
  let html = `<div class="sv-tab-wrap">
    <div class="sv-tab-header">
      <div class="sv-tab-title"><span class="badge badge-savant">Statcast</span> · ${displayYear}${histSavantYear ? ' <span class="sv-hist-note">(best Statcast season)</span>' : ''}</div>
      <a href="${savantUrl}" target="_blank" rel="noopener" class="external-open-btn sv-open-link">Open Savant ↗</a>
    </div>`;

  // For historical players, determine role from which Savant data has more keys
  const effectivePitcher = isPitcherRole || (!isBatterRole && pSvKeys > bSvKeys);
  const effectiveBatter  = isBatterRole  || (!isPitcherRole && bSvKeys >= pSvKeys);

  if (isTwoWay) {
    html += `<div class="sv-two-way-label">TWO-WAY PLAYER</div>`;
    html += `<div class="sv-role-section-title">AS BATTER</div>`;
    html += buildRoleSection('batter', hitStat, batterSv, hasBatSavant);
    html += `<div class="sv-role-section-title">AS PITCHER</div>`;
    html += buildRoleSection('pitcher', pitchStat, pitcherSv, hasPitSavant);
  } else if (effectivePitcher && !effectiveBatter) {
    html += buildRoleSection('pitcher', pitchStat, pitcherSv, hasPitSavant);
  } else {
    html += buildRoleSection('batter', hitStat, batterSv, hasBatSavant);
  }

  html += `</div>`;
  setTabContent('savant', html);
}

// Savant dimensions for player comparison (batter vs pitcher)
const SV_COMP_DIMS_BAT = ['xwoba','xba','xslg','ev','barrel','hard_hit','k_pct','bb_pct','whiff','chase'];
const SV_COMP_DIMS_PIT = ['xera','xba','fb_velo','ev','barrel','hard_hit','k_pct','bb_pct','whiff','chase'];

function savantSimilarity(a, b, dims) {
  const invertKeys = new Set(['k_pct','whiff','chase']);
  let d = 0, n = 0;
  for (const key of dims) {
    let va = a[key], vb = b[key];
    if (va == null || vb == null) continue;
    if (invertKeys.has(key)) { va = 100 - va; vb = 100 - vb; }
    d += ((va - vb) / 100) ** 2;
    n++;
  }
  return n >= 3 ? Math.max(0, 1 - Math.sqrt(d / n) * 2.2) : 0;
}

function prodSimilarity(target, comp, isPitcher) {
  if (!target || !comp) return 0.5;
  let d = 0, n = 0;
  const diff = (v1, v2, scale, w=1) => {
    if (v1 != null && v2 != null && !isNaN(v1) && !isNaN(v2)) {
      d += w * ((v1 - v2) / scale) ** 2; n += w;
    }
  };
  if (isPitcher) {
    diff(parseFloat(target.era),               parseFloat(comp.era),               1.2,  2.0);
    diff(parseFloat(target.whip),              parseFloat(comp.whip),              0.25, 1.5);
    diff(parseFloat(target.strikeoutsPer9Inn), parseFloat(comp.strikeoutsPer9Inn), 2.5,  1.5);
    diff(parseFloat(target.walksPer9Inn),      parseFloat(comp.walksPer9Inn),      1.5,  1.0);
    diff(parseFloat(target.homeRunsPer9),      parseFloat(comp.homeRunsPer9),      0.6,  1.0);
    const tbf = parseInt(target.battersFaced)||1, cbf = parseInt(comp.battersFaced)||1;
    const tso = parseInt(target.strikeOuts)||0,   cso = parseInt(comp.strikeOuts)||0;
    const tbb = parseInt(target.baseOnBalls)||0,  cbb = parseInt(comp.baseOnBalls)||0;
    diff(tso/tbf, cso/cbf, 0.08, 1.0);
    diff(tbb/tbf, cbb/cbf, 0.04, 1.0);
  } else {
    const obpKey = s => s.obp || s.onBasePercentage;
    const slgKey = s => s.slg || s.sluggingPercentage;
    diff(parseFloat(target.avg),          parseFloat(comp.avg),          0.045, 1.5);
    diff(parseFloat(obpKey(target)),       parseFloat(obpKey(comp)),       0.055, 1.5);
    diff(parseFloat(slgKey(target)),       parseFloat(slgKey(comp)),       0.07,  2.0);
    diff(parseFloat(target.ops),          parseFloat(comp.ops),          0.09,  1.0);
    const tpa = parseInt(target.plateAppearances)||1, cpa = parseInt(comp.plateAppearances)||1;
    const thr = parseInt(target.homeRuns)||0,         chr = parseInt(comp.homeRuns)||0;
    const tso = parseInt(target.strikeOuts)||0,       cso = parseInt(comp.strikeOuts)||0;
    const tbb = parseInt(target.baseOnBalls)||0,      cbb = parseInt(comp.baseOnBalls)||0;
    const tsb = parseInt(target.stolenBases)||0,      csb = parseInt(comp.stolenBases)||0;
    diff(thr/tpa, chr/cpa, 0.025, 2.0);
    diff(tso/tpa, cso/cpa, 0.07,  1.0);
    diff(tbb/tpa, cbb/cpa, 0.04,  1.0);
    diff(tsb/tpa, csb/cpa, 0.03,  0.5);
  }
  return n >= 1 ? Math.max(0, 1 - Math.sqrt(d / n) / 1.6) : 0.5;
}

function savantCompReason(a, b) {
  const close = (key) => a[key] != null && b[key] != null && Math.abs(a[key] - b[key]) < 10;
  if (close('xera') && close('fb_velo')) return 'Similar xERA & fastball velocity';
  if (close('whiff') && close('chase')) return 'Similar stuff+ command profile';
  if (close('barrel') && close('ev')) return 'Similar barrel rate & exit velocity';
  if (close('xwoba') && close('xba')) return 'Similar xwOBA & xBA profile';
  if (close('hard_hit')) return 'Similar hard-hit rate';
  return 'Similar Statcast profile';
}

async function buildProductionComps(playerId, isPitcher) {
  const group = isPitcher ? 'pitching' : 'hitting';

  // Try recent seasons first
  const recentYears = [CUR_SEASON, PREV_SEASON, CUR_SEASON - 2];
  let targetStat = null;
  let targetYear = null;
  for (const yr of recentYears) {
    const r = await apiFetch(`${MLB_API}/people/${playerId}/stats?stats=season&group=${group}&season=${yr}`).catch(() => null);
    const s = r?.stats?.[0]?.splits?.[0]?.stat;
    if (s && (isPitcher ? parseFloat(s.inningsPitched) >= 10 : parseInt(s.plateAppearances) >= 50)) {
      targetStat = s; targetYear = yr; break;
    }
  }

  // If no recent season, fall back to career stats + historical pool
  if (!targetStat) {
    return buildCareerProductionComps(playerId, isPitcher);
  }

  // Use Savant leaderboard player IDs as a large pool for a given year
  const lb = await apiFetch(`${PROXY_BASE}/proxy/savant?type=${isPitcher?'pitcher':'batter'}&year=${targetYear}`).catch(() => null);

  // If Savant leaderboard available, use it as pool
  if (lb) {
    const poolIds = Object.keys(lb).filter(k => k !== playerId.toString() && !isNaN(k)).slice(0, 80).map(Number);
    if (poolIds.length) {
      const chunks = [];
      for (let i = 0; i < poolIds.length; i += 20) chunks.push(poolIds.slice(i, i+20));
      const poolStats = {};
      await Promise.allSettled(chunks.flatMap(chunk =>
        chunk.map(async id => {
          const r = await apiFetch(`${MLB_API}/people/${id}/stats?stats=season&group=${group}&season=${targetYear}`).catch(() => null);
          const s = r?.stats?.[0]?.splits?.[0]?.stat;
          if (s) poolStats[id] = s;
        })
      ));
      const results = Object.entries(poolStats)
        .map(([id, s]) => ({
          id: parseInt(id), sv: lb[id] || {}, score: prodSimilarity(targetStat, s, isPitcher),
          prodStat: s, isProdComp: true,
        }))
        .filter(c => c.score > 0.4)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      if (results.length) return results;
    }
  }

  // Savant unavailable or pool empty — fall back to career production comps
  return buildCareerProductionComps(playerId, isPitcher);
}

// Career production comps using MLB all-players roster for the player's era
async function buildCareerProductionComps(playerId, isPitcher) {
  const group = isPitcher ? 'pitching' : 'hitting';

  // Fetch career stats for target
  const [carRes, byRes] = await Promise.allSettled([
    apiFetch(`${MLB_API}/people/${playerId}/stats?stats=career&group=${group}`),
    apiFetch(`${MLB_API}/people/${playerId}/stats?stats=yearByYear&group=${group}`),
  ]);
  const targetStat = carRes.value?.stats?.[0]?.splits?.[0]?.stat || null;
  if (!targetStat) return [];

  // Find the most recent year the player had meaningful stats
  const splits = byRes.value?.stats?.[0]?.splits || [];
  let peakYear = PREV_SEASON;
  for (let i = splits.length - 1; i >= 0; i--) {
    const s = splits[i].stat;
    const yr = parseInt(splits[i].season);
    if (isPitcher ? parseFloat(s?.inningsPitched||0) >= 20 : parseInt(s?.plateAppearances||0) >= 100) {
      peakYear = Math.min(yr, PREV_SEASON); // cap at prev season for API availability
      break;
    }
  }

  // Fetch all players registered in the player's peak season year
  const rosterRes = await apiFetch(`${MLB_API}/sports/1/players?season=${peakYear}`).catch(() => null);
  const allPeople = rosterRes?.people || [];
  const posType = isPitcher ? 'Pitcher' : null;
  const filtered = allPeople
    .filter(p => {
      const pt = p.primaryPosition?.type;
      return isPitcher ? pt === 'Pitcher' : pt !== 'Pitcher';
    })
    .filter(p => p.id !== playerId)
    .map(p => p.id)
    .slice(0, 80);

  if (!filtered.length) return [];

  // Fetch career stats for pool
  const chunks = [];
  for (let i = 0; i < filtered.length; i += 20) chunks.push(filtered.slice(i, i+20));
  const poolStats = {};
  await Promise.allSettled(chunks.flatMap(chunk =>
    chunk.map(async id => {
      const r = await apiFetch(`${MLB_API}/people/${id}/stats?stats=career&group=${group}`).catch(() => null);
      const s = r?.stats?.[0]?.splits?.[0]?.stat;
      if (s && (isPitcher ? parseFloat(s.inningsPitched||0) >= 200 : parseInt(s.plateAppearances||0) >= 500)) {
        poolStats[id] = s;
      }
    })
  ));

  return Object.entries(poolStats)
    .map(([id, s]) => ({
      id: parseInt(id), sv: {}, score: prodSimilarity(targetStat, s, isPitcher),
      prodStat: s, isProdComp: true, isCareerComp: true,
    }))
    .filter(c => c.score > 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function buildCareerComps(playerId, isPitcher) {
  const group = isPitcher ? 'pitching' : 'hitting';
  // Fetch target career stats
  const [carRes, byRes] = await Promise.allSettled([
    apiFetch(`${MLB_API}/people/${playerId}/stats?stats=career&group=${group}`),
    apiFetch(`${MLB_API}/people/${playerId}/stats?stats=yearByYear&group=${group}`),
  ]);
  const careerStat = carRes.value?.stats?.[0]?.splits?.[0]?.stat || null;
  const byySplits  = byRes.value?.stats?.[0]?.splits || [];

  // Find best Savant year for target
  const svYears = byySplits.filter(s => parseInt(s.season) >= 2015 && parseInt(s.season) <= CUR_SEASON);
  if (!careerStat && !svYears.length) return [];

  // Determine best Statcast year (for Savant profile)
  let bestSvYear = null;
  if (svYears.length) {
    if (isPitcher) {
      const best = svYears.reduce((b, s) => (parseFloat(s.stat?.inningsPitched||0) > parseFloat(b.stat?.inningsPitched||0) ? s : b));
      bestSvYear = parseInt(best.season);
    } else {
      const best = svYears.reduce((b, s) => (parseFloat(s.stat?.ops||0) > parseFloat(b.stat?.ops||0) ? s : b));
      bestSvYear = parseInt(best.season);
    }
  }

  // Fetch target Savant + leaderboards for multiple years (build large pool)
  const svYearList = [...new Set(svYears.map(s => parseInt(s.season)))].sort((a,b)=>b-a).slice(0,5);
  const lbFetches = svYearList.map(yr =>
    apiFetch(`${PROXY_BASE}/proxy/savant?type=${isPitcher?'pitcher':'batter'}&year=${yr}`).catch(()=>null)
  );
  const [targetSvRes, ...lbResults] = await Promise.allSettled([
    bestSvYear ? apiFetch(`${PROXY_BASE}/proxy/savant?type=${isPitcher?'pitcher':'batter'}&year=${bestSvYear}&id=${playerId}`) : Promise.resolve(null),
    ...lbFetches,
  ]);

  const targetSv = targetSvRes.value || null;
  const dims = isPitcher ? SV_COMP_DIMS_PIT : SV_COMP_DIMS_BAT;

  // Merge all leaderboard years into one pool (use best Savant data per player-year)
  const pool = {}; // id → {sv, year}
  lbResults.forEach((res, i) => {
    const lb = res.value; const yr = svYearList[i];
    if (!lb) return;
    Object.entries(lb).forEach(([id, sv]) => {
      if (id === String(playerId) || isNaN(id)) return;
      if (!pool[id] || yr === bestSvYear) pool[id] = { sv, year: yr };
    });
  });

  const poolEntries = Object.entries(pool);
  if (!poolEntries.length) {
    // No Savant pool — fall back to career production comps against historical roster
    return buildCareerProductionComps(playerId, isPitcher);
  }

  const dims2 = isPitcher ? SV_COMP_DIMS_PIT : SV_COMP_DIMS_BAT;
  let candidates = poolEntries
    .map(([id, {sv, year}]) => ({
      id: parseInt(id), sv, year,
      sim: targetSv ? savantSimilarity(targetSv, sv, dims2) : 0.5,
      name: sv.name || '',
    }))
    .filter(c => c.sim > 0.30)
    .sort((a,b) => b.sim - a.sim)
    .slice(0, 20);

  if (!candidates.length) return buildCareerProductionComps(playerId, isPitcher);

  // Re-rank with career production stats
  const candCareerResults = await Promise.allSettled(
    candidates.map(c => apiFetch(`${MLB_API}/people/${c.id}/stats?stats=career&group=${group}`).catch(()=>null))
  );
  const candCareer = candCareerResults.map(r => r.value?.stats?.[0]?.splits?.[0]?.stat || null);

  return candidates.map((c, i) => {
    const pSim = prodSimilarity(careerStat, candCareer[i], isPitcher);
    const svW  = targetSv ? 0.45 : 0;
    const prW  = 1 - svW;
    const score = svW * c.sim + prW * pSim;
    return { ...c, score, isProdComp: !targetSv };
  }).filter(c => c.score > 0.35)
    .sort((a,b) => b.score - a.score)
    .slice(0, 5);
}

async function loadCompsTab(playerId) {
  setTabContent('comps', '<div class="panel-loading"><div class="spinner"></div></div>');
  try {
    const isRetired = state.activePlayer?.active === false;

    if (isRetired) {
      // For retired players: career-based comps vs broad historical pool
      const [bioRes] = await Promise.allSettled([
        apiFetch(`${MLB_API}/people/${playerId}/stats?stats=career&group=hitting`),
      ]);
      const carHit = bioRes.value?.stats?.[0]?.splits?.[0]?.stat;
      const pitRes = await apiFetch(`${MLB_API}/people/${playerId}/stats?stats=career&group=pitching`).catch(()=>null);
      const carPit = pitRes?.stats?.[0]?.splits?.[0]?.stat;
      const isPitcherComp = (parseFloat(carPit?.inningsPitched)||0) > 100 && (parseFloat(carPit?.inningsPitched)||0) > (parseInt(carHit?.plateAppearances)||0) / 4;

      const comps = await buildCareerComps(playerId, isPitcherComp);
      if (!comps.length) {
        setTabContent('comps', '<div class="empty-state" style="padding:32px 16px;text-align:center"><strong>Not enough data for comps</strong><br><span style="color:var(--text-muted);font-size:0.8rem">Need at least a partial career of stats</span></div>');
        return;
      }

      const bioResults = await Promise.allSettled(comps.map(c => apiFetch(`${MLB_API}/people/${c.id}?hydrate=currentTeam`)));
      bioResults.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          const person = r.value.people?.[0];
          if (person) {
            comps[i].name = person.fullName || comps[i].sv?.name || 'Unknown';
            comps[i].team = person.currentTeam?.name || (person.active === false ? 'Retired' : '');
            comps[i].pos  = person.primaryPosition?.abbreviation || '';
            comps[i].isRetired = person.active === false;
          }
        }
      });

      renderCompsContent(comps, playerId, isPitcherComp, true);
      return;
    }

    // Fetch target's Savant data + both role leaderboards in parallel
    const [bSvRes, pSvRes, batLbRes, pitLbRes] = await Promise.allSettled([
      apiFetch(`${PROXY_BASE}/proxy/savant?type=batter&year=${CUR_SEASON}&id=${playerId}`),
      apiFetch(`${PROXY_BASE}/proxy/savant?type=pitcher&year=${CUR_SEASON}&id=${playerId}`),
      apiFetch(`${PROXY_BASE}/proxy/savant?type=batter&year=${CUR_SEASON}`),
      apiFetch(`${PROXY_BASE}/proxy/savant?type=pitcher&year=${CUR_SEASON}`),
    ]);

    const bSv  = bSvRes.status  === 'fulfilled' ? bSvRes.value  : null;
    const pSv  = pSvRes.status  === 'fulfilled' ? pSvRes.value  : null;
    const batLb = batLbRes.status === 'fulfilled' ? batLbRes.value : null;
    const pitLb = pitLbRes.status === 'fulfilled' ? pitLbRes.value : null;

    const bSvKeys = bSv ? Object.keys(bSv).filter(k=>k!=='name').length : 0;
    const pSvKeys = pSv ? Object.keys(pSv).filter(k=>k!=='name').length : 0;

    // Use pitcher role when pitcher Savant has significantly more keys
    const isPitcherComp = pSvKeys > bSvKeys;
    const targetSv = isPitcherComp ? pSv : (bSvKeys >= 3 ? bSv : pSvKeys >= 3 ? pSv : null);
    const lb = isPitcherComp ? pitLb : batLb;
    const dims = isPitcherComp ? SV_COMP_DIMS_PIT : SV_COMP_DIMS_BAT;

    let comps = [];

    if (targetSv && lb) {
      // Get top 15 Savant candidates (expanded pool for production re-ranking)
      const candidates = Object.entries(lb)
        .filter(([id]) => id !== String(playerId))
        .map(([id, sv]) => ({ id: parseInt(id), sv, sim: savantSimilarity(targetSv, sv, dims), name: sv.name || '' }))
        .filter(c => c.sim > 0.35)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 15);

      if (candidates.length) {
        // Fetch target + candidate production stats in parallel
        const statGroup = isPitcherComp ? 'pitching' : 'hitting';
        const statIds = [playerId, ...candidates.map(c => c.id)];
        const statResults = await Promise.allSettled(
          statIds.map(id => apiFetch(`${MLB_API}/people/${id}/stats?stats=season&season=${CUR_SEASON}&group=${statGroup}&gameType=R`))
        );
        const targetProd = statResults[0].value?.stats?.[0]?.splits?.[0]?.stat || null;
        const candProds  = statResults.slice(1).map(r => r.value?.stats?.[0]?.splits?.[0]?.stat || null);

        comps = candidates.map((c, i) => {
          const pSim = prodSimilarity(targetProd, candProds[i], isPitcherComp);
          const score = 0.55 * c.sim + 0.45 * pSim;
          return { ...c, score };
        }).filter(c => c.score > 0.35)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
      }
    }

    if (!comps.length) {
      // Fall back to production-only comps when no Savant data is available
      comps = await buildProductionComps(playerId, isPitcherComp);
      if (!comps.length) {
        setTabContent('comps', '<div class="empty-state" style="padding:32px 16px;text-align:center"><strong>Not enough data for comps</strong><br><span style="color:var(--text-muted);font-size:0.8rem">Need at least a partial season of stats</span></div>');
        return;
      }
    }

    // Fetch bio for each comp
    const bioResults = await Promise.allSettled(
      comps.map(c => apiFetch(`${MLB_API}/people/${c.id}?hydrate=currentTeam`))
    );
    bioResults.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const person = r.value.people?.[0];
        if (person) {
          comps[i].name = person.fullName || comps[i].sv?.name || 'Unknown';
          comps[i].team = person.currentTeam?.name || (person.active===false ? 'Retired':'');
          comps[i].pos  = person.primaryPosition?.abbreviation || '';
          comps[i].isRetired = person.active === false;
        }
      }
    });

    renderCompsContent(comps, playerId, isPitcherComp, false);
  } catch(e) {
    console.error('comps error', e);
    setTabContent('comps', '<div class="empty-state" style="padding:24px 0"><strong>Comps unavailable</strong></div>');
  }
}

function renderCompsContent(comps, playerId, isPitcherComp, isCareer) {
  const targetSv = null; // used for reason text only in career mode

    const renderSvCell = (key, label, sv) => {
      if (sv?.[key] == null) return '';
      const c = barColor(sv[key]);
      return `<div class="comp-sv-cell">
        <span class="comp-sv-val" style="color:${c}">${sv[key]}</span>
        <span class="comp-sv-lbl">${label}</span>
      </div>`;
    };

    const renderProdCell = (label, val) => {
      if (val == null || val === '—') return '';
      return `<div class="comp-sv-cell">
        <span class="comp-sv-val" style="color:var(--text-primary)">${val}</span>
        <span class="comp-sv-lbl">${label}</span>
      </div>`;
    };

    const isProdComp = isCareer || comps.some(c => c.isProdComp);
    const compNote = isCareer
      ? (isPitcherComp ? 'Career similarity: ERA, WHIP, K/9, BB/9 + Statcast profile where available'
                       : 'Career similarity: AVG, OBP, SLG, HR rate, K%, BB% + Statcast profile where available')
      : isProdComp
        ? (isPitcherComp ? 'Similarity based on ERA, WHIP, K/9, BB/9, K%, BB%, HR/9'
                         : 'Similarity based on AVG, OBP, SLG, OPS, HR rate, K%, BB%, SB rate')
        : (isPitcherComp ? 'Similarity based on xERA, xBA, FB velo, exit velo, barrel%, K%, BB%, whiff%, chase%'
                         : 'Similarity based on xwOBA, barrel%, exit velo, hard hit%, K%, BB%, whiff%, chase%');

    const fmtStat = (s, key) => {
      const v = parseFloat(s?.[key]); return isNaN(v) ? null : v;
    };

    const html = `<div class="stat-section">
      <div class="stat-section-title">Comparable Players${isProdComp ? ' · Production Profile' : ' · Statcast Profile'}</div>
      <div class="comp-method-note">${compNote}</div>
      ${comps.map(c => {
        const ps = c.prodStat;
        let cells = '';
        if (isProdComp && ps) {
          if (isPitcherComp) {
            const era = fmtStat(ps,'era'), whip = fmtStat(ps,'whip'), k9 = fmtStat(ps,'strikeoutsPer9Inn');
            const bf = parseInt(ps.battersFaced)||1;
            const kpct = ps.strikeOuts ? (parseInt(ps.strikeOuts)/bf*100).toFixed(1)+'%' : null;
            cells = [
              renderProdCell('ERA',  era  != null ? era.toFixed(2)  : null),
              renderProdCell('WHIP', whip != null ? whip.toFixed(2) : null),
              renderProdCell('K/9',  k9   != null ? k9.toFixed(1)   : null),
              renderProdCell('K%',   kpct),
              renderProdCell('W-L',  ps.wins != null ? `${ps.wins}-${ps.losses}` : null),
              renderProdCell('IP',   ps.inningsPitched ?? null),
            ].join('');
          } else {
            const avg = fmtStat(ps,'avg'), obp = fmtStat(ps,'obp')||fmtStat(ps,'onBasePercentage');
            const slg = fmtStat(ps,'slg')||fmtStat(ps,'sluggingPercentage'), ops = fmtStat(ps,'ops');
            cells = [
              renderProdCell('AVG',  avg != null ? avg.toFixed(3).replace('0.','.') : null),
              renderProdCell('OBP',  obp != null ? obp.toFixed(3).replace('0.','.') : null),
              renderProdCell('SLG',  slg != null ? slg.toFixed(3).replace('0.','.') : null),
              renderProdCell('OPS',  ops != null ? ops.toFixed(3).replace('0.','.') : null),
              renderProdCell('HR',   ps.homeRuns != null ? String(ps.homeRuns) : null),
              renderProdCell('RBI',  ps.rbi      != null ? String(ps.rbi)      : null),
            ].join('');
          }
        } else {
          cells = isPitcherComp ? `
            ${renderSvCell('xera','xERA',c.sv)}
            ${renderSvCell('fb_velo','FB Velo',c.sv)}
            ${renderSvCell('whiff','Whiff%',c.sv)}
            ${renderSvCell('chase','Chase%',c.sv)}
            ${renderSvCell('k_pct','K%',c.sv)}
            ${renderSvCell('ev','Exit Velo',c.sv)}
          ` : `
            ${renderSvCell('xwoba','xwOBA',c.sv)}
            ${renderSvCell('barrel','Barrel%',c.sv)}
            ${renderSvCell('ev','Exit Velo',c.sv)}
            ${renderSvCell('hard_hit','Hard Hit%',c.sv)}
            ${renderSvCell('whiff','Whiff%',c.sv)}
            ${renderSvCell('chase','Chase%',c.sv)}
          `;
        }
        return `<div class="comp-card" data-pid="${c.id}">
          <div class="comp-card-top">
            <img class="comp-headshot" src="${HEADSHOT(c.id)}" onerror="this.src=''" />
            <div class="comp-info">
              <div class="comp-name">${c.name}</div>
              <div class="comp-reason">${isCareer ? 'Similar career profile' : isProdComp ? 'Similar production profile' : savantCompReason(c.sv, c.sv)}</div>
              ${c.team ? `<div class="comp-team">${c.pos ? c.pos + ' · ' : ''}${c.team}${c.isRetired ? ' <span style="font-size:0.58rem;color:var(--text-muted)">(Ret.)</span>' : ''}</div>` : ''}
            </div>
            <div class="comp-similarity" style="color:${compMatchColor(Math.round((c.score??c.sim)*100))}">${Math.round((c.score ?? c.sim) * 100)}%<br><span style="font-size:0.6rem;color:var(--text-muted)">match</span></div>
          </div>
          <div class="comp-sv-grid">${cells}</div>
        </div>`;
      }).join('')}
    </div>`;

    setTabContent('comps', html);
    $('tab-comps').querySelectorAll('.comp-card[data-pid]').forEach(el =>
      el.addEventListener('click', () => openPlayerProfile(parseInt(el.dataset.pid), el.querySelector('.comp-name')?.textContent, null)));
}

function setTabContent(tabId,html){const el=$(`tab-${tabId}`);if(el)el.innerHTML=html;}
function setPanelTab(tabId){state.activeTab=tabId;document.querySelectorAll('.panel-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===tabId));document.querySelectorAll('.tab-pane').forEach(pane=>pane.classList.toggle('active',pane.id===`tab-${tabId}`));}

// ============================================================
// PLAYER SEARCH
// ============================================================

searchInput.addEventListener('input', ()=>{
  clearTimeout(state.searchTimer);
  const q=searchInput.value.trim();
  if(q.length<2){hideSearch();return;}
  state.searchTimer=setTimeout(()=>doSearch(q),350);
});
searchInput.addEventListener('keydown',e=>{if(e.key==='Escape'){searchInput.value='';hideSearch();}});
document.addEventListener('click',e=>{if(!$('search-wrap').contains(e.target))hideSearch();});

async function doSearch(q){
  try{
    const data=await apiFetch(`${MLB_API}/people/search?names=${encodeURIComponent(q)}&sportId=1`);
    const players=(data.people||[]).slice(0,8);
    searchResults.innerHTML=players.length
      ?players.map(p=>`<div class="search-result-item" data-pid="${p.id}" data-name="${p.fullName}"><div><div class="name">${p.fullName}</div><div class="meta">${p.primaryPosition?.abbreviation||''} · ${p.currentTeam?.name||''}</div></div></div>`).join('')
      :'<div class="search-result-item"><span style="color:var(--text-muted)">No players found</span></div>';
    searchResults.classList.add('visible');
    searchResults.querySelectorAll('.search-result-item[data-pid]').forEach(el=>
      el.addEventListener('click',()=>{openPlayerProfile(parseInt(el.dataset.pid),el.dataset.name,null);searchInput.value='';hideSearch();}));
  }catch{}
}
function hideSearch(){searchResults.classList.remove('visible');searchResults.innerHTML='';}

// ============================================================
// EVENT WIRING
// ============================================================

function closePlayerPanel() {
  playerPanel.classList.remove('open');
  appEl.classList.remove('panel-open');
  $('panel-overlay').classList.remove('visible');
  state.activePlayer = null;
  state.playerHistory = [];
  updatePanelBackBtn();
}

function updatePanelBackBtn() {
  let btn = $('panel-back-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'panel-back-btn';
    btn.className = 'panel-back-btn';
    btn.textContent = '← Back';
    btn.addEventListener('click', () => {
      const prev = state.playerHistory.pop();
      if (prev) openPlayerProfile(prev.id, prev.name, prev.gamePk, false);
    });
    const header = $('panel-header');
    if (header) header.insertBefore(btn, header.firstChild);
  }
  btn.style.display = state.playerHistory.length > 0 ? '' : 'none';
}

$('panel-close').addEventListener('click', closePlayerPanel);
$('panel-overlay').addEventListener('click', closePlayerPanel);

document.querySelectorAll('.panel-tab').forEach(btn=>btn.addEventListener('click',()=>setPanelTab(btn.dataset.tab)));
document.querySelectorAll('.gd-tab').forEach(btn=>btn.addEventListener('click',()=>setGdTab(btn.dataset.gdtab)));
$('gd-back').addEventListener('click', closeGamedayView);
$('gd-prev-game').addEventListener('click', () => navigateGame(-1));
$('gd-next-game').addEventListener('click', () => navigateGame(+1));
$('prev-date').addEventListener('click', ()=>changeDate(-1));
$('next-date').addEventListener('click', ()=>changeDate(1));

function changeDate(delta){
  state.currentDate=shiftDate(state.currentDate,delta);
  currentDateLbl.textContent=friendlyDate(state.currentDate);
  gamesGrid.innerHTML='<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>';
  state.expandedCardPk=null;
  stopMiniPoll();
  pushHash();
  refreshGrid();
}

function changeDateBanner(delta){
  state.currentDate=shiftDate(state.currentDate,delta);
  currentDateLbl.textContent=friendlyDate(state.currentDate);
  // If on games grid, refresh it too
  if (!gamesSection.classList.contains('hidden')) {
    gamesGrid.innerHTML='<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>';
    state.expandedCardPk=null;
    stopMiniPoll();
  }
  pushHash();
  refreshGrid();
}

// ============================================================
// RECENT GAMES
// ============================================================

function renderRecentGame(g, myTeamId) {
  const myTeam  = g.teams?.away?.team?.id === myTeamId ? 'away' : 'home';
  const oppTeam = myTeam === 'away' ? 'home' : 'away';
  const myRuns  = g.linescore?.teams?.[myTeam]?.runs  ?? g.teams?.[myTeam]?.score  ?? 0;
  const oppRuns = g.linescore?.teams?.[oppTeam]?.runs ?? g.teams?.[oppTeam]?.score ?? 0;
  const won     = myRuns > oppRuns;
  const oppAbbr = g.teams?.[oppTeam]?.team?.abbreviation || TEAM_ABBR[g.teams?.[oppTeam]?.team?.id] || '?';
  const isHome  = myTeam === 'home';
  const date    = g.officialDate ? g.officialDate.slice(5) : '';
  const winner  = g.decisions?.winner;
  const loser   = g.decisions?.loser;
  const save    = g.decisions?.save;
  const keyPlayer   = won ? winner : (save || loser);
  const playerName  = keyPlayer ? (keyPlayer.fullName?.split(' ').pop() || keyPlayer.fullName || '') : '';
  return `<div class="pv-recent-game ${won?'recent-win':'recent-loss'}">
    <span class="pv-rg-wl ${won?'wl-w':'wl-l'}">${won?'W':'L'}</span>
    <span class="pv-rg-opp">${isHome?'vs':'@'} ${oppAbbr}</span>
    <span class="pv-rg-score">${myRuns}–${oppRuns}</span>
    <span class="pv-rg-date">${date}</span>
    ${playerName ? `<span class="pv-rg-player">${playerName}</span>` : ''}
  </div>`;
}

async function loadRecentGames(data, awayId, homeId, away, home) {
  const container = $('pv-recent-games');
  if (!container) return;
  container.innerHTML = '<div class="loading-state" style="padding:8px 0"><div class="spinner"></div></div>';

  const endDate   = state.currentDate || new Date().toISOString().slice(0, 10);
  const startDate = new Date(new Date(endDate).getTime() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [awayGamesRes, homeGamesRes] = await Promise.allSettled([
    apiFetch(`${MLB_API}/schedule?sportId=1&teamId=${awayId}&startDate=${startDate}&endDate=${endDate}&hydrate=linescore,decisions&gameType=R`),
    apiFetch(`${MLB_API}/schedule?sportId=1&teamId=${homeId}&startDate=${startDate}&endDate=${endDate}&hydrate=linescore,decisions&gameType=R`),
  ]);

  const getGames = res => (res.value?.dates || [])
    .flatMap(d => d.games || [])
    .filter(g => g.status?.abstractGameState === 'Final')
    .slice(-5);

  const awayGames = getGames(awayGamesRes);
  const homeGames = getGames(homeGamesRes);

  if (!awayGames.length && !homeGames.length) {
    container.innerHTML = '';
    return;
  }

  // Re-check container still exists (poll may have replaced it)
  const el = $('pv-recent-games');
  if (!el) return;

  const awayAbbr = away?.abbreviation || TEAM_ABBR[awayId] || 'AWAY';
  const homeAbbr = home?.abbreviation || TEAM_ABBR[homeId] || 'HOME';

  el.innerHTML = `<div class="pv-recent-section">
    <div class="pv-section-title">RECENT GAMES</div>
    <div class="pv-recent-cols">
      <div class="pv-recent-col">
        <div class="pv-recent-team-hdr">${awayAbbr}</div>
        ${awayGames.length ? awayGames.map(g => renderRecentGame(g, awayId)).join('') : '<div style="font-size:0.7rem;color:var(--text-muted);padding:4px 0">No recent games</div>'}
      </div>
      <div class="pv-recent-col">
        <div class="pv-recent-team-hdr">${homeAbbr}</div>
        ${homeGames.length ? homeGames.map(g => renderRecentGame(g, homeId)).join('') : '<div style="font-size:0.7rem;color:var(--text-muted);padding:4px 0">No recent games</div>'}
      </div>
    </div>
  </div>`;
}

// ============================================================
// STANDINGS
// ============================================================

function syncMobNav(activeId) {
  document.querySelectorAll('.mob-nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(activeId)?.classList.add('active');
}

function openStandings() {
  $('games-section')?.classList.add('hidden');
  $('gameday-detail')?.classList.add('hidden');
  $('standings-section')?.classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  $('nav-standings-btn')?.classList.add('active');
  syncMobNav('mob-nav-standings');
  fetchAndRenderStandings();
  history.pushState(null, '', '#standings');
}

function closeStandings() {
  goToGameday();
}

function goToGameday() {
  $('standings-section')?.classList.add('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  $('nav-gameday-btn')?.classList.add('active');
  syncMobNav('mob-nav-games');
  if (state.selectedGamePk && state.gdData) {
    $('gameday-detail')?.classList.remove('hidden');
    $('games-section')?.classList.add('hidden');
  } else {
    $('games-section')?.classList.remove('hidden');
    $('gameday-detail')?.classList.add('hidden');
  }
  pushHash();
}

async function fetchAndRenderStandings() {
  const con = $('standings-content');
  if (!con) return;
  con.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  try {
    const data = await apiFetch(`${MLB_API}/standings?leagueId=103,104&season=${CUR_SEASON}&standingsType=regularSeason&hydrate=team,league,division`);
    renderStandings(data, con);
  } catch(e) {
    con.innerHTML = '<div class="empty-state"><strong>Could not load standings</strong></div>';
  }
}

function renderStandings(data, con) {
  const records = data?.records || [];
  // Group by league
  const AL = records.filter(r => r.league?.id === 103);
  const NL = records.filter(r => r.league?.id === 104);

  const renderTeamRow = (t, inPlayoff) => {
    const team   = t.team;
    const w      = t.wins ?? 0;
    const l      = t.losses ?? 0;
    const pct    = t.winningPercentage ?? '—';
    const gb     = t.gamesBack ?? '—';
    const l10    = t.records?.splitRecords?.find(s => s.type === 'lastTen');
    const l10str = l10 ? `${l10.wins}-${l10.losses}` : '—';
    const streak = t.streak?.streakCode || '—';
    const teamId = team?.id;
    return `<div class="standings-team-row${inPlayoff ? ' standings-playoff' : ''}">
      <div class="st-name">
        ${teamId ? `<img class="st-logo" src="${TEAM_LOGO(teamId)}" onerror="this.style.display='none'"/>` : ''}
        <span class="st-team-name">${team?.name || '?'}</span>
        ${inPlayoff ? '<span class="playoff-badge">PO</span>' : ''}
      </div>
      <span class="st-w">${w}</span>
      <span class="st-l">${l}</span>
      <span class="st-pct">${typeof pct === 'number' ? pct.toFixed(3).replace('0.','.') : pct}</span>
      <span class="st-gb">${gb === '0.0' || gb === 0 ? '—' : gb}</span>
      <span class="st-l10">${l10str}</span>
      <span class="st-str">${streak}</span>
    </div>`;
  };

  const renderColHeader = () => `<div class="standings-col-header">
    <span class="st-name">Team</span>
    <span class="st-w">W</span>
    <span class="st-l">L</span>
    <span class="st-pct">PCT</span>
    <span class="st-gb">GB</span>
    <span class="st-l10">L10</span>
    <span class="st-str">STK</span>
  </div>`;

  const renderDivision = (divRecord) => {
    const teams = (divRecord.teamRecords || []).slice().sort((a,b) => parseFloat(b.winningPercentage||0) - parseFloat(a.winningPercentage||0));
    const divName = divRecord.division?.name || 'Division';
    return `<div class="standings-division">
      <div class="standings-div-title">${divName}</div>
      ${renderColHeader()}
      ${teams.map((t, i) => renderTeamRow(t, i === 0)).join('')}
    </div>`;
  };

  const renderWildCard = (leagueRecords, leagueName) => {
    const allTeams = leagueRecords.flatMap(r => r.teamRecords || []);
    allTeams.sort((a,b) => parseFloat(b.winningPercentage||0) - parseFloat(a.winningPercentage||0));

    const divLeaders = new Set();
    leagueRecords.forEach(r => {
      const sorted = (r.teamRecords || []).slice().sort((a,b) => parseFloat(b.winningPercentage||0) - parseFloat(a.winningPercentage||0));
      if (sorted[0]) divLeaders.add(sorted[0].team?.id);
    });

    const wcTeams = allTeams.filter(t => !divLeaders.has(t.team?.id));
    if (!wcTeams.length) return '';

    return `<div class="standings-wildcard">
      <div class="standings-div-title">${leagueName} Wild Card</div>
      ${renderColHeader()}
      ${wcTeams.map((t, i) => {
        const sep = i === 3 ? '<div class="wc-cutoff-line">──── Wild Card Cutoff ────</div>' : '';
        return sep + renderTeamRow(t, i < 3);
      }).join('')}
    </div>`;
  };

  const renderLeague = (leagueRecords, leagueName) => {
    // Sort divisions: West, Central, East order within each league
    const divOrder = ['West','Central','East'];
    const sorted = leagueRecords.slice().sort((a,b) => {
      const ai = divOrder.findIndex(d => (a.division?.name||'').includes(d));
      const bi = divOrder.findIndex(d => (b.division?.name||'').includes(d));
      return ai - bi;
    });
    return `<div class="standings-league-col">
      <div class="standings-league-title">${leagueName}</div>
      ${sorted.map(renderDivision).join('')}
      ${renderWildCard(leagueRecords, leagueName)}
    </div>`;
  };

  con.innerHTML = `<div class="standings-layout">
    ${renderLeague(AL, 'American League')}
    ${renderLeague(NL, 'National League')}
  </div>`;
}

// ============================================================
// SCORECARD TAB
// ============================================================

function renderScorecard(data) {
  const con = $('gd-scorecard-content');
  if (!con) return;
  const box    = data.liveData?.boxscore;
  const allPlays = data.liveData?.plays?.allPlays || [];
  const gd     = data.gameData;
  const ls     = data.liveData?.linescore;

  if (!box || !allPlays.length) {
    con.innerHTML = '<div class="empty-state"><strong>No play data available yet</strong></div>';
    return;
  }

  const awayAbbr = gd?.teams?.away?.abbreviation || 'AWY';
  const homeAbbr = gd?.teams?.home?.abbreviation || 'HME';
  const awayId   = gd?.teams?.away?.id;
  const homeId   = gd?.teams?.home?.id;

  const maxInning = ls?.currentInning || allPlays.reduce((m,p) => Math.max(m, p.about?.inning||0), 0);

  // Map position name fragments → position number
  function posNum(text) {
    const t = text.toLowerCase();
    if (t.includes('pitcher'))      return '1';
    if (t.includes('catcher'))      return '2';
    if (t.includes('first base'))   return '3';
    if (t.includes('second base'))  return '4';
    if (t.includes('third base'))   return '5';
    if (t.includes('shortstop'))    return '6';
    if (t.includes('left field'))   return '7';
    if (t.includes('center field')) return '8';
    if (t.includes('right field'))  return '9';
    return null;
  }

  function eventToSymbol(play) {
    const event = play.result?.event || '';
    const desc  = play.result?.description || '';
    const dl    = desc.toLowerCase();

    if (event === 'Strikeout' || event === 'Strikeout Double Play' || event === 'Strikeout - Double Play')
      return dl.includes('called') ? 'ꓘ' : 'K';
    if (event === 'Walk')         return 'BB';
    if (event === 'Intent Walk')  return 'IBB';
    if (event === 'Hit By Pitch') return 'HBP';
    if (event === 'Single')       return '1B';
    if (event === 'Double')       return '2B';
    if (event === 'Triple')       return '3B';
    if (event === 'Home Run')     return 'HR';
    if (event === 'Sac Fly' || event === 'Sacrifice Fly') {
      const p = posNum(desc); return p ? `SF${p}` : 'SF';
    }
    if (event === 'Sac Bunt' || event === 'Sacrifice Bunt' || event === 'Bunt Groundout' || event === 'Bunt Ground Out') {
      const p = posNum(desc); return p ? `B${p}` : 'SAC';
    }
    if (event === 'Bunt Pop Out') {
      const p = posNum(desc); return p ? `BP${p}` : 'BP';
    }
    if (event.startsWith("Fielder's Choice") || event.startsWith('Fielders Choice')) return 'FC';
    if (event.includes('Double Play')) {
      const after = desc.split(/double play,?/i)[1] || '';
      const f1 = posNum(after);
      const toIdx = after.toLowerCase().indexOf(' to ');
      const f2 = toIdx >= 0 ? posNum(after.slice(toIdx + 4)) : null;
      if (f1 && f2) return `${f1}-${f2}`;
      return 'DP';
    }
    if (event === 'Ground Out' || event === 'Groundout' || event === 'Forceout') {
      const m = desc.match(/(?:grounds out|out,?),?\s+([\w\s]+?)\s+\w+\s+to\s+([\w\s]+?)\s+\w/i);
      if (m) {
        const f1 = posNum(m[1]), f2 = posNum(m[2]);
        if (f1 && f2 && f1 !== f2) return `${f1}-${f2}`;
        if (f1) return `${f1}-3`;
      }
      const after = dl.includes('grounds out') ? desc.slice(dl.indexOf('grounds out') + 11) : desc;
      const f1 = posNum(after);
      const toMatch = after.match(/\sto\s+([\w\s]+)/i);
      const f2 = toMatch ? posNum(toMatch[1]) : null;
      if (f1 && f2 && f1 !== f2) return `${f1}-${f2}`;
      if (f1) return `${f1}-3`;
      return 'GO';
    }
    if (event === 'Fly Out' || event === 'Flyout') {
      const p = posNum(desc); return p ? `F${p}` : 'FO';
    }
    if (event === 'Pop Out' || event === 'Pop Up' || event === 'Popout') {
      const p = posNum(desc); return p ? `P${p}` : 'PO';
    }
    if (event === 'Line Out' || event === 'Lineout') {
      const p = posNum(desc); return p ? `L${p}` : 'LO';
    }
    if (event.includes('Error')) return 'E';
    // Unknown out — try to extract fielder numbers from description
    if (play.result?.isOut) {
      const p1 = posNum(desc);
      const toMatch = desc.match(/\sto\s+([\w\s]+)/i);
      const p2 = toMatch ? posNum(toMatch[1]) : null;
      if (p1 && p2 && p1 !== p2) return `${p1}-${p2}`;
      if (p1) return `${p1}`;
      return '—';
    }
    return event.substring(0, 3).toUpperCase() || '?';
  }

  function makeDiamond(sym, rbi, scored, outNum) {
    // viewBox 0 0 84 84 — HP bottom, B1 right, B2 top, B3 left
    const HP=[42,76], B1=[70,44], B2=[42,12], B3=[14,44];
    const dcx=42, dcy=44; // diamond centroid

    const isHR = sym==='HR';
    const is3B = sym==='3B' || isHR;
    const is2B = sym==='2B' || is3B;
    const is1B = sym==='1B' || is2B;
    const isK  = sym==='K'  || sym==='ꓘ';
    const isBB = ['BB','IBB','HBP'].includes(sym);
    const isOut = outNum > 0;

    const red   = '#e05252';
    const blue  = '#6ab0e8';
    const green = '#52b870';
    const gold  = '#d4a843';
    const gray  = '#48525e';
    const lineCol = isHR ? gold : isK ? red : isBB ? green : is1B ? blue : gray;

    const hasScore = scored || isHR;
    const lw = '2', lc = 'round';
    let paths = '';
    if (is1B    || hasScore) paths += `<line x1="${HP[0]}" y1="${HP[1]}" x2="${B1[0]}" y2="${B1[1]}" stroke="${lineCol}" stroke-width="${lw}" stroke-linecap="${lc}"/>`;
    if (is2B    || hasScore) paths += `<line x1="${B1[0]}" y1="${B1[1]}" x2="${B2[0]}" y2="${B2[1]}" stroke="${lineCol}" stroke-width="${lw}" stroke-linecap="${lc}"/>`;
    if (is3B    || hasScore) paths += `<line x1="${B2[0]}" y1="${B2[1]}" x2="${B3[0]}" y2="${B3[1]}" stroke="${lineCol}" stroke-width="${lw}" stroke-linecap="${lc}"/>`;
    if (hasScore)            paths += `<line x1="${B3[0]}" y1="${B3[1]}" x2="${HP[0]}" y2="${HP[1]}" stroke="${lineCol}" stroke-width="${lw}" stroke-linecap="${lc}"/>`;

    const fill = hasScore
      ? `<polygon points="${HP.join(',')},${B1.join(',')},${B2.join(',')},${B3.join(',')}" fill="${lineCol}" opacity="0.2"/>`
      : '';

    const tip = hasScore ? HP : is3B ? B3 : is2B ? B2 : is1B ? B1 : null;
    const dot = tip ? `<circle cx="${tip[0]}" cy="${tip[1]}" r="3" fill="${lineCol}"/>` : '';

    const outlineAlpha = isOut ? '0.15' : '0.32';
    const outlineSW    = isOut ? '0.8' : '1.1';

    // Symbol centered inside the diamond
    const fs = sym.length > 3 ? 10 : sym.length > 2 ? 12 : sym.length > 1 ? 14 : 17;
    const symText = `<text x="${dcx}" y="${dcy}" text-anchor="middle" dominant-baseline="central" font-family="'JetBrains Mono',monospace" font-size="${fs}" font-weight="700" fill="${lineCol}" letter-spacing="-0.5">${sym}</text>`;

    // RBI count — top-left corner, small
    const rbiLabel = rbi > 0
      ? `<text x="4" y="11" font-family="'Inter',sans-serif" font-size="9" font-weight="700" fill="${lineCol}">${rbi}R</text>`
      : '';

    // Circled out number — bottom-right, outside the diamond
    const outCircle = outNum > 0
      ? `<circle cx="76" cy="76" r="7.5" fill="none" stroke="${lineCol}" stroke-width="1.5"/>
         <text x="76" y="76" text-anchor="middle" dominant-baseline="central" font-family="'Inter',sans-serif" font-size="9" font-weight="700" fill="${lineCol}">${outNum}</text>`
      : '';

    return `<svg width="100%" height="84" viewBox="0 0 84 84" preserveAspectRatio="xMidYMid meet" style="display:block">
      <polygon points="${HP.join(',')},${B1.join(',')},${B2.join(',')},${B3.join(',')}" fill="none" stroke="rgba(255,255,255,${outlineAlpha})" stroke-width="${outlineSW}"/>
      ${fill}${paths}${dot}${symText}${rbiLabel}${outCircle}
    </svg>`;
  }

  const renderTeamGrid = (side) => {
    const team = box.teams?.[side];
    if (!team) return '';
    const abbr   = side === 'away' ? awayAbbr : homeAbbr;
    const teamId = side === 'away' ? awayId : homeId;
    const half   = side === 'away' ? 'top' : 'bottom';

    // Build batting order
    const batters = (team.batters || []).map(pid => {
      const p = team.players?.[`ID${pid}`];
      if (!p) return null;
      const rawOrder = p.battingOrder ? parseInt(p.battingOrder) : 9999;
      const order    = Math.floor(rawOrder / 100);
      const pos      = p.position?.abbreviation || '?';
      return { id: pid, name: p.person?.fullName || '?', pos, order, rawOrder };
    }).filter(Boolean).filter(p => p.pos !== 'P').sort((a,b) => a.rawOrder - b.rawOrder);

    // Group plays by inning, storing symbol + rbi
    const grid = {}; // grid[batterId][inning] = { sym, rbi }
    allPlays.forEach(play => {
      if (play.about?.halfInning !== half) return;
      if (!play.result?.event) return;
      const batterId = play.matchup?.batter?.id;
      const inning   = play.about?.inning;
      if (!batterId || !inning) return;
      if (!grid[batterId]) grid[batterId] = {};
      const outNum = play.result?.isOut ? (play.about?.outs ?? 0) + 1 : 0;
      grid[batterId][inning] = { sym: eventToSymbol(play), rbi: play.result?.rbi || 0, outNum };
    });

    // Build set of (batterId, inning) where the batter later scored
    // Map each batter's at-bat: half+batterId → [{inning, playIdx}]
    const abMap = {};
    allPlays.forEach((play, idx) => {
      if (play.about?.halfInning !== half) return;
      const bid = play.matchup?.batter?.id;
      const inn = play.about?.inning;
      if (!bid || !inn) return;
      const k = bid;
      if (!abMap[k]) abMap[k] = [];
      abMap[k].push({ inn, idx });
    });
    const scoredSet = new Set(); // `${batterId}-${inning}`
    allPlays.forEach(play => {
      if (play.about?.halfInning !== half) return;
      const inn = play.about?.inning;
      (play.runners || []).forEach(runner => {
        if (runner.movement?.end !== 'score') return;
        const rid = runner.details?.runner?.id;
        if (!rid) return;
        const abs = abMap[rid];
        if (!abs) return;
        // Most recent at-bat in or before this inning
        const ab = [...abs].reverse().find(a => a.inn <= inn);
        if (ab) scoredSet.add(`${rid}-${ab.inn}`);
      });
    });

    const innings = Array.from({length: Math.max(9, maxInning)}, (_, i) => i + 1);

    const rows = batters.slice(0, 9).map(b => {
      const cells = innings.map(inn => {
        const entry  = grid[b.id]?.[inn];
        const scored = scoredSet.has(`${b.id}-${inn}`);
        return entry
          ? `<td class="sc-cell" title="${entry.sym}">${makeDiamond(entry.sym, entry.rbi, scored, entry.outNum)}</td>`
          : `<td class="sc-cell sc-empty"><svg width="100%" height="84" viewBox="0 0 84 84" preserveAspectRatio="xMidYMid meet" style="display:block"><polygon points="42,76 70,44 42,12 14,44" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="0.7"/></svg></td>`;
      }).join('');
      const pos = b.pos.length > 2 ? b.pos.substring(0,2) : b.pos;
      return `<tr class="sc-row">
        <td class="sc-player-name" data-pid="${b.id}" data-name="${b.name}" title="${b.name}">${b.name.split(' ').pop()}</td>
        <td class="sc-pos">${pos}</td>
        ${cells}
      </tr>`;
    }).join('');

    const innTotals = innings.map(inn => {
      const innData = ls?.innings?.find(i => i.num === inn);
      const runs = innData?.[side]?.runs ?? '';
      return `<td class="sc-cell sc-total-run">${runs !== '' ? `<strong>${runs}</strong>` : ''}</td>`;
    }).join('');

    return `<div class="scorecard-team">
      <div class="sc-team-header">
        ${teamId ? `<img class="sc-team-logo" src="${TEAM_LOGO(teamId)}" onerror="this.style.display='none'"/>` : ''}
        <span class="sc-team-name-lbl">${abbr} ${side === 'away' ? '(Away)' : '(Home)'}</span>
      </div>
      <div class="sc-grid-wrap">
        <table class="sc-grid">
          <thead>
            <tr class="sc-header">
              <th class="sc-player-name"></th>
              <th class="sc-pos"></th>
              ${innings.map(i => `<th class="sc-inn-hdr">${i}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows}
            <tr class="sc-totals-row">
              <td colspan="2" class="sc-totals-label">Runs</td>
              ${innTotals}
            </tr>
          </tbody>
        </table>
      </div>
    </div>`;
  };

  con.innerHTML = `<div class="scorecard-wrap" id="sc-wrap-inner">
    ${renderTeamGrid('away')}
    ${renderTeamGrid('home')}
  </div>`;

  con.querySelectorAll('.sc-player-name[data-pid]').forEach(el =>
    el.addEventListener('click', () => openPlayerProfile(parseInt(el.dataset.pid), el.dataset.name, state.selectedGamePk)));
}

function renderScorecardIframe(data) {
  renderScorecard(data);
}

// ============================================================
// VIDEO MODAL
// ============================================================

function openVideoModal(url, title) {
  const modal = $('video-modal');
  const video = $('vm-video');
  const titleEl = $('vm-title');
  if (!modal || !video) return;
  titleEl.textContent = title || '';
  video.src = url;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeVideoModal() {
  const modal = $('video-modal');
  const video = $('vm-video');
  if (!modal || !video) return;
  video.pause();
  video.src = '';
  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

// ============================================================
// POST GAME TAB
// ============================================================

async function loadPostGameHighlights(gamePk) {
  try {
    const data = await apiFetch(`${MLB_API}/game/${gamePk}/content`);
    const items = data?.highlights?.highlights?.items || [];
    return items.map(item => {
      const playbacks = item.playbacks || [];
      let best = playbacks.find(p => p.name === 'mp4Avc') ||
                 playbacks.slice().sort((a,b) => parseInt(b.width||0) - parseInt(a.width||0))[0];
      const keywords  = item.keywordsAll || item.keywordsDisplay || [];
      const playerIds = keywords.filter(k => k.type === 'player_id').map(k => String(k.value)).filter(Boolean);
      const title     = item.headline || item.title || '';
      return {
        title,
        description: item.blurb || item.description || '',
        videoUrl:    best?.url || '',
        playerIds,
        isHR:         /homer|home run|\(\d+\)/i.test(title),
        isDouble:     /double/i.test(title),
        isTriple:     /triple/i.test(title),
        isSingle:     /single/i.test(title),
        isStolenBase: /steal|stolen base/i.test(title),
      };
    }).filter(v => v.videoUrl);
  } catch {
    return [];
  }
}

async function loadGameLevelVideos(gamePk) {
  try {
    const data = await apiFetch(`${MLB_API}/game/${gamePk}/content`);
    const getVideoUrl = item => {
      const pb = item?.playbacks || [];
      const best = pb.find(p => p.name === 'mp4Avc') || pb.find(p => p.name === 'hlsCloud') || pb[0];
      return best?.url || null;
    };
    // Game-level videos are in media.epgAlternate
    const epgAlt = data?.media?.epgAlternate || [];
    const condensedBlock = epgAlt.find(e => /extended highlight|condensed/i.test(e.title || ''));
    const condensedItem  = condensedBlock?.items?.[0];
    const recapBlock     = epgAlt.find(e => /recap|daily/i.test(e.title || ''));
    const recapItem      = recapBlock?.items?.[0];

    return {
      condensedUrl:   getVideoUrl(condensedItem),
      condensedTitle: condensedItem?.title || condensedItem?.headline || 'Condensed Game',
      recapUrl:       getVideoUrl(recapItem),
      recapTitle:     recapItem?.title || recapItem?.headline || 'Daily Recap',
    };
  } catch { return {}; }
}

function findHighlightForPlay(highlights, batter, pid, event) {
  const lastName      = batter ? batter.split(' ').pop() : '';
  const pidStr        = String(pid || '');
  const isHR          = event.includes('Home Run');
  const isDouble      = event.includes('Double');
  const isTriple      = event.includes('Triple');
  const isSingle      = event.includes('Single');
  const isStolenBase  = /Stolen Base|Caught Stealing/.test(event);
  // Events that have a known highlight type — require a matching highlight, don't guess
  const hasKnownType  = isHR || isDouble || isTriple || isSingle || isStolenBase;

  const eventMatch = h =>
    (isHR && h.isHR) || (isDouble && h.isDouble) ||
    (isTriple && h.isTriple) || (isSingle && h.isSingle) ||
    (isStolenBase && h.isStolenBase);

  // 1. Player ID match
  if (pidStr) {
    const byId = highlights.filter(h => h.playerIds.includes(pidStr));
    if (byId.length > 0) {
      const matched = byId.find(eventMatch);
      if (matched) return matched;
      // Known event type but no matching highlight type = wrong video, skip
      if (hasKnownType) return null;
      // Unknown type (sac fly, fielder's choice, etc.) — only use if unambiguous
      return byId.length === 1 ? byId[0] : null;
    }
  }

  // 2. Last name match
  if (lastName) {
    const byName = highlights.filter(h => h.title.includes(lastName));
    if (byName.length > 0) {
      const matched = byName.find(eventMatch);
      if (matched) return matched;
      if (hasKnownType) return null;
      return byName.length === 1 ? byName[0] : null;
    }
  }

  return null;
}

async function renderPostGame(data) {
  const con = $('gd-postgame-content');
  if (!con) return;

  const gd      = data.gameData;
  const box     = data.liveData?.boxscore;
  const plays   = data.liveData?.plays?.allPlays || [];
  const ls      = data.liveData?.linescore;
  const awayAbbr = gd?.teams?.away?.abbreviation || 'AWY';
  const homeAbbr = gd?.teams?.home?.abbreviation || 'HME';
  const awayId   = gd?.teams?.away?.id;
  const homeId   = gd?.teams?.home?.id;
  const gamePk   = state.selectedGamePk;

  con.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';

  // Fetch WP data + highlights + game-level videos in parallel
  const [wpData, highlights, gameVideos] = await Promise.all([
    gamePk ? fetchWinProbability(gamePk) : Promise.resolve(null),
    gamePk ? loadPostGameHighlights(gamePk) : Promise.resolve([]),
    gamePk ? loadGameLevelVideos(gamePk) : Promise.resolve({}),
  ]);

  // ── Find decision pitchers via liveData.decisions (reliable ID-based lookup) ──
  const decisionsObj = data.liveData?.decisions;
  const findDecisionPitcherById = (pid) => {
    if (!pid) return null;
    for (const side of ['away', 'home']) {
      const team = box?.teams?.[side];
      const p = team?.players?.[`ID${pid}`];
      if (p) return { id: pid, side, abbr: side === 'away' ? awayAbbr : homeAbbr, ...p };
    }
    return null;
  };
  const winPitcher  = findDecisionPitcherById(decisionsObj?.winner?.id);
  const lossPitcher = findDecisionPitcherById(decisionsObj?.loser?.id);
  const savePitcher = findDecisionPitcherById(decisionsObj?.save?.id);

  const decisionPitcherCard = (pitcher, role) => {
    if (!pitcher) return '';
    const name = pitcher.person?.fullName || pitcher.abbr;
    const pit  = pitcher.stats?.pitching || pitcher.gameStats?.pitching || {};
    const ip   = pit.inningsPitched || '0.0';
    const h    = pit.hits ?? 0;
    const er   = pit.earnedRuns ?? 0;
    const bb   = pit.baseOnBalls ?? 0;
    const k    = pit.strikeOuts ?? 0;
    const era  = pitcher.seasonStats?.pitching?.era != null ? parseFloat(pitcher.seasonStats.pitching.era).toFixed(2) : '—';
    const roleColor = role === 'WIN' ? 'var(--accent-green)' : role === 'SAVE' ? 'var(--accent-gold)' : 'var(--accent-red)';
    return `<div class="pg-pitcher-line" data-pid="${pitcher.id}" onclick="openPlayerProfile(${pitcher.id},'${name.replace(/'/g,"\\'")}',${gamePk})">
      <img class="pg-pitcher-hs" src="${HEADSHOT(pitcher.id)}" onerror="this.style.display='none'" alt=""/>
      <div>
        <div class="pg-pitcher-role" style="color:${roleColor}">${pitcher.abbr} · ${role}</div>
        <div class="pg-pitcher-name">${name}</div>
        <div class="pg-pitcher-stat">${ip} IP · ${h} H · ${er} ER · ${bb} BB · ${k} K · ERA ${era}</div>
      </div>
    </div>`;
  };

  // ── Top 3 hitters per team ──
  const top3Hitters = (side) => {
    const team = box?.teams?.[side];
    const abbr = side === 'away' ? awayAbbr : homeAbbr;
    if (!team) return '';
    const ranked = (team.batters || []).map(pid => {
      const p = team.players?.[`ID${pid}`];
      if (!p) return null;
      const b = p.stats?.batting || {};
      if (!b.atBats) return null;
      const score = (b.homeRuns||0)*4 + (b.rbi||0)*2 + (b.hits||0);
      return { id:pid, name:p.person?.fullName||'?', score,
        ab:b.atBats||0, h:b.hits||0, r:b.runs||0, rbi:b.rbi||0, hr:b.homeRuns||0, bb:b.baseOnBalls||0 };
    }).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,3);
    if (!ranked.length) return '';
    return `<div class="pg-potg-team">
      <div class="pg-mini-bat-header">${abbr} IMPACT HITTERS</div>
      ${ranked.map(p=>`<div class="pg-potg-row" data-pid="${p.id}" onclick="openPlayerProfile(${p.id},'${p.name.replace(/'/g,"\\'")}',${gamePk})">
        <img class="pg-potg-hs" src="${HEADSHOT(p.id)}" onerror="this.style.display='none'" alt=""/>
        <div class="pg-potg-info">
          <div class="pg-potg-name">${p.name}</div>
          <div class="pg-potg-line">${p.ab} AB · ${p.h} H · ${p.rbi} RBI${p.hr?` · ${p.hr} HR`:''}${p.r?` · ${p.r} R`:''}</div>
        </div>
      </div>`).join('')}
    </div>`;
  };

  // ── Highlights: individual play highlights only — exclude game-level videos ──
  const gameLevelTitles = new Set([
    gameVideos.condensedTitle, gameVideos.recapTitle,
  ].filter(Boolean).map(t => t.toLowerCase()));
  const gameLevelUrls = new Set([gameVideos.condensedUrl, gameVideos.recapUrl].filter(Boolean));
  const playKeywords = /home run|hr|rbi|single|double|triple|scores|walk-off|grand slam|blast|homer/i;
  const specificHighlights = highlights.filter(h =>
    !gameLevelUrls.has(h.videoUrl) &&
    !gameLevelTitles.has(h.title.toLowerCase()) &&
    !/condensed game|daily recap/i.test(h.title) &&
    playKeywords.test(h.title + ' ' + h.description)
  );

  const highlightsHtml = specificHighlights.length ? specificHighlights.map(h => {
    const safeUrl = h.videoUrl.replace(/'/g, "\\'");
    const safeTitle = h.title.replace(/'/g, "\\'");
    return `<div class="pg-hl-play-card">
      <div class="pg-hl-play-info">
        <div class="pg-hl-play-title">${h.title}</div>
        ${h.description ? `<div class="pg-hl-play-desc">${h.description}</div>` : ''}
      </div>
      <button class="pg-watch-btn" onclick="openVideoModal('${safeUrl}','${safeTitle}')">▶ Watch</button>
    </div>`;
  }).join('') : '<div style="color:var(--text-muted);font-size:0.75rem;padding:8px">No highlights available</div>';

  // ── WP chart ──
  const wpaChartHtml = ls?.innings?.length ? buildWpaChart(ls, awayAbbr, homeAbbr, awayId, homeId, wpData, plays) : '';

  // ── Game-level video section ──
  const videoCardHtml = (url, title, label) => {
    if (!url) return '';
    const safe = url.replace(/'/g,"\\'"), safeT = title.replace(/'/g,"\\'");
    return `<div class="pg-video-card" onclick="openVideoModal('${safe}','${safeT}')">
      <div class="pg-video-icon">▶</div>
      <div class="pg-video-label">${label}</div>
      <div class="pg-video-title">${title}</div>
    </div>`;
  };
  const gameVideoHtml = (gameVideos.condensedUrl || gameVideos.recapUrl)
    ? `<div class="pg-section-title">GAME VIDEOS</div>
       <div class="pg-video-row">
         ${videoCardHtml(gameVideos.condensedUrl, gameVideos.condensedTitle || 'Condensed Game', 'CONDENSED')}
         ${videoCardHtml(gameVideos.recapUrl, gameVideos.recapTitle || 'Extended Highlights', 'HIGHLIGHTS')}
       </div>`
    : '';

  con.innerHTML = `<div class="pg-combined-layout">
    <div class="pg-left">
      <div class="pg-section-title">GAME DECISIONS</div>
      ${decisionPitcherCard(winPitcher, 'WIN') || '<div class="pg-no-data">Decision data unavailable</div>'}
      ${decisionPitcherCard(lossPitcher, 'LOSS')}
      ${decisionPitcherCard(savePitcher, 'SAVE')}
      <div class="pg-section-title" style="margin-top:8px">IMPACT HITTERS</div>
      <div class="pg-impact-row">
        ${top3Hitters('away')}
        ${top3Hitters('home')}
      </div>
    </div>
    <div class="pg-right">
      <div class="pg-section-title">WIN PROBABILITY</div>
      ${wpaChartHtml || '<div style="color:var(--text-muted);font-size:0.75rem;padding:8px">No data</div>'}
      ${gameVideoHtml ? `<div style="margin-top:8px">${gameVideoHtml}</div>` : ''}
      <div class="pg-section-title" style="margin-top:8px">PLAY HIGHLIGHTS</div>
      <div class="pg-hl-plays">${highlightsHtml}</div>
    </div>
  </div>`;
}

// ============================================================
// URL HASH — persist view across refreshes
// ============================================================

function pushHash() {
  const standingsVisible = !$('standings-section')?.classList.contains('hidden');
  if (standingsVisible) {
    history.replaceState(null, '', '#standings');
    return;
  }
  if (state.selectedGamePk) {
    history.replaceState(null, '', `#game/${state.selectedGamePk}/${state.gdTab || 'live'}/${state.currentDate}`);
    return;
  }
  history.replaceState(null, '', `#games/${state.currentDate}`);
}

async function restoreFromHash() {
  const hash = location.hash.slice(1);
  if (!hash) return false;
  const parts = hash.split('/');

  if (parts[0] === 'standings') {
    openStandings();
    return true;
  }

  if (parts[0] === 'games' && parts[1]) {
    state.currentDate = parts[1];
    currentDateLbl.textContent = friendlyDate(parts[1]);
    return false; // let init() call refreshGrid normally
  }

  if (parts[0] === 'game' && parts[1]) {
    const gamePk = parseInt(parts[1]);
    const tab    = parts[2] || 'live';
    const date   = parts[3];
    if (date) {
      state.currentDate = date;
      currentDateLbl.textContent = friendlyDate(date);
    }
    const games    = await loadSchedule(state.currentDate);
    state.games    = games;
    const gameData = games.find(g => g.gamePk === gamePk) || null;
    await openGamedayView(gamePk, gameData);
    if (tab !== 'live') setGdTab(tab);
    return true;
  }

  return false;
}

// ============================================================
// INIT
// ============================================================

async function init(){
  currentDateLbl.textContent = friendlyDate(state.currentDate);
  const restored = await restoreFromHash();
  if (!restored) refreshGrid();
  startGridPoll();
}

// ── Toast notification ───────────────────────────────────────
function showToast(msg, duration = 3500) {
  let el = document.getElementById('mob-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mob-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('visible'), duration);
}

// ── Back navigation via OS gesture / swipe ───────────────────
window.addEventListener('popstate', () => {
  const hash = location.hash.slice(1);
  const parts = hash.split('/');
  if (parts[0] === 'standings') {
    $('games-section')?.classList.add('hidden');
    $('gameday-detail')?.classList.add('hidden');
    $('standings-section')?.classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    $('nav-standings-btn')?.classList.add('active');
    syncMobNav('mob-nav-standings');
    fetchAndRenderStandings();
  } else if (parts[0] === 'game' && parts[1]) {
    // forward navigation — open that game if not already on it
    const pk = parseInt(parts[1]);
    if (state.selectedGamePk !== pk) openGamedayView(pk, state.games?.find(g => g.gamePk === pk) || null);
  } else {
    // back to games grid
    if (state.selectedGamePk) {
      stopGamedayPoll();
      state.selectedGamePk = null;
      state.gdData         = null;
      gamedayDetail?.classList.add('hidden');
      gamesSection?.classList.remove('hidden');
      document.querySelectorAll('.game-card').forEach(c => c.classList.remove('selected'));
    }
    $('standings-section')?.classList.add('hidden');
    $('games-section')?.classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    $('nav-gameday-btn')?.classList.add('active');
    syncMobNav('mob-nav-games');
  }
});

applyFavoriteTeamMeta(getFavoriteTeamId());
init();
