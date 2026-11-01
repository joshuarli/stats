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

- Every count is `sampleInterval`-weighted. Totals move by about one sample
  (100 events) per bucket, so ignore changes smaller than that.
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

Last-hour readings on 2026-11-01, outside the backfill:

- `stuff`: about 50k requests, 0.4 ms CPU average, before the bench loop
  stopped.
- `stats`: about 6.9k requests, of which about 1.2k were dashboard history
  reads and 0.7k ingests.

## Lanes

Each lane ends with a ticket in the repo that owns the code. Order inside a
lane is by evidence, not effort.

### A. Instrument what is still blind

- Durable Object storage size has no source (STA-34), and the estimate omits
  Durable Object duration, which is billed.
- R2 operations are not split into Class A and Class B, which are priced about
  12 times apart. Check whether `events.r2CombinedOperations` exposes an action
  type before adding a column.
- A cost estimate for R2 once the split exists.

### B. `stats`

- Dashboard polling: an open tab produced about 1.2k history reads in an hour,
  each 35 to 55 ms of Durable Object CPU on a cache miss (STA-32). Candidates:
  poll slower while the tab is hidden, and read 1m rollups for windows that do
  not need 15 s steps.
- Ingest CPU tail of 35 to 47 ms against a 1 ms JavaScript cost (STA-33).
  Count rows read and written per statement before moving any work.
- Collector store write of about 26 ms per run (STA-31).
- Collector reads about 8M analytics rows per run, plus about 2.2M for D1.
  Confirm whether the binding bills for it before widening any window.

### C. `stuff`

- Re-baseline for one hour now that the bench loop has stopped, then rank
  routes by CPU and R2 operations per request.
- Verify the response cache is absorbing repeat reads: compare `crates` blob
  requests with `stuff-mycrates` operations.

### D. `usr-memories` (blocked on the backfill ending)

Two patterns were visible during the backfill and may be defects at any volume
rather than backfill artifacts:

- `UPDATE remote_object SET last_referenced_at` writes a row for every
  referenced object on each sync, even when nothing changed.
- `INSERT INTO snapshot_object` writes one row per object per snapshot.

Decide on steady-state numbers: once the backfill ends, read one hour of D1
statements and per-route CPU, then fix whichever statements still lead. Any
change to the `remote_object` or `snapshot_object` tables is a stored-format
change and needs a yes first.

### E. Dependencies and size

- Rust crates in `stuff` and the stats agent are unaudited (`cargo outdated` is
  not installed). Check with `cargo update --dry-run`, upgrade, and record
  removals.
- The remaining esbuild and wrangler weight comes from the vitest plugin and is
  decided in `docs/dependencies.md`; revisit only if the plugin moves off them.

## Stop rule

A lane stops when its top item is under 10% of the project's list cost, or when
the last two fixes each moved their metric by less than one sample of noise.
