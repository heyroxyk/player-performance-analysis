// Answers "what's actually on disk for this league" -- the data behind GET /api/snapshots.
// Built entirely on store.js's existing, already-corruption-safe read functions rather than
// re-reading capture files directly, so this module can never disagree with store.js about
// what counts as a valid capture.

import { listSeasons, listCaptures, readLatest, readPrevious, getDataDir } from '../store.js';

export const defaultDeps = { listSeasons, listCaptures, readLatest, readPrevious, getDataDir };

function summarizeSnapshot(snapshot) {
  if (!snapshot) return null;
  return { season: snapshot.season, capturedAt: snapshot.capturedAt, playerCount: snapshot.players.length };
}

/**
 * Lists every season captured for a league, newest season first, with the latest and previous
 * capture's metadata for each -- enough for the control panel to render a season picker without
 * guessing at anything the store itself can't honestly answer.
 * @param {{league: number}} params
 * @param {typeof defaultDeps} deps
 * @returns {Promise<{league: number, seasons: Array<object>}>}
 */
export async function listSnapshotsForLeague({ league }, deps = defaultDeps) {
  const seasons = await deps.listSeasons({ league });
  const seasonsNewestFirst = [...seasons].sort((a, b) => b - a);

  const seasonSummaries = await Promise.all(
    seasonsNewestFirst.map(async (season) => {
      const [files, latest, previous] = await Promise.all([
        deps.listCaptures({ league, season }),
        deps.readLatest({ league, season }),
        deps.readPrevious({ league, season }),
      ]);

      return {
        season,
        captureCount: files.length,
        latest: summarizeSnapshot(latest),
        previous: summarizeSnapshot(previous),
        // A capture file exists but readLatest returned null: it failed to parse. Surfacing
        // this distinctly from "never captured" means the panel can say "corrupt, re-capture"
        // instead of pointing the user at an `update` command that won't fix anything, since
        // the season already has data -- it's just unreadable.
        corrupt: files.length > 0 && latest === null,
      };
    }),
  );

  return { league, dataDir: deps.getDataDir(), seasons: seasonSummaries };
}
