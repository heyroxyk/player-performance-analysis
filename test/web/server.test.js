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

// Only captureSnapshot is exercised through this server anymore -- POST /api/update is the one
// route left (see src/web/apiRoutes.js's header comment for why the rank/export/leagues/
// snapshots routes and their fakes are gone).
function makeCommandsDeps(overrides = {}) {
  return {
    captureSnapshot: trackCalls(async () => ({ skipped: false, snapshot: makeSnapshot() })),
    ...overrides,
  };
}

// Starts a real server on an OS-assigned port (0) so tests never collide with each other or
// with a real running control panel, exercises the request through it, then tears the server
// down. server.closeAllConnections() (not just server.close()) is required here: native
// fetch/undici keeps sockets alive in a pool, and without it server.close()'s callback never
// fires because it waits for existing connections to drain -- the test run would hang.
async function withServer(depsOverrides, fn) {
  const commandsDeps = makeCommandsDeps(depsOverrides);
  const server = createControlPanelServer({ commandsDeps });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await fn({ baseUrl: `http://127.0.0.1:${port}`, port, commandsDeps });
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
    { captureSnapshot: trackCalls(async () => { throw new Error('SHL API request timed out after 30000ms'); }) },
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
      captureSnapshot: trackCalls(async () => {
        await gate;
        return { skipped: false, snapshot: makeSnapshot() };
      }),
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
