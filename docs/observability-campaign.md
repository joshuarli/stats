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
| Producer | Streaming tail events, not an in-process export. Stats changes only its catch sites, which publish the original error on a diagnostics channel. |
| Collector | A new `stats-observe` Worker, attached to `stats` as a tail consumer, with no public route |
| Storage | One SQLite-backed `ObservationStore` Durable Object inside `stats-observe` |
| Retention | 7 days, checked on every read; cleanup is alarm-driven |
| Capture | Every tailed `stats` invocation, minus the excluded routes |
| Core | Portable TypeScript with no Cloudflare imports: model, codec, grouping, SQL |
| Fragment encoding | Chosen by the Phase 1 benchmark: STO1 binary or strict JSON |
| UI | The existing stats dashboard, proxied through the stats Access gate |
| Dependencies | None in stats. At most one source-map resolver in `stats-observe`, only if production stacks are not remapped |

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

Run locally on 2026-11-03 against workerd 1.20261023.1 (Miniflare
5.20261023.3-beta), compatibility date 2026-10-30 with `nodejs_compat`. The
harness was a throwaway pair of Workers, a producer with a SQLite Durable
Object and a consumer with `tail` and `tailStream` handlers, sending
requests with fake secrets in the query string, `authorization`, `cookie`,
and `cf-access-jwt-assertion`. Phase 2 turns each fact the design relies on
into a test against the real collector.

Decision: streaming tail. It is the only path that links stages into one
trace and carries SQL spans; it also carries every exception and log the
classic path does.

| Question | Local answer |
| --- | --- |
| Tails delivered locally? | Yes, classic and streaming, to one consumer. |
| Durable Object invocations? | Yes: fetch, RPC, and alarm, each with `durableObjectId` and `entrypoint`. One Worker request that calls the object by fetch and by RPC yields three invocations. |
| Stages linked? | Streaming only. All three share one `traceId`, and each object onset's parent is the caller's `fetch` or `jsRpcCall` span. Classic events have no trace identity. An alarm is its own root, unlinked from the request that set it. |
| Caught errors? | `console.error(error)` yields `errorInfo` with name, message, and frames in both paths, from the Worker, the object, and `scheduled`. A fixed JSON log line yields no `errorInfo`. |
| Uncaught errors? | `exceptions[]` with stack. An object's uncaught error also appears on the calling Worker, with the same name and message and no stack, so the collector attributes it to the stage that has the stack and counts it once. |
| SQL spans? | One `durable_object_storage_exec` span per statement with `db.query.text`, the binding count, `rows_read`, and `rows_written`. Bound values never appear. |
| `ctx.tracing.enterSpan`? | Available with no extra flag; its span, parent, and attributes reach the stream. |
| Diagnostics channel? | `diagnosticsChannelEvents` in both paths. A published `Error` arrives with name, message, and stack. |
| Headers? | Classic replaces `authorization`, `cookie`, and `cf-access-jwt-assertion` with `REDACTED`. **Streaming onsets carry them in plaintext**, with TLS handshake secrets and client geolocation in `cfJson`. Both keep the query string. |
| Consumer failure? | A consumer that throws or sleeps 3 s leaves producer responses and timing unchanged. |
| Event volume | Three stream events per SQL statement (open, attributes, close) plus about five per invocation. The `/ok` request produced 39 events across its three invocations. |

Not answerable locally, because `cpuTime` and `wallTime` read 0 and nothing
is sampled or source-mapped. These need one staging Worker with a streaming
tail consumer, which needs a yes:

1. Do streaming tail spans follow `observability.traces.headSamplingRate`
   (0.1 on stats)? If they do, full capture means raising the rate, and
   from 2026-12-01 traces count against the account's shared ingestion
   allowance.
2. Are streaming onset headers unredacted in production too?
3. Are stacks in `exceptions[]` and `errorInfo` source-mapped when maps are
   uploaded? This decides Phase 4.
4. Do diagnostics channel events count as Workers Logs ingestion?
5. What do `cpuTime` and `wallTime` report, and what does the consumer cost
   per stats invocation?
6. Does deploying stats with a tail consumer that does not exist fail, which
   fixes the rollout order?

## Phase 1: core

Portable modules under `cloudflare/src/observe/core/`, typechecked by their
own `observe.tsconfig.json` without Workers types and tested with
`node --test` and `node:sqlite`, following the `binary` and `deployments`
pattern. Lint bans `cloudflare:*` imports there.

- **Model:** invocation (trace and span IDs, parent, kind, route template,
  version ID, outcome, cpu and wall ms, timestamps), spans, and exceptions,
  with the limits below as types and one constants module.
- **Fragment encoding:** benchmark strict JSON, tuple JSON, and an STO1
  draft on fragments reduced from streaming events of the real stats Worker,
  captured in a local run and redacted. Measure
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
- Stats: add a streaming entry to `tailConsumers` and a service binding to
  `stats-observe` in `cloudflare.config.ts`. At each catch site that discards
  an error (`installation.ts`, `deployments/installation.ts`, both
  collectors, and the scheduled handler in `index.ts`), publish
  `{ operation, error }` on one diagnostics channel, where `operation` comes
  from a closed set and doubles as the explicit grouping code. Responses,
  status codes, and the existing fixed log lines stay as they are. Named
  application spans use `ctx.tracing.enterSpan` only where a platform span
  is missing, such as history construction.
- Reduction: the collector turns a stream into one fragment, keeping span
  names, parentage, outcomes, SQL text and row counts, and exceptions. It
  keeps the method, route template, and status from the onset and drops
  headers, `cfJson`, the query string, and `url.full`.
- Exclusions, in one tested policy in the collector: `/health`, static
  assets, `/api/observe/*`, and unauthenticated or unmatched requests.

Exit: in a local workerd test with both Workers, a real stats ingest, a
dashboard read, a scheduled run, and a deliberately failing fixture route
(present only in the test config) each produce the expected stored
invocations. The failure is grouped into one issue linked to its trace.
Polling `/api/observe/*` 100 times stores nothing. A request carrying fake secrets in every header and the query string leaves none of them in any row, blob, or API response. Removing or crashing
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

## Phase 4: source maps (only if production tail stacks are not remapped)

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
  parameters are never stored. Streaming tail events hand `stats-observe`
  host tokens and Access assertions in plaintext, so it never logs a raw
  event, runs with its own Workers logs off, and reduces each event before
  it reaches the store.
- No row older than 7 days is readable, whether or not cleanup has run. Live
  retention is not erasure from Durable Object point-in-time recovery, which
  keeps 30 days.
- Missing data is absent or unavailable, never zero; a trace with a missing
  stage is shown as incomplete.

## Fallback: in-process producer

Locally, tail events carry caught errors and link stages, so this is held
back for one case: production streaming spans follow head sampling and full
trace sampling costs more than this. A dependency-free module in stats records named operations and
caught errors per invocation and exports one fragment through a service
binding in `waitUntil`, with a 2 s deadline, one attempt, a bounded number
of concurrent exports, and no retry. The core, store, and UI are unchanged.

## Non-goals

Sentry or OTLP compatibility, browser instrumentation, log search, profiling,
alert delivery, multi-tenancy, public ingestion, and a non-Cloudflare server.
Instrumenting `stuff`, `usr-memories`, or the agent comes after this
campaign. Request-rate and CPU charts stay on the project page.

## State

Baseline: `8043bd0`. Phase 0 is done locally; the six production questions
wait on a yes for a staging Worker. Phase 1 needs none of them and can
start.
