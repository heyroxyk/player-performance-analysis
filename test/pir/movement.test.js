// Full coverage of computeMovement's default (PIR) behaviour already lives in
// test/snapshot.test.js, since src/snapshot.js re-exports it unchanged for the CLI/web capture
// path -- this file covers only what's new: the scoreKey/deltaKey options parameter the goalie
// side (src/pir/goalieEngine.js) needs to diff GIR instead of PIR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMovement } from '../../src/pir/movement.js';

test('computeMovement defaults to diffing pir into pirDelta when no options are given', () => {
  const current = [{ id: 1, pir: 5 }];
  const previous = [{ id: 1, pir: 3 }];

  const [row] = computeMovement(current, previous);

  assert.equal(row.pirDelta, 2);
  assert.equal('girDelta' in row, false);
});

test('computeMovement diffs a custom scoreKey into a custom deltaKey when both are given', () => {
  const current = [{ id: 1, gir: 12.5 }];
  const previous = [{ id: 1, gir: 10 }];

  const [row] = computeMovement(current, previous, { scoreKey: 'gir', deltaKey: 'girDelta' });

  assert.equal(row.girDelta, 2.5);
  assert.equal('pirDelta' in row, false);
});

test('computeMovement with custom keys still reports isNew for a goalie absent from the previous snapshot', () => {
  const current = [{ id: 1, gir: 12.5 }];
  const previous = [{ id: 99, gir: 8 }];

  const [row] = computeMovement(current, previous, { scoreKey: 'gir', deltaKey: 'girDelta' });

  assert.equal(row.isNew, true);
  assert.equal('girDelta' in row, false);
});

test('computeMovement with no previous snapshot returns a shallow copy regardless of scoreKey/deltaKey', () => {
  const current = [{ id: 1, gir: 12.5 }];

  const result = computeMovement(current, null, { scoreKey: 'gir', deltaKey: 'girDelta' });

  assert.deepStrictEqual(result, [{ id: 1, gir: 12.5 }]);
  assert.equal('isNew' in result[0], false);
});
