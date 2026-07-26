// PIR Control Panel frontend. Vanilla ES module, no build step, no framework. Untested by
// design (see src/web/public/format.js for the pure logic that IS tested) -- kept thin, with
// every non-trivial decision (validation, scoring, formatting) pushed to src/commands.js so
// this file is mostly DOM wiring.
//
// Runs the SAME compute pipeline the CLI and the local control panel server use --
// getRanking/formatRanking from ../../commands.js -- against a browser-backed store
// (../../browserStore.js) instead of a Node server. That's true whether this page is served by
// `node serve.js` on localhost or by GitHub Pages: the only thing that differs between the two
// is where the data comes from (a live local filesystem vs. a prebuilt manifest baked into the
// deploy), never how a leaderboard gets scored. The one thing that genuinely can't exist without
// a server -- writing a new capture to disk -- stays local-only, gated on the manifest's own
// `localCapture` flag (see updateCaptureAvailability below). Live Refresh (see runLiveRefresh) is
// the opposite: it needs no server at all, so it's available in both worlds identically.

import { formatTimeOnIce, formatRankMovement, formatPirDelta, formatGirDelta, formatRelativeTime, filterRows, sortRows, hasVariedStatus } from './format.js';
import { getRanking, formatRanking } from '../../commands.js';
import { getGoalieRanking, formatGoalieRanking } from '../../goalieCommands.js';
import { createBrowserStore } from '../../browserStore.js';
import { createBrowserCommandDeps } from '../../browserCommandDeps.js';

const LEAGUES = [{ id: 0, name: 'SHL' }, { id: 1, name: 'SMJHL' }];
const POSITION_FILTERS = ['ALL', 'F', 'D', 'C', 'LW', 'RW', 'LD', 'RD'];
const MODES = [{ id: 'skaters', label: 'Skaters' }, { id: 'goalies', label: 'Goalies' }];
// Every window option skaters can pick; goalies drop '5' -- see renderWindowOptions -- since a
// ~5-game goalie window (a few dozen shots at most) always blocks on
// MIN_WINDOW_SHOTS_AGAINST_HARD (src/pir/goalieWindow.js), so offering it is a trap, not a choice.
const WINDOW_OPTIONS = [
  { value: '', label: 'Season to date' },
  { value: '5', label: 'Last ~5 games', skatersOnly: true },
  { value: '8', label: 'Last ~8 games' },
  { value: '12', label: 'Last ~12 games' },
];

// Past this age, a capture is old enough that a scheduled capture run was likely missed --
// see styles.css's .freshness-readout.stale for the visual treatment.
const STALE_CAPTURE_MS = 36 * 60 * 60 * 1000;
const FRESHNESS_RERENDER_MS = 60_000;

const EXPORT_CONTENT_TYPES = {
  table: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};
const EXPORT_EXTENSIONS = { table: 'txt', json: 'json', csv: 'csv' };

// app.js lives at <root>/src/web/public/app.js in BOTH worlds (local dev and the Pages
// artifact -- see src/web/staticAssets.js's header comment for why the two share one layout),
// so this relative URL resolves to <root>/data/ identically whether <root> is
// http://127.0.0.1:8765/ or https://<user>.github.io/player-performance-analysis/. No
// configuration, no build-time base injection, no environment branch.
const DATA_BASE_URL = new URL('../../../data/', import.meta.url);

// Reassigned by runLiveRefresh (see below) to swap in a store/deps pair backed by an ephemeral
// live snapshot -- every other function reads these via the module scope at call time, never by
// destructuring a method off them up front, so a live refresh takes effect everywhere with no
// further plumbing.
let store = createBrowserStore({ baseUrl: DATA_BASE_URL });
let deps = createBrowserCommandDeps({ store });

// Window mode swaps in a couple of columns (see src/report/table.js's identical
// buildColumns(includeMovement, includeWindow) for the server-side analogue) -- GP/TOI are
// labelled as window-scoped rather than season-scoped, and a Season GP column appears so a
// window leaderboard is never visually mistakable for a season one. Status (see
// src/report/table.js's own hasVariedStatus) only appears when the current rows actually carry
// more than one distinct status -- a leaderboard already filtered to one status would show the
// same word on every row.
// title strings become each header cell's native hover tooltip (see renderTableHead) -- most
// column labels here are abbreviations or jargon (PIR, TPE, Mvmt, TOI...) with no room to spell
// out in a header row, so a tooltip is the only place that explanation can live without either
// widening every column or repeating a paragraph the user has to scroll past.
function buildColumns(isWindow, isStatus) {
  const columns = [
    { key: 'rank', label: 'Rank', align: 'right', sortable: false },
    {
      key: 'mvmt', label: 'Mvmt', align: 'left', sortable: false,
      title: 'Change in rank since the previous capture -- ^N climbed N spots, vN fell N spots, NEW means not in the previous capture, - means unchanged. Unavailable in window mode.',
    },
    { key: 'name', label: 'Player', align: 'left', sortable: true },
    { key: 'position', label: 'Pos', align: 'left', sortable: true },
    { key: 'team', label: 'Team', align: 'left', sortable: true },
  ];
  if (isStatus) {
    columns.push({
      key: 'status', label: 'Status', align: 'left', sortable: true,
      title: "Player activity status from the Portal (a separate system from the league API), joined by exact name match. 'unknown' means no confident match was found.",
    });
  }
  columns.push(
    {
      key: 'gamesPlayed', label: isWindow ? 'GP (win)' : 'GP', align: 'right', sortable: true,
      title: isWindow ? 'Games played within this rolling window (see the Window control).' : 'Games played this season.',
    },
    {
      key: 'timeOnIce', label: isWindow ? 'TOI (win)' : 'TOI', align: 'right', sortable: true,
      title: isWindow ? 'Time on ice within this rolling window (MM:SS).' : 'Time on ice this season (MM:SS).',
    },
  );
  if (isWindow) {
    columns.push({
      key: 'seasonGamesPlayed', label: 'Season GP', align: 'right', sortable: true,
      title: 'Games played all season, for comparison against the window-scoped GP column to the left.',
    });
  }
  columns.push(
    {
      key: 'pir', label: 'PIR', align: 'right', sortable: true,
      title: 'Player Impact above Replacement -- a weighted z-score composite across 8 stats, scored against a replacement-level baseline (not a league-average one). Higher is better.',
    },
    {
      key: 'pirDelta', label: 'PIR +/-', align: 'right', sortable: false,
      title: 'Change in PIR since the previous capture.',
    },
    {
      key: 'totalImpact', label: 'Total', align: 'right', sortable: true,
      title: "PIR multiplied by hours actually played -- accumulated impact this season. PIR alone is a rate, so it can't tell a hot small sample apart from a durable full-season contributor; Total answers \"how much impact has this player delivered\" alongside PIR's \"how good is this player right now\".",
    },
    {
      key: 'appliedTPE', label: 'TPE', align: 'right', sortable: true,
      title: "Total earned experience points invested in this player's build. Not an input to PIR -- PIR measures realized on-ice impact, not invested development resources. Shown for reference only.",
    },
  );
  return columns;
}

