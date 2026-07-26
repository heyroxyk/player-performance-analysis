import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { medianGamesPlayed } from './median.js';

export { medianGamesPlayed };

// Every capture is self-describing (it carries its own `league`/`season`/`capturedAt`), and
// every league+season keeps a short run of timestamped captures rather than a single rotating
// "current"/"previous" pair. There is deliberately no "current" bucket: a folder whose meaning
// silently changes when the league rolls to a new season is exactly what let a movement diff
// compare two different seasons against each other with no warning. "Give me the latest data"
// is now a question this module answers by looking at what's actually on disk, not a location
// with an assumed meaning.
//
// A function, not a module-level constant evaluated once at import time: PIR_DATA_DIR lets a
// caller point captures at a location outside the source tree (the scheduled GitHub Action
// checks out the `pir-data` branch into its own directory and needs to write there) without
// threading a data-dir argument through every call site, and a const read once at import could
// never see an env var a test sets after this module has already loaded.
function defaultDataDirUrl() {
  return process.env.PIR_DATA_DIR || new URL('../data/', import.meta.url);
}

// How much history to keep, expressed in games played rather than a file count -- a flat
// "keep the last N files" cap silently breaks the moment capture cadence changes (a week where
// `update` wasn't run at all still only costs one slot). Retention instead keeps every capture
// whose players are within this many games of the newest capture, so a rolling window (see
// src/pir/window.js) always has enough depth once captures accumulate, however often they
// actually happen.
const DEEPEST_WINDOW_GAMES = 12;
// Window-over-window movement (a window compared against the PRECEDING window of equal
// length, rather than against season-to-date) needs retained history spanning twice the
// deepest supported window, not just the window itself. That comparison isn't built yet (see
// src/commands.js), but setting the multiplier now means it will be unblocked by data the
// moment it is, rather than requiring a fresh multi-week wait to accumulate retroactively.
const WINDOW_COMPARISON_MULTIPLIER = 2;
const RETENTION_MARGIN_GAMES = 4;
const MIN_RETAINED_CAPTURES = 2;

function toPath(dirUrlOrPath) {
  return dirUrlOrPath instanceof URL ? fileURLToPath(dirUrlOrPath) : dirUrlOrPath;
}

/**
 * The absolute filesystem path captures are stored under, for display purposes (the web
 * control panel shows this so "where is my data" is never a guess).
 * @param {string|URL} [dataDirUrl]
 * @returns {string}
 */
export function getDataDir(dataDirUrl = defaultDataDirUrl()) {
  return toPath(dataDirUrl);
}

function leagueDirPath({ league }, dataDirUrl) {
  return join(toPath(dataDirUrl), `league-${league}`);
}

function seasonDirPath({ league, season }, dataDirUrl) {
  return join(leagueDirPath({ league }, dataDirUrl), `season-${season}`);
}

// Filenames are the capture's own capturedAt timestamp with colons stripped (Windows forbids
// `:` in filenames) -- ISO-8601 timestamps compare lexically in the same order they compare
// chronologically, so sorting filenames as plain strings is sorting captures by time.
function toFileStamp(isoString) {
  return isoString.replace(/:/g, '');
}

function captureFilePath(seasonDir, capturedAt) {
  return join(seasonDir, `${toFileStamp(capturedAt)}.json`);
}

