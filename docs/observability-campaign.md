# Observability campaign

Goal: a small, efficient error-tracking and tracing product whose first
customer is stats. It groups exceptions into issues, links each occurrence to
its trace and exact Worker version, and shows the trace as a waterfall, for 7
days. Stats is the customer, not the host: the product's core must not know
about stats, and stats must not pay for the product on its request path.

This plan does not authorize its own execution. Local work and commits are
authorized. Deploying, creating Cloudflare resources, attaching a tail
consumer to the production `stats` Worker, enabling account features, and
deleting data each need a yes first.

## What it has to beat

Cloudflare already gives stats most of this for free, so the prototype earns
its place only by what those features lack.

| Existing | Covers | Lacks |
| --- | --- | --- |
| Workers Issues (open beta) | SDK-free grouping of uncaught exceptions, 5xx, and `console.error` errors, source-mapped | Owned data, a query API, trace links, a stated retention, use outside Cloudflare |
| Workers traces (10% head-sampled) | Handler, fetch, binding, and per-statement SQLite spans | Error grouping, full capture, owned storage |
| Project page analytics | Requests, routes, and CPU for the stats Worker | Per-invocation detail |

The prototype therefore owns its storage and protocol, links issues to traces,
and keeps a core that a future non-Cloudflare producer or server can reuse.
It does not reproduce request counts or CPU charts that the project page
already shows.

## Decisions

| Area | Decision |
| --- | --- |
| Producer | Platform tail events, not an in-process export. Stats changes only its catch sites. |
| Collector | A new `stats-observe` Worker, attached to `stats` as a tail consumer, with no public route |
| Storage | One SQLite-backed `ObservationStore` Durable Object inside `stats-observe` |
| Retention | 7 days, checked on every read; cleanup is alarm-driven |
| Capture | Every tailed `stats` invocation, minus the excluded routes |
| Core | Portable TypeScript with no Cloudflare imports: model, codec, grouping, SQL |
| Fragment encoding | Chosen by the Phase 1 benchmark: STO1 binary or strict JSON |
| UI | The existing stats dashboard, proxied through the stats Access gate |
| Dependencies | None in stats. At most one source-map resolver in `stats-observe`, only if Phase 0 shows it is needed |

The tail design moves all telemetry work after the invocation. Stats does no
encoding and no `waitUntil` export, and needs no service-binding call, context
propagation, or SDK state. The platform supplies what an in-process SDK cannot
measure: per-invocation `cpuTime` and `wallTime` (the Workers clock cannot
time CPU work), the outcome including `exceededCpu` and `canceled`, the
version ID, and the Durable Object ID. Streaming tail events add `traceId`,
`spanId`, and platform spans that the runtime links across Worker and
Durable Object stages.

```text
stats Worker ─┐                      stats-observe Worker
              ├─ tail events ──────▶  tail handler ─▶ core ─▶ ObservationStore DO
Installation ─┘  (after invocation)                                │
                                                          SQLite rows + blobs
Browser ─▶ stats Access gate ─▶ /api/observe/* ─▶ service binding ─┘
```

## Phase 0: tail fidelity spike

The design depends on runtime facts the documentation leaves open. Settle
them before writing product code, locally in workerd first. A staging deploy,
if one is needed, needs a yes.

1. Do local workerd and the vitest pool deliver classic and streaming tail
   events to a consumer configured through `tailConsumers`?
2. Are `Installation` invocations (fetch, RPC, alarm) tailed with
   `durableObjectId`, and do streaming events give the Worker stage and the
   Durable Object stage one `traceId` with correct parent spans?
3. Does a caught error passed to `console.error` arrive with its stack, either
   in `logs[].errorInfo` or `exceptions[]`? Are tail stacks source-mapped when
   maps are uploaded? The docs say uncaught stacks are remapped for Tail
   Workers but `error.stack` inside the Worker is not.
4. Do platform spans include the per-statement SQLite spans that Workers
   traces show, and do they need `observability.traces` sampling to be on?
5. Is `ctx.tracing.enterSpan`, which appears only in the experimental types,
   available at the current compatibility date, and do its spans and
   attributes reach the streaming tail?
