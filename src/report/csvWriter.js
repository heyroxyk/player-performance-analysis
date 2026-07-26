// Serializes an already-ranked array of scored player rows to CSV text. Unlike table.js, this
// module always emits the RankDelta/PIRDelta columns, even when no row has movement data:
// CSV readers expect a fixed column count per file, and a ragged CSV would break downstream
// spreadsheet imports.

const HEADER = ['Rank', 'RankDelta', 'Player', 'Pos', 'Team', 'GP', 'TOI', 'PIR', 'PIRDelta', 'Total', 'TPE'];
// Appended only in window mode (see hasWindowData below) -- the column COUNT is still fixed
// within any one file, matching this module's existing "no ragged CSV" invariant.
const WINDOW_HEADER_SUFFIX = ['SeasonGP', 'SeasonTOI', 'WindowToiPct'];
// Appended only when the rows actually carry more than one distinct status (see
// hasVariedStatus below) -- a leaderboard already filtered to one status would render the same
// value in every row of this column, adding a fixed column for no information.
const STATUS_HEADER_SUFFIX = ['Status'];

// Window rows (see src/pir/window.js) are shape-compatible with season rows, so this is the
// only way to tell the two apart -- mirrors table.js's own hasWindowData.
function hasWindowData(rows) {
  return rows.some((row) => row.seasonGamesPlayed !== undefined);
}

// Mirrors table.js's own hasVariedStatus -- see that module for the full rationale.
function hasVariedStatus(rows) {
  return new Set(rows.map((row) => row.status)).size > 1;
}

// Per RFC 4180, a field only needs quoting if it contains a comma, a double quote, or a
// newline. Quoting every field defensively would still be valid CSV, but bare fields are
// easier to eyeball when spot-checking the file, so we only quote when the content forces it.
function escapeCsvField(value) {
  const stringValue = String(value);
  const needsQuoting = /[",\n]/.test(stringValue);
  if (!needsQuoting) return stringValue;
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function formatRankDelta(row) {
  if (row.isNew) return 'NEW';
  if (typeof row.rankDelta !== 'number') return '';
  return String(row.rankDelta);
}

function formatPirDelta(row) {
  if (typeof row.pirDelta !== 'number') return '';
  return String(row.pirDelta);
}

function buildRow(row, rank, includeWindow, includeStatus) {
  const base = [
    rank,
    formatRankDelta(row),
    row.name,
    row.position,
    row.team,
    // In window mode, gamesPlayed/timeOnIce ARE the window-scoped values (see
    // src/pir/window.js) -- seasonGamesPlayed/seasonTimeOnIce below carry the season totals
    // alongside them, so a window export is never mistakable for a season one.
    row.gamesPlayed,
    // Raw seconds, not table.js's MM:SS: CSV is for machine consumption, and a spreadsheet
    // can reformat a number far more easily than it can parse an "M:SS" string back into one.
    row.timeOnIce,
    row.pir,
    formatPirDelta(row),
    row.totalImpact,
    row.appliedTPE,
  ];

  const withWindow = includeWindow
    ? [...base, row.seasonGamesPlayed, row.seasonTimeOnIce, row.windowToiFraction * 100]
    : base;

  // 'unknown' for a missing status, matching table.js -- see that module's identical fallback.
  return includeStatus ? [...withWindow, row.status ?? 'unknown'] : withWindow;
}

export function toCsv(rankedRows, { top = Infinity } = {}) {
  const rows = rankedRows.slice(0, top);
  const includeWindow = hasWindowData(rows);
  const includeStatus = hasVariedStatus(rows);
  const header = [
    ...HEADER,
    ...(includeWindow ? WINDOW_HEADER_SUFFIX : []),
    ...(includeStatus ? STATUS_HEADER_SUFFIX : []),
  ];
  const records = [header, ...rows.map((row, index) => buildRow(row, index + 1, includeWindow, includeStatus))];
  return records.map((fields) => fields.map(escapeCsvField).join(',')).join('\n');
}
