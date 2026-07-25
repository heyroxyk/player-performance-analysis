import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replacementMean, zScore } from '../../src/pir/zscore.js';

test('replacementMean discounts a higher-is-better mean to 90%', () => {
  assert.equal(replacementMean(100), 90);
});

test('replacementMean inflates a lower-is-better mean to 110%', () => {
  assert.equal(replacementMean(100, { lowerIsBetter: true }), 110);
});

test('zScore computes standard deviations above the replacement baseline', () => {
  assert.equal(zScore({ rawValue: 95, replacementMean: 90, stdev: 5 }), 1);
});

test('zScore falls back to dividing by 1 instead of producing NaN/Infinity when stdev is 0', () => {
  assert.equal(zScore({ rawValue: 95, replacementMean: 90, stdev: 0 }), 5);
});