6. Does `diagnostics_channel` publish reach `diagnosticsChannelEvents` without
   counting as Workers Logs ingestion? If so, it carries structured app events
   off the logs budget.
7. Which request headers reach tail events? The collector must drop all of
   them; this checks whether anything sensitive arrives at all.
8. What does a tail consumer cost per event: CPU per classic and per streaming
   invocation, and how many events does one stats request produce?

Exit: a short findings section in this doc for each question, with the
command or test that showed the answer, and a classic-or-streaming decision.
If streaming is unavailable or cannot link stages, use classic tail for
issues and per-invocation facts, and take traces from the streaming path
later. If neither delivers stacks for caught errors, the fallback below
replaces the producer side only.

## Phase 1: core

Portable modules under `cloudflare/src/observe/core/`, typechecked by their
own `observe.tsconfig.json` without Workers types and tested with
`node --test` and `node:sqlite`, following the `binary` and `deployments`
pattern. Lint bans `cloudflare:*` imports there.

- **Model:** invocation (trace and span IDs, parent, kind, route template,
  version ID, outcome, cpu and wall ms, timestamps), spans, and exceptions,
  with the limits below as types and one constants module.
- **Fragment encoding:** benchmark strict JSON, tuple JSON, and an STO1
  draft on fragments built from Phase 0's captured tail events. Measure
  encoded bytes, encode and validated decode CPU, and SQLite blob size. Pick
  STO1 only if it is materially smaller or cheaper, and write its byte layout
  and hand-authored fixtures under `fixtures/observe/v1/` before freezing it.
  Whichever wins is decoded with full bounds checks and rejects trailing
  bytes, unknown versions, and bad references.
- **Store:** one `invocations` row per invocation holding indexed summary
  columns and the fragment blob, an `occurrences` row per exception, and an
  `issues` row per fingerprint holding only open or resolved state.
  Deduplicate on `invocationId`, so a replayed event is a no-op and the same
  ID with different bytes is a conflict. Counts, first seen, and last seen
  are computed from unexpired rows, never accumulated.
- **Retention:** `expires_at = min(event time, first receipt) + 7 days`;
  every query filters on `expires_at > now`; reject events already expired
  or more than 5 minutes in the future.
- **Grouping v1:** SHA-256 over a version tag, exception name, and up to 5
  normalized in-app frames (file and function, plus line for the top frame).
  The message is used only when there is no stack. Grouping fixtures cover
  two causes in one function, the same cause at different bundle offsets,
  changing messages, and a missing stack.

Amend the "Why not" section of `docs/TRACING.md` and the non-goals in
`docs/architecture.md` to admit this product, keeping the clock and cost
caveats.

Exit: core tests pass, including replay idempotence, expiry boundaries at 7
days minus 1 ms, at 7 days, and at 7 days plus 1 ms with cleanup not yet run,
and decoder rejection of a truncation at every byte of a small fixture.

## Phase 2: collector and stats wiring

- `stats-observe` Worker: a tail handler converts events to the core model,
  drops excluded routes and all headers, and writes to `ObservationStore` in
  one RPC per tail invocation. The store applies each batch in one
  transaction. Its own config has no tail consumer, no route, no
  `workers.dev`, and no preview URLs.
- Cleanup: the store's alarm deletes expired rows in bounded batches and
  reschedules itself. The existing `*/5` stats cron gains no work; a
  `stats-observe` cron of its own checks that the alarm is set.
- Stats: add `tailConsumers` and a service binding to `stats-observe` in
  `cloudflare.config.ts`. At each catch site that discards an error
  (`installation.ts`, `deployments/installation.ts`, both collectors, and the
  scheduled handler in `index.ts`), report the original error through the
  channel Phase 0 chose. Responses, status codes, and the existing fixed log
  lines stay as they are.
- Exclusions, in one tested policy in the collector: `/health`, static
  assets, `/api/observe/*`, and unauthenticated or unmatched requests.

Exit: in a local workerd test with both Workers, a real stats ingest, a
dashboard read, a scheduled run, and a deliberately failing fixture route
(present only in the test config) each produce the expected stored
invocations. The failure is grouped into one issue linked to its trace.
Polling `/api/observe/*` 100 times stores nothing. Removing or crashing
`stats-observe` leaves every stats response byte-identical.

## Phase 3: dashboard