// The goalie analogue of buildColumns -- mirrors src/report/goalieTable.js's own buildColumns
// exactly, since a goalie row shares almost no fields with a skater row (see
// src/pir/goalieEngine.js). No Pos column (every goalie row is position 'G', which would just
// repeat the same letter down the whole column) and no Baseline-driven grouping (a single-position
// pool has nothing to group by).
function buildGoalieColumns(isWindow, isStatus) {
  const columns = [
    { key: 'rank', label: 'Rank', align: 'right', sortable: false },
    { key: 'mvmt', label: 'Mvmt', align: 'left', sortable: false },
    { key: 'name', label: 'Player', align: 'left', sortable: true },
    { key: 'team', label: 'Team', align: 'left', sortable: true },
  ];
  if (isStatus) {
    columns.push({ key: 'status', label: 'Status', align: 'left', sortable: true });
  }
  columns.push(
    { key: 'gamesPlayed', label: isWindow ? 'GP (win)' : 'GP', align: 'right', sortable: true },
    { key: 'minutes', label: isWindow ? 'MIN (win)' : 'MIN', align: 'right', sortable: true },
    { key: 'shotsAgainst', label: isWindow ? 'SA (win)' : 'SA', align: 'right', sortable: true },
  );
  if (isWindow) {
    columns.push({ key: 'seasonGamesPlayed', label: 'Season GP', align: 'right', sortable: true });
  }
  columns.push(
    { key: 'savePct', label: 'SV%', align: 'right', sortable: true },
    { key: 'shrunkSavePct', label: 'xSV%', align: 'right', sortable: true },
    // How much of the shrunk estimate is this goalie's OWN record versus the league mean -- see
    // src/pir/goalieEngine.js's ownSignal. Placed right next to SV%/xSV%, not hidden in a
    // tooltip, since judging whether a gap between two goalies is real requires seeing this.
    { key: 'ownSignal', label: 'Sig%', align: 'right', sortable: true },
    { key: 'gir', label: 'GIR', align: 'right', sortable: true },
    { key: 'girDelta', label: 'GIR +/-', align: 'right', sortable: false },
    { key: 'gsar', label: 'GSAR', align: 'right', sortable: true },
    { key: 'luck', label: 'Luck', align: 'right', sortable: true },
    { key: 'appliedTPE', label: 'TPE', align: 'right', sortable: true },
  );
  return columns;
}

const state = {
  // 'skaters' | 'goalies' -- see renderModeChips/updateModeVisibility. Every other piece of
  // state below (league, season, status, movement, windowGames, filterQuery, sort, etc.) is
  // shared across both modes; only the shrinkage value needs two separate fields, since
  // skater shrinkage is in minutes and goalie shrinkage is in shots faced -- two different units
  // that must never collapse into one field lest a value entered for one mode silently gets
  // reinterpreted in the other's unit after a mode switch.
  mode: 'skaters',
  league: 0,
  season: undefined,
  baseline: 'league',
  status: 'all',
  movement: true,
  // null = adaptive (server-resolved, scaled to sample depth); a number = an explicit override.
  shrinkageMinutes: null,
  shrinkageShots: null,
  // null = season-to-date; a number = "last ~N games".
  windowGames: null,
  filterQuery: '',
  filterPosition: 'ALL',
  topLimit: 'all',
  sortKey: 'rank',
  sortDirection: 'asc',
  snapshotsByLeague: new Map(),
  // { meta, players, excluded } -- `players` holds whichever mode's ranked rows are current
  // (skater rows in 'skaters' mode, goalie rows in 'goalies' mode); the field name is not
  // renamed per mode to avoid touching every downstream reference to it for a purely cosmetic
  // difference.
  ranking: null,
  // Rank by row id, kept OUT of the row objects themselves (see loadRanking) so
  // re-sorting the on-screen table by a different column can never leak into what gets
  // exported -- toJson would otherwise serialize a `rank` key the CLI's own output never has.
  rankById: new Map(),
  expandedId: null,
  // A generation counter standing in for AbortController: getRanking's own async chain (fetches
  // through the browser store) has no cancellation signal threaded through it, so a stale
  // in-flight call is left to resolve on its own -- this counter is what lets loadRanking notice
  // "a newer request has since started" and discard the stale result rather than racing it.
  rankRequestId: 0,
  // Only true when this page is served by the local dev server (src/web/server.js), which still
  // exposes POST /api/update for a real disk capture -- the manifest itself reports this (see
  // init()), so the client never has to probe or guess.
  localCapture: false,
  // {league, season} of the last successful live refresh (see runLiveRefresh), or null. Compared
  // against the CURRENTLY DISPLAYED ranking's meta in renderFreshness -- not a bare boolean --
  // so switching league/season away from the live one correctly stops showing "live" without
  // this needing to be reset from every state-changing call site.
  liveSnapshotMeta: null,
};

// ---------------------------------------------------------------------------
// fetch helper (POST /api/update only -- the one route that survives locally)
// ---------------------------------------------------------------------------

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (cause) {
    const error = new Error(`Can't reach the control panel server -- is it still running?`);
    error.cause = cause;
    throw error;
  }

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const error = new Error(body?.error ?? `Request failed with ${res.status}`);
    error.status = res.status;
    error.code = body?.code;
    throw error;
  }

  return body;
}

// Reproduces apiRoutes.js's getRankingOrNotFound tagging exactly (.notFound -> NO_SNAPSHOT,
// .windowUnavailable -> WINDOW_UNAVAILABLE) so loadRanking's error handling below -- in
// particular its WINDOW_UNAVAILABLE auto-fallback -- needs no changes at all from when this
// same tagging happened server-side.
async function getRankingTagged(args) {
  try {
    return await getRanking(args, deps);
  } catch (error) {
    if (error.notFound) error.code = 'NO_SNAPSHOT';
    if (error.windowUnavailable) error.code = 'WINDOW_UNAVAILABLE';
    throw error;
  }
}

