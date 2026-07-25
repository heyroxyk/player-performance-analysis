import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRate60 } from '../../src/pir/rate60.js';

test('toRate60 converts a full hour of ice time to a per-60 rate equal to the raw total', () => {
  assert.equal(toRate60(30, 3600), 30);
});

test('toRate60 scales up a half hour of ice time to double the raw total', () => {
  assert.equal(toRate60(15, 1800), 30);
});
