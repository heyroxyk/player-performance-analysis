// Constants and derivation notes for goalie scoring (see src/pir/goalieEngine.js). Kept separate
// from the engine itself so the numbers -- and the research that produced them -- have one place
// to live, the same reason src/pir/components.js is its own file rather than being inlined into
// pirEngine.js.
//
// -----------------------------------------------------------------------------------------------
// Why goalies get a different engine than skaters, not a parameterized computePir
// -----------------------------------------------------------------------------------------------
// A goalie row shares almost no fields with a skater row (no advancedStats object at all -- see
// src/snapshotBuild.js's trimGoalieRow), and the scoring itself works differently in every way
// that matters: no z-score (see below), a different evidence unit for shrinkage (shots faced, not
// ice time), and a counting stat (GSAR) that deliberately does NOT shrink, unlike totalImpact.
// Building src/pir/goalieEngine.js as a sibling rather than adding four conditional parameters to
// computePir keeps both engines simple and leaves the skater oracle in test/pir/pirEngine.test.js
// completely undisturbed.
//
// -----------------------------------------------------------------------------------------------
// Why goalies are scored on save percentage alone
// -----------------------------------------------------------------------------------------------
// Measured directly against real season-89 SHL/SMJHL captures (48 and 33 goalies):
//   GAA          vs shots-against/60   r = +0.78   -- GAA is mostly team defence, not the goalie
//   win%         vs shots-against/60   r = -0.83   -- wins are almost purely a team artifact
//   gameRating   vs save percentage    r = +0.88   -- looks like a near-restatement of SV%
//   save %       vs shots-against/60   r = -0.13   -- the one workload-INDEPENDENT skill signal
//   shutout rate vs save percentage    r = +0.24   -- mostly noise
//
// gameRating looked like it might carry something beyond SV% -- its residual correlated with
// appliedTPE at +0.42/+0.33 (SHL/SMJHL), higher than SV%'s own 0.19/0.14. But appliedTPE is a
// confounded target: it correlates 0.77 with minutes played, so it partly measures tenure, not
// skill. The real test is out-of-sample prediction: does season N gameRating predict season N+1
// SV% BEYOND what season N SV% already predicts? Answer: -0.246 (SHL) / -0.093 (SMJHL) --
// negative in both leagues. gameRating adds nothing and should not be scored.
//
// GAA, W/L/OT, shutouts, gameRating, and appliedTPE are all still DISPLAYED on the goalie board --
// they're real, meaningful context -- just never fed into GIR/GSAR.
//
// -----------------------------------------------------------------------------------------------
// Why there is no z-score
// -----------------------------------------------------------------------------------------------
// A z-score exists to make several incommensurable units addable into one composite (see
// src/pir/components.js's 8-component weighted sum). With exactly one scored component there is
// nothing to make commensurable, and standardizing a heavily-shrunk save percentage compresses an
// entire leaderboard into a range around 0.1 to 0.9 where every goalie "rounds to about half".
// Goals-saved-per-1000-shots (GIR, below) is a natural unit that stays interpretable at every
// shrinkage level instead.
//
// -----------------------------------------------------------------------------------------------
// Replacement level: a fixed 1.5 percentage points below league save percentage
// -----------------------------------------------------------------------------------------------
// src/pir/zscore.js's replacementMean() computes a RELATIVE +/-10% adjustment, calibrated for
// skater rate stats centered near zero. Applied to a save percentage (mean ~0.882), it returns
// ~0.794 -- BELOW the worst goalie in the real SHL population (0.802) -- so every goalie would
// score positive and the metric would be meaningless. Goalies need an explicit, absolute
// replacement level instead.
//
// Tried deriving replacement level empirically (2nd-string goalies by team, minutes-played
// thresholds at 25/35/50% of the league max, bottom-quartile-by-shots-faced) and the resulting gap
// ranged from 0.000 to 0.024 percentage points depending on which arbitrary cutoff was chosen --
// an order of magnitude of instability. A fixed 1.5 percentage points (the standard definition in
// the sports-analytics literature) is one documented number instead of a hidden estimator, and it
// sits in the middle of that empirical cloud.
export const REPLACEMENT_SAVE_PCT_GAP = 0.015;

// GIR is expressed as goals saved per this many shots faced, above replacement -- an arbitrary
// but natural scale (1000 shots is roughly a full, healthy season's workload for a starter), not
// a standardized unit like a z-score.
export const SHOTS_PER_RATE_UNIT = 1000;

// -----------------------------------------------------------------------------------------------
// Adaptive shrinkage: the clamp bounds, derived from real data, not guessed
// -----------------------------------------------------------------------------------------------
// K (the shrinkage constant, in shots faced) comes from decomposing observed save-percentage
// spread into "real talent variance" and "binomial luck variance" (see
// adaptiveShrinkageShots in goalieEngine.js for the formula). Two independent methods, run
// against real season-89 data, corroborate each other within 20-40%:
//   within-season variance decomposition:        SHL K ~1390    SMJHL K ~389
//   season-88-to-89 predictive reliability check: SHL K ~1169    SMJHL K ~547
// Subsetting the population (e.g. only goalies with shotsAgainst >= 150) makes K wildly unstable
// -- an SHL subset like that gives a NEGATIVE true variance entirely -- which is an artifact of
// subsetting, not a real property of the data. adaptiveShrinkageShots must therefore always be
// computed over the FULL scoreable population, never a filtered subset.
//
// Neither bound below binds on any population observed during this research (389 and 1390 for
// SMJHL/SHL, 547/1169 on the reliability check), so both are set well outside that observed range
// as a safety net against a future capture with an unusual distribution, not as an expected
// operating point.
export const MIN_SHRINKAGE_SHOTS = 250;
export const MAX_SHRINKAGE_SHOTS = 3000;
export const DEFAULT_SHRINKAGE_SHOTS = 1200;

// Always computed as saves/shotsAgainst -- NEVER read off a stored `savePct` field. The raw API
// row's own savePct arrives as a rounded string ("0.898") and src/snapshotBuild.js's
// trimGoalieRow deliberately never persists it (see that file), so scoring always uses full
// integer precision.
export function savePct(row) {
  return row.saves / row.shotsAgainst;
}
