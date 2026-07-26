import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTimeOnIce,
  formatRankMovement,
  formatPirDelta,
  formatRelativeTime,
  hasVariedStatus,
  matchesPositionFilter,
  filterRows,
  sortRows,
} from '../../src/web/public/format.js';

test('formatTimeOnIce matches table.js MM:SS formatting', () => {
  assert.equal(formatTimeOnIce(21377), '356:17');
  assert.equal(formatTimeOnIce(65), '1:05');
  assert.equal(formatTimeOnIce(0), '0:00');
});

test('formatRankMovement renders NEW, caret, v, and hyphen exactly like table.js', () => {
  assert.equal(formatRankMovement({ isNew: true }), 'NEW');
  assert.equal(formatRankMovement({ rankDelta: 3 }), '^3');
  assert.equal(formatRankMovement({ rankDelta: -2 }), 'v2');
  assert.equal(formatRankMovement({ rankDelta: 0 }), '-');
  assert.equal(formatRankMovement({}), '-');
});

test('formatPirDelta renders a signed value and NEW/hyphen the same way as table.js', () => {
  assert.equal(formatPirDelta({ isNew: true }), 'NEW');
  assert.equal(formatPirDelta({ pirDelta: 1.5 }), '+1.50');
  assert.equal(formatPirDelta({ pirDelta: -0.5 }), '-0.50');
  assert.equal(formatPirDelta({}), '-');
});

test('formatRelativeTime renders "just now" for anything under a minute old', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  assert.equal(formatRelativeTime('2026-07-26T11:59:31.000Z', now), 'just now');
});

test('formatRelativeTime renders singular and plural minutes correctly', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  assert.equal(formatRelativeTime('2026-07-26T11:59:00.000Z', now), '1 minute ago');
  assert.equal(formatRelativeTime('2026-07-26T11:45:00.000Z', now), '15 minutes ago');
});

test('formatRelativeTime renders singular and plural hours correctly', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  assert.equal(formatRelativeTime('2026-07-26T11:00:00.000Z', now), '1 hour ago');
  assert.equal(formatRelativeTime('2026-07-26T09:00:00.000Z', now), '3 hours ago');
});

test('formatRelativeTime renders singular and plural days correctly', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  assert.equal(formatRelativeTime('2026-07-25T12:00:00.000Z', now), '1 day ago');
  assert.equal(formatRelativeTime('2026-07-24T00:00:00.000Z', now), '2 days ago');
});

test('formatRelativeTime treats a capturedAt technically in the future as "just now", not a negative duration', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  assert.equal(formatRelativeTime('2026-07-26T12:05:00.000Z', now), 'just now');
});

test('matchesPositionFilter matches ALL, an exact position, and a broad F/D group', () => {
  assert.equal(matchesPositionFilter('LD', 'ALL'), true);
  assert.equal(matchesPositionFilter('LD', 'LD'), true);
  assert.equal(matchesPositionFilter('LD', 'D'), true);
  assert.equal(matchesPositionFilter('C', 'D'), false);
  assert.equal(matchesPositionFilter('C', 'F'), true);
});

test('hasVariedStatus is true when rows carry more than one distinct status', () => {
  assert.equal(hasVariedStatus([{ status: 'active' }, { status: 'retired' }]), true);
});

test('hasVariedStatus is false when every row shares the same status', () => {
  assert.equal(hasVariedStatus([{ status: 'active' }, { status: 'active' }]), false);
});

test('hasVariedStatus is false when no row carries a status field at all', () => {
  assert.equal(hasVariedStatus([{ name: 'Alice' }, { name: 'Bob' }]), false);
});

test('hasVariedStatus is false for a single row, regardless of status', () => {
  assert.equal(hasVariedStatus([{ status: 'active' }]), false);
});

function makeRow(overrides = {}) {
  return { id: 1, name: 'Test Player', position: 'C', team: 'DET', ...overrides };
}

test('filterRows matches a query against name or team, case-insensitively', () => {
  const rows = [makeRow({ name: 'Alpha', team: 'DET' }), makeRow({ name: 'Bravo', team: 'VAN' })];
  assert.deepEqual(filterRows(rows, { query: 'alpha' }).map((r) => r.name), ['Alpha']);
  assert.deepEqual(filterRows(rows, { query: 'van' }).map((r) => r.name), ['Bravo']);
});

test('filterRows combines a position filter with a text query', () => {
  const rows = [makeRow({ name: 'Alpha', position: 'C' }), makeRow({ name: 'Bravo', position: 'LD' })];
  assert.deepEqual(filterRows(rows, { position: 'D' }).map((r) => r.name), ['Bravo']);
});

test('filterRows with no options returns every row unchanged', () => {
  const rows = [makeRow(), makeRow({ id: 2 })];
  assert.deepEqual(filterRows(rows), rows);
});

test('sortRows sorts numerically ascending and descending without mutating input', () => {
  const rows = [{ pir: 3 }, { pir: 1 }, { pir: 2 }];
  const original = [...rows];

  assert.deepEqual(sortRows(rows, { key: 'pir', direction: 'asc' }).map((r) => r.pir), [1, 2, 3]);
  assert.deepEqual(sortRows(rows, { key: 'pir', direction: 'desc' }).map((r) => r.pir), [3, 2, 1]);
  assert.deepEqual(rows, original);
});

test('sortRows sorts strings via localeCompare', () => {
  const rows = [{ name: 'Charlie' }, { name: 'Alpha' }, { name: 'Bravo' }];
  assert.deepEqual(sortRows(rows, { key: 'name', direction: 'asc' }).map((r) => r.name), ['Alpha', 'Bravo', 'Charlie']);
});

test('sortRows preserves each row\'s own rank field regardless of new array position', () => {
  const rows = [{ rank: 1, pir: 3 }, { rank: 2, pir: 5 }];
  const sorted = sortRows(rows, { key: 'pir', direction: 'desc' });
  assert.equal(sorted[0].rank, 2, 'the row with the higher pir kept its original PIR-derived rank of 2');
});
