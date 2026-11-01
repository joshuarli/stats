# Cost campaign

Goal: the lowest Cloudflare spend across the `stats`, `stuff`, and `usr-memories`
Workers at equal or better features. Stats is the instrument: a change ships
only when the project page can show whether it helped.

This plan does not authorize its own execution. Deploys of the three Workers
are authorized. Deleting a resource or data, a D1 migration, or a change to a
stored or wire format needs a yes first.

## Loop

1. Open the project page for the range since the last deploy. Take the top row
   of the Estimated cost widget, then the top D1 statement or CPU route under it.
2. State the hypothesis in one line and name the metric that would move.
3. Reproduce with a failing test or a measured count (rows written, CPU per
   call), fix the cause, and run the narrowest checks.
4. Deploy, wait one hour of new data, and read the same metric over the hour
   after the deploy only. Earlier data predates the change and is not a
   baseline.
5. Put the before and after figures in the commit body. A fix that did not move
   its metric is reverted or re-diagnosed, not kept.

Rules for reading the numbers:

- Worker, R2, and D1 counts are unweighted. Those datasets keep every event at
  current volumes but stamp a `sampleInterval` that does not match, so weighted
  figures were inflated by the stamp: 10 for `stats`, 4 for `stuff`, and
  hundreds for D1 (see `docs/architecture.md` for the measurements). Every
  Worker, R2, and D1 figure quoted before the fix was inflated, including the
  "D1 rows written per hour" reading that suggested a four-figure daily cost.
  Re-check against a known source when volumes change: D1 database growth,
  Worker events against R2 operations, or a counted burst.
- Estimated cost is list price before included allowances. It ranks components;
  it is not the bill.
- `usr-memories` is excluded from baselines until its backfill ends. Its D1 and
  R2 figures during the backfill describe the backfill.

## State

Done:

- JavaScript dependencies are current in all three repos (checked 2026-11-01).
- The collector records D1 totals and the ten costliest statements per project
  (`d15d003`), and the project page shows them with an Estimated cost widget
  (`aca0cbc`). Both are deployed and read live.
- The `example/bench` loop that made up about 86% of `stuff` requests has
  stopped. The old `stats-worker` script no longer exists.

Unweighted last-hour readings on 2026-11-01, outside the backfill:

- `stuff`: about 1.6k Worker events after the bench loop stopped. Before it
  stopped the loop was most of the traffic, so its cost was a quarter of what
  the weighted figure suggested.
- `stats`: about 370 Worker events, which include the Durable Object's own
  fetch for each ingest. The Durable Object saw about 117 ingests (one host,
  every 30 s) and a few dashboard reads. Ingest costs 15 to 25 ms of Durable
  Object CPU and about 60 ms wall; a trivial warm read costs about 5 ms CPU.
  Rows touched per ingest are small (about 10 read, 20 written), and
  `canonicalJson`, `parseBatch`, and JSON parsing cost under 0.3 ms combined in
  workerd, so the ingest CPU is storage and platform cost, not code.
- Durable Object CPU is not a billed dimension (requests, duration, and rows
  are), so lane B items are latency and headroom work, not cost work.

Corrected cost picture (unweighted, 2026-11-01, list prices):

- Workers requests and CPU across all three Workers sit near the plan's
  included amounts: about 1.6k events an hour for `stuff`, 0.4k for `stats`, and
  7k to 15k an hour for `usr-memories` outside the backfill (68k during it).
  There is little to save here, and Durable Object CPU is not billed.
- D1 writes were 114k to 940k rows an hour during the backfill, not hundreds of
  millions. The database grew 190 MB in six hours, which matches that count.
- The spend that can still matter is `usr-memories` R2 operations (about 66k an
  hour during the backfill, mostly `PUT /sync/objects`, which is Class A at
  about $4.50 per million) and its D1 writes at steady state. Both are lane D.

Lanes B and C therefore buy latency and headroom more than money, and lane D is
where a cost change can still show up once the backfill ends.

## Lanes

Each lane ends with a ticket in the repo that owns the code. Order inside a
lane is by evidence, not effort.

### A. Instrument what is still blind

- Durable Object storage size has no source (STA-34), and the estimate omits
  Durable Object duration, which is billed.
- R2 operations cannot be split into Class A and Class B, which are priced about
  12 times apart: `events.r2CombinedOperations` has no action-type column
  (checked 2026-11-01). Approximate from the route mix (reads and heads are
  Class B, puts are Class A) if R2 becomes the leading cost.

### B. `stats`

- Dashboard polling: an open tab reads history on every refresh, each 35 to
  55 ms of Durable Object CPU on a cache miss (STA-32). Candidates: poll slower
  while the tab is hidden, and read 1m rollups for windows that do not need
  15 s steps. Volume is low (tens an hour), so the gain is latency.
- Ingest CPU of 15 to 25 ms per call is not in the JavaScript (STA-33,
  measured). The remaining suspect is the SQLite commit path; test changes that
  reduce write transactions per ingest against the live Durable Object CPU
  histogram before keeping them.
- Collector store write of about 26 ms per run (STA-31).
- Collector reads about 8M analytics rows per run, plus about 2.2M for D1.
  Confirm whether the binding bills for it before widening any window.

### C. `stuff`

- Re-baseline for one hour now that the bench loop has stopped, then rank
  routes by CPU and R2 operations per request.
- Verify the response cache is absorbing repeat reads: compare `crates` blob
  requests with `stuff-mycrates` operations.

### D. `usr-memories`

Re-baselined on 2026-11-01 after the backfill, using the 30 minutes from 22:00
(unweighted):

- 14.7k Worker events, 95% of them `GET /api/v1/sync/objects/<id>` (one R2 read
  each, about 2 ms CPU): another machine pulling objects one at a time. That is
  a finite restore, not a steady load.
- D1 writes come in bursts: `POST /sync/snapshots` ran four times at about 19:30
  and four times at 22:00, each writing one `snapshot_object` row and one
  `remote_object` update per referenced object (about 32k each). That is roughly
  220k rows per burst, which is on the order of $8 a month at list price over
  the included amount, and about $3 a month if the `last_referenced_at` update
  skipped unchanged rows.

Decision: do not change the snapshot write path for that saving. It touches GC
marking in a backup system and the larger part, the per-snapshot object list,
is a stored-format change. Revisit if snapshots become more frequent or the
object count grows by an order of magnitude.

The risk that is not priced in is size: the database grew about 39 MB an hour in
steady state regardless of rows written, which would reach D1's 10 GB cap in
about ten days if it continued (STA-41). The D1 widget now charts it.

### E. Dependencies and size

- Rust crates in `stuff` and the stats agent are unaudited (`cargo outdated` is
  not installed). Check with `cargo update --dry-run`, upgrade, and record
  removals.
- The remaining esbuild and wrangler weight comes from the vitest plugin and is
  decided in `docs/dependencies.md`; revisit only if the plugin moves off them.

## Stop rule

A lane stops when its top item is under 10% of the project's list cost, or when
the last two fixes each moved their metric by less than one sample of noise.