// The goalie analogue of getRankingTagged -- same tagging, calling src/goalieCommands.js's
// getGoalieRanking instead. getGoalieRanking's own .notFound also covers a capture that predates
// goalie support entirely (no `goalies` array at all), which reads to the user identically to
// "no snapshot found" -- both mean "there's nothing to rank yet for this league/season".
async function getGoalieRankingTagged(args) {
  try {
    return await getGoalieRanking(args, deps);
  } catch (error) {
    if (error.notFound) error.code = 'NO_SNAPSHOT';
    if (error.windowUnavailable) error.code = 'WINDOW_UNAVAILABLE';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const el = {
  freshnessReadout: document.getElementById('freshnessReadout'),
  dataDirReadout: document.getElementById('dataDirReadout'),
  statusPill: document.getElementById('statusPill'),
  modeChips: document.getElementById('modeChips'),
  goalieModeNote: document.getElementById('goalieModeNote'),
  leagueChips: document.getElementById('leagueChips'),
  seasonSelect: document.getElementById('seasonSelect'),
  seasonNote: document.getElementById('seasonNote'),
  liveRefreshButton: document.getElementById('liveRefreshButton'),
  liveRefreshStatus: document.getElementById('liveRefreshStatus'),
  captureButton: document.getElementById('captureButton'),
  captureStatus: document.getElementById('captureStatus'),
  newSeasonToggle: document.getElementById('newSeasonToggle'),
  newSeasonForm: document.getElementById('newSeasonForm'),
  newSeasonInput: document.getElementById('newSeasonInput'),
  newSeasonCapture: document.getElementById('newSeasonCapture'),
  baselineBlock: document.getElementById('baselineBlock'),
  baselineChips: document.getElementById('baselineChips'),
  statusSelect: document.getElementById('statusSelect'),
  windowSelect: document.getElementById('windowSelect'),
  windowNote: document.getElementById('windowNote'),
  movementToggle: document.getElementById('movementToggle'),
  movementNote: document.getElementById('movementNote'),
  shrinkInput: document.getElementById('shrinkInput'),
  shrinkageUnitLabel: document.getElementById('shrinkageUnitLabel'),
  shrinkageNote: document.getElementById('shrinkageNote'),
  metaStrip: document.getElementById('metaStrip'),
  noSignalBanner: document.getElementById('noSignalBanner'),
  excludedBanner: document.getElementById('excludedBanner'),
  excludedToggle: document.getElementById('excludedToggle'),
  excludedList: document.getElementById('excludedList'),
  filterInput: document.getElementById('filterInput'),
  positionChips: document.getElementById('positionChips'),
  topSelect: document.getElementById('topSelect'),
  countReadout: document.getElementById('countReadout'),
  tableWrap: document.getElementById('tableWrap'),
  boardHeadRow: document.getElementById('boardHeadRow'),
  boardBody: document.getElementById('boardBody'),
  emptyState: document.getElementById('emptyState'),
  errorBanner: document.getElementById('errorBanner'),
  errorMessage: document.getElementById('errorMessage'),
  errorRetry: document.getElementById('errorRetry'),
  errorDismiss: document.getElementById('errorDismiss'),
  exportCsv: document.getElementById('exportCsv'),
  exportJson: document.getElementById('exportJson'),
  exportTable: document.getElementById('exportTable'),
};

function setStatus(mode, text) {
  el.statusPill.textContent = text;
  el.statusPill.dataset.state = mode;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function textEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// chip groups (league / baseline / position)
// ---------------------------------------------------------------------------

function renderChips(container, options, activeValue, onSelect) {
  clearChildren(container);
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = option.label;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(option.value === activeValue));
    if (option.title) button.title = option.title;
    button.addEventListener('click', () => onSelect(option.value));
    container.appendChild(button);
  }
}

function renderModeChips() {
  const options = MODES.map((mode) => ({ value: mode.id, label: mode.label }));
  renderChips(el.modeChips, options, state.mode, (value) => {
    if (value === state.mode) return;
    state.mode = value;
    // Neither the position filter nor an in-flight window/expanded selection means anything
    // across a mode switch (a goalie row's position is always 'G', and shrinkage is tracked in
    // two separate fields precisely so switching modes never reinterprets one mode's value in
    // the other's unit -- see state's own comment) -- resetting the on-screen filter/expansion
    // state here avoids carrying over a selection that silently stops applying.
    state.filterPosition = 'ALL';
    state.expandedId = null;
    renderModeChips(); // see renderBaselineChips' comment on the same self-re-invoking pattern
    updateModeVisibility();
    refreshSnapshotsAndRanking();
  });
}

// Toggles every piece of UI that only makes sense for ONE mode: Baseline and the position filter
// are skater-only (a single-position goalie pool has nothing to group or filter by), the goalie
// scoring-methodology note is goalie-only, and the Shrinkage block's unit label/help text and the
// Window select's option set both need mode-aware TEXT even though the controls themselves are
// shared. Called once at init() and again on every mode switch.
function updateModeVisibility() {
  const isGoalieMode = state.mode === 'goalies';

  el.baselineBlock.classList.toggle('hidden', isGoalieMode);
  el.positionChips.classList.toggle('hidden', isGoalieMode);
  el.goalieModeNote.classList.toggle('hidden', !isGoalieMode);

  el.shrinkageUnitLabel.textContent = isGoalieMode ? '(shots)' : '(min)';
  el.shrinkInput.setAttribute('aria-label', `Shrinkage constant in ${isGoalieMode ? 'shots faced' : 'minutes'}`);
  el.shrinkageNote.textContent = isGoalieMode
    ? 'Pulls a goalie\'s save percentage toward the league mean, scaled to how much of the observed talent spread is real versus binomial luck. Blank = adaptive (recommended); 0 disables it entirely.'
    : 'Pulls small-sample rates toward the league mean, scaled to sample depth. Blank = adaptive (recommended); 0 disables it entirely.';
  // Re-syncs the visible input to the NEWLY ACTIVE mode's own shrinkage field -- without this, a
  // value typed in one mode would keep showing (unapplied) after switching to the other, which
  // reads as "this value is in effect" when it silently is not.
  const activeShrinkageValue = isGoalieMode ? state.shrinkageShots : state.shrinkageMinutes;
  el.shrinkInput.value = activeShrinkageValue === null ? '' : String(activeShrinkageValue);

  renderWindowOptions();
}

// Rebuilds the Window select's option list for the current mode, preserving the current
// selection when it still exists in the new list (falls back to season-to-date otherwise, e.g.
// switching TO goalie mode while '~5 games' was selected).
function renderWindowOptions() {
  const currentValue = el.windowSelect.value;
  clearChildren(el.windowSelect);

  for (const option of WINDOW_OPTIONS) {
    if (option.skatersOnly && state.mode === 'goalies') continue;
    const optionEl = textEl('option', null, option.label);
    optionEl.value = option.value;
    el.windowSelect.appendChild(optionEl);
  }

  const stillExists = [...el.windowSelect.options].some((option) => option.value === currentValue);
  el.windowSelect.value = stillExists ? currentValue : '';
  if (!stillExists) state.windowGames = null;
}

function renderLeagueChips() {
  const options = LEAGUES.map((league) => ({ value: league.id, label: league.name }));
  renderChips(el.leagueChips, options, state.league, (value) => {
    if (value === state.league) return;
    state.league = value;
    state.season = undefined;
    refreshSnapshotsAndRanking();
  });
}

function renderBaselineChips() {
  const options = [
    { value: 'league', label: 'League-wide', title: 'Every skater is scored against one shared league-wide population.' },
    {
      value: 'position', label: 'Position (F vs D)',
      title: 'Forwards are scored only against other forwards, defensemen only against other defensemen -- corrects for a league-wide baseline structurally favoring forwards (D naturally post lower Points/60 and higher Blocks/60).',
    },
  ];
  renderChips(el.baselineChips, options, state.baseline, (value) => {
    state.baseline = value;
    // renderChips rebuilds the chip buttons (and their aria-checked, which drives the
    // .chip[aria-checked="true"] highlight in styles.css) from whatever activeValue was passed
    // in AT CALL TIME -- re-calling this function is what makes the highlight track the new
    // selection. Without it (the bug renderLeagueChips avoids by being re-invoked from
    // refreshSnapshotsAndRanking on every league switch), the pressed-looking chip freezes on
    // whichever one was active when this ran, even though the underlying state -- and the
    // ranking it drives -- has since moved on correctly.
    renderBaselineChips();
    loadRanking();
  });
}

function renderPositionChips() {
  const options = POSITION_FILTERS.map((value) => ({ value, label: value }));
  renderChips(el.positionChips, options, state.filterPosition, (value) => {
    state.filterPosition = value;
    renderPositionChips(); // see renderBaselineChips' comment on the same pattern
    renderTable();
  });
}

// ---------------------------------------------------------------------------
// season select + capture
// ---------------------------------------------------------------------------

function renderSeasonSelect() {
  const snapshotInfo = state.snapshotsByLeague.get(state.league);
  clearChildren(el.seasonSelect);

  if (!snapshotInfo || snapshotInfo.seasons.length === 0) {
    const option = textEl('option', null, 'No captures yet');
    option.value = '';
    el.seasonSelect.appendChild(option);
    el.seasonSelect.disabled = true;
    el.seasonNote.textContent = 'Capture a snapshot to get started.';
    return;
  }

  el.seasonSelect.disabled = false;
  for (const seasonInfo of snapshotInfo.seasons) {
    const option = document.createElement('option');
    option.value = String(seasonInfo.season);
    const when = seasonInfo.latest ? new Date(seasonInfo.latest.capturedAt).toLocaleString() : 'unknown';
    // Shown regardless of the current mode -- both counts are useful context either way (e.g.
    // spotting a season with skaters captured but zero goalies yet).
    const counts = seasonInfo.latest ? `${seasonInfo.latest.playerCount} skaters / ${seasonInfo.latest.goalieCount ?? 0} goalies` : '';
    const flags = seasonInfo.corrupt ? ' -- CORRUPT' : seasonInfo.previous ? '' : ' -- no previous capture';
    option.textContent = `Season ${seasonInfo.season} -- ${when} -- ${counts}${flags}`;
    if (seasonInfo.corrupt) option.disabled = true;
    el.seasonSelect.appendChild(option);
  }

  const currentValue = state.season ?? snapshotInfo.seasons[0]?.season;
  if (currentValue !== undefined) {
    el.seasonSelect.value = String(currentValue);
    state.season = currentValue;
  }

  const active = snapshotInfo.seasons.find((s) => s.season === state.season);
  el.seasonNote.textContent = active?.previous
    ? `Previous capture: ${new Date(active.previous.capturedAt).toLocaleString()}`
    : 'No previous capture for this season yet -- movement will be unavailable.';
}

async function loadSnapshots() {
  const result = await store.listSnapshotsForLeague({ league: state.league });
  state.snapshotsByLeague.set(state.league, result);
  el.dataDirReadout.textContent = result.dataDir ?? '';
  renderSeasonSelect();
}

// Shows/hides the capture controls based on whether this page is served locally (where
// POST /api/update can actually write a new capture to disk) or hosted on Pages (where there is
// no server at all to write to). Read once from the manifest at init() -- see this file's
// header comment -- rather than probed, since the manifest is already the first thing loaded.
function updateCaptureAvailability() {
  el.captureButton.classList.toggle('hidden', !state.localCapture);
  el.newSeasonToggle.classList.toggle('hidden', !state.localCapture);
  if (!state.localCapture) {
    el.newSeasonForm.classList.add('hidden');
    el.captureStatus.textContent = 'This is the hosted, read-only site -- data comes from the daily automated capture, not a live click.';
  }
}

let captureTimer = null;

function startCaptureTimer() {
  const startedAt = Date.now();
  el.captureButton.disabled = true;
  captureTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    el.captureStatus.textContent = `Capturing... ${seconds}s (can take up to ~60s if the league API is slow)`;
  }, 250);
}

