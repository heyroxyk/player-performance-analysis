// The Node-only half of capture handling: this module is the disk-backed adapter that wraps
// src/snapshotBuild.js's pure fetch/trim/join/assemble logic with the two things that DO need
// Node (a content-hash fingerprint via node:crypto, and reading/writing captures via
// src/store.js's node:fs/promises calls). Split this way so src/snapshotBuild.js -- and by
// extension the browser's live-refresh feature, see src/browserCommandDeps.js -- never needs
// either capability: a live-refreshed snapshot is never fingerprinted against disk (there's no
// disk to compare against) or written anywhere, it's ephemeral by design.
import { createHash } from 'node:crypto';

import { buildSnapshot, defaultBuildDeps, STORED_STAT_FIELDS, trimPlayerRow } from './snapshotBuild.js';
import { computeMovement } from './pir/movement.js';
import { readLatest, writeCapture } from './store.js';

export { STORED_STAT_FIELDS, trimPlayerRow, computeMovement };

// v1 always reports "not finished". Determining this properly would mean
// cross-referencing fetchSchedule for remaining unplayed games, which is out
// of scope for now. Always resolving false just means we never take the
// skip path below, so a finished season gets re-captured on every run --
// wasteful (one avoidable round trip) but not incorrect, since re-fetching
// unchanged stats just reproduces the same snapshot.
// TODO: wire this up to a real schedule lookup once fetchSchedule's shape is
// battle-tested for detecting "no games remaining".
async function isSeasonFinished(_params) {
  return false;
}

// Merges snapshotBuild.js's fetch deps with the two disk-backed ones only this Node adapter
// needs. Deliberately kept flat (not nested under a `build` key) so this stays a drop-in
// replacement for every existing caller and test fake -- captureSnapshot passes this same object
// straight through to buildSnapshot, which only reads the three fetch keys and ignores the rest.
export const defaultDeps = {
  ...defaultBuildDeps,
  readLatest,
  writeCapture,
  isSeasonFinished,
};

/**
 * A stable fingerprint of a snapshot's player data, independent of array order -- two captures
 * with the same fingerprint describe the same league state, so the second one adds nothing but
 * a file (and, per store.js's findAnchorCapture, a candidate window anchor that would resolve
 * to a zero-game span). Order-insensitive by design: the API's row ordering has been stable
 * across every real capture pair seen so far, but that isn't a contractual guarantee, and a
 * re-sort must never register as a "change". Sorting by id before stringifying is safe
 * regardless of key order, since trimPlayerRow always builds its keys from the same fixed
 * STORED_STAT_FIELDS list.
 * @param {Array<object>} players
 * @returns {string}
 */
export function playersFingerprint(players) {
  const sortedById = [...players].sort((a, b) => a.id - b.id);
  return createHash('sha256').update(JSON.stringify(sortedById)).digest('hex');
}

/**
 * Captures the current season-to-date skater stats + ratings from the live API, trims each
 * row, resolves the season the capture actually belongs to, and persists it as a new,
 * self-describing capture (see store.js -- captures are additive, never overwritten). Skips
 * writing (with a distinct `reason`) in two cases: a season that's both finished and already
 * captured, since a finished season's stats can never change again; and a capture that's
 * byte-for-byte identical to the one already on disk, which happens routinely on a daily
 * capture schedule between game days. Neither skip avoids the network round trip -- there's no
 * way to know the data is unchanged without fetching it -- so this saves disk and git-history
 * churn, never an API call.
 * `status` (see src/playerStatus.js) is joined onto every player row by exact name match
 * against a fresh Portal fetch, so `rank` never needs a live Portal call of its own -- status
 * becomes part of the persisted, timestamped capture, exactly like appliedTPE already is
 * (including participating in the unchanged-capture fingerprint below: a Portal outage that
 * flips every status to UNKNOWN_STATUS on an otherwise-unchanged capture IS treated as a change
 * and gets written, the same way an appliedTPE-only change already is today).
 * @param {{league: number, season?: number}} params
 * @param {typeof defaultDeps} deps
 * @param {string | URL} [dataDirUrl]
 * @returns {Promise<{skipped: boolean, reason?: 'season-finished' | 'unchanged', snapshot: object, warning?: string}>}
 */
export async function captureSnapshot({ league, season }, deps = defaultDeps, dataDirUrl) {
  // Checking isSeasonFinished before touching disk avoids a wasted readLatest
  // call on the (currently universal, per the v1 stub above) common case where
  // the season isn't finished.
  if (season !== undefined && (await deps.isSeasonFinished({ league, season }))) {
    const existingSnapshot = await deps.readLatest({ league, season }, dataDirUrl);
    if (existingSnapshot) {
      return { skipped: true, reason: 'season-finished', snapshot: existingSnapshot };
    }
  }

  // The fetch/trim/join/assemble work is entirely delegated to buildSnapshot -- deps is passed
  // straight through since it already carries fetchPlayerStats/fetchPlayerRatings/
  // fetchPortalPlayersByLeague (buildSnapshot reads only those three keys off it). Everything
  // below this line is what makes a built snapshot into a durable CAPTURE: comparing it against
  // what's already on disk, and writing it if it's new.
  const { snapshot, warning } = await buildSnapshot({ league, season }, deps);
  const warningResult = warning ? { warning } : {};

  const existingSnapshot = await deps.readLatest({ league, season: snapshot.season }, dataDirUrl);
  if (existingSnapshot && playersFingerprint(existingSnapshot.players) === playersFingerprint(snapshot.players)) {
    return { skipped: true, reason: 'unchanged', snapshot: existingSnapshot, ...warningResult };
  }

  await deps.writeCapture({ league, season: snapshot.season, snapshot }, dataDirUrl);

  return { skipped: false, snapshot, ...warningResult };
}
