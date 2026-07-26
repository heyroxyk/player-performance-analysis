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

## Small-sample handling

Every component is a per-60-minute rate, and a rate built from a handful of shifts is mostly
noise — a player with a couple of favorable shifts can print a rate that dwarfs a full-season
regular's, with nothing in a plain z-score to push back on it. Two corrections handle this:

- **The league baseline is weighted by ice time.** `populationMean`/`populationStdev`
  (`src/pir/population.js`) weight each player's rate by their `timeOnIce`, so a brief cameo
  doesn't get an equal vote against a full-season sample in setting the league mean and stdev.
- **Each observed rate is shrunk toward that baseline before scoring**
  (`src/pir/shrink.js`), in proportion to how much ice time backs it up: as playing time
  approaches zero the shrunk value collapses to the league mean (no evidence, no opinion); as it
  grows past the shrinkage constant (`K`), the shrunk value converges on the player's real
  observed rate.

**`K` is adaptive by default**, not a fixed number: `src/pir/pirEngine.js`'s
`adaptiveShrinkageMinutes` sets `K = 0.316 × median sample time-on-ice (in minutes)`, so the
median player always sits at roughly the same "own signal vs. league prior" split regardless of
how far into a season (or how deep a rolling window, see below) the sample runs. A fixed `K`
doesn't have this property: at the old flat default of 400 minutes, the median SMJHL/SHL player
sat at ~45% own signal 17 games into a season but ~76% by game 66 — the same player, same true
talent, scored differently in November than in March. The `0.316` coefficient is derived (not
independently tuned) to reproduce that historical 400-minute default at a full ~66-game season,
so this is a continuity fix, not a change to season-end behavior. Pass `--shrink=<minutes>` to
override with an explicit constant (`--shrink=0` disables shrinkage entirely); the table header,
JSON `meta`, and web panel all label the result `(adaptive)` or `(explicit)` accordingly.

Because PIR is a rate, it can't on its own distinguish a hot small-sample player from a durable
full-season contributor with a lower rate but far more accumulated minutes. Every scored row also
carries **`totalImpact`** — PIR multiplied back out by hours actually played — shown as the
`Total` column in the table and CSV output (and as `totalImpact` in JSON), so both questions
("who's best right now" and "who has delivered the most this season") have an honest answer.

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

## Player status filter

`--status=active|inactive|all` (default `all`, no filtering) restricts `rank` to active or
inactive players. Unlike everything else this tool computes, activity status is **not** sourced
from the league's Index API (`index.simulationhockey.com`) at all -- that API has no status/
active/inactive field anywhere. Instead it comes from a completely separate system, the
**Portal** (`portal.simulationhockey.com`), whose own `/player` endpoint reports a `status` enum
(`pending` | `denied` | `active` | `retired`) per player. "Active" means `status === 'active'`;
"inactive" means anything else -- retired, pending, denied, and unmatched/ambiguous players (see
below) all bucket into "inactive" for filtering purposes.

**The join, and why it's by name:** the Portal's player id (`pid`) and the Index API's player id
(`id`) are different, unrelated numeric spaces -- e.g. "Winston Coles" is `id: 2937` in the Index
API but `pid: 2471` in the Portal. There is no shared numeric key, so the only reliable join
available is the player's `name` string (see `joinPlayerStatusByName` in `src/playerStatus.js`).
A name with no match in the Portal data, or with more than one Portal player sharing that exact
name (an ambiguous match), is never guessed at -- it resolves to `'unknown'` rather than risking
a silently wrong status pulled from an unrelated same-named player. `'unknown'` buckets the same
way as any other non-active status: it counts as "inactive" when filtering.

**League scope:** the Portal's own `leagueID` enum only cleanly covers SHL (`0`) and SMJHL (`1`).
IIHF (`2`) requires querying the Portal "in tandem with a teamID" (a country id), which doesn't
fit this tool's per-league capture model, and WJC (`3`) isn't in the Portal's `leagueID` enum at
all. For those two leagues, the Portal fetch is skipped entirely and every player's status is
`'unknown'` -- not an error, just an honest scope limit (see `src/snapshot.js`).

**When it's fetched:** status is joined onto every player row at capture time (`update`), not
looked up live by `rank` -- it becomes part of the persisted, timestamped snapshot, exactly like
`appliedTPE` already is. A Portal fetch failure never fails `update`: it's caught, every player's
status falls back to `'unknown'` for that capture, and a warning is surfaced alongside the
capture result (in the CLI's stderr and the web panel's capture status line) so the fallback is
never silent.

A `Status` column appears in the table/CSV output only when the leaderboard actually contains
more than one distinct status -- a fully-filtered view (`--status=active`, say) would otherwise
show the same word on every row, which is clutter rather than information.

