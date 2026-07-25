import { toRate60 } from './rate60.js';

// The 8 statistical components that make up PIR, each weighted by how much it
// should move the final composite score. `row` here is always the TRIMMED
// stored shape (see test/fixtures.js makeTrimmedPlayerRow / src/snapshot.js
// STORED_STAT_FIELDS) -- timeOnIce is in whole seconds, and the on-ice rate
// stats (GF60/GA60/SF60/SA60) and FFPctRel arrive already computed by the API.
//
// Two components intentionally do NOT call toRate60 even though they look
// like rates: Net Goals/60 and Net Shots/60 are built directly from the API's
// own GF60/GA60/SF60/SA60 fields, which are already real per-60 on-ice rates.
// Re-deriving them from raw totals via toRate60 would be both redundant and
// wrong, since GF60/GA60 are on-ice (5-on-5 team) rates tied to shifts, not a
// simple (rawTotal * 3600) / timeOnIce conversion of a personal stat.
export const PIR_COMPONENTS = [
  {
    key: 'ffPctRel',
    label: 'FF% Rel',
    weight: 2.5,
    lowerIsBetter: false,
    getRawValue: (row) => row.FFPctRel,
  },
  {
    key: 'pointsPer60',
    label: 'Pts/60',
    weight: 1,
    lowerIsBetter: false,
    getRawValue: (row) => toRate60(row.points, row.timeOnIce),
  },
  {
    key: 'netGoalsPer60',
    label: 'Net G/60',
    weight: 1,
    lowerIsBetter: false,
    getRawValue: (row) => row.GF60 - row.GA60,
  },
  {
    key: 'netShotsPer60',
    label: 'Net Shots/60',
    weight: 1,
    lowerIsBetter: false,
    getRawValue: (row) => row.SF60 - row.SA60,
  },
  {
    key: 'netTakeawaysPer60',
    label: 'Net Takeaways/60',
    weight: 1,
    lowerIsBetter: false,
    getRawValue: (row) => toRate60(row.takeaways - row.giveaways, row.timeOnIce),
  },
  {
    key: 'shotsBlockedPer60',
    label: 'Blocks/60',
    weight: 1,
    lowerIsBetter: false,
    getRawValue: (row) => toRate60(row.shotsBlocked, row.timeOnIce),
  },
  {
    key: 'hitsPer60',
    label: 'Hits/60',
    weight: 0.5,
    lowerIsBetter: false,
    getRawValue: (row) => toRate60(row.hits, row.timeOnIce),
  },
  {
    key: 'pimPer60',
    label: 'PIM/60',
    weight: -1.5,
    lowerIsBetter: true,
    getRawValue: (row) => toRate60(row.pim, row.timeOnIce),
  },
];

// Maps a skater's specific position to the broader Forward/Defense group used
// by position-segmented baseline scoring -- a defenseman's raw stat profile
// (e.g. fewer points, more blocks) is different enough from a forward's that
// scoring them against one shared league-wide population would systematically
// undervalue defensemen relative to forwards.
export const POSITION_GROUPS = { C: 'F', LW: 'F', RW: 'F', LD: 'D', RD: 'D' };
