# Performance measurement

## Agent benchmark method

Run on a named Linux host only:

```sh
bench/bench.sh agent/dist/stats-x86_64-unknown-linux-musl 4 15000 .work/tmp/bench-idle.json
```

The agent's `--bench <iterations> <interval_ms>` mode samples without network,
reports collection latency, process user/system CPU, and max RSS, and exits.
`/usr/bin/time -v` records the process RSS ceiling; `perf stat` records cycles,
instructions, context switches, and page faults when available. Record the
kernel, CPU model, filesystem, capabilities, load, and interval with every run.

Compare with Node Exporter only on the same host and interval. Report median and
spread across repeated runs; never mix partial metric sets. Local numbers from a
development macOS host are not evidence. The agent's targets are
aspirations: at most 16 MiB steady RSS and under 0.1% of one logical CPU at 15 s
on an idle representative host.

## Recorded 2026-10-31

Host `oracle-free`: Ubuntu 24.04.4 LTS, kernel 6.17.0-1007-oracle, x86_64,
AMD EPYC 7551 (2 vCPU), ext4, about 1 GiB RAM, load 0.00-0.07 during the runs.
The telemetry service was stopped and the two tools ran interleaved: five runs
of four samples at 15 s, plus one agent run under `/usr/bin/time -v` and
`perf stat`. Node Exporter 1.12.1 used its default collectors, scraped four
times per run. Median [minimum-maximum]:

| Metric | Agent | Node Exporter |
| --- | --- | --- |
| CPU per sample | 0.93 ms [0.89-1.15] | 22.5 ms [15.0-32.5] |
| CPU over the run | 0.0082% [0.0079-0.0102] | 0.199% [0.133-0.288] |
| Max RSS | 1.70 MiB | 20.45 MiB [20.38-20.58] |

The agent's collection latency median was 0.92 ms [0.87-1.05]. The separate
perf run recorded 136.5 ms task-clock, 10,001,322 cycles, 6,011,430
instructions, 5 context switches, and 51 page faults over 45.14 s; `/usr/bin/time`
reported 1,124 KiB maximum RSS for that run. The event set did not include
syscalls, and the collection-only benchmark did not measure bytes sent. The
agent met both targets on this
host. Node Exporter's default collectors expose a broader metric set than the
agent's fixed groups, so this is a same-host, same-interval cost comparison,
not a like-for-like metric-set comparison. `threadripper` was not used because
its load average was above 5.5 on 32 CPUs; no performance claim is made for it.

## Dashboard load

```sh
make dashboard-bench
make dashboard-bench BENCH_ARGS="--runs 9 --cpu 4 --latency 100"
```

The target builds the client, starts the local preview, and loads the fleet,
host, and project pages in Chromium under an emulated 1.6 Mbps / 150 ms link.
It reports medians for first paint, largest paint, content-ready, JS heap, DOM
nodes, listeners, and transferred bytes. `--runs`, `--latency`, `--down`, and
`--cpu` change the workload.

The preview serves captured fixtures without the production cache headers or
the Worker's compression, so compare runs of the same build. The Worker serves
hashed `/assets/*` with `private, max-age=31536000, immutable`; a reload after
the first visit should transfer no bundle bytes.

## Ingest protocol

```sh
make ingest-bench
```

`bench/ingest.sh` prints request and acknowledgment bytes for the fixture
workloads (`bench/ingest-bytes.mjs`), the agent's encoder time and
allocations (`agent/examples/ingest_bench.rs`, release), the Worker's
complete decode-to-stored-string work (`bench/ingest-decode.ts`), and
end-to-end ingest through the Worker and Durable Object in local workerd.
Method, results, and limits are in [`docs/binary-ingest.md`](../docs/binary-ingest.md).

## Ingest CPU

```sh
node --experimental-strip-types cloudflare/bench/ingest-cpu.ts
```

`cloudflare/bench/ingest-cpu.ts` sends two-sample `linux-normal` batches (200
warmup, then 2,000) through the real `InstallationCore` ingest on node:sqlite,
advancing the clock per batch, and reports CPU milliseconds per batch at p50,
p90, and p99. node:sqlite commits to a file synchronously, which Durable
Objects do not, so compare runs of this script with each other, not with
production CPU.

## Collection and project history

```sh
node --experimental-strip-types cloudflare/bench/collection.ts [small|production|heavy]...
node --experimental-strip-types cloudflare/bench/capture-collection.ts
```

`cloudflare/bench/collection.ts` runs the real collector and project store
in-process against node:sqlite. It replays one production collection
(`cloudflare/bench/fixtures/collection.json`, every analytics response for
the five production projects) and first seeds a week of history by replaying
the same window shifted back in 90-minute steps. It reports CPU
milliseconds for one collection into a new window, for a repeated collection
that changes nothing, and for the dashboard's project history read at 1h,
24h, and 7d. The tiers are `small` (the `stats` project), `production`
(all five), and `heavy` (ten copies of the five under new ids). The heavy
tier is where per-project work that grows with the project count shows up.

`capture-collection.ts` refreshes the fixture with `cf`. It replaces every
route path segment and D1 statement with a stable pseudonym of the same
shape, so route folding behaves as it does on the real labels and nothing
private reaches the public repository. Version segments such as `v1` stay
verbatim.

## Durable Object rows per ingest

```sh
pnpm --dir cloudflare run bench:workerd ingest-rows
```

`cloudflare/bench/ingest-rows.workerd.ts` ingests fixture batches into the
`Installation` object in local workerd and prints `writtenPerSample`, the
SQLite rows written per persisted sample from cursor totals. The count is
deterministic; it read 7.762 at `c85450f` and 7.254 at `1baf925`, once hourly rollups were deferred.

