// The browser peer of src/store.js: answers the same four questions (list what's captured,
// read the latest, read the previous, find a rolling-window anchor) but over HTTP against a
// prebuilt manifest (data/index.json, see src/site/manifest.js) instead of a local filesystem.
// Deliberately NOT under src/web/public/ -- that directory is coverage-excluded and means
// "untested DOM wiring"; this module is fully testable in Node with a fake fetchImpl and must
// count toward the 80% coverage gate like everything else that isn't presentation.
//
// The one thing this module exists specifically to avoid: src/store.js's findAnchorCapture
// reads and parses EVERY capture in a season directory to pick a window anchor by
// medianGamesPlayed distance -- fine against a local disk, but over HTTP that's N x ~190KB
// fetches just to pick one file. The manifest precomputes medianGamesPlayed per capture at
// build time (with src/median.js -- the SAME function store.js uses, which is the entire parity
// guarantee between the two), so this module can select the anchor from a few hundred bytes of
// JSON and fetch exactly one capture file.

import { medianGamesPlayed } from './median.js';

const MAX_CACHED_CAPTURES = 6;

function getLeagueEntry(manifest, league) {
  return manifest.leagues.find((entry) => entry.league === league) ?? null;
}

function getSeasonEntry(leagueEntry, season) {
  return leagueEntry?.seasons.find((entry) => entry.season === season) ?? null;
}

// Mirrors src/store.js's resolveSeason: "whichever season was captured most recently" is a
// different question from "the numerically highest season number", and only the former is what
// an omitted `season` honestly means. Comparing capture FILENAMES (ISO-8601 timestamps, which
// sort lexically in time order -- see store.js's toFileStamp) rather than capturedAt fields for
// consistency with the manifest's own newest-first capture ordering.
function resolveSeasonNumber(leagueEntry, season) {
  if (season !== undefined) return season;
  if (!leagueEntry) return null;

  const captured = leagueEntry.seasons.filter((entry) => entry.captures.length > 0);
  if (captured.length === 0) return null;

  let newest = captured[0];
  for (const candidate of captured.slice(1)) {
    if (candidate.captures[0].file > newest.captures[0].file) newest = candidate;
  }
  return newest.season;
}

/**
 * Builds a browser data-access layer backed by a prebuilt manifest and fetch. `baseUrl` is the
 * URL of the `data/` directory itself (both `index.json` and `league-<L>/season-<S>/<file>.json`
 * are resolved relative to it) -- callers derive this from their own module URL (see
 * src/web/public/app.js), so this module makes no assumption about where it's mounted.
 * `liveSnapshot`, when set, is an ephemeral snapshot for `liveSnapshot.league` fetched live from
 * the API rather than found in the manifest (see src/browserCommandDeps.js's captureSnapshot) --
 * it becomes what readLatest/readPrevious/findAnchorCapture treat as "ahead of" every manifest
 * capture, the mirror image of how store.js's readLatest treats disk as ground truth.
 * @param {{baseUrl: string|URL, fetchImpl?: typeof fetch, liveSnapshot?: object|null}} params
 * @returns {{
 *   loadManifest: () => Promise<object>, reloadManifest: () => Promise<object>,
 *   listSnapshotsForLeague: (params: {league: number}) => Promise<object>,
 *   readLatest: (params: {league: number, season?: number}) => Promise<object|null>,
 *   readPrevious: (params: {league: number, season?: number}) => Promise<object|null>,
 *   findAnchorCapture: (params: {league: number, season?: number, games: number}) => Promise<object>,
 * }}
 */
