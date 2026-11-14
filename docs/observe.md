# Observability product

`stats-observe` is a small error-tracking and tracing product. It groups
exceptions into issues, links each occurrence to its trace and exact Worker
version, and shows each trace's invocations with their platform CPU and wall
time, for 7 days. `stats` is its first customer, not its host: the core knows
nothing about `stats`, and `stats` pays only one in-process publish per
invocation on its request path. The routing, per-service policies, sampling,
operation summaries, and coverage rule are in
[Architecture](architecture.md#worker) and
[Operations and coverage](architecture.md#operations-and-coverage). This page
holds the design rationale, the data model, the limits, and the invariants.

## What it adds to Cloudflare's own tools

| Existing | Covers | Lacks |
| --- | --- | --- |
| Workers Issues | Grouping of uncaught exceptions, 5xx, and `console.error` errors, source-mapped | Owned data, a query API, trace links, a stated retention, use outside Cloudflare |
| Workers traces (10% head-sampled) | Handler, fetch, binding, and per-statement SQLite spans | Error grouping, full capture, owned storage |
| Project page analytics | Requests, routes, and CPU for a Worker | Per-invocation detail |

So `stats-observe` owns its storage and protocol, links issues to traces, and
keeps a core that a non-Cloudflare producer could reuse. It does not repeat the
request and CPU charts of the project page, and it does not copy per-statement
SQL spans, which stay in Workers traces.

## Design

| Area | Decision |
| --- | --- |
| Producer | Classic tail events. A service publishes one diagnostics-channel `operation` message per invocation, carrying the native trace context, and one error report per caught error. |
| Collector | The `stats-observe` Worker, a tail consumer of every observed service, with no public route |
| Storage | One SQLite-backed `ObservationStore` Durable Object per observed service |
| Retention | 7 days, enforced on every read; an alarm deletes expired rows in bounded batches |
| Capture | Every tailed invocation, minus the excluded routes |
| Core | Portable TypeScript with no Cloudflare imports: model, grouping, SQL. `observe.tsconfig.json` typechecks it without Workers types, and it is tested with `node --test` and `node:sqlite`. |
| UI | The stats dashboard, proxied through the stats Access gate; and the `pnpm observe` CLI |
| Encoding | None. A classic tail item reduces to indexed columns and error rows, so there is no per-invocation payload to encode. |

All telemetry work except the publish happens after the invocation, in another
Worker. The producer does no encoding, no `waitUntil` export, and no
service-binding call, and keeps no SDK state. The platform supplies what an
in-process SDK cannot measure: per-invocation `cpuTime` and `wallTime` (the
Workers clock freezes between I/O, so it cannot time CPU work), the outcome
including `exceededCpu` and `canceled`, the version id, and the Durable Object
id.

```text
stats Worker ─┐                      stats-observe Worker
              ├─ tail events ──────▶  tail handler ─▶ core ─▶ ObservationStore DO
Installation ─┘  (after invocation)
Browser ─▶ stats Access gate ─▶ /api/observe/* ─▶ service binding ─┘
```

### Tail behavior the design depends on

Measured on 2026-11-03 with a throwaway producer and consumer, locally and in
production:

- **Classic tail only.** Production delivers classic tail events. A
  `streaming: true` consumer is accepted at deploy time but never called.
- **Durable Object invocations are delivered.** Fetch, RPC, and alarm each
  arrive as their own item with `durableObjectId`, `entrypoint`, and the RPC
  method or request URL.
- **Stages link only through a published trace id.** Classic events do not
  link stages. Each stage publishes `tracing.getActiveSpan().spanContext()`
  once, and the shared `traceId` links them, even for the 90% of requests that
  traces do not sample. An alarm is its own root.
- **CPU and wall time are real** but whole milliseconds, so most small
  invocations read 0 or 1 ms CPU. Aggregates over many calls resolve finer.
- **Uncaught errors** arrive in `exceptions[]` with a stack the platform
  source-maps. An object's uncaught error also appears on the calling Worker
  with the same name and message and no stack, so the collector attributes it to
  the stage that has the stack and counts it once.
- **Caught errors** reach the collector through `logs[].errorInfo` for
  `console.error(error)` and through the published `{ operation, error }`
  message. Neither stack is source-mapped. A fixed JSON log line carries no
  error.
- **Diagnostics publishes do not reach Workers Logs**, so they stay off the
  shared logs allowance.
- **Header redaction is partial.** Classic events replace `authorization`,
  `cookie`, and `cf-access-jwt-assertion` with `REDACTED` but keep the query
  string, `cf-connecting-ip`, and `x-real-ip`. The collector therefore keeps
  only method, route template, and status, and drops every header, the query
  string, and the full URL before anything else reads the event.
- **A failing consumer changes nothing** for the producer's responses or timing.
- **Rollout order is enforced by the platform.** Deploying a producer whose tail
  consumer does not exist fails with `[10203]`, and deleting a consumer a
  producer still references fails with `[100109]`.

## Data model

- **Invocation.** One `invocations` row per invocation: invocation key, trace
  and span ids when published, kind, entrypoint and RPC method or route
  template, version id, outcome, CPU and wall ms, event time. A trace is the set
  of stored invocations that share a trace id; its root is the stateless one.
  Classic events carry no invocation id, so the key is the published span id,
  or, for an invocation that published none, a hash of script version, Durable
  Object id, entrypoint, and event time. A replayed event is a no-op, and the
  same key with different bytes is a conflict that keeps the first row.
- **Occurrence and issue.** An `occurrences` row per exception, and an
  `issues` row per fingerprint that holds only open or resolved state and when
  it was last resolved. Counts, first seen, and last seen are computed from
  unexpired rows, never accumulated.
- **Grouping.** The fingerprint is SHA-256 over a version tag
  (`GROUPING_VERSION`), the published `operation`, the exception name, and up to
  5 in-app function names. `stats` is unminified, so function names are stable
  across builds and grouping needs no source map. A message, with digits and
  long hex runs normalized, is used only when there is no in-app frame.
- **Application failures.** An application telemetry event whose outcome is
  not `ok` and that carries `error.code` (`docs/integration.md`, section 5)
  adds one occurrence with source `application`, no message and no frames, to
  the issue whose fingerprint is SHA-256 over `GROUPING_VERSION`,
  `application`, the service, the operation, and the code. The event's
  `release` is the occurrence version and its trace id, when present, the
  occurrence trace. The occurrence is written in the same transaction as the
  event, so a duplicate event id adds none. A failure without a code is
  counted in the operation totals and never grouped.
- **Retention.** `expires_at = min(event time, first receipt) + 7 days`. Every
  query filters on `expires_at > now`, so an expired row is unreadable before
  cleanup runs. Events already expired, or more than 5 minutes in the future,
  are rejected with a named reason. Live retention is not erasure from Durable
  Object point-in-time recovery, which keeps 30 days.
- **Versions and rollouts.** A version is the code identity every invocation
  carries. A rollout is an event at a time that sets the traffic mix across
  versions, with a source and a message; a plain deploy is a one-version
  rollout. Rollouts are pushed to `POST /rollouts`, are idempotent on their id,
  and the same id with different content is a conflict. After each successful
  deployment poll for an observed project, `stats` forwards its deployments and
  version tags over the `OBSERVE` binding; a failure is reported as the
  `deployments.forward` operation and never affects the poll. The browser
  proxy accepts only the issue-state POST and the source-map PUT, so rollouts
  cannot be written from the dashboard. Rollouts are kept 30 days plus the
  newest older one as a baseline. Writes from outside a Cloudflare deployment
  decide separately: when a non-Cloudflare producer needs to record its own
  rollouts, extend the service deploy-marker token shape
  (`POST /ingest/services/:name/deployments`) to observed services rather than
  add a new route or a public receiver. Until that producer exists, the
  deployment poll remains the only rollout write path.
- **Rollout impact.**
  - An issue is *new in rollout R* when it has an occurrence on a version R
    introduced, after R, and no retained occurrence on any version active
    before R.
  - It is a *regression in R* when it was resolved before R and recurs on a
    version R introduced.
  - Failure rate is failed over total invocations per version.
  - CPU compares the mean per call with its standard error, plus p50 and p95 CPU
    and wall time, per route and stage. A change is marked only when it exceeds
    twice the combined standard error.
  - An issue first seen on a version is attributed to it; that says where it
    appeared, not that the deploy caused it.
  - For a rollout older than the 7-day observation window the answer is "older
    than retained data", never a guess, and every answer states how much earlier
    data it compared against.
- **Operation profile.** A service message may also carry an optional R2
  account, `r2: { classA, classB }`; messages without it are unchanged. When a
  policy captures operation accounts (`captureOperations`, used by the local
  profile policy), the store writes one `observe_profile` row per stored
  invocation with its operation, stage, CPU and wall ms, outcome, SQLite rows
  read/written and statements, and R2 Class A/B counts. Rows share the
  invocation retention and are bounded to 20,000. `GET /api/observe/<service>/profile?from=<ms>&to=<ms>`
  aggregates them per `(operation, stage)` with exact nearest-rank CPU and wall
  percentiles. Other policies write no profile rows, so their stored shape and
  write cost are unchanged.
- **Source maps.** Caught-error stacks point into the bundle, so frames resolve
  when they are read. A map is stored per version and bundle file and is
  immutable: the same content again is a no-op, different content is a conflict.
  `make worker-deploy` parses the version id from `cf deploy` and registers the
  map from the same build with `pnpm observe sourcemap`, a same-origin PUT
  through the stats Access gate capped at 1.5 MiB. `make observe-sourcemap
  VERSION=...` repeats it. Errors that arrived before their map resolve once it
  is registered. A frame without a map keeps its bundle position and is marked
  unmapped. The newest 12 maps are kept.

## Services

`src/observe/services.ts` lists the observed services. Each has its own
`ObservationStore` named after it, so the core stays single-service and nothing
is shared between their rows. `src/observe/core/policies.ts` holds each
service's route templates and closed set of error operations. `usr-memories`
keeps only its known path segments and replaces every other segment with `:id`,
so object digests and memory ids never become labels. The API and the proxy are
`/api/observe/<service>/*`.

The store sums the backend's billed `rowsWritten` for every ingest and cleanup,
so `observe health` reports rows written per invocation from production. Every
health counter keeps a reason and one example, and a conflict names its key
source (`span` or `fallback`) and the stored columns that differ.

Names outside this list are admitted only by the local stack. Its producer
wrapper sets `OBSERVE_LOCAL_SERVICES` for the collector copy that tails that
producer, and the collector admits those names with the `PROFILE_POLICY` (keep
every invocation, capture its operation account). The deployed
`stats-observe` sets no such variable, so production still drops any other
script name as `unknown-service`. See [Local profiling](profiling.md).

## Command line

`pnpm observe <command>` (`src/observe/client/cli.ts`) is a Cloudflare-agnostic
client over the observe HTTP API. It uses `parseArgs` and `fetch`, has no
dependencies, and fails a command whose response does not validate against
`src/observe/client/decode.ts`.

- **Target and auth.** `--base` or `OBSERVE_URL`, and a header produced by a
  command: `OBSERVE_AUTH_COMMAND` with the required `OBSERVE_AUTH_HEADER`, for
  origins that need one; the tailnet stats origin needs none. Credentials never
  come from argv.
- **Read commands.** `health`, `routes`, `issues`, `issue <fingerprint>`,
  `traces`, `trace <id>` (a text waterfall), and `deployment <rollout id>`.
- **Write commands.** `issue resolve|reopen <fingerprint>` and `sourcemap`, which
  send the base origin as `Origin` so the proxy's same-origin rule applies.
- **Output.** Aligned text, or `--json`. Exit codes: 0 success, 1 usage, 2
  collector unavailable, 3 not found or expired, 4 conflict.

`statsctl observe ...` reads the same API with the `statsctl/1` envelope and its
own exit codes ([Operations](operations.md#measuring-a-deployment-with-statsctl)).
`make observe-sourcemap` depends on the codes above, so they do not change.

## Rollout order

Deploy `stats-observe` first, because a producer cannot reference a consumer
that does not exist. Then deploy the producer with `tailConsumers` and register
its map. To roll back, remove `tailConsumers` from the producer first, because a
referenced consumer cannot be deleted; deleting `stats-observe` and its data is
a separate decision.

## Budgets

| Budget | Target |
| --- | --- |
| Producer CPU per request | One publish per invocation; no other change outside catch paths |
| Producer bundle | Under 1 KiB gzip added to `stats` |
| Rows written per invocation, including index entries and its later delete | 6 or fewer |
| Stored bytes per successful invocation | Under 512 |
| Collector CPU per tail call | Under 1 ms |
| `ObservationStore` requests | One per tail call |
| Live store size at steady state | Flat after 7 days |

At the 2026-11-02 volume of about 10,000 tail calls a day, these come to about
1.8M rows written and 300,000 Durable Object requests a month, against 50M and
1M included on Workers Paid. The measured costs of sampled services are in
[Observation billing facts](observe-billing.md).

## Limits

| Limit | Value |
| --- | --- |
| Live retention | 7 days |
| Invocations per trace shown | 16 |
| Exceptions per invocation | 4, with 32 frames and 4 KiB of stack each |
| Exception message | 512 bytes, stored only for error names the service policy marks safe |
| Invocations retained | 200,000, oldest successful evicted first |
| Occurrences retained | 20,000, oldest evicted first |
| Issues retained | 1,000 |
| Source maps | 12 of at most 1.5 MiB each |
| Query page size | 100 |

The constants are in `src/observe/core/limits.ts`.

## Invariants

- Viewing or polling the observability UI stores nothing.
- `stats-observe` has no tail consumer, no public route, and no binding to
  `Installation`. It never tails itself.
- Headers, query strings, bodies, tokens, Access assertions, client IPs, and SQL
  parameters are never stored. `stats-observe` never logs a raw tail event, its
  Workers logs keep invocation records only, and its traces are off.
- No row older than 7 days is readable, whether or not cleanup has run.
- Missing data is absent or unavailable, never zero. A trace with a missing
  stage is shown as incomplete.
- Removing or crashing `stats-observe` leaves every `stats` response
  byte-identical.

## Non-goals

Sentry or OTLP compatibility, per-statement SQL spans, browser instrumentation,
log search, CPU sampling profilers, alert delivery, tenancy inside one store, public
ingestion, and a non-Cloudflare server. The agent and `stuff` are not
instrumented. Request-rate and CPU charts stay on the project page. Rollouts have
no CI write path, because the stats proxy refuses rollout writes on purpose.
Local per-operation resource profiling is a local-stack tool only
([Local profiling](profiling.md)); it is not a production feature.
