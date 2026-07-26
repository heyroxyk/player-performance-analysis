import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinPlayerStatusByName, UNKNOWN_STATUS } from '../src/playerStatus.js';

function player(overrides = {}) {
  return { id: 1, name: 'Test Player', position: 'C', team: 'DET', ...overrides };
}

function portalPlayer(overrides = {}) {
  return { pid: 100, name: 'Test Player', status: 'active', ...overrides };
}

test('joinPlayerStatusByName attaches the Portal status AND portalId for an exact single name match', () => {
  const players = [player({ name: 'Winston Coles' })];
  const portalPlayers = [portalPlayer({ pid: 2471, name: 'Winston Coles', status: 'active' })];

  const result = joinPlayerStatusByName(players, portalPlayers);

  assert.equal(result[0].status, 'active');
  assert.equal(result[0].portalId, 2471);
});

test('joinPlayerStatusByName resolves to unknown status and a null portalId when no Portal row matches the name at all', () => {
  const players = [player({ name: 'Nobody Here' })];
  const portalPlayers = [portalPlayer({ name: 'Someone Else' })];

  const result = joinPlayerStatusByName(players, portalPlayers);

  assert.equal(result[0].status, UNKNOWN_STATUS);
  assert.equal(result[0].portalId, null);
});

test('joinPlayerStatusByName resolves to unknown status and a null portalId when the Portal has no rows at all', () => {
  const players = [player({ name: 'Anyone' })];

  const result = joinPlayerStatusByName(players, []);

  assert.equal(result[0].status, UNKNOWN_STATUS);
  assert.equal(result[0].portalId, null);
});

test('joinPlayerStatusByName resolves an ambiguous multi-match to unknown status and a null portalId, without throwing or guessing', () => {
  // Two different Portal players (different pid, different status) that happen to share a
  // name -- exactly the scenario the README calls out: a name-based join across two
  // independently-run systems can collide, and this must never silently pick either one, for
  // portalId any more than for status -- picking either pid would link to the WRONG player's
  // Portal profile.
  const players = [player({ name: 'John Smith' })];
  const portalPlayers = [
    portalPlayer({ pid: 1, name: 'John Smith', status: 'active' }),
    portalPlayer({ pid: 2, name: 'John Smith', status: 'retired' }),
  ];

  assert.doesNotThrow(() => joinPlayerStatusByName(players, portalPlayers));
  const result = joinPlayerStatusByName(players, portalPlayers);
  assert.equal(result[0].status, UNKNOWN_STATUS);
  assert.equal(result[0].portalId, null);
});

test('joinPlayerStatusByName resolves three-or-more same-named Portal rows to unknown as well', () => {
  const players = [player({ name: 'Common Name' })];
  const portalPlayers = [
    portalPlayer({ pid: 1, name: 'Common Name', status: 'active' }),
    portalPlayer({ pid: 2, name: 'Common Name', status: 'retired' }),
    portalPlayer({ pid: 3, name: 'Common Name', status: 'pending' }),
  ];

  const result = joinPlayerStatusByName(players, portalPlayers);

  assert.equal(result[0].status, UNKNOWN_STATUS);
});

test('joinPlayerStatusByName joins each player in a mixed batch independently: match, no-match, and ambiguous side by side', () => {
  const players = [
    player({ id: 1, name: 'Matched Player' }),
    player({ id: 2, name: 'Unmatched Player' }),
    player({ id: 3, name: 'Ambiguous Player' }),
  ];
  const portalPlayers = [
    portalPlayer({ pid: 10, name: 'Matched Player', status: 'active' }),
    portalPlayer({ pid: 20, name: 'Ambiguous Player', status: 'active' }),
    portalPlayer({ pid: 21, name: 'Ambiguous Player', status: 'denied' }),
  ];

  const result = joinPlayerStatusByName(players, portalPlayers);

  assert.equal(result.find((p) => p.id === 1).status, 'active');
  assert.equal(result.find((p) => p.id === 1).portalId, 10);
  assert.equal(result.find((p) => p.id === 2).status, UNKNOWN_STATUS);
  assert.equal(result.find((p) => p.id === 2).portalId, null);
  assert.equal(result.find((p) => p.id === 3).status, UNKNOWN_STATUS);
  assert.equal(result.find((p) => p.id === 3).portalId, null);
});

test('joinPlayerStatusByName carries every Portal status enum value through untouched', () => {
  const players = [
    player({ id: 1, name: 'Pending Player' }),
    player({ id: 2, name: 'Denied Player' }),
    player({ id: 3, name: 'Retired Player' }),
  ];
  const portalPlayers = [
    portalPlayer({ name: 'Pending Player', status: 'pending' }),
    portalPlayer({ name: 'Denied Player', status: 'denied' }),
    portalPlayer({ name: 'Retired Player', status: 'retired' }),
  ];

  const result = joinPlayerStatusByName(players, portalPlayers);

  assert.equal(result.find((p) => p.id === 1).status, 'pending');
  assert.equal(result.find((p) => p.id === 2).status, 'denied');
  assert.equal(result.find((p) => p.id === 3).status, 'retired');
});

test('joinPlayerStatusByName preserves every other field on the player row untouched', () => {
  const players = [player({ name: 'Test Player', position: 'LD', team: 'TOR' })];

  const result = joinPlayerStatusByName(players, []);

  assert.equal(result[0].position, 'LD');
  assert.equal(result[0].team, 'TOR');
  assert.equal(result[0].id, 1);
});

test('joinPlayerStatusByName never mutates the input players array', () => {
  const original = player({ name: 'Test Player' });
  const players = [original];

  joinPlayerStatusByName(players, [portalPlayer({ name: 'Test Player', status: 'active' })]);

  assert.equal('status' in original, false, 'the original row must be left untouched -- a new object is returned instead');
});
