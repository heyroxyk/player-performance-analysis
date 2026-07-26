import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shrinkToMean } from '../../src/pir/shrink.js';

test('shrinkToMean returns exactly the mean when timeOnIce is 0', () => {
  assert.equal(shrinkToMean(999, { mean: 5, timeOnIce: 0, constant: 24000 }), 5);
});

test('shrinkToMean returns a value close to the raw observation when timeOnIce is huge relative to the constant', () => {
  const result = shrinkToMean(10, { mean: 0, timeOnIce: 24_000_000, constant: 24000 });
  assert.ok(Math.abs(result - 10) < 0.01);
});

test('shrinkToMean returns exactly the raw value when timeOnIce equals the raw value already (no pull needed)', () => {
  assert.equal(shrinkToMean(5, { mean: 5, timeOnIce: 100, constant: 24000 }), 5);
});

test('shrinkToMean splits the difference evenly when timeOnIce equals the constant', () => {
  const result = shrinkToMean(10, { mean: 0, timeOnIce: 24000, constant: 24000 });
  assert.equal(result, 5);
});

test('shrinkToMean pulls a below-mean value up, not just an above-mean value down', () => {
  const result = shrinkToMean(-10, { mean: 0, timeOnIce: 1000, constant: 24000 });
  assert.ok(result > -10 && result < 0);
});
