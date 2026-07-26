// Builds the browser-facing capture index (data/index.json) that src/browserStore.js reads
// instead of listing a filesystem directly. Built entirely on src/store.js's already
// corruption-safe readers (listSeasons/listCaptures/readCapture) -- the same pattern
// src/web/snapshotIndex.js already uses for the local panel's /api/snapshots endpoint -- so this
// manifest can never disagree with the Node store about what counts as a valid capture.
//
// Two consumers build this: scripts/buildSite.js runs it once at Pages-deploy build time, and
// src/web/dataRoutes.js runs it live on every local dev-server request to /data/index.json (see
// that file's comment for why running it live locally, rather than caching it, is deliberate).
//
// This module is the one place that belongs to BOTH worlds: it imports node:path and
// src/store.js's node:fs-backed readers (so it can never run in a browser), but its OUTPUT is
// exactly what the browser panel consumes. It does not appear in src/web/staticAssets.js.

import { basename } from 'node:path';

import { listSeasons, listCaptures, readCapture } from '../store.js';
import { medianGamesPlayed } from '../median.js';

export const defaultDeps = {
  listSeasons,
  listCaptures,
  readCapture,
  now: () => new Date().toISOString(),
};

export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * @param {{
 *   leagues: number[], dataDirUrl?: string|URL, dataDir?: string|null, localCapture?: boolean,
 * }} params - `dataDirUrl` is the actual filesystem location to read captures FROM, forwarded
 *   to every store.js call exactly like store.js's own optional dataDirUrl parameter (omit it
 *   to fall back to PIR_DATA_DIR / this repo's own data/ directory, same as store.js's default).
 *   `dataDir` is an entirely separate, purely cosmetic DISPLAY string for the panel's
 *   data-source readout (a branch/commit description on Pages, an absolute filesystem path
 *   locally -- see src/web/dataRoutes.js) -- it is never used to locate anything, which is why
 *   it's a distinct parameter from dataDirUrl rather than double-purposed as both. `localCapture`
 *   is true only when the local dev server builds this, since that's the one context where
 *   POST /api/update (a real disk capture) is available at all.
 * @param {typeof defaultDeps} deps
 * @returns {Promise<object>} `{schemaVersion, generatedAt, dataDir, localCapture, leagues: [
 *   {league, seasons: [{season, corruptCount, captures: [
 *     {file, capturedAt, medianGamesPlayed, playerCount}, ...   // newest-first
 *   ]}, ...]}   // newest-season-first
 * ]}`. An empty or nonexistent data directory yields `leagues: [{league, seasons: []}, ...]`
 * rather than throwing -- that IS the state of a fresh Pages deploy before any capture has run,
 * since store.js's listSeasons/listCaptures already read a missing directory as "nothing here".
 */
export async function buildManifest({ leagues, dataDirUrl, dataDir = null, localCapture = false }, deps = defaultDeps) {
  const leagueEntries = await Promise.all(leagues.map(async (league) => {
    const seasons = await deps.listSeasons({ league }, dataDirUrl);
    const seasonsNewestFirst = [...seasons].sort((a, b) => b - a);

    const seasonEntries = await Promise.all(seasonsNewestFirst.map(async (season) => {
      const files = await deps.listCaptures({ league, season }, dataDirUrl); // newest first, absolute paths
      const parsed = await Promise.all(files.map(async (file) => ({ file, snapshot: await deps.readCapture(file) })));

      const captures = [];
      let corruptCount = 0;
      for (const { file, snapshot } of parsed) {
        // A capture that fails to parse is omitted from the manifest entirely (rather than
        // included with a null placeholder) so browserStore.js's anchor selection never has to
        // reason about a candidate it can't compute medianGamesPlayed for -- it only ever sees
        // captures the manifest has already proven are readable.
        if (!snapshot) {
          corruptCount += 1;
          continue;
        }
        captures.push({
          file: basename(file),
          capturedAt: snapshot.capturedAt,
          medianGamesPlayed: medianGamesPlayed(snapshot),
          playerCount: snapshot.players.length,
        });
      }

      return { season, corruptCount, captures };
    }));

    return { league, seasons: seasonEntries };
  }));

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: deps.now(),
    dataDir,
    localCapture,
    leagues: leagueEntries,
  };
}
