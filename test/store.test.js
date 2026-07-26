import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readLatest, readPrevious, writeCapture, listCaptures, listSeasons,
  readCapture, medianGamesPlayed, findAnchorCapture, getDataDir,
} from '../src/store.js';
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

test('writeCapture then readLatest round-trips the exact snapshot', async () => {
  await withTempDir(async (dir) => {
    const snapshot = makeSnapshot();
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot }, dir);

    const result = await readLatest({ league: LEAGUE, season: SEASON }, dir);
    assert.deepStrictEqual(result, snapshot);
  });
});

test('the first-ever writeCapture for a season leaves readPrevious null', async () => {
  await withTempDir(async (dir) => {
    const snapshot = makeSnapshot();
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot }, dir);

    const previous = await readPrevious({ league: LEAGUE, season: SEASON }, dir);
    assert.strictEqual(previous, null);
  });
});

test('a second writeCapture becomes latest, and the first becomes previous -- both remain on disk', async () => {
  await withTempDir(async (dir) => {
    const first = makeSnapshot({ capturedAt: '2026-07-13T12:00:00.000Z' });
    const second = makeSnapshot({ capturedAt: '2026-07-20T12:00:00.000Z' });

    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: first }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: second }, dir);

    const latest = await readLatest({ league: LEAGUE, season: SEASON }, dir);
    const previous = await readPrevious({ league: LEAGUE, season: SEASON }, dir);

    assert.deepStrictEqual(latest, second);
    assert.deepStrictEqual(previous, first);
  });
});

test('readLatest and readPrevious both return null for a season directory that does not exist yet', async () => {
  await withTempDir(async (dir) => {
    const latest = await readLatest({ league: LEAGUE, season: SEASON }, dir);
    const previous = await readPrevious({ league: LEAGUE, season: SEASON }, dir);

    assert.strictEqual(latest, null);
    assert.strictEqual(previous, null);
  });
});

test('readLatest returns null for a corrupted capture file instead of throwing', async () => {
  await withTempDir(async (dir) => {
    const seasonDir = join(dir, `league-${LEAGUE}`, `season-${SEASON}`);
    await mkdir(seasonDir, { recursive: true });
    await writeFile(join(seasonDir, '2026-07-25T120000000Z.json'), '{ this is not valid JSON');

    const result = await readLatest({ league: LEAGUE, season: SEASON }, dir);
    assert.strictEqual(result, null);
  });
});

test('writeCapture creates the season directory recursively when it does not exist', async () => {
  await withTempDir(async (dir) => {
    const snapshot = makeSnapshot();
    // Nothing under dir exists yet at all - not even league-{league}.
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot }, dir);

    const result = await readLatest({ league: LEAGUE, season: SEASON }, dir);
    assert.deepStrictEqual(result, snapshot);
  });
});

test('an omitted season resolves to whichever season was captured most recently for that league', async () => {
  await withTempDir(async (dir) => {
    const olderSeason = makeSnapshot({ season: 88, capturedAt: '2026-07-01T12:00:00.000Z' });
    const newerSeason = makeSnapshot({ season: 89, capturedAt: '2026-07-20T12:00:00.000Z' });

    // The older season is written SECOND (so its file timestamp would sort newer if season
    // resolution incorrectly used file-write order or the highest season number instead of
    // each capture's own recorded time) to prove resolution genuinely compares capturedAt
    // across season directories rather than falling back to something coincidentally correct.
    await writeCapture({ league: LEAGUE, season: 89, snapshot: newerSeason }, dir);
    await writeCapture({ league: LEAGUE, season: 88, snapshot: olderSeason }, dir);

    const result = await readLatest({ league: LEAGUE, season: undefined }, dir);
    assert.strictEqual(result.season, 89);
  });
});

test('an omitted season with no captures anywhere for the league returns null, not an error', async () => {
  await withTempDir(async (dir) => {
    const result = await readLatest({ league: LEAGUE, season: undefined }, dir);
    assert.strictEqual(result, null);
  });
});

