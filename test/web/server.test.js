import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createControlPanelServer, startControlPanelServer } from '../../src/web/server.js';
import { makeSnapshot } from '../fixtures.js';

// Wraps a fake implementation so tests can assert on how many times it was called and with
// what arguments, without pulling in a mocking library -- matches test/index.test.js.
function trackCalls(impl = () => undefined) {
  const calls = [];
  function fn(...args) {
    calls.push(args);
    return impl(...args);
  }
  fn.calls = calls;
  return fn;
}

function makeCommandsDeps(overrides = {}) {
  return {
    captureSnapshot: trackCalls(async () => ({ skipped: false, snapshot: makeSnapshot() })),
    readLatest: trackCalls(async () => makeSnapshot()),
    readPrevious: trackCalls(async () => null),
    findAnchorCapture: trackCalls(async () => ({ anchor: null, reason: 'only one capture on disk -- a window needs at least two' })),
    buildWindowRows: trackCalls(() => ({ rows: [], dropped: [], summary: {} })),
    evaluateWindowQuality: trackCalls(({ anchorReason } = {}) => (
      anchorReason ? { blockers: [anchorReason], warnings: [] } : { blockers: [], warnings: [] }
    )),
    adaptiveShrinkageMinutes: trackCalls(() => 400),
    filterScoreableRows: trackCalls((players) => ({ usable: players, excluded: [] })),
    computePir: trackCalls((rows) => rows.map((row) => ({ ...row, pir: 1.5, totalImpact: 2.5, components: {} }))),
    rankByPir: trackCalls((rows) => rows),
    computeMovement: trackCalls((currentRows) => currentRows),
    formatTable: trackCalls(() => 'TABLE OUTPUT'),
    toJson: trackCalls(() => 'JSON OUTPUT'),
    toCsv: trackCalls(() => 'CSV,OUTPUT\n1,2,3'),
    writeFile: trackCalls(async () => undefined),
    POSITION_GROUPS: { C: 'F', LW: 'F', RW: 'F', LD: 'D', RD: 'D' },
    ...overrides,
  };
}

function makeSnapshotIndexDeps(overrides = {}) {
  return {
    listSeasons: trackCalls(async () => [89]),
    listCaptures: trackCalls(async () => ['a.json']),
    readLatest: trackCalls(async () => makeSnapshot()),
    readPrevious: trackCalls(async () => null),
    getDataDir: trackCalls(() => '/fake/data'),
    ...overrides,
  };
}

// Starts a real server on an OS-assigned port (0) so tests never collide with each other or
// with a real running control panel, exercises the request through it, then tears the server
// down. server.closeAllConnections() (not just server.close()) is required here: native
// fetch/undici keeps sockets alive in a pool, and without it server.close()'s callback never
// fires because it waits for existing connections to drain -- the test run would hang.
async function withServer(depsOverrides, fn) {
  const commandsDeps = makeCommandsDeps(depsOverrides?.commands);
  const snapshotIndexDeps = makeSnapshotIndexDeps(depsOverrides?.snapshotIndex);
  const server = createControlPanelServer({ commandsDeps, snapshotIndexDeps });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await fn({ baseUrl: `http://127.0.0.1:${port}`, port, commandsDeps, snapshotIndexDeps });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

// A raw node:http request, used only for the handful of tests that need to set Host/Origin
// headers directly -- the Fetch spec (and therefore native fetch/undici) forbids a caller from
// setting either header, so those specific security checks can't be exercised through fetch.
function rawRequest(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

test('GET / serves the control panel HTML', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.match(body, /PIR Control Panel/);
  });
});

test('GET of an unmapped path returns 404, including a path traversal attempt', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    for (const path of ['/nope', '/../../package.json', '/%2e%2e%2fpackage.json', '/..%5c..%5cpackage.json']) {
      const res = await fetch(baseUrl + path);
      assert.equal(res.status, 404, `expected 404 for ${path}`);
    }
  });
});

test('GET /favicon.ico returns 204 rather than a 404', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/favicon.ico');
    assert.equal(res.status, 204);
  });
});

// ---------------------------------------------------------------------------
// GET /api/leagues, /api/snapshots
// ---------------------------------------------------------------------------

test('GET /api/leagues returns SHL and SMJHL', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/leagues');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.leagues.map((l) => l.id), [0, 1]);
  });
});

test('GET /api/snapshots requires a league param', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/snapshots');
    assert.equal(res.status, 400);
  });
});

test('GET /api/snapshots returns the league\'s season list', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/snapshots?league=1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.league, 1);
    assert.equal(body.dataDir, '/fake/data');
  });
});

// ---------------------------------------------------------------------------
// GET /api/rank -- validation
// ---------------------------------------------------------------------------

test('GET /api/rank rejects an out-of-range league', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/rank?league=9');
    assert.equal(res.status, 400);
  });
});