export function createBrowserStore({ baseUrl, fetchImpl = globalThis.fetch, liveSnapshot = null }) {
  const manifestUrl = new URL('index.json', baseUrl);

  // Captures are named after their own capturedAt timestamp and are therefore immutable once
  // published -- default fetch caching (and Pages' CDN) is correct for them. The manifest is
  // the one thing that changes on every redeploy, so it's fetched with no-cache: a stale index
  // would otherwise mask a fresh capture behind a cached 200 with the old capture list.
  let manifestPromise = null;
  function fetchManifestNow() {
    return fetchImpl(manifestUrl, { cache: 'no-cache' }).then((res) => {
      if (!res.ok) throw new Error(`Failed to load the capture index (${res.status} ${res.statusText}) from ${manifestUrl}`);
      return res.json();
    });
  }
  function loadManifest() {
    if (!manifestPromise) manifestPromise = fetchManifestNow();
    return manifestPromise;
  }
  function reloadManifest() {
    manifestPromise = fetchManifestNow();
    return manifestPromise;
  }

  // Caches the PROMISE, not the resolved value, so concurrent readers of the same file coalesce
  // into one fetch -- a movement request does readLatest + readPrevious, and a window anchor can
  // be the same file readPrevious already fetched. Bounded with insertion-order eviction: a
  // parsed ~190KB capture is roughly 1-2MB of live JS objects, so this is a real memory decision,
  // not a formality.
  const captureCache = new Map();
  function fetchCapture(url) {
    const key = url.href;
    if (!captureCache.has(key)) {
      captureCache.set(key, fetchImpl(url).then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch capture (${res.status} ${res.statusText}) from ${url}`);
        return res.json();
      }));
      while (captureCache.size > MAX_CACHED_CAPTURES) {
        captureCache.delete(captureCache.keys().next().value);
      }
    }
    return captureCache.get(key);
  }
  // A capture fetch failing (network blip, 404 from a manifest/data drift) degrades to null --
  // the same "not available" contract store.js's readCapture has for a missing/corrupt file --
  // rather than an uncaught rejection, and evicts the failed promise so a later call gets a
  // fresh attempt instead of a cached rejection.
  async function fetchCaptureSafe(url) {
    try {
      return await fetchCapture(url);
    } catch {
      captureCache.delete(url.href);
      return null;
    }
  }

  function captureUrl(league, season, file) {
    return new URL(`league-${league}/season-${season}/${file}`, baseUrl);
  }

  function isLiveFor(league, season) {
    return liveSnapshot !== null && liveSnapshot.league === league && (season === undefined || season === liveSnapshot.season);
  }

  /**
   * Lists every season captured for a league, newest season first, with the latest and previous
   * capture's metadata for each -- derived entirely from the already-loaded manifest with ZERO
   * additional fetches, since capturedAt/playerCount are already in the manifest per capture, so
   * summarizing a season never needs to read the capture file itself.
   * @param {{league: number}} params
   */
  async function listSnapshotsForLeague({ league }) {
    const manifest = await loadManifest();
    const leagueEntry = getLeagueEntry(manifest, league);
    const seasons = leagueEntry ? [...leagueEntry.seasons].sort((a, b) => b.season - a.season) : [];

    return {
      league,
      dataDir: manifest.dataDir,
      seasons: seasons.map((entry) => ({
        season: entry.season,
        captureCount: entry.captures.length,
        // `goalieCount ?? 0` covers a manifest built before goalieCount existed (schema v1) --
        // see src/site/manifest.js's MANIFEST_SCHEMA_VERSION history.
        latest: entry.captures[0]
          ? { season: entry.season, capturedAt: entry.captures[0].capturedAt, playerCount: entry.captures[0].playerCount, goalieCount: entry.captures[0].goalieCount ?? 0 }
          : null,
        previous: entry.captures[1]
          ? { season: entry.season, capturedAt: entry.captures[1].capturedAt, playerCount: entry.captures[1].playerCount, goalieCount: entry.captures[1].goalieCount ?? 0 }
          : null,
        // Node's `corrupt` means "a capture file exists but the NEWEST one fails to parse" --
        // unreachable here by construction, since the manifest build already parsed every
        // capture it lists (see src/site/manifest.js) and drops anything that doesn't parse.
        // The closest honest browser-side signal is "this season has corrupt files and nothing
        // usable at all", which is what corruptCount alongside an empty captures list means.
        corrupt: entry.captures.length === 0 && entry.corruptCount > 0,
      })),
    };
  }

  /**
   * @param {{league: number, season?: number}} params
   */
  async function readLatest({ league, season }) {
    if (isLiveFor(league, season)) return liveSnapshot;

    const manifest = await loadManifest();
    const leagueEntry = getLeagueEntry(manifest, league);
    const resolvedSeason = resolveSeasonNumber(leagueEntry, season);
    if (resolvedSeason === null) return null;

    const seasonEntry = getSeasonEntry(leagueEntry, resolvedSeason);
    if (!seasonEntry || seasonEntry.captures.length === 0) return null;
    return fetchCaptureSafe(captureUrl(league, resolvedSeason, seasonEntry.captures[0].file));
  }

  /**
   * @param {{league: number, season?: number}} params
   */
  async function readPrevious({ league, season }) {
    const manifest = await loadManifest();
    const leagueEntry = getLeagueEntry(manifest, league);

    if (isLiveFor(league, season)) {
      // The live snapshot logically sits AHEAD of every manifest capture (it isn't in the
      // manifest at all), so what counts as "previous" is the manifest's own newest capture --
      // not its second-newest, which is what "previous" means when the newest capture already
      // IS the manifest's newest entry.
      const seasonEntry = getSeasonEntry(leagueEntry, liveSnapshot.season);
      if (!seasonEntry || seasonEntry.captures.length === 0) return null;
      return fetchCaptureSafe(captureUrl(league, liveSnapshot.season, seasonEntry.captures[0].file));
    }

    const resolvedSeason = resolveSeasonNumber(leagueEntry, season);
    if (resolvedSeason === null) return null;

    const seasonEntry = getSeasonEntry(leagueEntry, resolvedSeason);
    if (!seasonEntry || seasonEntry.captures.length < 2) return null;
    return fetchCaptureSafe(captureUrl(league, resolvedSeason, seasonEntry.captures[1].file));
  }

  /**
   * Selects a rolling-window anchor from the manifest's precomputed medianGamesPlayed (zero
   * fetches) and fetches ONLY the winning candidate -- see this module's header comment for why
   * that's the entire point of a manifest existing. Preserves store.js's findAnchorCapture
   * contract byte-for-byte: identical reason strings, identical <= tie-break (the OLDER capture
   * wins a distance tie -- see the loop below), identical return shape. Verified directly
   * against the Node implementation by test/anchorParity.test.js.
   * @param {{league: number, season?: number, games: number}} params
   */
  async function findAnchorCapture({ league, season, games }) {
    const manifest = await loadManifest();
    const leagueEntry = getLeagueEntry(manifest, league);
    const live = isLiveFor(league, season);
    const resolvedSeason = live ? liveSnapshot.season : resolveSeasonNumber(leagueEntry, season);
    const seasonEntry = resolvedSeason !== null ? getSeasonEntry(leagueEntry, resolvedSeason) : null;
    const manifestCaptures = seasonEntry ? seasonEntry.captures : [];

    // A live snapshot isn't itself a manifest entry, so EVERY manifest capture is a valid older
    // candidate (not manifestCaptures.slice(1), which is "every capture except the newest" --
    // correct only when the newest capture already IS a manifest entry, i.e. the non-live case).
    const latestMedianGamesPlayed = live ? medianGamesPlayed(liveSnapshot) : (manifestCaptures[0]?.medianGamesPlayed ?? 0);
    const candidateEntries = live ? manifestCaptures : manifestCaptures.slice(1);
    const totalCaptures = live ? manifestCaptures.length + 1 : manifestCaptures.length;

    if (candidateEntries.length === 0) {
      return {
        anchor: null, anchorFile: null, requestedGames: games, resolvedGames: 0,
        latestMedianGamesPlayed: live ? latestMedianGamesPlayed : 0, candidates: totalCaptures,
        reason: 'only one capture on disk -- a window needs at least two',
      };
    }

    const targetMedianGamesPlayed = latestMedianGamesPlayed - games;
    let remaining = candidateEntries;

    while (remaining.length > 0) {
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const distance = Math.abs(remaining[i].medianGamesPlayed - targetMedianGamesPlayed);
        // <= (not <) so that on a tie, the LATER entry in this pass wins -- remaining preserves
        // the manifest's newest-first order, so "later in this loop" means "older capture",
        // matching store.js's own tie-break rationale (a longer window is the safer miss).
        if (distance <= bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }

      const chosen = remaining[bestIndex];
      const anchor = await fetchCaptureSafe(captureUrl(league, resolvedSeason, chosen.file));
      if (anchor) {
        return {
          anchor, anchorFile: chosen.file, requestedGames: games,
          resolvedGames: latestMedianGamesPlayed - chosen.medianGamesPlayed,
          latestMedianGamesPlayed, candidates: totalCaptures, reason: null,
        };
      }

      // The chosen candidate failed to fetch (a manifest/data drift, or a transient network
      // blip) -- drop it and re-select among what's left, reproducing store.js's
      // skip-unreadable-and-keep-walking behaviour without having fetched anything else.
      remaining = remaining.filter((entry) => entry !== chosen);
    }

    return {
      anchor: null, anchorFile: null, requestedGames: games, resolvedGames: 0,
      latestMedianGamesPlayed, candidates: totalCaptures,
      reason: 'no readable earlier capture was found',
    };
  }

  return { loadManifest, reloadManifest, listSnapshotsForLeague, readLatest, readPrevious, findAnchorCapture };
}
