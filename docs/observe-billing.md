# Observation billing facts

What `stats-observe` costs per observed invocation, for Nanoshop's cost model
to cite. A platform fact names its source page and the date it was read. A
measured figure names the command that produced it. List prices are Workers
Paid prices above the included amounts.

## Platform facts

| Fact | Value | Source, read 2026-11-05 |
| --- | --- | --- |
| Tail Worker billing | "Tail Workers are billed by CPU time, not by the number of requests." | <https://developers.cloudflare.com/workers/observability/logs/tail-workers/> |
| Workers CPU time | $0.02 per million CPU ms above 30M ms a month | <https://developers.cloudflare.com/workers/platform/pricing/> |
| Workers requests | $0.30 per million above 10M a month; does not apply to tail invocations | <https://developers.cloudflare.com/workers/platform/pricing/> |
| Durable Object requests | $0.15 per million above 1M a month; "Each RPC session is billed as one request" | <https://developers.cloudflare.com/durable-objects/platform/pricing/> |
| Durable Object duration | $12.50 per million GB-s above 400k GB-s a month | <https://developers.cloudflare.com/durable-objects/platform/pricing/> |
| SQLite rows written | $1.00 per million above 50M a month | <https://developers.cloudflare.com/durable-objects/platform/pricing/> |
| SQLite rows read | $0.001 per million above 25B a month | <https://developers.cloudflare.com/durable-objects/platform/pricing/> |
| Deletes and alarms | "Deletes are counted as rows written." Each `setAlarm()` is one row written. | <https://developers.cloudflare.com/durable-objects/platform/pricing/> |
| Index updates | "every row update of an index counts as an additional row"; `cursor.rowsWritten` is final once the cursor is consumed and is the billed figure | <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/> |
| In-memory state | "not preserved across eviction or hibernation", so a buffered count is lost with its isolate | <https://developers.cloudflare.com/durable-objects/reference/in-memory-state/> |
| `ctx.id.name` | available inside an object reached by `idFromName()` or `getByName()` (page updated 2026-05-27) | <https://developers.cloudflare.com/durable-objects/api/id/> |
| `waitUntil` | up to 30 s after the response for HTTP-triggered Workers | <https://developers.cloudflare.com/workers/runtime-apis/context/> |

## Store calls per tail batch

The tail handler makes at most one store RPC per observed service per tail
batch (`cloudflare/src/observe/cloudflare/worker.ts`):

- A service observed in full (`stats`, `usr-memories`) calls its store for
  every batch.
- A sampled service (`nanoshop-storied`) calls its store when the batch holds a
  kept event or an outcome, or when its count buffer is due, which is every
  five minutes per tail isolate. A batch of only sampled-out events makes no
  call.
- The hourly cron calls every service's store once to schedule cleanup, and
  the cleanup alarm adds one more request an hour.

In production, `stats` sends about one event per batch: 19,347 accepted
invocations in 19,576 ingest batches, read from
`GET /api/observe/stats/health` (`writes`, newest event 2026-11-05 13:12Z).

## Rows and requests per event

Measured in workerd against the real tail handler and store, with a seeded
Nanoshop workload of one event per batch and cleanup run after retention
elapses:

```sh
cd cloudflare && node --experimental-strip-types test/observe/observation-cost.measure.ts
```

| Event | Rows written at ingest | Rows written at retention | Store requests |
| --- | --- | --- | --- |
| Kept (sampled in, slow, or untraced) | 5.00 | 1.01 | 1 |
| Failed (always kept, with its error) | 10.01 | 2.05 | 1 |
| Rejected as invalid | 3.00 | 0.07 | 1 |
| Sampled out | 0 | 0 | 0 |
| Count flush, per tail isolate per 5 minutes | 2.05 | 1 per bucket | 1 |
| Hourly maintenance | 1 (alarm) | | 2 |

A kept event's five rows are its invocation row and its two index rows
(`observed_at` and `trace_id`), plus one update each to the count bucket row
and the hourly write-cost row. Rows read are left out of the budget; at $0.001
per million, a cent a month would take 10 billion.

For comparison, `stats` (observed in full) writes 3.15 rows per accepted
invocation in production: 60,925 ingest rows for 19,347 accepted, from the
same health read. Its `cleanupRows` was still 0 because nothing had reached
the 7-day retention, so production retention rows are unmeasured.

## Collector CPU per event

Two numbers that are kept apart:

- **Cloudflare:** 0.413 ms of `stats-observe` CPU per Worker invocation, the
  ratio of `workerCpuMs` to `workerInvocations` in
  `pnpm --dir cloudflare -s statsctl cost --project stats-observe --window 24h --json`
  for the 24 h ending 2026-11-05 06:20Z. The store's wall time in the same
  report is 31.7 ms per call, which bounds billed duration from above. These
  are the figures the budget uses (`STATS_OBSERVE_COST_REPORT` in
  `cloudflare/src/observe/core/budget.ts`).
- **Node:** reduce, decide, and count cost a median 1.48 µs per sampled-out
  event and 8.67 µs per kept event (12 interleaved runs of 20,000 events,
  Node v26.12.1), from
  `cd cloudflare && node --experimental-strip-types test/observe/tail-cpu.measure.ts`.
  The platform figure is about 50 times the Node figure for a kept event, so
  most of it is runtime overhead rather than this code.

## Budget

At 29.4M tail events a month, Nanoshop's observation must cost at most $1.10
at list price and write at most 1.0M rows. `project` in
`cloudflare/src/observe/core/budget.ts` prices the figures above, and
`test/observe/budget.test.ts` fails when the shipped policy exceeds the
budget:

```sh
cd cloudflare && node --experimental-strip-types --test test/observe/budget.test.ts
```

The shipped policy keeps 2,000 per million by trace, keeps every invocation
at or above 1 s wall or 50 ms CPU, and flushes counts every five minutes. At
three tail isolates, with 500 failed, 1,000 slow, 45 untraced, and 45
rejected per million assumed, it projects to:

| Line | Monthly |
| --- | --- |
| Rows written | 783k, $0.78 |
| Tail CPU | 12.1M ms, $0.24 |
| Store requests | 133k, $0.02 |
| Store duration | $0.01 |
| Total | $1.05 |

Always-kept events take $0.38 of that before any sampled-in event, and a tail
isolate admits at most 10 of them per five-minute bucket
(`ALWAYS_KEPT_PER_BUCKET`); the rest are counted with their outcome class and
not stored. The worst case is every one of the three isolates hitting the cap
in every bucket all month: 259,200 always-kept events at the failed per-event
cost, plus the shipped sampled-in volume and the assumed rejected share. It
projects to $3.86 and 3.55M rows a month (`alwaysKeptStorm` in `budget.ts`),
and `budget.test.ts` fails above $5.00. The ceiling scales linearly with the
number of tail isolates, so a deploy that fails most requests costs at most
that, not the $19 a month a 5% failure rate projected before the cap. The
1.0M-row budget is not held in the storm: that is the price of detail on every
failure.

## Unverified

- Nanoshop's production batch size. Every per-event figure above assumes one
  event per tail batch, so it is an upper bound on store requests until
  Nanoshop deploys and its health is read.
- Whether tail CPU is billed at sub-millisecond precision. The cost report
  gives whole milliseconds per invocation, and the budget uses the 0.413 ms
  average.
- Tail isolate lifetime. A buffer lost to eviction loses at most one
  five-minute bucket of sampled-out counts, and the tail handler's
  `waitUntil` limit is not documented (STA-51).
- The slow, untraced, and rejected shares, which are assumptions until
  Nanoshop runs under load (STA-50).