function stopCaptureTimer() {
  clearInterval(captureTimer);
  captureTimer = null;
  el.captureButton.disabled = false;
}

async function runCapture(season) {
  startCaptureTimer();
  setStatus('busy', 'capturing');
  try {
    const result = await api('/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(season === undefined ? { league: state.league } : { league: state.league, season }),
    });
    el.captureStatus.textContent = result.skipped
      ? `Season ${result.season} is already finished and captured -- no network call made.`
      : `Captured ${result.playerCount} players and ${result.goalieCount} goalies for season ${result.season} in ${((result.durationMs ?? 0) / 1000).toFixed(1)}s.`;
    // A soft, non-fatal Portal status-lookup failure (see snapshot.js's captureSnapshot) --
    // every player's status silently fell back to 'unknown' for this capture, worth surfacing
    // right next to the capture result rather than only in a server log.
    if (result.warning) {
      el.captureStatus.textContent += ` ${result.warning}`;
    }
    state.season = result.season;
    // The manifest is cached after its first load (see src/browserStore.js) so repeat page
    // interactions don't refetch it -- but that means a just-written local capture would
    // otherwise stay invisible until a full page reload, since loadSnapshots/loadRanking below
    // both read through that same cached manifest. Force a reload here specifically because
    // THIS caller (uniquely, among everything that reads the store) knows the underlying data
    // has actually changed.
    await store.reloadManifest();
    await loadSnapshots();
    await loadRanking();
  } catch (error) {
    if (error.code === 'UPDATE_IN_PROGRESS') {
      el.captureStatus.textContent = 'Already capturing this league/season -- hang tight.';
    } else {
      showError(error);
    }
  } finally {
    stopCaptureTimer();
    setStatus('ready', 'idle');
  }
}

// ---------------------------------------------------------------------------
// live refresh
// ---------------------------------------------------------------------------

// Pulls the CURRENT season's stats straight from the league API into memory -- no disk write, no
// server round trip -- and swaps in a store/deps pair backed by that snapshot (see
// src/browserStore.js's liveSnapshot option and src/browserCommandDeps.js's captureSnapshot).
// Available in both local and hosted contexts, unlike captureButton: a live refresh never
// touches disk, so there's nothing here the hosted, read-only site can't do too. Deliberately
// omits `season` from the captureSnapshot call -- a live refresh always means "the current
// season, right now", never whatever archived season happens to be selected in the dropdown.
async function runLiveRefresh() {
  el.liveRefreshButton.disabled = true;
  el.liveRefreshStatus.textContent = 'Fetching live data...';
  setStatus('busy', 'live refresh');
  try {
    const result = await deps.captureSnapshot({ league: state.league });
    store = createBrowserStore({ baseUrl: DATA_BASE_URL, liveSnapshot: result.snapshot });
    deps = createBrowserCommandDeps({ store });
    state.season = result.snapshot.season;
    state.liveSnapshotMeta = { league: result.snapshot.league, season: result.snapshot.season };

    el.liveRefreshStatus.textContent = `Live data fetched for ${result.snapshot.players.length} players and ${result.snapshot.goalies.length} goalies, just now.`;
    // A soft, non-fatal Portal status-lookup failure (see snapshotBuild.js's buildSnapshot) --
    // every player's status silently fell back to 'unknown' for this refresh, worth surfacing
    // right next to the result, matching runCapture's identical handling of the same warning.
    if (result.warning) {
      el.liveRefreshStatus.textContent += ` ${result.warning}`;
    }
    hideError();
    await loadSnapshots();
    await loadRanking();
  } catch (error) {
    showError(error);
  } finally {
    el.liveRefreshButton.disabled = false;
    setStatus('ready', 'idle');
  }
}

// ---------------------------------------------------------------------------
// ranking
// ---------------------------------------------------------------------------

function renderMetaStrip() {
  const meta = state.ranking?.meta;
  if (!meta) {
    el.metaStrip.textContent = '--';
    return;
  }
  const league = LEAGUES.find((l) => l.id === meta.league)?.name ?? `League ${meta.league}`;
  const parts = [`${league}`, `Season ${meta.season}`];

  // Goalie meta has no `baseline` at all (a single-position pool has nothing to group by -- see
  // src/goalieCommands.js) and reports the league/replacement save percentage baseline the
  // shrinkage was actually computed against, which a skater ranking has no equivalent of.
  if (state.mode === 'goalies') {
    parts.push(`League SV%: ${meta.leagueSavePct.toFixed(4)}`, `Replacement SV%: ${meta.replacementSavePct.toFixed(4)}`);
  } else {
    parts.push(`Baseline: ${meta.baseline}`);
  }

  parts.push(`Captured ${new Date(meta.capturedAt).toLocaleString()}`);
  if (meta.window) {
    parts.push(`Window: last ~${meta.window.requestedGames} (resolved ${meta.window.resolvedGames})`);
  }
  parts.push(
    state.mode === 'goalies'
      ? `Shrinkage: K=${Math.round(meta.shrinkageShots)} shots (${meta.shrinkageMode})`
      : `Shrinkage: ${Math.round(meta.shrinkageMinutes)}min (${meta.shrinkageMode})`,
  );
  el.metaStrip.textContent = parts.join('  ·  ');
}

