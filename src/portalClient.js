// Thin HTTP client for the "Portal" (portal.simulationhockey.com), a system entirely separate
// from the Index API this tool otherwise talks to (see src/shlClient.js) -- different host,
// different data model, different ID space. This client exists solely to source player
// activity `status` (active/inactive/pending/retired), a field the Index API has no equivalent
// for anywhere. Deliberately mirrors shlClient.js's retry/timeout/User-Agent shape rather than
// inventing a second style: both clients talk to sibling simulationhockey.com properties with
// no published reliability guarantees, so there's no reason for them to behave differently.
const USER_AGENT = 'Mozilla/5.0 (compatible; SHL-PlayerImpact-Bot/1.0)';
const PORTAL_API_V1 = 'https://portal.simulationhockey.com/api/v1';

// Same reasoning as shlClient.js's identical constants: sized for this endpoint's occasional
// multi-second stalls, not normal traffic, with a single retry to absorb a one-off blip.
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Performs one fetch+parse attempt against `url`. Identical error-tagging contract to
 * shlClient.js's own fetchOnce -- see that file's docstring for the full rationale.
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
      const timeoutError = new Error(`Portal API request timed out after ${REQUEST_TIMEOUT_MS}ms (${url})`);
      timeoutError.retryable = true;
      throw timeoutError;
    }
    error.retryable = true;
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const statusError = new Error(`Portal API request failed: ${res.status} ${res.statusText} (${url})`);
    statusError.retryable = res.status >= 500;
    throw statusError;
  }

  try {
    return await res.json();
  } catch (cause) {
    throw new Error(`Portal API returned a non-JSON response for ${url}`, { cause });
  }
}

/**
 * GETs `url` from the Portal API, retrying once after a short delay on a transient failure
 * (timeout, network error, 5xx). Non-transient failures throw immediately with no retry.
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function apiGet(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (error) {
      if (!error.retryable || attempt === MAX_RETRIES) throw error;
      console.warn(`Portal API request failed, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt + 1}/${MAX_RETRIES}): ${error.message} (${url})`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// Comfortably above the largest real query seen in testing (418 SMJHL players, unpaginated).
// The Portal API exposes no total-count header, so a returned row count equal to this limit is
// the only truncation signal available -- see fetchPortalPlayersByLeague below.
const PLAYER_FETCH_LIMIT = 1000;

/**
 * Every Portal player row for one Portal leagueID. Portal's leagueID enum is 0 = SHL, 1 = SMJHL,
 * 2 = IIHF (requires an accompanying teamID/country parameter this tool doesn't supply), 3 isn't
 * defined at all -- callers should only ever pass 0 or 1 here (see src/snapshot.js's
 * PORTAL_LEAGUE_ID_BY_LEAGUE for where that scope decision is made).
 * @param {{leagueID: number}} params
 * @returns {Promise<{rows: Array<object>, truncated: boolean}>} `truncated` is true when the
 *   response's row count equals PLAYER_FETCH_LIMIT -- a real (if rare) signal that more rows
 *   may exist beyond this unpaginated fetch, worth a log line even though full pagination is out
 *   of scope for this feature.
 */
export async function fetchPortalPlayersByLeague({ leagueID }) {
  const params = new URLSearchParams({ leagueID, limit: PLAYER_FETCH_LIMIT });
  const rows = await apiGet(`${PORTAL_API_V1}/player?${params}`);
  return { rows, truncated: rows.length === PLAYER_FETCH_LIMIT };
}