**Portal profile links:** the same name-based join also carries the Portal's own `pid` through
as `portalId` on every player row, under the identical ambiguity rule as `status` (null unless
the name resolved to exactly one Portal row). The web panel uses it to link a player's name
directly to their Portal profile (`https://portal.simulationhockey.com/player/<pid>`) -- an
unmatched, ambiguous, or IIHF/WJC player (or a capture taken before this field existed) simply
renders as plain, unlinked text rather than a guessed or broken URL.

## Data store

Every capture is self-describing and additive — nothing is ever silently overwritten:

```
data/
  league-{L}/
    season-{S}/                       the season the API actually returned, always resolved
      2026-07-25T202329639Z.json       one file per capture, newest first by filename
      2026-07-20T090011204Z.json
      ...
```

`update`'s `--season` flag only controls *which* season to ask the API for; the season a capture
actually belongs to is read back off the API's own response and stored inside the file, never
guessed from a folder name. Earlier versions stored a capture taken without `--season` under a
`current/` folder — that's gone, because a folder whose meaning silently changes when the league
rolls to a new season let a movement comparison diff two different seasons against each other
with no warning. Omitting `--season` still means "whatever the API currently considers live"; the
answer is just recorded now instead of assumed.

Retention keeps a short recent history per league+season, pruned by **games played** rather than
a flat file count — a count-based cap would silently lose depth the moment capture cadence
changes (a week without running `update` shouldn't cost the same "slots" as a week of daily
captures). Retained depth is 28 games (twice the deepest supported rolling window of 12, plus a
4-game margin) — deep enough that a `--window` request always has real data to resolve against,
and deep enough (once captured) to eventually support window-over-window movement. `rank` reads
the *most recent* capture by default; when `--season` is omitted, that means the season captured
most recently for that league, not the highest season number. A finished season's stats never
change again, so `update` re-run against an already-captured finished season makes no network
call at all — and neither does re-running `update` against a season whose stats haven't changed
since the last capture (a routine outcome between game days): the fetch still happens (there's no
way to know the data is unchanged without asking), but nothing new is written to disk.

Each stored player row keeps only the fields PIR actually reads or displays (see
`STORED_STAT_FIELDS` in `src/snapshot.js`) — everything else the raw API returns (PDO, faceoffs,
fight stats, power-play splits, the ~30 unused attribute ratings, etc.) is one re-fetch away if a
future feature needs it, which is cheaper than warehousing it speculatively today.

`data/` is gitignored on `master`: captures are local working data, not source, and re-capturing
is one command (or one click, in the web panel) away. The data directory defaults to `./data`
next to the source, overridable via the `PIR_DATA_DIR` environment variable — this is how the
scheduled capture Action (see "Automated capture" below) points a fresh checkout of the
`pir-data` branch at a location outside the source tree without threading a data-dir flag through
every command.

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
print a clean leaderboard with no movement column. Movement is unavailable in `--window` mode
(see below) — the "previous" capture it would compare against is the wrong comparison point for
a window, not merely a missing one.

## Rolling window analytics

`--window=<games>` scores a **rolling window** ("last ~N games") instead of season-to-date, by
differencing the latest capture against an earlier one (the "anchor") rather than scoring
cumulative totals. This answers "who is playing well *right now*" rather than "who has been good
this season" — a player who was excellent through forty games and has since fallen off still
ranks near the top on a season view, since forty good games outweigh twelve bad ones.

```
node index.js rank --league=1 --window=12
```

**How it works:** every player is differenced against the *same* anchor capture (a shared span of
league play for the whole leaderboard), rather than each against their own personal "N games ago"
— the latter would score a player just back from injury against a different stretch of the
season than everyone else. The reported window depth is always the **actual resolved span**, not
the requested one: captures don't land on request, so "last ~12 games" resolves to whichever
capture on disk is closest, and the leaderboard header, JSON `meta.window`, and the panel's rail
note all say so explicitly (e.g. "resolved 11, anchor 2026-07-01T12:00:00.000Z").