let freshnessTimer = null;

// The primary trust signal for the hosted site in particular: makes it obvious the data is
// already current, so a live refresh (once added) reads as optional rather than something the
// page seems to be silently missing without it. Re-rendered on a timer (see
// startFreshnessTimer) purely for a long-open tab -- the underlying capturedAt never changes
// until the next ranking loads.
function renderFreshness() {
  const meta = state.ranking?.meta;
  if (!meta) {
    el.freshnessReadout.textContent = '';
    el.freshnessReadout.title = '';
    el.freshnessReadout.classList.remove('stale', 'live');
    return;
  }

  // Whether the CURRENTLY DISPLAYED ranking (not just "a live refresh happened at some point")
  // is the live one -- switching league or season away from it must fall back to the normal
  // "Captured N ago" reading, matching how src/browserStore.js's own isLiveFor decides whether
  // the live snapshot applies to a given league/season.
  const isLive = state.liveSnapshotMeta?.league === meta.league && state.liveSnapshotMeta?.season === meta.season;
  const capturedAt = new Date(meta.capturedAt);
  el.freshnessReadout.textContent = isLive
    ? `${formatRelativeTime(capturedAt, new Date())} · live, not saved`
    : `Captured ${formatRelativeTime(capturedAt, new Date())}`;
  el.freshnessReadout.title = capturedAt.toLocaleString();
  el.freshnessReadout.classList.toggle('live', isLive);
  el.freshnessReadout.classList.toggle('stale', !isLive && Date.now() - capturedAt.getTime() > STALE_CAPTURE_MS);
}

function startFreshnessTimer() {
  clearInterval(freshnessTimer);
  freshnessTimer = setInterval(renderFreshness, FRESHNESS_RERENDER_MS);
}

function renderExcludedBanner() {
  const excluded = state.ranking?.excluded ?? [];
  if (excluded.length === 0) {
    el.excludedBanner.classList.add('hidden');
    return;
  }
  const noun = state.mode === 'goalies' ? 'goalie' : 'skater';
  el.excludedBanner.classList.remove('hidden');
  el.excludedToggle.textContent = `${excluded.length} ${noun}${excluded.length === 1 ? '' : 's'} excluded from scoring (click to view)`;
  clearChildren(el.excludedList);
  for (const { row, reason } of excluded) {
    el.excludedList.appendChild(textEl('li', null, `${row.name} -- ${reason}`));
  }
}

// Surfaces src/pir/goalieEngine.js's adaptiveShrinkageShots noSignal flag as a page-level
// warning: when no goalie talent spread is detectable above binomial luck yet, GIR ranks are
// close to arbitrary and a user needs to know that rather than trusting a confidently-rendered
// leaderboard. Never true in skater mode -- skater meta has no noSignal field at all.
function updateNoSignalBanner() {
  el.noSignalBanner.classList.toggle('hidden', !state.ranking?.meta?.noSignal);
}

// The single shared builder for getRanking's args -- both loadRanking and exportRanking need
// the identical option set, and having two independent builders was already a latent drift bug
// even before window/shrink grew a third and fourth conditional field between them. A plain
// object now (rather than a URLSearchParams query string) since getRanking is called directly
// in-process, with no HTTP request or requestOptions.js parsing step in between.
function buildRankArgs() {
  const args = {
    league: state.league,
    baseline: state.baseline,
    status: state.status,
    movement: state.movement,
  };
  if (state.season !== undefined) args.season = state.season;
  if (state.shrinkageMinutes !== null) args.shrinkageMinutes = state.shrinkageMinutes;
  if (state.windowGames !== null) args.windowGames = state.windowGames;
  return args;
}

// The goalie analogue of buildRankArgs -- no `baseline` at all, and `shrinkageShots` (a distinct
// state field, see state's own comment on why) rather than `shrinkageMinutes`.
function buildGoalieRankArgs() {
  const args = {
    league: state.league,
    status: state.status,
    movement: state.movement,
  };
  if (state.season !== undefined) args.season = state.season;
  if (state.shrinkageShots !== null) args.shrinkageShots = state.shrinkageShots;
  if (state.windowGames !== null) args.windowGames = state.windowGames;
  return args;
}

