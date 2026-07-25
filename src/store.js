import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// We only ever need "this season's numbers" and "last time we looked" to compute
// ranking movement (who climbed, who fell). Keeping a full history per snapshot
// would just be an ever-growing pile of JSON nobody reads; two files per
// league+season is the entire feature, enforced by rotateAndWrite being the only
// function in this module allowed to write.
const DEFAULT_DATA_DIR_URL = new URL('../data/', import.meta.url);

function toPath(dirUrlOrPath) {
  return dirUrlOrPath instanceof URL ? fileURLToPath(dirUrlOrPath) : dirUrlOrPath;
}

function seasonDirPath({ league, season }, dataDirUrl) {
  // `season` is undefined when the caller wants "whatever season the API currently
  // considers active" (see shlClient's fetchPlayerStats/fetchPlayerRatings, which omit
  // the season query param entirely in that case). Without this branch, that mode would
  // land in a directory literally named "season-undefined", which is both confusing to
  // browse and easy to misread as a bug rather than the deliberate "current season" bucket
  // it actually is.
  const seasonSegment = season === undefined ? 'current' : `season-${season}`;
  return join(toPath(dataDirUrl), `league-${league}`, seasonSegment);
}

function currentFilePath(params, dataDirUrl) {
  return join(seasonDirPath(params, dataDirUrl), 'current.json');
}

function previousFilePath(params, dataDirUrl) {
  return join(seasonDirPath(params, dataDirUrl), 'previous.json');
}

/**
 * Reads and parses a snapshot file, degrading to null for anything that would
 * stop the pipeline from producing a report: the file doesn't exist yet, or a
 * prior write got interrupted/corrupted. A missing or corrupt snapshot just
 * means "no comparison data available", never a fatal error.
 * @param {string} filePath
 * @returns {Promise<object | null>}
 */
async function readSnapshotFile(filePath) {
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
    console.warn(`store: ignoring corrupt snapshot at ${filePath} (failed to parse JSON)`);
    return null;
  }
}

/**
 * @param {{ league: number | string, season: number | string }} params
 * @param {string | URL} [dataDirUrl]
 * @returns {Promise<object | null>} the current snapshot, or null if none exists yet
 */
export async function readCurrent({ league, season }, dataDirUrl = DEFAULT_DATA_DIR_URL) {
  return readSnapshotFile(currentFilePath({ league, season }, dataDirUrl));
}

/**
 * @param {{ league: number | string, season: number | string }} params
 * @param {string | URL} [dataDirUrl]
 * @returns {Promise<object | null>} the previous snapshot, or null if none exists yet
 */
export async function readPrevious({ league, season }, dataDirUrl = DEFAULT_DATA_DIR_URL) {
  return readSnapshotFile(previousFilePath({ league, season }, dataDirUrl));
}

/**
 * Persists a new snapshot for a league+season, rotating the existing current.json
 * into previous.json first. This ordering (rotate, then write) is what guarantees
 * the directory never holds more than two snapshots: whatever was "current" a
 * moment ago becomes "previous", and anything that used to be "previous" is
 * discarded, on purpose, so it can't quietly accumulate as history we never
 * asked for.
 * @param {{ league: number | string, season: number | string, snapshot: object }} params
 * @param {string | URL} [dataDirUrl]
 * @returns {Promise<void>}
 */
export async function rotateAndWrite({ league, season, snapshot }, dataDirUrl = DEFAULT_DATA_DIR_URL) {
  const params = { league, season };
  await mkdir(seasonDirPath(params, dataDirUrl), { recursive: true });

  const currentPath = currentFilePath(params, dataDirUrl);
  const previousPath = previousFilePath(params, dataDirUrl);

  try {
    await copyFile(currentPath, previousPath);
  } catch (error) {
    // ENOENT here just means this is the first-ever capture for this league+season:
    // there's nothing to rotate yet, which is expected, not an error condition.
    if (error.code !== 'ENOENT') throw error;
  }

  await writeFile(currentPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}