test('GET /api/rank rejects a non-integer season instead of letting it reach the filesystem', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/rank?league=1&season=' + encodeURIComponent('../../etc'));
    assert.equal(res.status, 400);
  });
});

test('GET /api/rank rejects a season with trailing garbage', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/rank?league=1&season=89abc');
    assert.equal(res.status, 400);
  });
});

test('GET /api/rank rejects an unrecognized query parameter', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/rank?league=1&bogus=1');
    assert.equal(res.status, 400);
  });
});

test('GET /api/rank rejects an invalid baseline', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/rank?league=1&baseline=team');
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/rank -- behavior
// ---------------------------------------------------------------------------

test('GET /api/rank returns meta, players, and excluded', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/rank?league=1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.meta);
    assert.ok(Array.isArray(body.players));
    assert.ok(Array.isArray(body.excluded));
  });
});

test('GET /api/rank with movement=false never calls readPrevious', async () => {
  await withServer(undefined, async ({ baseUrl, commandsDeps }) => {
    const res = await fetch(baseUrl + '/api/rank?league=1&movement=false');
    assert.equal(res.status, 200);
    assert.equal(commandsDeps.readPrevious.calls.length, 0);
  });
});

test('GET /api/rank returns 404 with an actionable message when no snapshot exists', async () => {
  await withServer({ commands: { readLatest: trackCalls(async () => null) } }, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/rank?league=1&season=89');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'NO_SNAPSHOT');
    assert.match(body.error, /update --league=1 --season=89/);
  });
});

test('GET /api/rank builds a position groupBy from --baseline=position', async () => {
  await withServer(undefined, async ({ baseUrl, commandsDeps }) => {
    await fetch(baseUrl + '/api/rank?league=1&baseline=position');
    const [, options] = commandsDeps.computePir.calls[0];
    assert.equal(typeof options.groupBy, 'function');
    assert.equal(options.groupBy({ position: 'LD' }), 'D');
  });
});

// ---------------------------------------------------------------------------
// GET /api/rank -- window mode
// ---------------------------------------------------------------------------

test('GET /api/rank rejects a non-integer window', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/rank?league=1&window=abc');
    assert.equal(res.status, 400);
  });
});

test('GET /api/rank rejects window=0 as meaningless', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/rank?league=1&window=0');
    assert.equal(res.status, 400);
  });
});

test('GET /api/rank?window=12 reaches getRanking/buildWindowRows with the parsed value', async () => {
  const windowRows = [{ id: 1, timeOnIce: 1000, gamesPlayed: 5 }];
  await withServer(
    {
      commands: {
        findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 12 })),
        buildWindowRows: trackCalls(() => ({
          rows: windowRows,
          dropped: [],
          summary: {
            medianToiFraction: 0.4, playerCount: 1, droppedCount: 0, callUpCount: 0,
            anchorCapturedAt: '2026-07-01T12:00:00.000Z', medianWindowGamesPlayed: 5, medianWindowTimeOnIce: 1000, tradedCount: 0,
          },
        })),
        evaluateWindowQuality: trackCalls(() => ({ blockers: [], warnings: [] })),
      },
    },
    async ({ baseUrl, commandsDeps }) => {
      const res = await fetch(baseUrl + '/api/rank?league=1&window=12');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.meta.window.requestedGames, 12);
      assert.equal(body.meta.window.resolvedGames, 12);
      const [rowsPassed] = commandsDeps.computePir.calls[0];
      assert.deepEqual(rowsPassed, windowRows);
    },
  );
});

test('GET /api/rank?window=12 returns 409 WINDOW_UNAVAILABLE when no anchor capture exists', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/rank?league=1&window=12');
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'WINDOW_UNAVAILABLE');
    assert.match(body.error, /only one capture on disk/);
  });
});

test('GET /api/export?window=12 is accepted (window inherits from the shared KNOWN_RANK_PARAMS set)', async () => {
  await withServer(
    {
      commands: {
        findAnchorCapture: trackCalls(async () => ({ anchor: makeSnapshot(), reason: null, resolvedGames: 12 })),
        buildWindowRows: trackCalls(() => ({
          rows: [{ id: 1, timeOnIce: 1000, gamesPlayed: 5 }],
          dropped: [],
          summary: { medianToiFraction: 0.4, playerCount: 1, droppedCount: 0, callUpCount: 0, anchorCapturedAt: 'x', medianWindowGamesPlayed: 5, medianWindowTimeOnIce: 1000, tradedCount: 0 },
        })),
        evaluateWindowQuality: trackCalls(() => ({ blockers: [], warnings: [] })),
      },
    },
    async ({ baseUrl }) => {
      const res = await fetch(baseUrl + '/api/export?league=1&window=12&format=json');
      assert.equal(res.status, 200);
    },
  );
});

