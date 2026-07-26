// Pure, DOM-free formatting/sorting/filtering helpers for the control panel. Kept in their own
// module -- rather than inline in app.js -- specifically so Node can `import` and test them
// directly with no DOM: app.js touches `document` at import time and isn't testable this way,
// but the actual formatting logic (the part most likely to silently drift from the CLI's own
// table.js) is. Mirrors src/report/table.js's MM:SS / ^N / vN / NEW / "-" conventions exactly,
// so the same movement value reads identically whether it came from the CLI or the browser.

export function formatTimeOnIce(totalSeconds) {
  const seconds = Math.round(totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function formatRankMovement(row) {
  if (row.isNew) return 'NEW';
  if (typeof row.rankDelta !== 'number') return '-';
  if (row.rankDelta > 0) return `^${row.rankDelta}`;
  if (row.rankDelta < 0) return `v${Math.abs(row.rankDelta)}`;
  return '-';
}

export function formatPirDelta(row) {
  if (row.isNew) return 'NEW';
  if (typeof row.pirDelta !== 'number') return '-';
  const sign = row.pirDelta > 0 ? '+' : '';
  return `${sign}${row.pirDelta.toFixed(2)}`;
}

// The goalie analogue of formatPirDelta, reading row.girDelta instead of row.pirDelta (see
// src/pir/movement.js's scoreKey/deltaKey options) -- everything else about the formatting
// (NEW marker, sign, 2 decimals) is identical.
export function formatGirDelta(row) {
  if (row.isNew) return 'NEW';
  if (typeof row.girDelta !== 'number') return '-';
  const sign = row.girDelta > 0 ? '+' : '';
  return `${sign}${row.girDelta.toFixed(2)}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A human-readable "how long ago" string for a capture's timestamp -- so the panel can show
 * "captured 3 hours ago" rather than only a bare ISO timestamp, making it clear at a glance that
 * the data is already current and a live refresh isn't something the user needs to reach for.
 * `now` is a parameter (not `new Date()` computed internally) so this stays pure and directly
 * testable, and so a caller can re-render the same capturedAt against a fresh "now" on a timer
 * without this function drifting out of sync with what's on screen.
 * @param {string|Date} capturedAt
 * @param {Date} now
 * @returns {string} "just now", "N minute(s) ago", "N hour(s) ago", or "N day(s) ago" -- floored,
 *   never negative (a capturedAt that's technically in the future, e.g. from clock skew, still
 *   reads as "just now" rather than a confusing negative duration).
 */
export function formatRelativeTime(capturedAt, now) {
  const capturedMs = capturedAt instanceof Date ? capturedAt.getTime() : new Date(capturedAt).getTime();
  const diffMs = Math.max(0, now.getTime() - capturedMs);

  if (diffMs < MINUTE_MS) return 'just now';
  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(diffMs / DAY_MS);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * True when `rows` contains more than one distinct player status -- mirrors
 * src/report/table.js's own hasVariedStatus (and its rationale): a leaderboard already filtered
 * down to one status via --status=active/inactive would show the same word in every row, which
 * is clutter, not information, so the Status column only earns its place on screen when it
 * actually varies.
 * @param {Array<{status?: string}>} rows
 * @returns {boolean}
 */
export function hasVariedStatus(rows) {
  return new Set(rows.map((row) => row.status)).size > 1;
}

const POSITION_GROUP_MEMBERS = { F: ['C', 'LW', 'RW'], D: ['LD', 'RD'] };

/**
 * True when `position` belongs to the requested filter -- an exact position code ("LD"), a
 * broad group ("F"/"D"), or "ALL".
 */
export function matchesPositionFilter(position, filter) {
  if (filter === 'ALL') return true;
  if (filter === position) return true;
  return POSITION_GROUP_MEMBERS[filter]?.includes(position) ?? false;
}

/**
 * Filters ranked rows by a free-text name/team query and a position filter. Never mutates or
 * reorders -- filtering and sorting are independent operations composed by the caller.
 * @param {Array<object>} rows
 * @param {{query?: string, position?: string}} [options]
 */
export function filterRows(rows, { query = '', position = 'ALL' } = {}) {
  const normalizedQuery = query.trim().toLowerCase();

  return rows.filter((row) => {
    const matchesPosition = matchesPositionFilter(row.position, position);
    const matchesQuery =
      normalizedQuery === '' ||
      row.name.toLowerCase().includes(normalizedQuery) ||
      row.team.toLowerCase().includes(normalizedQuery);
    return matchesPosition && matchesQuery;
  });
}

/**
 * Returns a NEW array sorted by `key` -- never mutates its input, matching rankByPir's own
 * contract in src/pir/pirEngine.js. Sorting by a column other than "pir" changes display order
 * only: callers should keep each row's original PIR-derived `rank` field intact rather than
 * re-deriving it from the new array position, so a re-sorted view never implies a different
 * ranking than the one PIR actually produced.
 * @param {Array<object>} rows
 * @param {{key: string, direction: 'asc'|'desc'}} options
 */
export function sortRows(rows, { key, direction }) {
  const sign = direction === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    const left = a[key];
    const right = b[key];

    if (typeof left === 'string') return sign * left.localeCompare(right);
    return sign * (left - right);
  });
}
