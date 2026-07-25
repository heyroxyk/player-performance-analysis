import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPlayerStats,
  fetchPlayerRatings,
  fetchStandings,
  fetchTeams,
  fetchSchedule,
} from '../src/shlClient.js';

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

// The retry loop makes 1 + MAX_RETRIES attempts before giving up. Asserting on
// this literal (rather than importing the constant) is deliberate: it keeps
// the tests a guard against someone quietly widening the retry budget.
const TOTAL_ATTEMPTS = 2;

test('fetchPlayerStats requests the players/stats endpoint with the given league and no season by default', async () => {
  let requestedUrl;
  await withFakeFetch(
    async (url) => {
      requestedUrl = url;
      return jsonResponse(200, []);
    },
    async () => {
      await fetchPlayerStats({ league: 1 });
    },
  );
  assert.match(requestedUrl, /\/api\/v1\/players\/stats\?league=1$/);
  assert.ok(!requestedUrl.includes('season='));
});

test('fetchPlayerStats includes the season param only when provided', async () => {
  let requestedUrl;
  await withFakeFetch(
    async (url) => {
      requestedUrl = url;
      return jsonResponse(200, []);
    },
    async () => {
      await fetchPlayerStats({ league: 1, season: 89 });
    },
  );
  assert.match(requestedUrl, /\/api\/v1\/players\/stats\?league=1&season=89$/);
});

test('fetchPlayerRatings requests the players/ratings endpoint with the given league and no season by default', async () => {
  let requestedUrl;
  await withFakeFetch(
    async (url) => {
      requestedUrl = url;
      return jsonResponse(200, []);
    },
    async () => {
      await fetchPlayerRatings({ league: 0 });
    },
  );
  assert.match(requestedUrl, /\/api\/v1\/players\/ratings\?league=0$/);
  assert.ok(!requestedUrl.includes('season='));
});

test('fetchPlayerRatings includes the season param only when provided', async () => {
  let requestedUrl;
  await withFakeFetch(
    async (url) => {
      requestedUrl = url;
      return jsonResponse(200, []);
    },
    async () => {
      await fetchPlayerRatings({ league: 0, season: 89 });
    },
  );
  assert.match(requestedUrl, /\/api\/v1\/players\/ratings\?league=0&season=89$/);
});

test('fetchStandings requests the standings endpoint with league and season', async () => {
  let requestedUrl;
  await withFakeFetch(
    async (url) => {
      requestedUrl = url;
      return jsonResponse(200, []);
    },
    async () => {
      await fetchStandings({ league: 1, season: 89 });
    },
  );
  assert.match(requestedUrl, /\/api\/v1\/standings\?league=1&season=89$/);
});

test('fetchTeams requests the teams endpoint with the given league', async () => {
  let requestedUrl;
  await withFakeFetch(
    async (url) => {
      requestedUrl = url;
      return jsonResponse(200, []);
    },
    async () => {
      await fetchTeams({ league: 0 });
    },
  );
  assert.match(requestedUrl, /\/api\/v1\/teams\?league=0$/);
});

test('fetchSchedule defaults to Regular Season and omits season when not provided', async () => {
  let requestedUrl;
  await withFakeFetch(
    async (url) => {
      requestedUrl = url;
      return jsonResponse(200, []);
    },
    async () => {
      await fetchSchedule({ league: 1 });
    },
  );
  assert.match(requestedUrl, /\/api\/v1\/schedule\?league=1&type=Regular\+Season$/);
  assert.ok(!requestedUrl.includes('season='));
});

test('fetchSchedule includes season and a custom type when provided', async () => {
  let requestedUrl;
  await withFakeFetch(
    async (url) => {
      requestedUrl = url;
      return jsonResponse(200, []);
    },
    async () => {
      await fetchSchedule({ league: 1, season: 89, type: 'Playoffs' });
    },
  );
  assert.match(requestedUrl, /\/api\/v1\/schedule\?league=1&type=Playoffs&season=89$/);
});

test('a 500 response is retried once and can succeed on the second attempt', async () => {
  let fetchCalls = 0;
  let result;
  await withFakeFetch(
    async () => {
      fetchCalls++;
      if (fetchCalls === 1) return jsonResponse(500, {});
      return jsonResponse(200, [{ id: 7 }]);
    },
    async () => {
      result = await fetchTeams({ league: 0 });
    },
  );
  assert.equal(fetchCalls, TOTAL_ATTEMPTS);
  assert.deepEqual(result, [{ id: 7 }]);
});

test('a 500 response that persists through the retry throws with status and URL context', async () => {
  let fetchCalls = 0;
  await withFakeFetch(
    async () => {
      fetchCalls++;
      return jsonResponse(500, {});
    },
    async () => {
      await assert.rejects(() => fetchTeams({ league: 0 }), /SHL API request failed: 500/);
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
      return jsonResponse(200, [{ id: 7 }]);
    },
    async () => {
      result = await fetchTeams({ league: 0 });
    },
  );
  assert.equal(fetchCalls, TOTAL_ATTEMPTS);
  assert.deepEqual(result, [{ id: 7 }]);
});

test('a timeout that persists through the retry is translated into a clear timeout error', async () => {
  let fetchCalls = 0;
  await withFakeFetch(
    async () => {
      fetchCalls++;
      throw abortError();
    },
    async () => {
      await assert.rejects(() => fetchTeams({ league: 0 }), /timed out after \d+ms/);
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
      await assert.rejects(() => fetchTeams({ league: 0 }), /SHL API request failed: 404/);
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
      await assert.rejects(() => fetchTeams({ league: 0 }), /non-JSON response for .*\/api\/v1\/teams\?league=0/);
    },
  );
  assert.equal(fetchCalls, 1, 'a malformed body is not a transient failure, so it must not be retried');
});