// Triggers a same-origin download via a synthetic, never-inserted-visibly <a download> click --
// the standard DOM pattern for turning in-memory content into a file save with no server round
// trip. The object URL is revoked right after the click so it doesn't linger for the page's
// lifetime.
function downloadBlob(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// Same code path as the CLI's --out flag: formatRanking is the exact function
// `node index.js rank --format=X --out=file` calls, so this export is byte-identical to it for
// the same league/season/baseline/movement/shrink/window -- see the export caption in
// index.html. Deliberately reads state.ranking.players (the full, unfiltered/unsorted ranking)
// rather than whatever the on-screen filter/sort currently shows, matching that same caption.
function exportRanking(format) {
  const meta = state.ranking?.meta;
  if (!meta || !state.ranking) return;

  // top: undefined -- matching the CLI's own unset --top default (Infinity, i.e. every row) --
  // export has never reflected the on-screen "Rows to show" limiter, by design (see the export
  // caption in index.html).
  const isGoalieMode = state.mode === 'goalies';
  const formatted = isGoalieMode
    ? formatGoalieRanking(state.ranking.players, { format, top: undefined, meta }, deps)
    : formatRanking(state.ranking.players, { format, top: undefined, meta }, deps);
  const filenamePrefix = isGoalieMode ? 'gir' : 'pir';
  const filename = `${filenamePrefix}-league${meta.league}-season${meta.season}.${EXPORT_EXTENSIONS[format]}`;
  downloadBlob(filename, formatted, EXPORT_CONTENT_TYPES[format]);
}

async function loadRanking() {
  if (state.season === undefined && !state.snapshotsByLeague.get(state.league)?.seasons.length) {
    state.ranking = null;
    renderMetaStrip();
    renderFreshness();
    renderTable();
    return;
  }

  const requestId = ++state.rankRequestId;

  setStatus('busy', 'scoring');
  el.tableWrap.setAttribute('aria-busy', 'true');

  try {
    const args = state.mode === 'goalies' ? buildGoalieRankArgs() : buildRankArgs();
    const result = state.mode === 'goalies' ? await getGoalieRankingTagged(args) : await getRankingTagged(args);
    if (requestId !== state.rankRequestId) return; // a newer request has since started

    // Rank is tracked by id, out of band from the row objects themselves -- see state.rankById's
    // own comment for why this replaced mutating a `rank` field directly onto each row.
    state.rankById = new Map(result.ranked.map((row, index) => [row.id, index + 1]));
    state.ranking = { meta: result.meta, players: result.ranked, excluded: result.excluded };
    hideError();
  } catch (error) {
    if (requestId !== state.rankRequestId) return;

    if (error.code === 'WINDOW_UNAVAILABLE') {
      // An unmet precondition (not enough captures, or too noisy a window), not a bug --
      // revert to season-to-date and retry immediately, rather than leaving the
      // previously-good leaderboard replaced by an empty table. windowNote is set AFTER the
      // retry (which calls updateWindowAvailability internally) so the retry's own rewrite of
      // windowNote doesn't wipe this more specific message out from under it.
      state.windowGames = null;
      el.windowSelect.value = '';
      hideError();
      setStatus('ready', 'idle');
      el.tableWrap.setAttribute('aria-busy', 'false');
      await loadRanking();
      el.windowNote.textContent = error.message;
      return;
    }

    state.ranking = null;
    showError(error);
  } finally {
    if (requestId === state.rankRequestId) {
      setStatus('ready', 'idle');
      el.tableWrap.setAttribute('aria-busy', 'false');
    }
  }

  renderMetaStrip();
  renderFreshness();
  renderExcludedBanner();
  updateNoSignalBanner();
  updateWindowAvailability();
  updateMovementAvailability();
  renderTable();
}

// Movement has two independent reasons it might be unavailable (no previous capture for this
// season, or window mode being active at all), so this returns the FIRST blocking one rather
// than a bare boolean -- checking window mode second would silently let it clobber the
// no-previous-capture note whenever both happen to apply at once.
function computeMovementAvailability() {
  if (state.windowGames !== null) {
    return { available: false, reason: 'Movement is not available in window mode yet.' };
  }
  const snapshotInfo = state.snapshotsByLeague.get(state.league);
  const active = snapshotInfo?.seasons.find((s) => s.season === state.season);
  if (!active?.previous) {
    return { available: false, reason: 'No previous capture for this season yet.' };
  }
  return { available: true, reason: '' };
}

function updateMovementAvailability() {
  const { available, reason } = computeMovementAvailability();
  el.movementToggle.disabled = !available;
  el.movementNote.textContent = reason;
  if (!available && state.movement) {
    state.movement = false;
    el.movementToggle.checked = false;
  }
}

// Mirrors updateMovementAvailability's shape: derived from captureCount (already returned by
// store.listSnapshotsForLeague, so this needs no additional fetch), disables the control with a
// stated reason, and forces state back to a safe value when the current selection stops being
// valid (e.g. switching to a season with only one capture while "last ~12 games" was selected).
function updateWindowAvailability() {
  const snapshotInfo = state.snapshotsByLeague.get(state.league);
  const active = snapshotInfo?.seasons.find((s) => s.season === state.season);
  const hasEnoughCaptures = (active?.captureCount ?? 0) >= 2;

  el.windowSelect.disabled = !hasEnoughCaptures;
  if (!hasEnoughCaptures && state.windowGames !== null) {
    state.windowGames = null;
    el.windowSelect.value = '';
  }

  if (!hasEnoughCaptures) {
    el.windowNote.textContent = 'Need at least two captures for this season before a window can be built.';
    return;
  }

  // Quality warnings from the last successful ranking (e.g. "too small a sample -- Net
  // Goals/60 will be noisier than usual") live here, next to the control that caused them,
  // rather than in the meta strip.
  const warnings = state.ranking?.meta?.window?.warnings ?? [];
  el.windowNote.textContent = warnings.join(' ');
}

// ---------------------------------------------------------------------------
// table rendering
// ---------------------------------------------------------------------------

function renderTableHead(columns) {
  clearChildren(el.boardHeadRow);
  for (const column of columns) {
    const th = document.createElement('th');
    if (column.align === 'right') th.classList.add('num');
    if (column.title) th.title = column.title;

    if (!column.sortable) {
      const span = textEl('span', null, column.label);
      span.style.padding = '10px 12px';
      span.style.display = 'block';
      span.style.fontFamily = 'var(--font-ui)';
      span.style.fontWeight = '700';
      span.style.fontSize = '11px';
      span.style.letterSpacing = '0.08em';
      span.style.textTransform = 'uppercase';
      span.style.color = 'var(--ink-dim)';
      if (column.align === 'right') span.style.textAlign = 'right';
      th.appendChild(span);
      el.boardHeadRow.appendChild(th);
      continue;
    }

    const isActive = state.sortKey === column.key;
    th.setAttribute('aria-sort', isActive ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = column.label + (isActive ? (state.sortDirection === 'asc' ? ' ↑' : ' ↓') : '');
    button.addEventListener('click', () => {
      if (state.sortKey === column.key) {
        state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = column.key;
        state.sortDirection = column.key === 'name' || column.key === 'position' || column.key === 'team' ? 'asc' : 'desc';
      }
      renderTable();
    });
    th.appendChild(button);
    el.boardHeadRow.appendChild(th);
  }
}

function movementClass(row) {
  if (row.isNew) return 'mvmt-new';
  if (typeof row.rankDelta !== 'number' || row.rankDelta === 0) return 'mvmt-flat';
  return row.rankDelta > 0 ? 'mvmt-up' : 'mvmt-down';
}

function buildDetailGrid(row) {
  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  const entries = Object.entries(row.components ?? {});
  const maxAbsWeighted = Math.max(1e-9, ...entries.map(([, c]) => Math.abs(c.weighted)));

  for (const [key, component] of entries) {
    const item = document.createElement('div');
    item.className = 'detail-item';
    item.appendChild(textEl('span', 'detail-label', key));
    item.appendChild(textEl('span', 'mono', `raw ${component.rawValue.toFixed(2)}  z ${component.zScore.toFixed(2)}  wt ${component.weighted.toFixed(2)}`));

    const track = document.createElement('div');
    track.className = 'detail-bar-track';
    const fill = document.createElement('div');
    fill.className = `detail-bar-fill${component.weighted < 0 ? ' negative' : ''}`;
    const pct = Math.min(100, (Math.abs(component.weighted) / maxAbsWeighted) * 50);
    fill.style.width = `${pct}%`;
    fill.style.left = component.weighted < 0 ? `${50 - pct}%` : '50%';
    track.appendChild(fill);
    item.appendChild(track);

    grid.appendChild(item);
  }
  return grid;
}

// row.portalId is the Portal's own `pid` (see src/playerStatus.js) -- an entirely different,
// unrelated numeric ID space from this row's own `id` (the Index API's), so it's never safe to
// build this URL from anything but portalId itself. null/undefined (an unmatched or ambiguous
// name join, a capture predating this feature, or a league the Portal join skips entirely --
// IIHF/WJC) means there is no real profile to link to, handled below by leaving the name as
// plain text rather than a link to a guessed or wrong URL.
const PORTAL_PLAYER_URL_BASE = 'https://portal.simulationhockey.com/player/';

// Builds the shared `<td class="player-cell">` for a name column -- a Portal profile link when
// portalId resolved, plain text otherwise. Shared by renderRow and renderGoalieRow (a goalie row
// carries portalId from the exact same Portal join as a skater row -- see
// src/snapshotBuild.js's buildSnapshot -- so the two boards must never diverge on when a name
// does or doesn't get a link).
function buildNameCell(row) {
  const td = document.createElement('td');
  td.classList.add('player-cell');

  if (row.portalId != null) {
    const link = document.createElement('a');
    link.className = 'player-link';
    link.href = `${PORTAL_PLAYER_URL_BASE}${row.portalId}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = `Open ${row.name}'s Portal profile`;
    link.textContent = row.name;
    // Without this, the click would also bubble to the row's own listener below and toggle the
    // detail row open/closed at the same moment a new tab opens -- confusing and unnecessary,
    // since opening the profile is a complete action on its own.
    link.addEventListener('click', (event) => event.stopPropagation());
    td.appendChild(link);
  } else {
    td.textContent = row.name;
  }

  return td;
}

// The goalie analogue of buildDetailGrid. A goalie has no per-component z-score breakdown to
// show (see src/pir/goalieComponents.js -- there is exactly one scored component, and no
// z-score at all), so instead of a weighted-components bar chart this shows the actual
// arithmetic that produced GIR/GSAR: how many shots backed the estimate, how much of it is the
// goalie's own record versus the league mean (the single most important number for judging
// whether a gap between two goalies is real -- see the project's own emphasis on communicating
// this), and the luck decomposition between GSAR and what GIR alone would have predicted.
function buildGoalieDetailGrid(row) {
  const grid = document.createElement('div');
  grid.className = 'detail-grid';

  const ownSignalPct = Math.round(row.ownSignal * 100);
  const items = [
    ['Shots faced', `${row.shotsAgainst} shots, ${row.saves} saves -> observed ${row.savePct.toFixed(4)}`],
    ['Shrunk to', `${ownSignalPct}% own record / ${100 - ownSignalPct}% league mean -> ${row.shrunkSavePct.toFixed(4)}`],
    ['GIR', `${row.gir.toFixed(2)} goals saved per 1000 shots, above replacement`],
    ['GSAR', `${row.gsar.toFixed(2)} goals = ${row.expectedGsar.toFixed(2)} expected from GIR + ${row.luck.toFixed(2)} luck`],
  ];

  for (const [label, text] of items) {
    const item = document.createElement('div');
    item.className = 'detail-item';
    item.appendChild(textEl('span', 'detail-label', label));
    item.appendChild(textEl('span', 'mono', text));
    grid.appendChild(item);
  }

  // A single-direction bar (0-100%, not the two-sided weighted-component bar skaters get) --
  // the visual equivalent of the "Shrunk to" line above, so a reader can compare two goalies'
  // own-signal at a glance rather than reading two percentages.
  const signalItem = document.createElement('div');
  signalItem.className = 'detail-item';
  signalItem.appendChild(textEl('span', 'detail-label', 'Own signal'));
  const track = document.createElement('div');
  track.className = 'detail-bar-track';
  const fill = document.createElement('div');
  fill.className = 'detail-bar-fill';
  fill.style.left = '0%';
  fill.style.width = `${ownSignalPct}%`;
  track.appendChild(fill);
  signalItem.appendChild(track);
  grid.appendChild(signalItem);

  return grid;
}

function renderRow(row, columns) {
  const tr = document.createElement('tr');
  tr.className = 'data-row';
  tr.dataset.id = String(row.id);

  const cells = {
    // Read from rankById (keyed by player id), never from the row itself -- see
    // state.rankById's comment for why the row objects no longer carry a mutated `rank` field.
    rank: String(state.rankById.get(row.id) ?? ''),
    mvmt: formatRankMovement(row),
    position: row.position,
    team: row.team,
    // 'unknown' for a missing status, matching src/report/table.js's identical fallback --
    // either a capture predating this feature, or a Portal join that couldn't resolve a match.
    status: row.status ?? 'unknown',
    gamesPlayed: String(row.gamesPlayed),
    timeOnIce: formatTimeOnIce(row.timeOnIce),
    seasonGamesPlayed: row.seasonGamesPlayed !== undefined ? String(row.seasonGamesPlayed) : '',
    pir: row.pir.toFixed(2),
    pirDelta: formatPirDelta(row),
    totalImpact: row.totalImpact.toFixed(2),
    appliedTPE: String(row.appliedTPE),
  };

  for (const column of columns) {
    if (column.key === 'name') {
      tr.appendChild(buildNameCell(row));
      continue;
    }

    const td = document.createElement('td');
    if (column.align === 'right') td.classList.add('num');
    if (column.key === 'rank') td.classList.add('rank-cell');
    if (column.key === 'pir') td.classList.add('pir-cell');
    if (column.key === 'mvmt') td.classList.add(movementClass(row));
    td.textContent = cells[column.key];
    tr.appendChild(td);
  }

  tr.addEventListener('click', () => {
    state.expandedId = state.expandedId === row.id ? null : row.id;
    renderTable();
  });

  return tr;
}

// The goalie analogue of renderRow, built off buildGoalieColumns' column set instead of
// buildColumns' -- no Pos cell (every goalie row is position 'G'), and PIR/Total/pirDelta are
// replaced by SV%/xSV%/Sig%/GIR/GIR+/-/GSAR/Luck (see src/pir/goalieEngine.js).
function renderGoalieRow(row, columns) {
  const tr = document.createElement('tr');
  tr.className = 'data-row';
  tr.dataset.id = String(row.id);

  const cells = {
    rank: String(state.rankById.get(row.id) ?? ''),
    mvmt: formatRankMovement(row),
    team: row.team,
    status: row.status ?? 'unknown',
    gamesPlayed: String(row.gamesPlayed),
    minutes: String(row.minutes),
    shotsAgainst: String(row.shotsAgainst),
    seasonGamesPlayed: row.seasonGamesPlayed !== undefined ? String(row.seasonGamesPlayed) : '',
    savePct: row.savePct.toFixed(3),
    shrunkSavePct: row.shrunkSavePct.toFixed(3),
    ownSignal: `${Math.round(row.ownSignal * 100)}%`,
    gir: row.gir.toFixed(2),
    girDelta: formatGirDelta(row),
    gsar: row.gsar.toFixed(2),
    luck: row.luck.toFixed(2),
    appliedTPE: String(row.appliedTPE),
  };

  for (const column of columns) {
    if (column.key === 'name') {
      tr.appendChild(buildNameCell(row));
      continue;
    }

    const td = document.createElement('td');
    if (column.align === 'right') td.classList.add('num');
    if (column.key === 'rank') td.classList.add('rank-cell');
    if (column.key === 'gir') td.classList.add('pir-cell');
    if (column.key === 'mvmt') td.classList.add(movementClass(row));
    td.textContent = cells[column.key];
    tr.appendChild(td);
  }

  tr.addEventListener('click', () => {
    state.expandedId = state.expandedId === row.id ? null : row.id;
    renderTable();
  });

  return tr;
}

function renderTable() {
  const isGoalieMode = state.mode === 'goalies';
  const allPlayers = state.ranking?.players ?? [];
  const columns = isGoalieMode
    ? buildGoalieColumns(Boolean(state.ranking?.meta?.window), hasVariedStatus(allPlayers))
    : buildColumns(Boolean(state.ranking?.meta?.window), hasVariedStatus(allPlayers));
  renderTableHead(columns);
  clearChildren(el.boardBody);

  // Goalie mode never applies a position filter (every row is position 'G'; the position chips
  // are hidden entirely -- see updateModeVisibility), so 'ALL' is passed regardless of whatever
  // state.filterPosition happens to hold from skater mode.
  const filtered = filterRows(allPlayers, { query: state.filterQuery, position: isGoalieMode ? 'ALL' : state.filterPosition });
  const sorted = sortRows(filtered, { key: state.sortKey, direction: state.sortDirection });
  const limited = state.topLimit === 'all' ? sorted : sorted.slice(0, Number(state.topLimit));

  const noun = isGoalieMode ? 'goalies' : 'skaters';
  el.countReadout.textContent = state.ranking
    ? `Showing ${limited.length} of ${allPlayers.length} ${noun}`
    : '';

  // Checked in this order deliberately: "nothing has ever been captured" must win over "the
  // filter matched nothing", since an empty ranking always makes limited.length === 0 too --
  // without this ordering, a fresh page load with zero captures (the hosted site's actual
  // first-deploy state) would show "No skaters match this filter" instead of the real reason.
  if (!state.ranking) {
    showEmptyState('no-ranking');
    return;
  }
  if (allPlayers.length === 0) {
    showEmptyState('no-snapshot-or-empty');
    return;
  }
  if (limited.length === 0) {
    showEmptyState('filter-no-match');
    return;
  }
  el.emptyState.classList.add('hidden');
  el.tableWrap.querySelector('table').classList.remove('hidden');

  const fragment = document.createDocumentFragment();
  for (const row of limited) {
    fragment.appendChild(isGoalieMode ? renderGoalieRow(row, columns) : renderRow(row, columns));
    if (state.expandedId === row.id) {
      const detailTr = document.createElement('tr');
      detailTr.className = 'detail-row';
      const td = document.createElement('td');
      td.className = 'detail-cell';
      td.colSpan = columns.length;
      td.appendChild(isGoalieMode ? buildGoalieDetailGrid(row) : buildDetailGrid(row));
      detailTr.appendChild(td);
      fragment.appendChild(detailTr);
    }
  }
  el.boardBody.appendChild(fragment);
}

function showEmptyState(kind) {
  el.tableWrap.querySelector('table').classList.add('hidden');
  el.emptyState.classList.remove('hidden');
  clearChildren(el.emptyState);

  const noun = state.mode === 'goalies' ? 'goalies' : 'skaters';
  const singularNoun = state.mode === 'goalies' ? 'goalie' : 'skater';

  if (kind === 'filter-no-match') {
    el.emptyState.appendChild(textEl('p', null, `No ${noun} match this filter.`));
    return;
  }

  if (kind === 'no-ranking') {
    if (state.localCapture) {
      // `update` always captures both players and goalies together (see src/goalieCommands.js's
      // header comment), so the SAME suggested command is correct regardless of mode -- a
      // goalie-mode "no ranking" empty state is never telling the user to run a different command
      // than the skater one would.
      const suggestion = `node index.js update --league=${state.league}${state.season !== undefined ? ` --season=${state.season}` : ''}`;
      el.emptyState.appendChild(textEl('p', null, 'No snapshot captured yet for this league/season.'));
      el.emptyState.appendChild(textEl('code', 'empty-state-cmd', suggestion));
    } else {
      el.emptyState.appendChild(textEl('p', null, 'No snapshot captured yet for this league/season -- check back after the next automated capture.'));
    }
    return;
  }

  // kind === 'no-snapshot-or-empty': a ranking WAS loaded (state.ranking is truthy here -- see
  // renderTable's guard order), but every row in it was excluded from scoring or filtered out by
  // a --status option (see the excluded banner above for the per-row breakdown).
  el.emptyState.appendChild(textEl('p', null, `Every ${singularNoun} in this snapshot was excluded from scoring or filtered out (see above).`));
}

// ---------------------------------------------------------------------------
// error banner
// ---------------------------------------------------------------------------

let lastFailedAction = null;

function showError(error) {
  setStatus('error', 'error');
  el.errorBanner.classList.remove('hidden');
  el.errorMessage.textContent = error.status ? `[${error.status}] ${error.message}` : error.message;
}

function hideError() {
  el.errorBanner.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

async function refreshSnapshotsAndRanking() {
  renderLeagueChips();
  try {
    await loadSnapshots();
    hideError();
  } catch (error) {
    showError(error);
  }
  await loadRanking();
}

function debounce(fn, delayMs) {
  let handle;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), delayMs);
  };
}

