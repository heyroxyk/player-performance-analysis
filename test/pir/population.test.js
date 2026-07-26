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

test('populationMean with uniform weights matches the unweighted mean', () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9];
  const weights = values.map(() => 10);
  assert.equal(populationMean(values, weights), populationMean(values));
});

test('populationMean with weights counts a heavily-weighted value proportionally more', () => {
  // A value of 100 weighted 99x against a single value of 0 should land close to 100, not at
  // the unweighted midpoint of 50.
  const mean = populationMean([100, 0], [99, 1]);
  assert.ok(Math.abs(mean - 99) < 1e-9);
});

test('populationStdev with weights matches the unweighted stdev for uniform weights', () => {
  const values = [1, 2, 3, 4];
  const weights = values.map(() => 5);
  assert.equal(populationStdev(values, weights), populationStdev(values));
});

test('populationStdev with weights shrinks toward 0 as a heavily-weighted value dominates a population near its own value', () => {
  // One value at exactly the (weighted) mean carries no variance on its own; weighting it
  // heavily against a couple of outliers should pull the population stdev down compared to
  // treating all three values as equally weighted.
  const values = [10, 0, 20];
  const unweighted = populationStdev(values);
  const weighted = populationStdev(values, [100, 1, 1]);
  assert.ok(weighted < unweighted);
});