test('listCaptures returns every capture file for a league+season, newest first', async () => {
  await withTempDir(async (dir) => {
    const first = makeSnapshot({ capturedAt: '2026-07-01T12:00:00.000Z' });
    const second = makeSnapshot({ capturedAt: '2026-07-08T12:00:00.000Z' });
    const third = makeSnapshot({ capturedAt: '2026-07-15T12:00:00.000Z' });

    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: first }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: second }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: third }, dir);

    const files = await listCaptures({ league: LEAGUE, season: SEASON }, dir);
    assert.strictEqual(files.length, 3);
    assert.ok(files[0].includes('2026-07-15'));
    assert.ok(files[2].includes('2026-07-01'));
  });
});

test('writeCapture prunes captures whose players have fallen far enough behind the newest capture on games played', async () => {
  await withTempDir(async (dir) => {
    const makeAt = (capturedAt, gamesPlayed) =>
      makeSnapshot({ capturedAt, players: [{ id: 1, name: 'Skater', gamesPlayed, timeOnIce: 1000 }] });

    // Deepest window (12) x the window-comparison multiplier (2) + margin (4) = 28 games of
    // retained span (see WINDOW_COMPARISON_MULTIPLIER in store.js -- doubled from the original
    // 16 so window-over-window movement has enough depth once it's built). A capture at
    // gamesPlayed=1 sits 39 games behind a newest capture at gamesPlayed=40, well past that
    // floor, so it should be pruned once enough newer captures exist to push it past both the
    // games-played floor and the minimum-retained-count floor.
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAt('2026-07-01T12:00:00.000Z', 1) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAt('2026-07-05T12:00:00.000Z', 5) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAt('2026-07-10T12:00:00.000Z', 10) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAt('2026-07-15T12:00:00.000Z', 20) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAt('2026-07-20T12:00:00.000Z', 40) }, dir);

    const files = await listCaptures({ league: LEAGUE, season: SEASON }, dir);
    assert.ok(files.every((file) => !file.includes('2026-07-01')), 'the games-played=1 capture should have been pruned');
    assert.ok(files.every((file) => !file.includes('2026-07-05')), 'the games-played=5 capture should have been pruned');
    assert.ok(files.every((file) => !file.includes('2026-07-10')), 'the games-played=10 capture should have been pruned');
    assert.ok(files.some((file) => file.includes('2026-07-15')), 'the games-played=20 capture is within the floor and must remain');
    assert.ok(files.some((file) => file.includes('2026-07-20')), 'the newest capture must always be retained');
  });
});

test('writeCapture never prunes below the minimum retained capture count, even for a huge games-played gap', async () => {
  await withTempDir(async (dir) => {
    const makeAt = (capturedAt, gamesPlayed) =>
      makeSnapshot({ capturedAt, players: [{ id: 1, name: 'Skater', gamesPlayed, timeOnIce: 1000 }] });

    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAt('2026-07-01T12:00:00.000Z', 1) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAt('2026-07-20T12:00:00.000Z', 66) }, dir);

    const files = await listCaptures({ league: LEAGUE, season: SEASON }, dir);
    assert.strictEqual(files.length, 2, 'only two captures exist, so both must be kept regardless of the games-played gap');
  });
});

test('listSeasons returns every season number captured for a league, ignoring stray non-season directories', async () => {
  await withTempDir(async (dir) => {
    await writeCapture({ league: LEAGUE, season: 88, snapshot: makeSnapshot({ season: 88 }) }, dir);
    await writeCapture({ league: LEAGUE, season: 89, snapshot: makeSnapshot({ season: 89 }) }, dir);
    await mkdir(join(dir, `league-${LEAGUE}`, 'notes'), { recursive: true });

    const seasons = await listSeasons({ league: LEAGUE }, dir);
    assert.deepStrictEqual([...seasons].sort((a, b) => a - b), [88, 89]);
  });
});

test('listSeasons returns an empty array for a league with no captures at all', async () => {
  await withTempDir(async (dir) => {
    const seasons = await listSeasons({ league: LEAGUE }, dir);
    assert.deepStrictEqual(seasons, []);
  });
});

test('writeCapture stores files with no colon characters, so filenames are valid on Windows', async () => {
  await withTempDir(async (dir) => {
    const snapshot = makeSnapshot({ capturedAt: '2026-07-25T20:23:29.639Z' });
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot }, dir);

    const seasonDir = join(dir, `league-${LEAGUE}`, `season-${SEASON}`);
    const files = await readdir(seasonDir);
    assert.strictEqual(files.length, 1);
    assert.ok(!files[0].includes(':'), `filename "${files[0]}" must not contain a colon`);
  });
});

