import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, medianGamesPlayed } from '../src/median.js';

test('median averages the two middle values for an even-length array', () => {
  assert.strictEqual(median([4, 10, 6, 8]), 7);
});

test('median returns the single middle value for an odd-length array', () => {
  assert.strictEqual(median([4, 10, 6]), 6);
});

test('median is NaN for an empty array, not a fabricated 0', () => {
  assert.ok(Number.isNaN(median([])));
});

test('medianGamesPlayed is 0 for a snapshot with no players, not NaN', () => {
  assert.strictEqual(medianGamesPlayed({ players: [] }), 0);
});

test('medianGamesPlayed matches median() over the players\' gamesPlayed field', () => {
  const snapshot = { players: [{ gamesPlayed: 4 }, { gamesPlayed: 10 }, { gamesPlayed: 6 }] };
  assert.strictEqual(medianGamesPlayed(snapshot), median([4, 10, 6]));
});
