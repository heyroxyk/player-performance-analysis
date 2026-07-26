// src/web/dataRoutes.js hard-imports store.js's real listCaptures/getDataDir rather than taking
// injectable deps (unlike apiRoutes.js) -- it's the local server's half of a contract with the
// REAL filesystem, the same way src/store.js itself is, so these tests point PIR_DATA_DIR at a
// temp directory with real capture files rather than injecting fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createControlPanelServer } from '../../src/web/server.js';
import { writeCapture } from '../../src/store.js';
import { makeSnapshot } from '../fixtures.js';

async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pir-datarouotes-test-'));
  const original = process.env.PIR_DATA_DIR;
  process.env.PIR_DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (original === undefined) delete process.env.PIR_DATA_DIR;
    else process.env.PIR_DATA_DIR = original;
    await rm(dir, { recursive: true, force: true });
  }
}

async function withServer(fn) {
  const server = createControlPanelServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('GET /data/index.json reports localCapture: true and the real on-disk captures', async () => {
  await withTempDataDir(async (dir) => {
    await writeCapture({ league: 1, season: 89, snapshot: makeSnapshot({ league: 1, season: 89 }) }, dir);

    await withServer(async (baseUrl) => {
      const res = await fetch(baseUrl + '/data/index.json');
      assert.equal(res.status, 200);
      const manifest = await res.json();

      assert.equal(manifest.localCapture, true);
      assert.deepEqual(manifest.leagues.map((l) => l.league), [0, 1]);
      const league1 = manifest.leagues.find((l) => l.league === 1);
      assert.equal(league1.seasons.length, 1);
      assert.equal(league1.seasons[0].season, 89);
      assert.equal(league1.seasons[0].captures.length, 1);
    });
  });
});

test('GET /data/league-<L>/season-<S>/<file> serves the real capture file byte-for-byte', async () => {
  await withTempDataDir(async (dir) => {
    const snapshot = makeSnapshot({ league: 1, season: 89 });
    await writeCapture({ league: 1, season: 89, snapshot }, dir);

    await withServer(async (baseUrl) => {
      const manifestRes = await fetch(baseUrl + '/data/index.json');
      const manifest = await manifestRes.json();
      const [file] = manifest.leagues.find((l) => l.league === 1).seasons[0].captures;

      const res = await fetch(baseUrl + `/data/league-1/season-89/${file.file}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /application\/json/);
      const body = await res.json();
      assert.deepEqual(body, snapshot);
    });
  });
});

test('GET /data/league-<L>/season-<S>/<file> 404s for a filename that was never captured', async () => {
  await withTempDataDir(async (dir) => {
    await writeCapture({ league: 1, season: 89, snapshot: makeSnapshot({ league: 1, season: 89 }) }, dir);

    await withServer(async (baseUrl) => {
      const res = await fetch(baseUrl + '/data/league-1/season-89/2099-01-01T000000.000Z.json');
      assert.equal(res.status, 404);
    });
  });
});

test('GET /data/league-<L>/season-<S>/<file> 404s for a non-integer league or season instead of reaching the filesystem', async () => {
  await withTempDataDir(async () => {
    await withServer(async (baseUrl) => {
      for (const path of ['/data/league-abc/season-89/x.json', '/data/league-1/season-abc/x.json', '/data/league-1/season-89abc/x.json']) {
        const res = await fetch(baseUrl + path);
        assert.equal(res.status, 404, `expected 404 for ${path}`);
      }
    });
  });
});

test('GET /data/league-<L>/season-<S>/<file> 404s a traversal attempt instead of escaping the season directory', async () => {
  await withTempDataDir(async (dir) => {
    await writeCapture({ league: 1, season: 89, snapshot: makeSnapshot({ league: 1, season: 89 }) }, dir);

    await withServer(async (baseUrl) => {
      // The requested filename is only ever compared with === against a basename listCaptures
      // itself produced (see dataRoutes.js's own comment) -- a traversal attempt can never match
      // any of those, so this MUST 404 rather than read anything outside the season directory.
      for (const path of ['/data/league-1/season-89/..%2f..%2f..%2fpackage.json', '/data/league-1/season-89/....json']) {
        const res = await fetch(baseUrl + path);
        assert.equal(res.status, 404, `expected 404 for ${path}`);
      }
    });
  });
});

test('GET /data/<anything else> 404s rather than falling through to static serving', async () => {
  await withTempDataDir(async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(baseUrl + '/data/');
      assert.equal(res.status, 404);
    });
  });
});
