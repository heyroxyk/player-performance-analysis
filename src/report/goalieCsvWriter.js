// Serializes an already-ranked array of scored goalie rows to CSV text, mirroring
// src/report/csvWriter.js's structure and its "no ragged CSV" invariant: RankDelta/GirDelta
// columns are always emitted, even when no row has movement data.

const HEADER = [
  'Rank', 'RankDelta', 'Player', 'Team', 'GP', 'MIN', 'SA',
  'SavePct', 'ShrunkSavePct', 'OwnSignalPct', 'GIR', 'GirDelta', 'GSAR', 'Luck', 'TPE',
];
// Appended only in window mode (see hasWindowData below) -- mirrors csvWriter.js's identical
// fixed-column-count-per-file convention.
const WINDOW_HEADER_SUFFIX = ['SeasonGP', 'SeasonMinutes'];
// Appended only when the rows actually carry more than one distinct status -- mirrors
// csvWriter.js's own hasVariedStatus rationale exactly.
const STATUS_HEADER_SUFFIX = ['Status'];

// Mirrors csvWriter.js's own hasWindowData -- see src/report/goalieTable.js for the goalie-row
// specifics.
function hasWindowData(rows) {
  return rows.some((row) => row.seasonGamesPlayed !== undefined);
}

// Mirrors csvWriter.js's own hasVariedStatus.
function hasVariedStatus(rows) {
  return new Set(rows.map((row) => row.status)).size > 1;
}

// Mirrors csvWriter.js's own escapeCsvField exactly (RFC 4180, quotes only when forced).
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

function formatGirDelta(row) {
  if (typeof row.girDelta !== 'number') return '';
  return String(row.girDelta);
}

function buildRow(row, rank, includeWindow, includeStatus) {
  const base = [
    rank,
    formatRankDelta(row),
    row.name,
    row.team,
    // In window mode, gamesPlayed/minutes/shotsAgainst ARE the window-scoped values (see
    // src/pir/goalieWindow.js) -- seasonGamesPlayed/seasonMinutes below carry the season totals
    // alongside them, matching csvWriter.js's identical convention for skaters.
    row.gamesPlayed,
    row.minutes,
    row.shotsAgainst,
    row.savePct,
    row.shrunkSavePct,
    // Percentage points (0-100), not a 0-1 fraction, so a spreadsheet reader doesn't need to
    // know this column is a fraction to make sense of "28" versus "0.28".
    row.ownSignal * 100,
    row.gir,
    formatGirDelta(row),
    row.gsar,
    row.luck,
    row.appliedTPE,
  ];

  const withWindow = includeWindow ? [...base, row.seasonGamesPlayed, row.seasonMinutes] : base;

  // 'unknown' for a missing status, matching csvWriter.js's identical fallback.
  return includeStatus ? [...withWindow, row.status ?? 'unknown'] : withWindow;
}

export function toGoalieCsv(rankedRows, { top = Infinity } = {}) {
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
