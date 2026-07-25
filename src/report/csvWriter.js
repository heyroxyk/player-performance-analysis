// Serializes an already-ranked array of scored player rows to CSV text. Unlike table.js, this
// module always emits the RankDelta/PIRDelta columns, even when no row has movement data:
// CSV readers expect a fixed column count per file, and a ragged CSV would break downstream
// spreadsheet imports.

const HEADER = ['Rank', 'RankDelta', 'Player', 'Pos', 'Team', 'GP', 'TOI', 'PIR', 'PIRDelta', 'TPE'];

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

function buildRow(row, rank) {
  return [
    rank,
    formatRankDelta(row),
    row.name,
    row.position,
    row.team,
    row.gamesPlayed,
    // Raw seconds, not table.js's MM:SS: CSV is for machine consumption, and a spreadsheet
    // can reformat a number far more easily than it can parse an "M:SS" string back into one.
    row.timeOnIce,
    row.pir,
    formatPirDelta(row),
    row.appliedTPE,
  ];
}

export function toCsv(rankedRows, { top = Infinity } = {}) {
  const rows = rankedRows.slice(0, top);
  const records = [HEADER, ...rows.map((row, index) => buildRow(row, index + 1))];
  return records.map((fields) => fields.map(escapeCsvField).join(',')).join('\n');
}
