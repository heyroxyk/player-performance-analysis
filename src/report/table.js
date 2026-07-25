// Formats an already-ranked array of scored player rows into an aligned, fixed-width text
// table for terminal output or writing to a plain-text file. Column widths are computed per
// call from the actual data, so a longer-than-expected player name never gets truncated.

// Two spaces reads cleanly in a monospaced terminal without needing a heavier "|" grid.
const COLUMN_SEPARATOR = '  ';

// Movement fields (rankDelta, pirDelta, isNew) only exist once a previous ranking has been
// captured to diff against. We check for their presence across the whole (already-sliced) set
// rather than assuming every row has them, since a brand-new player entering the league mid-
// season carries isNew while the veterans around them carry rankDelta/pirDelta instead.
function hasMovementData(rows) {
  return rows.some((row) => row.rankDelta !== undefined || row.isNew !== undefined);
}

function formatTimeOnIce(totalSeconds) {
  const seconds = Math.round(totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

// ASCII-only markers (caret/v) instead of unicode arrows: this table may get piped to a
// terminal, a log file, or a Discord code block, and arrow glyphs mangle badly in all three.
function formatRankMovement(row) {
  if (row.isNew) return 'NEW';
  if (typeof row.rankDelta !== 'number') return '-';
  if (row.rankDelta > 0) return `^${row.rankDelta}`;
  if (row.rankDelta < 0) return `v${Math.abs(row.rankDelta)}`;
  return '-';
}

function formatPirDelta(row) {
  if (row.isNew) return 'NEW';
  if (typeof row.pirDelta !== 'number') return '-';
  const sign = row.pirDelta > 0 ? '+' : '';
  return `${sign}${row.pirDelta.toFixed(2)}`;
}

// Rank is derived from array position rather than read off the row: the caller hands us rows
// in final ranked order, so re-deriving it here means this module never has to trust (or
// re-validate) a rank field that could drift out of sync with the actual array order.
function buildColumns(includeMovement) {
  const columns = [{ label: 'Rank', align: 'right', getValue: (_row, rank) => String(rank) }];

  if (includeMovement) {
    columns.push({ label: 'Mvmt', align: 'left', getValue: (row) => formatRankMovement(row) });
  }

  columns.push(
    { label: 'Player', align: 'left', getValue: (row) => row.name },
    { label: 'Pos', align: 'left', getValue: (row) => row.position },
    { label: 'Team', align: 'left', getValue: (row) => row.team },
    { label: 'GP', align: 'right', getValue: (row) => String(row.gamesPlayed) },
    { label: 'TOI', align: 'right', getValue: (row) => formatTimeOnIce(row.timeOnIce) },
    { label: 'PIR', align: 'right', getValue: (row) => row.pir.toFixed(2) }
  );

  if (includeMovement) {
    columns.push({ label: 'PIR+/-', align: 'right', getValue: (row) => formatPirDelta(row) });
  }

  columns.push({ label: 'TPE', align: 'right', getValue: (row) => String(row.appliedTPE) });

  return columns;
}

function pad(value, width, align) {
  return align === 'right' ? value.padStart(width) : value.padEnd(width);
}

export function formatTable(rankedRows, { top = Infinity, header = null } = {}) {
  const rows = rankedRows.slice(0, top);
  const includeMovement = hasMovementData(rows);
  const columns = buildColumns(includeMovement);

  const cellsByRow = rows.map((row, index) =>
    columns.map((column) => column.getValue(row, index + 1))
  );

  // Column width = the widest cell in that column, including the header itself, so the header
  // row and every data row line up under the same padding.
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
