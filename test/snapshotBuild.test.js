// Most of buildSnapshot's behavior is already exercised indirectly through test/snapshot.test.js's
// captureSnapshot tests (captureSnapshot delegates its fetch/trim/join work straight to
// buildSnapshot). This file covers what's newly reachable now that buildSnapshot/resolveSeason
// are their own exported, directly-testable functions -- in particular the edge cases neither
// captureSnapshot's tests nor buildSnapshot's happy path exercises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, resolveSeason } from '../src/snapshotBuild.js';
import { makePlayerStatsRow, makePlayerRatingsRow } from './fixtures.js';

test('resolveSeason returns the single season every row agrees on', () => {
  const rows = [makePlayerStatsRow({ season: 89 }), makePlayerStatsRow({ id: 2, season: 89 })];
  assert.strictEqual(resolveSeason(rows, undefined), 89);
});

test('resolveSeason accepts an explicit season that matches what the rows report', () => {
  const rows = [makePlayerStatsRow({ season: 89 })];
  assert.strictEqual(resolveSeason(rows, 89), 89);
});

test('resolveSeason falls back to the requested season when the API returned zero rows', () => {
  assert.strictEqual(resolveSeason([], 89), 89);
});

test('resolveSeason throws when zero rows were returned and no season was requested either', () => {
  assert.throws(() => resolveSeason([], undefined), /returned zero player rows and no --season was given/);
});

test('resolveSeason throws when an explicit season contradicts what the rows report', () => {
  const rows = [makePlayerStatsRow({ season: 89 })];
  assert.throws(() => resolveSeason(rows, 86), /Requested season 86 but the API returned season 89/);
});

test('resolveSeason throws when every row shares a season of undefined', () => {
  const rows = [makePlayerStatsRow({ season: undefined })];
  assert.throws(() => resolveSeason(rows, undefined), /player rows carry no season field/);
});

test('buildSnapshot logs (but does not fail on) a Portal fetch that returns exactly the fetch limit, a truncation signal', async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);

  try {
    const deps = {
      fetchPlayerStats: async () => [makePlayerStatsRow({ id: 1, season: 89 })],
      fetchPlayerRatings: async () => [makePlayerRatingsRow({ id: 1 })],
      fetchPortalPlayersByLeague: async () => ({ rows: [], truncated: true }),
    };

    const { snapshot, warning } = await buildSnapshot({ league: 0, season: 89 }, deps);

    assert.strictEqual(warning, null);
    assert.strictEqual(snapshot.players.length, 1);
    assert.ok(warnings.some((message) => message.includes('may be truncated')));
  } finally {
    console.warn = originalWarn;
  }
});

test('buildSnapshot resolves appliedTPE to null for a stats row with no matching ratings row', async () => {
  const deps = {
    fetchPlayerStats: async () => [makePlayerStatsRow({ id: 1, season: 89 })],
    fetchPlayerRatings: async () => [], // no ratings row for id 1 at all
    fetchPortalPlayersByLeague: async () => ({ rows: [], truncated: false }),
  };

  const { snapshot } = await buildSnapshot({ league: 0, season: 89 }, deps);
  assert.strictEqual(snapshot.players[0].appliedTPE, null);
});