// ---------------------------------------------------------------------------
// medianGamesPlayed
// ---------------------------------------------------------------------------

test('medianGamesPlayed averages the two middle values for an even player count', () => {
  const median = medianGamesPlayed({ players: [{ gamesPlayed: 4 }, { gamesPlayed: 10 }, { gamesPlayed: 6 }, { gamesPlayed: 8 }] });
  assert.strictEqual(median, 7);
});

test('medianGamesPlayed returns the single middle value for an odd player count', () => {
  const median = medianGamesPlayed({ players: [{ gamesPlayed: 4 }, { gamesPlayed: 10 }, { gamesPlayed: 6 }] });
  assert.strictEqual(median, 6);
});

test('medianGamesPlayed returns 0 for a snapshot with no players', () => {
  assert.strictEqual(medianGamesPlayed({ players: [] }), 0);
});

// ---------------------------------------------------------------------------
// readCapture
// ---------------------------------------------------------------------------

test('readCapture reads and parses a capture file directly by its path', async () => {
  await withTempDir(async (dir) => {
    const snapshot = makeSnapshot();
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot }, dir);

    const [file] = await listCaptures({ league: LEAGUE, season: SEASON }, dir);
    assert.deepStrictEqual(await readCapture(file), snapshot);
  });
});

test('readCapture returns null for a path that does not exist', async () => {
  await withTempDir(async (dir) => {
    assert.strictEqual(await readCapture(join(dir, 'nope.json')), null);
  });
});

// ---------------------------------------------------------------------------
// findAnchorCapture
// ---------------------------------------------------------------------------

function makeAtGp(capturedAt, gamesPlayed) {
  return makeSnapshot({ capturedAt, players: [{ id: 1, name: 'Skater', gamesPlayed, timeOnIce: gamesPlayed * 1000 }] });
}

test('findAnchorCapture picks the capture closest to the requested games behind the newest one', async () => {
  await withTempDir(async (dir) => {
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-01T12:00:00.000Z', 4) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-05T12:00:00.000Z', 8) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-10T12:00:00.000Z', 12) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-20T12:00:00.000Z', 17) }, dir);

    // Newest is 17 GP; asking for "8 games back" targets a median of 9. Of the earlier
    // captures (4, 8, 12), the GP=8 capture is closest (distance 1), so it should win even
    // though no capture sits at exactly the requested depth.
    const result = await findAnchorCapture({ league: LEAGUE, season: SEASON, games: 8 }, dir);

    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.anchor.players[0].gamesPlayed, 8);
    assert.strictEqual(result.resolvedGames, 9);
    assert.strictEqual(result.requestedGames, 8);
    assert.strictEqual(result.latestMedianGamesPlayed, 17);
  });
});

test('findAnchorCapture breaks a distance tie toward the OLDER capture (the longer, safer span)', async () => {
  await withTempDir(async (dir) => {
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-01T12:00:00.000Z', 8) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-10T12:00:00.000Z', 12) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-20T12:00:00.000Z', 20) }, dir);

    // Newest is 20 GP; "10 games back" targets a median of 10. GP=12 and GP=8 are both exactly
    // 2 games off -- a tie the amplification analysis says should resolve toward the longer
    // (older) span, since a too-short window is the noisier failure mode.
    const result = await findAnchorCapture({ league: LEAGUE, season: SEASON, games: 10 }, dir);

    assert.strictEqual(result.anchor.players[0].gamesPlayed, 8);
    assert.strictEqual(result.resolvedGames, 12);
  });
});

test('findAnchorCapture returns a null anchor with a reason when fewer than two captures exist', async () => {
  await withTempDir(async (dir) => {
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-20T12:00:00.000Z', 17) }, dir);

    const result = await findAnchorCapture({ league: LEAGUE, season: SEASON, games: 8 }, dir);

    assert.strictEqual(result.anchor, null);
    assert.match(result.reason, /only one capture on disk/);
  });
});

test('findAnchorCapture returns a null anchor with a reason when nothing has been captured', async () => {
  await withTempDir(async (dir) => {
    const result = await findAnchorCapture({ league: LEAGUE, season: SEASON, games: 8 }, dir);

    assert.strictEqual(result.anchor, null);
    assert.match(result.reason, /only one capture on disk/);
  });
});

