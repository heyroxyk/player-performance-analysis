import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCurrent, readPrevious, rotateAndWrite } from '../src/store.js';
import { makeSnapshot } from './fixtures.js';

const LEAGUE = 1;
const SEASON = 89;

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pir-store-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('rotateAndWrite then readCurrent round-trips the exact snapshot', async () => {
  await withTempDir(async (dir) => {
    const snapshot = makeSnapshot();
    await rotateAndWrite({ league: LEAGUE, season: SEASON, snapshot }, dir);

    const result = await readCurrent({ league: LEAGUE, season: SEASON }, dir);
    assert.deepStrictEqual(result, snapshot);
  });
});

test('the first-ever rotateAndWrite for a season leaves previous absent', async () => {
  await withTempDir(async (dir) => {
    const snapshot = makeSnapshot();
    await rotateAndWrite({ league: LEAGUE, season: SEASON, snapshot }, dir);

    const previous = await readPrevious({ league: LEAGUE, season: SEASON }, dir);
    assert.strictEqual(previous, null);
  });
});

test('a second rotateAndWrite moves the first snapshot into previous and discards any older previous', async () => {
  await withTempDir(async (dir) => {
    const first = makeSnapshot({ capturedAt: '2026-07-13T12:00:00.000Z' });
    const second = makeSnapshot({ capturedAt: '2026-07-20T12:00:00.000Z' });
    const third = makeSnapshot({ capturedAt: '2026-07-27T12:00:00.000Z' });

    await rotateAndWrite({ league: LEAGUE, season: SEASON, snapshot: first }, dir);
    await rotateAndWrite({ league: LEAGUE, season: SEASON, snapshot: second }, dir);
    await rotateAndWrite({ league: LEAGUE, season: SEASON, snapshot: third }, dir);

    const current = await readCurrent({ league: LEAGUE, season: SEASON }, dir);
    const previous = await readPrevious({ league: LEAGUE, season: SEASON }, dir);

    assert.deepStrictEqual(current, third);
    // "first" must be gone entirely - only two snapshots are ever kept on disk.
    assert.deepStrictEqual(previous, second);
  });
});

test('readCurrent and readPrevious both return null for a season directory that does not exist yet', async () => {
  await withTempDir(async (dir) => {
    const current = await readCurrent({ league: LEAGUE, season: SEASON }, dir);
    const previous = await readPrevious({ league: LEAGUE, season: SEASON }, dir);

    assert.strictEqual(current, null);
    assert.strictEqual(previous, null);
  });
});

test('readCurrent returns null for a corrupted current.json instead of throwing', async () => {
  await withTempDir(async (dir) => {
    const seasonDir = join(dir, `league-${LEAGUE}`, `season-${SEASON}`);
    await mkdir(seasonDir, { recursive: true });
    await writeFile(join(seasonDir, 'current.json'), '{ this is not valid JSON');

    const result = await readCurrent({ league: LEAGUE, season: SEASON }, dir);
    assert.strictEqual(result, null);
  });
});

test('an omitted season is stored under a "current" directory, not the literal string "season-undefined"', async () => {
  await withTempDir(async (dir) => {
    const snapshot = makeSnapshot({ season: undefined });
    await rotateAndWrite({ league: LEAGUE, season: undefined, snapshot }, dir);

    const result = await readCurrent({ league: LEAGUE, season: undefined }, dir);
    // JSON.stringify drops keys whose value is undefined, so `season` is simply absent
    // from the round-tripped object rather than present-but-undefined -- compare the
    // fields that do survive instead of a deepStrictEqual against the original snapshot.
    assert.strictEqual(result.league, snapshot.league);
    assert.strictEqual(result.season, undefined);
    assert.deepStrictEqual(result.players, snapshot.players);

    // Confirms the friendly directory name is what's actually on disk, not just that
    // readCurrent/rotateAndWrite happen to agree with each other by coincidence.
    await assert.doesNotReject(() => access(join(dir, `league-${LEAGUE}`, 'current', 'current.json')));
    await assert.rejects(() => access(join(dir, `league-${LEAGUE}`, 'season-undefined')));
  });
});

test('rotateAndWrite creates the season directory recursively when it does not exist', async () => {
  await withTempDir(async (dir) => {
    const snapshot = makeSnapshot();
    // Nothing under dir exists yet at all - not even league-{league}.
    await rotateAndWrite({ league: LEAGUE, season: SEASON, snapshot }, dir);

    const result = await readCurrent({ league: LEAGUE, season: SEASON }, dir);
    assert.deepStrictEqual(result, snapshot);
  });
});