// Lists a season directory's capture filenames, newest first. Missing directory reads as "no
// captures yet" rather than an error -- the common case for a league+season nobody has
// captured.
async function listCaptureFilenames(seasonDir) {
  let entries;
  try {
    entries = await readdir(seasonDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/**
 * Full paths of every capture on disk for one league+season, newest first.
 * @param {{league: number|string, season: number}} params
 * @param {string|URL} [dataDirUrl]
 * @returns {Promise<string[]>}
 */
export async function listCaptures({ league, season }, dataDirUrl = defaultDataDirUrl()) {
  const seasonDir = seasonDirPath({ league, season }, dataDirUrl);
  const filenames = await listCaptureFilenames(seasonDir);
  return filenames.map((filename) => join(seasonDir, filename));
}

/**
 * Reads and parses a capture file, degrading to null for anything that would stop the
 * pipeline from producing a report: the file doesn't exist, or a prior write got
 * interrupted/corrupted. A missing or corrupt capture just means "not available", never a
 * fatal error. Exported (promoted from a private helper) because window-anchor selection
 * needs to read arbitrary captures, not just the newest one or two.
 * @param {string} filePath
 * @returns {Promise<object | null>}
 */
export async function readCapture(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`store: ignoring corrupt capture at ${filePath} (failed to parse JSON)`);
    return null;
  }
}

/**
 * Lists every season number captured for a league, by reading the league directory rather
 * than trusting any external index -- a directory is only ever treated as a season bucket
 * when its name is exactly `season-<digits>`, so a stray or malformed directory is silently
 * skipped rather than crashing season resolution. Exported for src/site/manifest.js's
 * browser-facing capture index, which needs to enumerate seasons before it can list captures
 * within each one.
 * @param {{league: number|string}} params
 * @param {string|URL} [dataDirUrl]
 * @returns {Promise<number[]>}
 */
export async function listSeasons({ league }, dataDirUrl = defaultDataDirUrl()) {
  return listSeasonNumbers({ league }, dataDirUrl);
}

async function listSeasonNumbers({ league }, dataDirUrl) {
  let entries;
  try {
    entries = await readdir(leagueDirPath({ league }, dataDirUrl), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory() && /^season-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice('season-'.length)));
}

// Resolves an omitted `season` to whichever season was captured most recently for this
// league, by comparing the newest capture filename (a timestamp) across every season
// directory -- not the highest season number, since the most recently captured season and the
// numerically latest season are different questions and only the former is "whatever is live
// right now" as far as this module can honestly know. Returns null when the league has no
// captures at all. An explicit `season` passes through unchanged.
async function resolveSeason({ league, season }, dataDirUrl) {
  if (season !== undefined) return season;

  const seasons = await listSeasonNumbers({ league }, dataDirUrl);
  if (seasons.length === 0) return null;

  const newestPerSeason = await Promise.all(
    seasons.map(async (candidateSeason) => {
      const [newestFilename] = await listCaptureFilenames(seasonDirPath({ league, season: candidateSeason }, dataDirUrl));
      return { season: candidateSeason, newestFilename };
    }),
  );

  const captured = newestPerSeason.filter((entry) => entry.newestFilename !== undefined);
  if (captured.length === 0) return null;

  captured.sort((a, b) => (a.newestFilename < b.newestFilename ? 1 : -1));
  return captured[0].season;
}

/**
 * The most recently captured snapshot for a league+season, or -- when `season` is omitted --
 * for whichever season was captured most recently in that league. Returns null when nothing
 * has been captured yet.
 * @param {{league: number|string, season?: number}} params
 * @param {string|URL} [dataDirUrl]
 * @returns {Promise<object | null>}
 */
export async function readLatest({ league, season }, dataDirUrl = defaultDataDirUrl()) {
  const resolvedSeason = await resolveSeason({ league, season }, dataDirUrl);
  if (resolvedSeason === null) return null;

  const [latestFile] = await listCaptures({ league, season: resolvedSeason }, dataDirUrl);
  if (!latestFile) return null;
  return readCapture(latestFile);
}

/**
 * The capture immediately before the latest one, for computing movement since "last time".
 * Resolves an omitted `season` exactly like readLatest, so the two always agree on which
 * season they're looking at. Returns null when fewer than two captures exist.
 * @param {{league: number|string, season?: number}} params
 * @param {string|URL} [dataDirUrl]
 * @returns {Promise<object | null>}
 */
export async function readPrevious({ league, season }, dataDirUrl = defaultDataDirUrl()) {
  const resolvedSeason = await resolveSeason({ league, season }, dataDirUrl);
  if (resolvedSeason === null) return null;

  const files = await listCaptures({ league, season: resolvedSeason }, dataDirUrl);
  if (files.length < 2) return null;
  return readCapture(files[1]);
}

// Deletes captures older than the retention floor -- always keeping at least
// MIN_RETAINED_CAPTURES regardless of games-played span, so movement-since-last-capture never
// loses its comparison point. Captures are newest-first and games played only decreases going
// back in time, so once one capture falls below the floor, every older one does too.
async function pruneOldCaptures({ league, season }, dataDirUrl) {
  const files = await listCaptures({ league, season }, dataDirUrl);
  if (files.length <= MIN_RETAINED_CAPTURES) return;

  const newest = await readCapture(files[0]);
  if (!newest) return;

  const retentionFloorGp = medianGamesPlayed(newest) - (DEEPEST_WINDOW_GAMES * WINDOW_COMPARISON_MULTIPLIER + RETENTION_MARGIN_GAMES);

  const keep = [];
  for (const file of files) {
    if (keep.length < MIN_RETAINED_CAPTURES) {
      keep.push(file);
      continue;
    }

    const snapshot = await readCapture(file);
    if (snapshot && medianGamesPlayed(snapshot) >= retentionFloorGp) {
      keep.push(file);
    } else {
      break;
    }
  }

  await Promise.all(files.slice(keep.length).map((file) => rm(file)));
}

/**
 * Persists a new capture for a league+season and prunes captures that have fallen out of the
 * games-played retention window. Every capture is additive (nothing is overwritten), so a
 * concurrent reader can never observe a half-written "current" file.
 * @param {{league: number|string, season: number, snapshot: object}} params
 * @param {string|URL} [dataDirUrl]
 * @returns {Promise<void>}
 */
export async function writeCapture({ league, season, snapshot }, dataDirUrl = defaultDataDirUrl()) {
  const seasonDir = seasonDirPath({ league, season }, dataDirUrl);
  await mkdir(seasonDir, { recursive: true });
  await writeFile(captureFilePath(seasonDir, snapshot.capturedAt), `${JSON.stringify(snapshot, null, 2)}\n`);
  await pruneOldCaptures({ league, season }, dataDirUrl);
}

/**
 * Picks the capture closest to `games` games behind the latest one, for scoring a rolling
 * window against a shared anchor (every player is differenced against the SAME earlier
 * capture, rather than each against their own personal "N games ago" -- see src/pir/window.js
 * for why). Never fabricates an anchor: when the request can't be honestly satisfied, returns
 * `{anchor: null, reason}` rather than guessing, and always reports the span it ACTUALLY
 * resolved to (`resolvedGames`) so a caller can never present a window as deeper than it is.
 * @param {{league: number|string, season: number, games: number}} params
 * @param {string|URL} [dataDirUrl]
 * @returns {Promise<{
 *   anchor: object | null,
 *   anchorFile: string | null,
 *   requestedGames: number,
 *   resolvedGames: number,
 *   latestMedianGamesPlayed: number,
 *   candidates: number,
 *   reason: string | null,
 * }>}
 */
export async function findAnchorCapture({ league, season, games }, dataDirUrl = defaultDataDirUrl()) {
  const files = await listCaptures({ league, season }, dataDirUrl);

  if (files.length < 2) {
    return {
      anchor: null,
      anchorFile: null,
      requestedGames: games,
      resolvedGames: 0,
      latestMedianGamesPlayed: 0,
      candidates: files.length,
      reason: 'only one capture on disk -- a window needs at least two',
    };
  }

  const newest = await readCapture(files[0]);
  if (!newest) {
    return {
      anchor: null,
      anchorFile: null,
      requestedGames: games,
      resolvedGames: 0,
      latestMedianGamesPlayed: 0,
      candidates: files.length,
      reason: 'the latest capture is unreadable',
    };
  }

  const latestMedianGamesPlayed = medianGamesPlayed(newest);
  const targetMedianGamesPlayed = latestMedianGamesPlayed - games;

  let bestAnchor = null;
  let bestAnchorFile = null;
  let bestMedianGamesPlayed = null;
  let bestDistance = Infinity;

  // Captures are newest-first, so this walk moves strictly backwards in time. Unreadable
  // (corrupt) captures are skipped rather than treated as a hard stop -- a single bad file
  // shouldn't make every earlier capture unreachable.
  for (const file of files.slice(1)) {
    const candidate = await readCapture(file);
    if (!candidate) continue;

    const candidateMedianGamesPlayed = medianGamesPlayed(candidate);
    const distance = Math.abs(candidateMedianGamesPlayed - targetMedianGamesPlayed);

    // <= rather than < so that on a tie, the OLDER candidate wins (files are newest-first, so
    // later in this loop means older). The rate-reconstruction noise in src/pir/window.js gets
    // worse the SHORTER a window is, so on a tie the safer miss is a slightly-too-long window
    // rather than a slightly-too-short one.
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestAnchor = candidate;
      bestAnchorFile = file;
      bestMedianGamesPlayed = candidateMedianGamesPlayed;
    }
  }

  if (!bestAnchor) {
    return {
      anchor: null,
      anchorFile: null,
      requestedGames: games,
      resolvedGames: 0,
      latestMedianGamesPlayed,
      candidates: files.length,
      reason: 'no readable earlier capture was found',
    };
  }

  return {
    anchor: bestAnchor,
    anchorFile: bestAnchorFile,
    requestedGames: games,
    resolvedGames: latestMedianGamesPlayed - bestMedianGamesPlayed,
    latestMedianGamesPlayed,
    candidates: files.length,
    reason: null,
  };
}