test('findAnchorCapture skips a corrupt capture between two readable ones instead of throwing', async () => {
  await withTempDir(async (dir) => {
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-01T12:00:00.000Z', 5) }, dir);

    const seasonDir = join(dir, `league-${LEAGUE}`, `season-${SEASON}`);
    await writeFile(join(seasonDir, '2026-07-10T120000.000Z.json'), '{ not valid JSON');

    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-20T12:00:00.000Z', 20) }, dir);

    // Requesting a huge number of games back means both earlier captures (the corrupt one and
    // the readable GP=5 one) are candidates; the corrupt one must be skipped rather than
    // thrown on, leaving the readable GP=5 capture as the only usable anchor.
    const result = await findAnchorCapture({ league: LEAGUE, season: SEASON, games: 200 }, dir);

    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.anchor.players[0].gamesPlayed, 5);
    assert.ok(result.anchorFile.includes('2026-07-01'));
  });
});

test('findAnchorCapture returns a null anchor with a reason when the newest capture itself is corrupt', async () => {
  await withTempDir(async (dir) => {
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-01T12:00:00.000Z', 5) }, dir);

    const seasonDir = join(dir, `league-${LEAGUE}`, `season-${SEASON}`);
    await writeFile(join(seasonDir, '2026-07-20T120000.000Z.json'), '{ not valid JSON');

    const result = await findAnchorCapture({ league: LEAGUE, season: SEASON, games: 8 }, dir);

    assert.strictEqual(result.anchor, null);
    assert.match(result.reason, /the latest capture is unreadable/);
  });
});

test('findAnchorCapture returns a null anchor with a reason when every earlier capture is corrupt', async () => {
  await withTempDir(async (dir) => {
    const seasonDir = join(dir, `league-${LEAGUE}`, `season-${SEASON}`);
    await mkdir(seasonDir, { recursive: true });
    await writeFile(join(seasonDir, '2026-07-01T120000.000Z.json'), '{ not valid JSON');
    await writeFile(join(seasonDir, '2026-07-10T120000.000Z.json'), '{ also not valid JSON');
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-20T12:00:00.000Z', 20) }, dir);

    const result = await findAnchorCapture({ league: LEAGUE, season: SEASON, games: 8 }, dir);

    assert.strictEqual(result.anchor, null);
    assert.match(result.reason, /no readable earlier capture was found/);
  });
});

test('findAnchorCapture reports the span it actually resolved to, honestly, when no capture is near the request', async () => {
  await withTempDir(async (dir) => {
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-01T12:00:00.000Z', 5) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-05T12:00:00.000Z', 10) }, dir);
    await writeCapture({ league: LEAGUE, season: SEASON, snapshot: makeAtGp('2026-07-20T12:00:00.000Z', 20) }, dir);

    // Requesting 100 games back from a 20-GP season is impossible to satisfy -- the best
    // available anchor (GP=5) only resolves a 15-game span. resolvedGames must report that
    // real span, never the requested 100.
    const result = await findAnchorCapture({ league: LEAGUE, season: SEASON, games: 100 }, dir);

    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.requestedGames, 100);
    assert.strictEqual(result.resolvedGames, 15);
    assert.notStrictEqual(result.resolvedGames, result.requestedGames);
  });
});

// ---------------------------------------------------------------------------
// PIR_DATA_DIR
// ---------------------------------------------------------------------------

test('PIR_DATA_DIR overrides the default data directory when no explicit dataDirUrl is given', async () => {
  await withTempDir(async (dir) => {
    const originalEnv = process.env.PIR_DATA_DIR;
    process.env.PIR_DATA_DIR = dir;
    try {
      assert.strictEqual(getDataDir(), dir);

      const snapshot = makeSnapshot();
      await writeCapture({ league: LEAGUE, season: SEASON, snapshot });
      assert.deepStrictEqual(await readLatest({ league: LEAGUE, season: SEASON }), snapshot);
    } finally {
      if (originalEnv === undefined) delete process.env.PIR_DATA_DIR;
      else process.env.PIR_DATA_DIR = originalEnv;
    }
  });
});