// ---------------------------------------------------------------------------
// GET /api/export
// ---------------------------------------------------------------------------

test('GET /api/export?format=csv returns text/csv with a Content-Disposition attachment, byte-identical to toCsv\'s output', async () => {
  await withServer(undefined, async ({ baseUrl, commandsDeps }) => {
    const res = await fetch(baseUrl + '/api/export?league=1&format=csv');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="pir-league1-season89\.csv"/);
    const body = await res.text();
    assert.equal(commandsDeps.toCsv.calls.length, 1);
    assert.equal(body, 'CSV,OUTPUT\n1,2,3');
  });
});

test('GET /api/export defaults to the table format, matching the CLI default', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/export?league=1');
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const body = await res.text();
    assert.equal(body, 'TABLE OUTPUT');
  });
});

test('GET /api/export rejects an invalid format', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/export?league=1&format=xml');
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/update
// ---------------------------------------------------------------------------

test('POST /api/update calls captureSnapshot and returns the result with a durationMs', async () => {
  await withServer(undefined, async ({ baseUrl, commandsDeps }) => {
    const res = await fetch(baseUrl + '/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ league: 1 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(commandsDeps.captureSnapshot.calls.length, 1);
    assert.equal(typeof body.durationMs, 'number');
    assert.equal(body.playerCount, 1);
  });
});

test('POST /api/update rejects an unrecognized body field', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ league: 1, extra: true }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /api/update with a body over the size limit is rejected and never reaches captureSnapshot', async () => {
  await withServer(undefined, async ({ baseUrl, commandsDeps }) => {
    const res = await fetch(baseUrl + '/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ league: 1, padding: 'x'.repeat(9000) }),
    });
    assert.equal(res.status, 413);
    assert.equal(commandsDeps.captureSnapshot.calls.length, 0);
  });
});

test('POST /api/update requires an application/json Content-Type', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ league: 1 }),
    });
    assert.equal(res.status, 415);
  });
});

test('POST /api/update rejects a cross-origin Origin header', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ league: 1 }),
    });
    assert.equal(res.status, 403);
  });
});

test('POST /api/update rejects a request whose Host header does not match the bound port', async () => {
  await withServer(undefined, async ({ port }) => {
    const body = JSON.stringify({ league: 1 });
    const res = await rawRequest(port, {
      method: 'POST',
      path: '/api/update',
      headers: { 'Content-Type': 'application/json', Host: 'evil.example', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    assert.equal(res.status, 403);
  });
});

test('GET /api/update (wrong method) returns 405 with an Allow header', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/api/update');
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });
});

test('POST /api/update maps an upstream captureSnapshot failure to 502 without leaking a stack trace', async () => {
  await withServer(
    { commands: { captureSnapshot: trackCalls(async () => { throw new Error('SHL API request timed out after 30000ms'); }) } },
    async ({ baseUrl }) => {
      const res = await fetch(baseUrl + '/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league: 1 }),
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.match(body.error, /timed out/);
      assert.ok(!body.error.includes('at '), 'response body should not contain a stack trace');
    },
  );
});

test('a second POST /api/update for the same league+season while one is in flight gets 409', async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });

  await withServer(
    {
      commands: {
        captureSnapshot: trackCalls(async () => {
          await gate;
          return { skipped: false, snapshot: makeSnapshot() };
        }),
      },
    },
    async ({ baseUrl }) => {
      const firstRequest = fetch(baseUrl + '/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league: 1, season: 89 }),
      });

      // Give the first request a tick to register itself in inFlightUpdates before firing the
      // second -- otherwise both could race to check the map before either has claimed it.
      await new Promise((resolve) => setImmediate(resolve));

      const secondRes = await fetch(baseUrl + '/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league: 1, season: 89 }),
      });
      assert.equal(secondRes.status, 409);

      releaseFirst();
      const firstRes = await firstRequest;
      assert.equal(firstRes.status, 200);
    },
  );
});

test('two POSTs for different leagues run concurrently, neither blocked by the other', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const [resLeague0, resLeague1] = await Promise.all([
      fetch(baseUrl + '/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ league: 0 }) }),
      fetch(baseUrl + '/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ league: 1 }) }),
    ]);
    assert.equal(resLeague0.status, 200);
    assert.equal(resLeague1.status, 200);
  });
});

// ---------------------------------------------------------------------------
// startControlPanelServer
// ---------------------------------------------------------------------------

test('startControlPanelServer surfaces an actionable message on EADDRINUSE', async () => {
  const first = await startControlPanelServer({ port: 0 });
  const { port } = first.address();

  try {
    await assert.rejects(() => startControlPanelServer({ port }), /already in use/);
  } finally {
    first.closeAllConnections();
    await new Promise((resolve) => first.close(resolve));
  }
});
