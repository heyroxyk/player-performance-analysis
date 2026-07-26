import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPortalPlayersByLeague } from '../src/portalClient.js';

async function withFakeFetch(impl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'status text',
    json: async () => body,
  };
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

// The retry loop makes 1 + MAX_RETRIES attempts before giving up -- mirrors
// test/shlClient.test.js's identical constant and rationale: asserting on this literal (rather
// than importing the constant) keeps the test a guard against someone quietly widening the
// retry budget.
const TOTAL_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// fetchPortalPlayersByLeague -- request shape
// ---------------------------------------------------------------------------

test('fetchPortalPlayersByLeague requests the /player endpoint with leagueID and a limit', async () => {
  let requestedUrl;
  await withFakeFetch(
    async (url) => {
      requestedUrl = url;
      return jsonResponse(200, []);
    },
    async () => {
      await fetchPortalPlayersByLeague({ leagueID: 0 });
    },
  );
  assert.match(requestedUrl, /^https:\/\/portal\.simulationhockey\.com\/api\/v1\/player\?leagueID=0&limit=1000$/);
});

test('fetchPortalPlayersByLeague returns the parsed rows, untruncated, for a normal-sized response', async () => {
  const rows = [{ pid: 1, name: 'Alice', status: 'active' }, { pid: 2, name: 'Bob', status: 'retired' }];
  let result;
  await withFakeFetch(
    async () => jsonResponse(200, rows),
    async () => {
      result = await fetchPortalPlayersByLeague({ leagueID: 1 });
    },
  );
  assert.deepEqual(result, { rows, truncated: false });
});

test('fetchPortalPlayersByLeague flags truncated: true when the response row count hits the fetch limit exactly', async () => {
  // The Portal API exposes no total-count header, so a row count equal to the requested limit
  // (1000, see PLAYER_FETCH_LIMIT in src/portalClient.js) is the only truncation signal
  // available -- this is a real (if rare) edge case worth its own test, not just an off-by-one.
  const rows = Array.from({ length: 1000 }, (_, i) => ({ pid: i, name: `Player ${i}`, status: 'active' }));
  let result;
  await withFakeFetch(
    async () => jsonResponse(200, rows),
    async () => {
      result = await fetchPortalPlayersByLeague({ leagueID: 0 });
    },
  );
  assert.equal(result.truncated, true);
});

// ---------------------------------------------------------------------------
// retry behavior -- mirrors test/shlClient.test.js's own retry/timeout/4xx tests, since
// portalClient.js deliberately copies shlClient.js's retry shape rather than inventing a
// second one.
// ---------------------------------------------------------------------------

test('a 500 response is retried once and can succeed on the second attempt', async () => {
  let fetchCalls = 0;
  let result;
  await withFakeFetch(
    async () => {
      fetchCalls++;
      if (fetchCalls === 1) return jsonResponse(500, {});
      return jsonResponse(200, [{ pid: 7, name: 'Late Bloomer', status: 'active' }]);
    },
    async () => {
      result = await fetchPortalPlayersByLeague({ leagueID: 0 });
    },
  );
  assert.equal(fetchCalls, TOTAL_ATTEMPTS);
  assert.deepEqual(result.rows, [{ pid: 7, name: 'Late Bloomer', status: 'active' }]);
});

test('a 500 response that persists through the retry throws with status and URL context', async () => {
  let fetchCalls = 0;
  await withFakeFetch(
    async () => {
      fetchCalls++;
      return jsonResponse(500, {});
    },
    async () => {
      await assert.rejects(() => fetchPortalPlayersByLeague({ leagueID: 0 }), /Portal API request failed: 500/);
    },
  );
  assert.equal(fetchCalls, TOTAL_ATTEMPTS);
});

test('an aborted (timeout) request is retried once and can succeed on the second attempt', async () => {
  let fetchCalls = 0;
  let result;
  await withFakeFetch(
    async () => {
      fetchCalls++;
      if (fetchCalls === 1) throw abortError();
      return jsonResponse(200, [{ pid: 7, name: 'Late Bloomer', status: 'active' }]);
    },
    async () => {
      result = await fetchPortalPlayersByLeague({ leagueID: 0 });
    },
  );
  assert.equal(fetchCalls, TOTAL_ATTEMPTS);
  assert.deepEqual(result.rows, [{ pid: 7, name: 'Late Bloomer', status: 'active' }]);
});

test('a timeout that persists through the retry is translated into a clear timeout error', async () => {
  let fetchCalls = 0;
  await withFakeFetch(
    async () => {
      fetchCalls++;
      throw abortError();
    },
    async () => {
      await assert.rejects(() => fetchPortalPlayersByLeague({ leagueID: 0 }), /Portal API request timed out after \d+ms/);
    },
  );
  assert.equal(fetchCalls, TOTAL_ATTEMPTS);
});

test('a 404 response is not retried', async () => {
  let fetchCalls = 0;
  await withFakeFetch(
    async () => {
      fetchCalls++;
      return jsonResponse(404, {});
    },
    async () => {
      await assert.rejects(() => fetchPortalPlayersByLeague({ leagueID: 0 }), /Portal API request failed: 404/);
    },
  );
  assert.equal(fetchCalls, 1, 'a 4xx is broken about this specific request, so retrying it only wastes the run budget');
});

test('a 2xx response with a non-JSON body throws with URL context instead of a bare SyntaxError', async () => {
  let fetchCalls = 0;
  await withFakeFetch(
    async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      };
    },
    async () => {
      await assert.rejects(() => fetchPortalPlayersByLeague({ leagueID: 0 }), /non-JSON response for .*\/api\/v1\/player\?leagueID=0/);
    },
  );
  assert.equal(fetchCalls, 1, 'a malformed body is not a transient failure, so it must not be retried');
});