## Producer queue bound

```sh
node --experimental-strip-types bench/producer-queue.ts 1024
node --experimental-strip-types bench/producer-queue.ts 256
```

The first count is the pre-O1 default; the second is the current cap. The
script constructs the largest valid event (16 work keys, maximum label and id
lengths) and multiplies its encoded size by the queue count. The queue stores
parsed events, so this is the protocol-side bound, not a heap measurement.

Recorded 2026-11-06: one event is 1,512 bytes. 1,024 events is 1.477 MiB,
above the 1 MiB budget; 256 events is 0.369 MiB. Both producers cap the queue
at 256.

## Local stack counts

```sh
make bench-local
```

`cloudflare/bench/local.ts` runs two fixed workloads against the local stack
and prints one JSON object per workload. Every value is a count, so two runs
on the same revision print the same numbers and the host-load rules for timing
do not apply. Each object names its `revision`, whether the tree was `dirty`,
and the `miniflare` and `workerd` versions.

- `ingest` sends 40 warm-up batches and then 1,500 two-sample `linux-normal`
  batches to the `Installation` object, advancing its clock per batch the way
  the Durable Object rows bench does. `writtenPerSample` matches that bench:
  7.254.
- `collection` runs one S1 collection of the production registry through the
  offline `ANALYTICS_SQL` provider.

Each object's `provenance` maps every field to where its number comes from:

| Provenance | Meaning | Fields |
| --- | --- | --- |
| `local-measured` | Counted by the real code in local workerd: cursor totals, operation work, observe store writes, and file sizes on disk | rows read and written, statements, `metricRows`, `upstreamQueries`, response bytes, database growth, observation rows per invocation |
| `fixture-replay` | Fixed by the replayed fixture input | ingest `invocations`, `requestBytes` |
| `modeled` | Produced by the scenario model, not by Cloudflare | `analyticsRowsReturned` |

Database growth counts the Installation's SQLite file and its WAL, which
local workerd does not checkpoint, so it is not the size Cloudflare bills.
Nothing here measures CPU time. `cloudflare/test/local/bench.test.ts` checks
that two runs agree and that one planted SQL statement per ingest raises
`statements` by one per batch.

## Review work counts, 2026-11-12

These local probes exercised source revision `4f111c4` under Linux and Node
24.22.1, not the release pin of 26.13.1. They count repeated work and response
bytes; they do not measure production latency, throughput, billed rows or
savings. Findings and acceptance conditions are in [TODO](../TODO.md).

| Path | Input and observation | Ticket |
| --- | --- | --- |
| Producer batch selection | 64 valid events, public TypeScript `flush()` and an acknowledging fake transport: 65 batch serializations visit 2,144 event representations, including the final 64-event send; no drops | STA-117 |
| Project overview deployment history | Real SQLite-backed API and production decoder: 3 deployments/6 versions return 1,113 bytes; 1,000/2,000 return 344,983 bytes, with the same latest ID, time and title | STA-118 |
| Rollout timing distributions | Real `rolloutImpact` with synthetic grouped SQL rows: 100 distinct timing values cause 11,577 array-iterator steps; 1,000 cause 1,015,707, including helper iterations | STA-119 |
| External-event retention | 10,000 retained, unexpired events through real `cleanup`/`nextCleanupAt`: no deletions, correct next alarm, but the expiry count and nested minimum both scan retained rows | STA-120 |
| Cost ledger | Retained `stuff` 30-day capture, 406 route series and 720 rows: `buildLedger` makes 1,625 route `names()` calls and 166,866 route `cells()` calls | STA-121 |
| Full cost report | Same capture through `buildCostReport`, including plan-month histories: 4,264 route `names()` calls enumerate 1,731,184 names; 169,708 route `cells()` calls | STA-121 |
| Known deployment versions | Real `knownDeploymentVersions` with 2,000 stored versions parses 2,000 payloads to return IDs already present in a SQL column | STA-86 |

Reproduce the cost counters by loading `worker-30d.json`, `routes-30d.json` and
`r2-30d.json` from `cloudflare/test/ui/captures/stuff/` into `Table.from` using
the `tableView` helper in `cloudflare/test/support/history.ts`. Use the captured
Worker bounds as the current window, no previous histories, and those same
histories as the settled plan-month input. Count `Table.names()` calls and the
length of each returned list, and `Table.cells()` calls, separately by history
kind. Assert the captured 68,424 Worker requests and monthly projection
0.20705114667; these are fixture expectations, not a current account bill.
`planBill` alone makes only two Worker and three R2 cell lookups in this case.
Keep the cost parity and partial-coverage assertions when testing a cache.

For the deployment payload probe, use `openHarness` from
`cloudflare/test/node/support.ts`, seed the actual deployment/version tables
with fixed valid UUIDs and decreasing timestamps, and call
`GET /projects/demo/deployments` through `InstallationCore.fetch`. Each
deployment has one 100% version and null message; each version has a `tag-N`
label and null message. Decode with `decodeDeploymentHistory` and assert the
newest marker before counting UTF-8 response bytes.

For retention, seed valid external events within the seven-day window, call
the real store methods, and inspect `EXPLAIN QUERY PLAN` for their exact SQL.
The `(service, event_at)` index does not bound the global expiry count or
`MIN(MIN(received_at, event_at))`. Replaying those statements on the same schema
with Python SQLite at 10,000 and 100,000 rows produced approximately
50,000/500,000 VM steps for the count and 70,000/700,000 for the minimum
(progress callback every 100 steps). Those are SQLite instruction counts,
not Cloudflare row billing. Include index write/storage overhead when choosing
an alternative.