function wireEvents() {
  el.liveRefreshButton.addEventListener('click', () => {
    lastFailedAction = runLiveRefresh;
    runLiveRefresh();
  });

  el.captureButton.addEventListener('click', () => {
    lastFailedAction = () => runCapture(state.season);
    runCapture(state.season);
  });

  el.newSeasonToggle.addEventListener('click', () => {
    el.newSeasonForm.classList.toggle('hidden');
  });

  el.newSeasonCapture.addEventListener('click', () => {
    const raw = el.newSeasonInput.value.trim();
    const season = raw === '' ? undefined : Number(raw);
    runCapture(season);
  });

  el.seasonSelect.addEventListener('change', () => {
    state.season = Number(el.seasonSelect.value);
    updateWindowAvailability();
    updateMovementAvailability();
    loadRanking();
  });

  el.statusSelect.addEventListener('change', () => {
    state.status = el.statusSelect.value;
    loadRanking();
  });

  el.windowSelect.addEventListener('change', () => {
    const raw = el.windowSelect.value;
    state.windowGames = raw === '' ? null : Number(raw);
    updateMovementAvailability();
    loadRanking();
  });

  el.movementToggle.addEventListener('change', () => {
    state.movement = el.movementToggle.checked;
    loadRanking();
  });

  el.shrinkInput.addEventListener(
    'change',
    debounce(() => {
      // Writes to whichever of the two shrinkage fields matches the CURRENT mode -- see state's
      // own comment for why skater (minutes) and goalie (shots) shrinkage are never allowed to
      // share one field.
      const stateKey = state.mode === 'goalies' ? 'shrinkageShots' : 'shrinkageMinutes';
      const raw = el.shrinkInput.value.trim();
      if (raw === '') {
        state[stateKey] = null;
        loadRanking();
        return;
      }
      const value = Number(raw);
      state[stateKey] = Number.isFinite(value) && value >= 0 ? value : null;
      loadRanking();
    }, 150),
  );

  el.filterInput.addEventListener(
    'input',
    debounce(() => {
      state.filterQuery = el.filterInput.value;
      renderTable();
    }, 150),
  );

  el.topSelect.addEventListener('change', () => {
    state.topLimit = el.topSelect.value;
    renderTable();
  });

  el.excludedToggle.addEventListener('click', () => {
    el.excludedList.classList.toggle('hidden');
  });

  el.errorDismiss.addEventListener('click', hideError);
  el.errorRetry.addEventListener('click', () => {
    hideError();
    lastFailedAction?.();
  });

  for (const [linkEl, format] of [[el.exportCsv, 'csv'], [el.exportJson, 'json'], [el.exportTable, 'table']]) {
    linkEl.addEventListener('click', (event) => {
      event.preventDefault();
      exportRanking(format);
    });
  }
}

async function init() {
  wireEvents();
  renderModeChips();
  updateModeVisibility();
  renderBaselineChips();
  renderPositionChips();
  state.league = LEAGUES[0]?.id ?? 0;

  try {
    const manifest = await store.loadManifest();
    el.dataDirReadout.textContent = manifest.dataDir ?? '';
    state.localCapture = manifest.localCapture === true;
  } catch (error) {
    // No manifest at all (a broken deploy, or a network hiccup on first load) is worse than a
    // stale one -- surface it plainly rather than silently rendering an empty panel that looks
    // like "nothing has ever been captured".
    state.localCapture = false;
    showError(new Error(`Couldn't load the capture index: ${error.message}`));
  }
  updateCaptureAvailability();

  lastFailedAction = refreshSnapshotsAndRanking;
  await refreshSnapshotsAndRanking();

  startFreshnessTimer();
}

init();
