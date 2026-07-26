// Formats an already-ranked array of scored goalie rows into an aligned, fixed-width text table,
// mirroring src/report/table.js's structure exactly but with goalie-appropriate columns -- a
// goalie row shares almost no fields with a skater row (see src/pir/goalieEngine.js), so the two
// column sets are entirely different rather than a shared, conditional buildColumns.

const COLUMN_SEPARATOR = '  ';

// Mirrors table.js's own hasMovementData -- see that module for the full rationale. Goalie
// movement carries girDelta (not pirDelta) alongside the same rankDelta/isNew fields (see
// src/pir/movement.js's scoreKey/deltaKey options).
function hasMovementData(rows) {
  return rows.some((row) => row.rankDelta !== undefined || row.isNew !== undefined);
}

// Mirrors table.js's own hasWindowData -- a goalie window row (see src/pir/goalieWindow.js)
// carries the season totals alongside the window-scoped gamesPlayed/minutes/shotsAgainst it's
// actually scored on.
function hasWindowData(rows) {
  return rows.some((row) => row.seasonGamesPlayed !== undefined);
}

// Mirrors table.js's own hasVariedStatus -- see that module for the full rationale.
function hasVariedStatus(rows) {
  return new Set(rows.map((row) => row.status)).size > 1;
}

// ASCII-only markers, matching table.js's identical choice for the same reason: this table may
// get piped to a terminal, a log file, or a Discord code block, and arrow glyphs mangle badly.
function formatRankMovement(row) {
  if (row.isNew) return 'NEW';
  if (typeof row.rankDelta !== 'number') return '-';
  if (row.rankDelta > 0) return `^${row.rankDelta}`;
  if (row.rankDelta < 0) return `v${Math.abs(row.rankDelta)}`;
  return '-';
}

function formatGirDelta(row) {
  if (row.isNew) return 'NEW';
  if (typeof row.girDelta !== 'number') return '-';
  const sign = row.girDelta > 0 ? '+' : '';
  return `${sign}${row.girDelta.toFixed(2)}`;
}

function formatSavePct(value) {
  return value.toFixed(3);
}

function formatSignal(ownSignal) {
  return `${Math.round(ownSignal * 100)}%`;
}

// Rank is derived from array position, never read off the row -- matches table.js's identical
// rationale: the caller hands us rows in final ranked order, so re-deriving it here means this
// module never has to trust a rank field that could drift out of sync with the array order.
function buildColumns(includeMovement, includeWindow, includeStatus) {
  const columns = [{ label: 'Rank', align: 'right', getValue: (_row, rank) => String(rank) }];

  if (includeMovement) {
    columns.push({ label: 'Mvmt', align: 'left', getValue: (row) => formatRankMovement(row) });
  }

  columns.push(
    { label: 'Player', align: 'left', getValue: (row) => row.name },
    { label: 'Team', align: 'left', getValue: (row) => row.team },
  );

  if (includeStatus) {
    columns.push({ label: 'Status', align: 'left', getValue: (row) => row.status ?? 'unknown' });
  }

  columns.push(
    { label: includeWindow ? 'GP (win)' : 'GP', align: 'right', getValue: (row) => String(row.gamesPlayed) },
    { label: includeWindow ? 'MIN (win)' : 'MIN', align: 'right', getValue: (row) => String(row.minutes) },
    { label: includeWindow ? 'SA (win)' : 'SA', align: 'right', getValue: (row) => String(row.shotsAgainst) },
  );

  if (includeWindow) {
    columns.push({ label: 'Season GP', align: 'right', getValue: (row) => String(row.seasonGamesPlayed) });
  }

  columns.push(
    { label: 'SV%', align: 'right', getValue: (row) => formatSavePct(row.savePct) },
    { label: 'xSV%', align: 'right', getValue: (row) => formatSavePct(row.shrunkSavePct) },
    // How much of the shrunk estimate is this goalie's OWN record versus the league mean --
    // deliberately placed right next to SV%/xSV% rather than off in a footnote, since a reader
    // comparing two goalies needs this to judge whether a gap is real or mostly regression.
    { label: 'Sig%', align: 'right', getValue: (row) => formatSignal(row.ownSignal) },
    { label: 'GIR', align: 'right', getValue: (row) => row.gir.toFixed(2) },
  );

  if (includeMovement) {
    columns.push({ label: 'GIR+/-', align: 'right', getValue: (row) => formatGirDelta(row) });
  }

  columns.push(
    { label: 'GSAR', align: 'right', getValue: (row) => row.gsar.toFixed(2) },
    // The gap between GSAR (observed) and what GIR alone would have predicted -- the single
    // most informative column on this board for telling "genuinely playing well" apart from
    // "got a bit lucky/unlucky given the underlying rate", see src/pir/goalieEngine.js.
    { label: 'Luck', align: 'right', getValue: (row) => row.luck.toFixed(2) },
    { label: 'TPE', align: 'right', getValue: (row) => String(row.appliedTPE) },
  );

  return columns;
}

function pad(value, width, align) {
  return align === 'right' ? value.padStart(width) : value.padEnd(width);
}

export function formatGoalieTable(rankedRows, { top = Infinity, header = null } = {}) {
  const rows = rankedRows.slice(0, top);
  const includeMovement = hasMovementData(rows);
  const includeWindow = hasWindowData(rows);
  const includeStatus = hasVariedStatus(rows);
  const columns = buildColumns(includeMovement, includeWindow, includeStatus);

  const cellsByRow = rows.map((row, index) =>
    columns.map((column) => column.getValue(row, index + 1))
  );

  const widths = columns.map((column, columnIndex) =>
    Math.max(column.label.length, ...cellsByRow.map((cells) => cells[columnIndex].length))
  );

  const renderLine = (cells) =>
    cells.map((cell, i) => pad(cell, widths[i], columns[i].align)).join(COLUMN_SEPARATOR);

  const headerLine = renderLine(columns.map((column) => column.label));
  const bodyLines = cellsByRow.map(renderLine);
  const table = [headerLine, ...bodyLines].join('\n');

  return header ? `${header}\n\n${table}` : table;
}
