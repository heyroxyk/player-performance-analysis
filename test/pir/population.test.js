import { test } from 'node:test';
import assert from 'node:assert/strict';
import { populationMean, populationStdev } from '../../src/pir/population.js';

test('populationMean and populationStdev match a classic worked example', () => {
  // [2,4,4,4,5,5,7,9]: mean = 40/8 = 5, and the population stdev of this
  // exact set is a commonly cited textbook example that comes out to exactly 2.
  const values = [2, 4, 4, 4, 5, 5, 7, 9];
  assert.equal(populationMean(values), 5);
  assert.equal(populationStdev(values), 2);
});

test('populationStdev is 0 when every value is identical', () => {
  assert.equal(populationStdev([5, 5, 5]), 0);
});

test('populationStdev divides by N, not N-1', () => {
  // mean = 2.5, population variance = ((1.5^2 + 0.5^2 + 0.5^2 + 1.5^2)) / 4 = 1.25.
  // The N-1 (sample) variance would instead be 5/3 ~= 1.667, giving a different stdev.
  const values = [1, 2, 3, 4];
  assert.equal(populationMean(values), 2.5);
  assert.equal(populationStdev(values), Math.sqrt(1.25));
});