A Traces and Issues section on `#/project/stats`, using the existing
components, URL state, and WebP goldens. Stats verifies Access, then proxies
fixed GET queries and one same-origin POST (resolve and reopen) to
`stats-observe`.

- Issues: open or resolved, occurrences and last seen within 7 days, version,
  top frame, and links to the occurrences' traces.
- Traces: list filtered by route, version, and outcome; waterfall in plain
  DOM; per-invocation CPU and wall time from the platform; Durable Object
  stages; incomplete and expired states shown as such.
- Health: last received event, rows and live bytes, `databaseSize`, oldest
  unexpired row, and cleanup lag.

Exit: `make dashboard-test` passes with new goldens for desktop and mobile,
and a replay fixture captured from a Phase 2 run.

## Phase 4: source maps (only if Phase 0 says tail stacks are not remapped)

Build private source maps, register them with `stats-observe` through an
Access-gated upload in stats, and resolve frames there with one small pinned
resolver such as `@jridgewell/trace-mapping`, measured for size. A missing
map leaves the frame generated and marked unmapped. Exit: a bundled throwing
fixture resolves to its original file and line, and a wrong map is rejected.

## Phase 5: rollout (owner-run)

Deploy `stats-observe`, then add `tailConsumers` to stats, then compare a day
of stats CPU and wall time against the previous day using the project page.
Rollback removes `tailConsumers` from stats; deleting the namespace is a
separate decision.

## Budgets

The design limits that cost by construction, and measurements confirm it.
The volume figures come from 2026-11-02 readings: about 7k Worker and 3.5k
Durable Object invocations a day, so roughly 10k tail events a day and 70k
live invocations at 7 days.

| Budget | Target | How it is checked |
| --- | --- | --- |
| Stats CPU per request | No change outside catch paths | Project page CPU before and after Phase 5 |
| Stats bundle | Under 1 KiB gzip added | `make worker-bundle` size before and after |
| Rows written per invocation, including index entries and its later delete | 6 or fewer | Store test reading the cursor's `rowsWritten` |
| Stored bytes per successful invocation | Under 1 KiB | Phase 1 benchmark on captured events |
| Collector CPU per tail event | Under 1 ms median | Local benchmark; tail `cpuTime` once deployed |
| `ObservationStore` requests | One per tail invocation | Collector test |
| Live store size at steady state | Flat after 7 simulated days | Fake-clock test running 14 days of the measured volume |

The write and request budgets come to about 1.8M rows written and 300k
Durable Object requests a month, against 50M and 1M included on Workers Paid.

## Limits

| Limit | Value |
| --- | --- |
| Live retention | 7 days |
| Spans per invocation | 128 |
| Exceptions per invocation | 4, with 32 frames and 4 KiB of stack each |
| Exception message | 512 bytes; redacted unless it comes from a known error class |
| Invocations retained | 200,000, oldest successful detail evicted first |
| Issues retained | 1,000 |
| Query page size | 100 |

## Invariants

- Viewing or polling the observability UI stores nothing.
- `stats-observe` has no tail consumer, no public route, and no binding to
  `Installation`.
- Headers, query strings, bodies, tokens, Access assertions, and SQL
  parameters are never stored. A secret-bearing fixture checks packets,
  rows, and API responses.
- No row older than 7 days is readable, whether or not cleanup has run. Live
  retention is not erasure from Durable Object point-in-time recovery, which
  keeps 30 days.
- Missing data is absent or unavailable, never zero; a trace with a missing
  stage is shown as incomplete.

## Fallback: in-process producer

Use this only if Phase 0 shows tail events cannot carry caught errors or
link stages. A dependency-free module in stats records named operations and
caught errors per invocation and exports one fragment through a service
binding in `waitUntil`, with a 2 s deadline, one attempt, a bounded number
of concurrent exports, and no retry. The core, store, and UI are unchanged.

## Non-goals

Sentry or OTLP compatibility, browser instrumentation, log search, profiling,
alert delivery, multi-tenancy, public ingestion, and a non-Cloudflare server.
Instrumenting `stuff`, `usr-memories`, or the agent comes after this
campaign. Request-rate and CPU charts stay on the project page.

## State

Not started. Baseline: `8043bd0`.