**What can go wrong, and how it's surfaced instead of hidden:** a window needs at least two
captures for the season, and the reconstructed per-60 rates get noisier the shorter the window is
relative to a player's season-to-date ice time (the API only ever reports pre-computed rates, not
the raw counts they're built from, so a window rate is *un-averaged* out of two season-to-date
figures — accurate, but with error that grows as the window shrinks). Below 15% of season TOI the
request is refused outright rather than shown; between 15% and 25% it's shown with an explicit
warning naming the affected component (`Net Goals/60`). A request that can't be honestly built at
all — no second capture yet, or a window so short it fails the quality floor — fails with an
actionable message (`--league=1 --window=12` → "the nearest available anchor resolves to a
zero-or-negative game span...") rather than silently falling back to season-to-date, which would
answer a different question than the one asked with no indication anything changed. Both the CLI
and the web panel surface this identically, since it comes from one shared error path
(`src/commands.js`'s `.windowUnavailable`-tagged error → `409` in the panel).

Windowed rows carry the window-scoped `gamesPlayed`/`timeOnIce` alongside the season totals
(`seasonGamesPlayed`/`seasonTimeOnIce`), so a 12-game leaderboard is never visually confusable
with a season one: the table and web panel label the columns `GP (win)` / `TOI (win)` and add a
`Season GP` column; the CSV export appends `SeasonGP,SeasonTOI,WindowToiPct` columns.

Because a window only accumulates as captures do, and the API can't backfill history, this
feature needs real capture density to be useful — see "Automated capture" below.

## Usage

```
node index.js update --league=<0|1|2|3> [--season=<n>]
node index.js rank   --league=<0|1|2|3> [--season=<n>] [--baseline=league|position]
                      [--no-movement] [--top=N] [--format=table|json|csv] [--out=<path>]
                      [--shrink=<minutes>] [--window=<games>] [--status=active|inactive|all]
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

## Web control panel

The control panel is a static, dependency-free browser client (`src/web/public/`, vanilla ES
modules, no framework, no build step) that runs the exact same scoring path as the CLI
(`src/commands.js`, `src/pir/*`, `src/report/*`) directly in the browser — a table/CSV/JSON
export from the panel is byte-identical to the equivalent CLI invocation, because it's the same
code, not a reimplementation. League, season, baseline, status, movement, shrinkage, and
rolling-window controls all map directly to the CLI flags above. A "Captured N ago" readout next
to the status pill shows how fresh the loaded data is, so there's never a need to guess whether a
refresh is worth clicking.

Two ways to run it:

```
npm run serve
```

Starts a local server (a raw `node:http` server, no Express) at `http://127.0.0.1:8765` that
serves this same static client plus a "Capture Snapshot" button, which drives `update` against a
local disk capture with a live elapsed-time readout in place of a terminal command. The server
binds to loopback only (no `--host` flag) since capturing writes files and makes live outbound
API calls from browser input.

The same client is also hosted on **GitHub Pages** — see below — where there's no server at all
and no capture button; data comes from the daily automated capture instead (see "Automated
capture" below). Locally vs. hosted, the only thing that differs is where a capture comes from
(a live local disk vs. a prebuilt manifest baked into the deploy); the scoring is identical code
either way, so the two can never drift into disagreeing about a ranking.

### Hosting on GitHub Pages

```
npm run build:site -- --out=<dir>
```

Assembles the browser client, the `src/` modules it needs (`src/web/staticAssets.js` is the
exact, literal list — the same list the local server's static routes are built from, so a file
that loads locally can never be missing from the deployed site), and every capture file under
`PIR_DATA_DIR` into `<dir>`, a ready-to-serve static artifact — plus `data/index.json`, a
generated manifest indexing every capture's `capturedAt`/`medianGamesPlayed`/`playerCount` so the
browser can pick a rolling-window anchor from a few hundred bytes of JSON rather than fetching
every capture in a season to inspect it.

`.github/workflows/pages.yml` runs this build on every push to `master` and on every successful
run of the capture workflow (so a fresh daily capture shows up on the hosted site automatically),
checking out `pir-data` as the capture source — the repo must be public for Pages to work on the
free plan, and Settings → Pages → Source must be set to "GitHub Actions" once, manually.

## Automated capture

Rolling-window analytics (`--window`) can only get better with more captured history, and the API
serves only cumulative season-to-date totals — there's no way to backfill the past, so capture
depth has to accumulate in real time going forward. A scheduled GitHub Action
(`.github/workflows/capture.yml`) captures both leagues daily and commits the result to a
dedicated `pir-data` branch, keeping `master` clean (`data/` stays gitignored there, so a local
click of "Capture Snapshot" still causes zero repository churn). Point a local checkout of that
branch at this tool via the `PIR_DATA_DIR` environment variable (see "Data store" above) to
analyze against the accumulated history. Retention still prunes the branch tip to the most recent
28 games per league+season; the branch's git *history* is the actual long-term archive.

## Testing

```
npm test              # node:test, no coverage instrumentation
npm run test:coverage # node:test with 80%/80% line/branch coverage gate
```

Zero runtime dependencies: native `fetch` for HTTP, hand-rolled table/CSV output, `node:test` +
`node:assert/strict` for testing. Every function that does I/O accepts a `deps` parameter
defaulting to the real implementation, so tests substitute plain fake functions with no mocking
library.
