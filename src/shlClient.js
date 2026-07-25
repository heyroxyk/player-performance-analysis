// Thin HTTP client for the league's live JSON API. This project is a fresh,
// independent implementation (not shared code) but deliberately mirrors the
// retry/timeout shape of the sibling shl-boxscore-discord project's own
// src/shlClient.js, since both clients are talking to the same flaky-under-
// load upstream and that shape has already earned its keep there.

// The index.simulationhockey.com API rejects requests with no/unusual User-Agent
// headers, and specifically disallows the ClaudeBot UA.
const USER_AGENT = 'Mozilla/5.0 (compatible; SHL-PlayerImpact-Bot/1.0)';
const INDEX_API_V1 = 'https://index.simulationhockey.com/api/v1';

// No published guidance on typical response times for this endpoint from this
// project, so we start from the sibling project's measured budget (a healthy
// request clears in ~150ms; this is sized for the endpoint's occasional
// multi-second stalls, not normal traffic).
const REQUEST_TIMEOUT_MS = 30_000;

// One retry, deliberately. A stall on this API tends to last several seconds,
// which no practical number of quick retries rides out; the timeout above is
// what actually carries us through that. The single retry exists only to
// absorb a genuine one-off blip (a reset connection, a DNS hiccup), which is
// cheap and worth having without adding sustained load to an already-struggling
// endpoint.
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Performs one fetch+parse attempt against `url`. Thrown errors are tagged
 * `.retryable` when the failure is plausibly transient (a timeout, a
 * network-level failure, or a 5xx), so apiGet's retry loop can tell "try
 * again" apart from "this request is broken, fail fast" (e.g. a 404 for a
 * bad league/season combo, which retrying can never fix).
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function fetchOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`SHL API request timed out after ${REQUEST_TIMEOUT_MS}ms (${url})`);
      timeoutError.retryable = true;
      throw timeoutError;
    }
    // Every other throw out of fetch() is a network-layer failure (DNS,
    // connection reset/refused, TLS), all of which are worth one more try.
    error.retryable = true;
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const statusError = new Error(`SHL API request failed: ${res.status} ${res.statusText} (${url})`);
    statusError.retryable = res.status >= 500;
    throw statusError;
  }

  try {
    return await res.json();
  } catch (cause) {
    // A 2xx response with a non-JSON body (e.g. an HTML error page from an
    // intermediate proxy during an upstream outage) would otherwise surface
    // as a bare, contextless SyntaxError with no indication of which
    // endpoint produced it.
    throw new Error(`SHL API returned a non-JSON response for ${url}`, { cause });
  }
}

/**
 * GETs `url` from the SHL API and returns the parsed JSON body, retrying once
 * after a short delay on a transient failure (timeout, network error, 5xx).
 * Non-transient failures (4xx, a non-JSON body) throw immediately on the
 * first attempt with no retry.
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function apiGet(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (error) {
      if (!error.retryable || attempt === MAX_RETRIES) throw error;
      console.warn(`SHL API request failed, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt + 1}/${MAX_RETRIES}): ${error.message} (${url})`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// League ids are hardcoded, stable knowledge from the API itself, not
// something this client fetches or validates: 0 = SHL, 1 = SMJHL, 2 = IIHF,
// 3 = WJC. Passing a valid id is the caller's responsibility.

/**
 * Season-to-date cumulative skater stats (goalies excluded), one row per
 * player. Omitting `season` returns the current season, so it is left out of
 * the query string entirely rather than defaulted here.
 * @param {{league: number, season?: number}} params
 * @returns {Promise<Array<object>>}
 */
export function fetchPlayerStats({ league, season } = {}) {
  const params = new URLSearchParams({ league });
  if (season !== undefined) params.set('season', season);
  return apiGet(`${INDEX_API_V1}/players/stats?${params}`);
}

/**
 * Player attribute ratings (appliedTPE and per-attribute values), one row
 * per player. Join to fetchPlayerStats results by numeric `id`. Omitting
 * `season` returns the current season.
 * @param {{league: number, season?: number}} params
 * @returns {Promise<Array<object>>}
 */
export function fetchPlayerRatings({ league, season } = {}) {
  const params = new URLSearchParams({ league });
  if (season !== undefined) params.set('season', season);
  return apiGet(`${INDEX_API_V1}/players/ratings?${params}`);
}

/**
 * Team standings for a specific league/season. Unlike the other endpoints
 * here, both params are required: standings are inherently season-scoped and
 * the API has no meaningful "current" default to fall back on for this call.
 * @param {{league: number, season: number}} params
 * @returns {Promise<Array<object>>}
 */
export function fetchStandings({ league, season }) {
  const params = new URLSearchParams({ league, season });
  return apiGet(`${INDEX_API_V1}/standings?${params}`);
}

/**
 * Every team in a league.
 *
 * WARNING: the response's `stats` field is a current-season standings
 * snapshot, not per-game data, so it must never be treated as reflecting any
 * particular game or moment in the season.
 * @param {{league: number}} params
 * @returns {Promise<Array<object>>}
 */
export function fetchTeams({ league }) {
  const params = new URLSearchParams({ league });
  return apiGet(`${INDEX_API_V1}/teams?${params}`);
}

/**
 * A league's game schedule. Omitting `season` returns the current season.
 * @param {{league: number, season?: number, type?: string}} params
 * @returns {Promise<Array<object>>}
 */
export function fetchSchedule({ league, season, type = 'Regular Season' } = {}) {
  const params = new URLSearchParams({ league, type });
  if (season !== undefined) params.set('season', season);
  return apiGet(`${INDEX_API_V1}/schedule?${params}`);
}
