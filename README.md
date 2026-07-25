# Player Performance Analysis

Computes **PIR** (Player Impact above Replacement), a z-score-based composite skater impact
metric for an SHL/SMJHL-style simulation hockey league, sourced entirely from the league's live
JSON API at [index.simulationhockey.com](https://index.simulationhockey.com). It replaces an
older Google Sheets / Apps Script pipeline (ZPI) with a small, dependency-free Node CLI.

## What PIR measures

PIR scores each skater against a **replacement-level** baseline, not a league-average one.
League-average z-scores answer "how much better is this player than a typical player," which
flatters everyone in a shallow league and undersells everyone in a deep one. Replacement level
instead asks "how much better is this player than the freely-available fill-in you'd call up if
the roster spot opened" — a fixed, meaningful floor (90% of the mean for stats where higher is
better, 110% of the mean for stats where lower is better, e.g. penalty minutes). Each of the 8
components below is converted to a z-score against that replacement baseline, multiplied by its
weight, and summed. The result reads as "weighted standard deviations of impact above a
replacement-level skater."

## The 8 components

| Component | Weight | Why it's weighted that way |
| --- | ---: | --- |
| FF% Relative | 2.5 | The single best predictor of sustained on-ice possession impact; weighted heaviest because it captures value the raw counting stats below can't. |
| Points/60 | 1 | Direct offensive production, normalized so a fourth-liner and a top-line forward are compared on equal ice time. |
| Net Goals/60 | 1 | On-ice goals-for minus goals-against per 60 — the actual scoreboard impact of a player's shifts, not just their own point totals. |
| Net Shots/60 | 1 | On-ice shot differential per 60 — a larger-sample proxy for territorial impact than goals alone, which are noisier over a season. |
| Net Takeaways/60 | 1 | Takeaways minus giveaways per 60 — puck management: does this player create possession swings or hand the puck back? |
| Blocks/60 | 1 | Shot-blocking rate — a defensive contribution that Points/60 and the net-rate stats above don't otherwise capture. |
| Hits/60 | 0.5 | Physical engagement; weighted lightly since it correlates only loosely with winning and can be padded by chasing hits late in games. |
| PIM/60 | -1.5 | Penalty minutes per 60, weighted *negatively* and heavily — taking penalties hands the opponent a power play, a direct and repeatable cost to the team. |

`appliedTPE` (a player's total earned experience points) rides along as a display column only. It
is never an input to PIR — PIR measures *realized on-ice impact*, not invested development
resources.

Component definitions and weights live in `src/pir/components.js`; the formula plumbing
(mean/stdev/replacement-level/z-score) lives in `src/pir/population.js`, `src/pir/zscore.js`, and
`src/pir/rate60.js`.

## Baseline modes

`rank` supports two `--baseline` modes:

- **`league`** (default) — every skater is scored against one shared league-wide population.
- **`position`** — forwards (C/LW/RW) and defensemen (LD/RD) are each scored against their own
  separate population.

Position segmentation matters because a league-wide baseline structurally favors forwards:
defensemen naturally post lower Points/60 (they're deployed for defensive responsibility, not
offensive zone time) and higher Blocks/60 (shot-blocking is a bigger part of the defensive job).
Scored against one shared population, a defenseman's real defensive value gets diluted by a
forward-shaped baseline. `--baseline=position` corrects that by comparing each player only to
others at a similar position.

## Data store

Each league+season pair gets exactly two files:

```
data/
  league-{L}/
    season-{S}/          (or "current/" when --season was omitted)
      current.json        newest capture
      previous.json        the capture before it
```

This is **intentionally not a full historical archive**. `update` rotates whatever was `current`
into `previous` and discards anything older — the goal is just enough history to compute ranking
movement since the last capture, not a general-purpose time series. A finished season's stats
never change again, so `update` re-run against an already-captured finished season makes no
network call at all.

Each stored player row keeps only the fields PIR actually reads or displays (see
`STORED_STAT_FIELDS` in `src/snapshot.js`) — everything else the raw API returns (PDO, faceoffs,
fight stats, power-play splits, the ~30 unused attribute ratings, etc.) is one re-fetch away if a
future feature needs it, which is cheaper than warehousing it speculatively today.

## Ranking movement

Every `rank` run scores the `current` snapshot, and, when a `previous` snapshot exists for that
league+season, scores it too and joins the two rankings by player id. Each player in the report
then carries either:

- `rankDelta` / `pirDelta` — how many places they climbed or fell, and how much their PIR moved,
  since the previous capture, or
- `isNew: true` — no rank/PIR delta shown, because they weren't in the previous capture at all
  (a debut, call-up, or trade into the league).

In the table output this renders as `^N` (climbed N places), `vN` (fell N places), `-`
(unchanged), or `NEW`. Pass `--no-movement` to skip reading the previous snapshot entirely and
print a clean leaderboard with no movement column.

## Usage

```
node index.js update --league=<0|1|2|3> [--season=<n>]
node index.js rank   --league=<0|1|2|3> [--season=<n>] [--baseline=league|position]
                      [--no-movement] [--top=N] [--format=table|json|csv] [--out=<path>]
```

League ids: `0` = SHL, `1` = SMJHL, `2` = IIHF, `3` = WJC. `--league` is required with no default —
silently scoring one league's data under another's label would produce a plausible-looking but
wrong leaderboard with no error. Omitting `--season` targets whatever the API currently considers
the active season.

**Capture a snapshot:**

```
node index.js update --league=1 --season=86
```

**Rank the top 25, league-wide baseline, as a table (the default):**

```
node index.js rank --league=1 --season=86 --baseline=league --top=25
```

**Rank with position-segmented baselines, no movement column:**

```
node index.js rank --league=1 --season=86 --baseline=position --no-movement
```

**Export to CSV:**

```
node index.js rank --league=1 --season=86 --format=csv --out=rankings.csv
```

**Export full per-component JSON breakdown:**

```
node index.js rank --league=1 --season=86 --format=json --out=rankings.json
```

`rank` errors with an actionable message (including the exact `update` command to run) if no
snapshot has been captured yet for the given league/season, rather than printing an empty table.

## Testing

```
npm test              # node:test, no coverage instrumentation
npm run test:coverage # node:test with 80%/80% line/branch coverage gate
```

Zero runtime dependencies: native `fetch` for HTTP, hand-rolled table/CSV output, `node:test` +
`node:assert/strict` for testing. Every function that does I/O accepts a `deps` parameter
defaulting to the real implementation, so tests substitute plain fake functions with no mocking
library.
