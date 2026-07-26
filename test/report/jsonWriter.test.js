import test from 'node:test';
import assert from 'node:assert/strict';
import { toJson, toGoalieJson } from '../../src/report/jsonWriter.js';

function makeRow(overrides = {}) {
  return {
    id: 1,
    name: 'Test Player',
    position: 'C',
    team: 'DET',
    gamesPlayed: 20,
    timeOnIce: 1230,
    appliedTPE: 350,
    pir: 1.5,
    components: {},
    ...overrides,
  };
}

test('toJson embeds meta and the full player array under top-level keys', () => {
  const parsed = JSON.parse(toJson([makeRow()], { meta: { league: 1, season: 86 } }));

  assert.deepEqual(parsed.meta, { league: 1, season: 86 });
  assert.equal(parsed.players.length, 1);
  assert.equal(parsed.players[0].name, 'Test Player');
});

test('toJson defaults meta to an empty object when omitted', () => {
  const parsed = JSON.parse(toJson([makeRow()]));

  assert.deepEqual(parsed.meta, {});
});

test('toJson applies the top limit to the players array', () => {
  const rows = [makeRow({ id: 1 }), makeRow({ id: 2 }), makeRow({ id: 3 })];
  const parsed = JSON.parse(toJson(rows, { top: 2 }));

  assert.deepEqual(parsed.players.map((row) => row.id), [1, 2]);
});

test('toJson passes meta through verbatim without validating its shape', () => {
  const weirdMeta = { league: 1, previousCapturedAt: null, nested: { ok: true } };
  const parsed = JSON.parse(toJson([], { meta: weirdMeta }));

  assert.deepEqual(parsed.meta, weirdMeta);
});

test('toGoalieJson embeds the ranked rows under a "goalies" key, not "players"', () => {
  const goalieRow = { id: 5118, name: 'Test Goalie', gir: 12.5 };
  const parsed = JSON.parse(toGoalieJson([goalieRow], { meta: { league: 0 } }));

  assert.deepEqual(parsed.meta, { league: 0 });
  assert.equal('players' in parsed, false);
  assert.equal(parsed.goalies.length, 1);
  assert.equal(parsed.goalies[0].name, 'Test Goalie');
});

test('toGoalieJson applies the top limit the same way toJson does', () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const parsed = JSON.parse(toGoalieJson(rows, { top: 2 }));

  assert.deepEqual(parsed.goalies.map((row) => row.id), [1, 2]);
});
