# Observability campaign

Goal: a small, efficient error-tracking and tracing product whose first
customer is stats. It groups exceptions into issues, links each occurrence to
its trace and exact Worker version, and shows each trace's invocations with
their real CPU and wall time, for 7 days. Stats is the customer, not the
host: the product's core must not know about stats, and stats must not pay
for the product on its request path beyond one in-process publish per
invocation.

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
already shows, and it does not copy per-statement SQL spans, which stay in
Workers traces.

## Decisions

| Area | Decision |
| --- | --- |
| Producer | Classic tail events. Stats publishes one diagnostics event per invocation carrying the native trace context, and one per caught error. |
| Collector | A new `stats-observe` Worker, attached to `stats` as a tail consumer, with no public route |
| Storage | One SQLite-backed `ObservationStore` Durable Object inside `stats-observe` |
| Retention | 7 days, checked on every read; cleanup is alarm-driven |
| Capture | Every tailed `stats` invocation, minus the excluded routes |
| Core | Portable TypeScript with no Cloudflare imports: model, codec, grouping, SQL |
| Encoding | None. A classic tail item reduces to indexed columns and error rows, so there is no per-invocation blob to encode |
| UI | The existing stats dashboard, proxied through the stats Access gate |
| Dependencies | None in stats. One source-map resolver in `stats-observe`, in Phase 4 |

All telemetry work except the publishes happens after the invocation, in
another Worker. Stats does no encoding, no `waitUntil` export, and no
service-binding call, and keeps no SDK state. The platform supplies what an
in-process SDK cannot measure: per-invocation `cpuTime` and `wallTime` (the
Workers clock cannot time CPU work), the outcome including `exceededCpu` and
`canceled`, the version ID, and the Durable Object ID.

```text
stats Worker ─┐                      stats-observe Worker
              ├─ tail events ──────▶  tail handler ─▶ core ─▶ ObservationStore DO
Installation ─┘  (after invocation)                                │
                                                          SQLite rows + blobs
Browser ─▶ stats Access gate ─▶ /api/observe/* ─▶ service binding ─┘
```

## Phase 0: tail fidelity spike (done)

Run on 2026-11-03 with a throwaway producer (a Worker and a SQLite Durable
Object) and consumer, first locally on workerd 1.20261023.1 (Miniflare
5.20261023.3-beta), then deployed as `observe-probe-producer` and
`observe-probe-consumer`, both since deleted. Compatibility date
2026-10-30 with `nodejs_compat`. Requests carried fake secrets in the query
string, `authorization`, `cookie`, and `cf-access-jwt-assertion`. Phase 2
turns each fact the design relies on into a test against the real collector.

Decision: classic tail, plus a per-invocation diagnostics publish for trace
linkage. Streaming tail would carry spans and linkage itself, but production
does not deliver it.

| Question | Answer |
| --- | --- |
| Streaming tail in production? | No. `cf deploy` accepted a `streaming: true` consumer, but the deployed Worker lists only the classic one and `tailStream` was never called. Locally it works. |
| Durable Object invocations? | Yes: fetch, RPC, and alarm, each with `durableObjectId`, `entrypoint`, and the RPC method or request URL. A Worker request that calls the object by fetch and by RPC yields three invocations, delivered as three tail calls of one item each. |
| Stages linked? | Not by classic events. In production, `tracing.getActiveSpan().spanContext()` from `cloudflare:workers` returned a `traceId` shared by the Worker and both object stages in all 20 requests tried, although traces sample only 10%. Each stage publishing it once links the trace. An alarm is its own root. |
| CPU and wall time? | Real in production, in whole milliseconds. Most probe invocations read 0 or 1 ms CPU. Locally both read 0. |
| Uncaught errors? | `exceptions[]` with a stack that production source-maps to the original file and line, though remapped function names are shifted by a frame. An object's uncaught error also appears on the calling Worker, with the same name and message and no stack, so the collector attributes it to the stage that has the stack and counts it once. |
| Caught errors? | `console.error(error)` yields `logs[].errorInfo`, and publishing `{ operation, error }` yields a diagnostics event, each with name, message, and stack. Neither stack is source-mapped. A fixed JSON log line carries no error. |
| Diagnostics channel and Workers Logs? | The 60 stage publishes did not appear in Workers Logs; caught `console.error` stacks did. Publishes therefore stay off the shared logs allowance (checked against the newest 200 log events). |
| Headers? | Classic replaces `authorization`, `cookie`, and `cf-access-jwt-assertion` with `REDACTED` but keeps the query string, `cf-connecting-ip`, and `x-real-ip`. Locally, streaming onsets carried all of them in plaintext. |
| Custom spans? | `ctx.tracing.enterSpan` works in production but only feeds Workers traces, which are sampled. |
| Consumer failure? | A consumer that throws or sleeps 3 s leaves producer responses and timing unchanged (local). |
| Consumer cost | 60 tail invocations used 5 ms of CPU in total, about 0.08 ms each, plus 60 RPCs to the sink object. Tail Workers bill CPU, not requests. |
| Rollout order | Deploying a producer whose tail consumer does not exist fails with `[10203]`. Deleting a consumer that a producer still references fails with `[100109]`. |

The stats build is unminified and already emits `index.js.map`, so caught
stacks keep their real function names and only their positions point into
the bundle.

## Phase 1: core

Portable modules under `cloudflare/src/observe/core/`, typechecked by their
own `observe.tsconfig.json` without Workers types and tested with
`node --test` and `node:sqlite`, following the `binary` and `deployments`
pattern. That typecheck has no Workers types, so a `cloudflare:*` import or a Workers global fails it.

- **Model:** an invocation (invocation key, trace and span IDs when
  published, kind, entrypoint and RPC method or route template, version ID,
  outcome, CPU and wall ms, event time) and its exceptions, with the limits
  below as types and one constants module. A trace is the set of stored
  invocations sharing a trace ID; its root is the stateless invocation.
- **Store:** one `invocations` row per invocation holding its summary
  columns, an `occurrences` row per exception, and an
  `issues` row per fingerprint holding only open or resolved state. Classic
  events have no invocation ID, so the key is the published span ID, which
  is unique per invocation, or for an invocation that published none, a hash
  of script version, Durable Object ID, entrypoint, and event time. A
  replayed event is a no-op and the same key with different bytes is a
  conflict. Counts, first seen, and last seen are computed from unexpired
  rows, never accumulated.
- **Retention:** `expires_at = min(event time, first receipt) + 7 days`;
  every query filters on `expires_at > now`; reject events already expired
  or more than 5 minutes in the future.
- **Grouping v1:** SHA-256 over a version tag, the published `operation`
  when present, the exception name, and up to 5 in-app function names. Stats
  is unminified, so names are stable across builds and no source map is
  needed to group. The message is used only when there is no stack.
  Grouping fixtures cover two causes in one operation, the same cause at
  different bundle positions, changing messages, and a missing stack.

Amend the "Why not" section of `docs/TRACING.md` and the non-goals in
`docs/architecture.md` to admit this product, keeping the clock and cost
caveats.

Exit: core tests pass, including replay idempotence, expiry boundaries at 7
days minus 1 ms, at 7 days, and at 7 days plus 1 ms with cleanup not yet run,
rejection of malformed collector input with a named reason, and a 14-day
steady state at the measured volume.

## Phase 2: collector and stats wiring

- `stats-observe` Worker: a `tail` handler converts each item to the core
  model, drops excluded routes, and writes to `ObservationStore` in one RPC
  per tail call. The store applies each batch in one transaction. Its own
  config has no tail consumer, no route, no `workers.dev`, and no preview
  URLs.
- Cleanup: the store's alarm deletes expired rows in bounded batches and
  reschedules itself. The existing `*/5` stats cron gains no work; a
  `stats-observe` cron of its own checks that the alarm is set.
- Stats: add `tailConsumers` and a service binding to `stats-observe` in
  `cloudflare.config.ts`. One function publishes the active span context on
  a diagnostics channel at the start of each Worker `fetch` and `scheduled`
  and each `Installation` fetch, RPC, and alarm entry; it runs once per
  invocation and is the only code on the request path. At each catch site
  that discards an error (`installation.ts`, `deployments/installation.ts`,
  both collectors, and the scheduled handler in `index.ts`), publish
  `{ operation, error }` on the same channel, where `operation` comes from a
  closed set. Responses, status codes, and the existing fixed log lines stay
  as they are.
- Reduction: the collector keeps method, route template, and status, and
  drops every header, the query string, and the full URL before anything
  else touches the event.
- Exclusions, in one tested policy in the collector: `/health`, static
  assets, `/api/observe/*`, and unauthenticated or unmatched requests.

Exit: in a local workerd test with both Workers, a real stats ingest, a
dashboard read, a scheduled run, and a deliberately failing fixture route
(present only in the test config) each produce the expected stored
invocations, linked by trace ID. The failure is grouped into one issue linked
to its trace. Polling `/api/observe/*` 100 times stores nothing. A request
carrying fake secrets in every header and the query string leaves none of
them in any row, blob, or API response. Removing or crashing `stats-observe`
leaves every stats response byte-identical.

## Phase 3: dashboard

A Traces and Issues section on `#/project/stats`, using the existing
components, URL state, and WebP goldens. Stats verifies Access, then proxies
fixed GET queries and one same-origin POST (resolve and reopen) to
`stats-observe`.

- Issues: open or resolved, occurrences and last seen within 7 days, version,
  top frame, and links to the occurrences' traces.
- Traces: list filtered by route, version, and outcome; each trace shows its
  invocations in time order with platform CPU and wall time, outcome, and
  errors. A trace whose root is missing, or an invocation that published no
  trace context, is shown as incomplete.
- Health: last received event, rows and live bytes, `databaseSize`, oldest
  unexpired row, and cleanup lag.

Exit: `make dashboard-test` passes with new goldens for desktop and mobile,
and a replay fixture captured from a Phase 2 run.

## Phase 3b: versions and rollouts

Goal: show whether a deployment brought new issue groups, regressions, or a
higher failure rate, without Cloudflare concepts in the core.

- **Version:** the code identity every invocation and occurrence already
  carries, a bounded token rather than a Cloudflare UUID, with an optional
  label (a tag or commit) and message.
- **Rollout:** an event at a time that sets the traffic mix across
  versions, `[{ version, percent }]`, with a source and a message. A plain
  deploy is a one-version rollout. Rollouts are pushed to the receiver's
  `POST /rollouts` and are idempotent on their id; the same id with
  different content is a conflict.
- **New in rollout R:** an issue with an occurrence on a version R
  introduced, after R, and no retained occurrence on any version active
  before R. An issue that also appears on an earlier version is carried
  over, not new.
- **Regression in R:** an issue resolved before R that recurs on a version
  R introduced. Issues record when they were last resolved for this.
- **Failure rate:** failed invocations over invocations, per version, from
  the stored invocations.
- **Retention:** rollouts are kept 30 days, matching deployment history,
  plus the newest older one as the baseline. For a rollout older than the
  7-day observation window the answer is "older than retained data", never
  a guess, and every answer states how much earlier data it compared
  against.
- **Attribution only:** an issue first seen on a version is attributed to
  it; that says where it appeared, not that the deploy caused it.

The Cloudflare adapter is the existing deployment poll. After a successful
poll for the observed project, stats forwards its deployments and version
tags to `stats-observe` over the `OBSERVE` binding; a failure is reported as
the `deployments.forward` operation and never affects the poll. The browser
proxy accepts only the issue-state POST, so rollouts cannot be written from
the dashboard.

The UI adds, for the selected deployment in the Deployments card, its new
issue groups, regressions, and failure rate before and after, linking to
the issues, and gives each issue an "introduced in" version with a filter.

Exit: core tests for idempotent rollouts, new versus carried-over issues,
regressions, split rollouts, expired rollouts, and retention; a two-Worker
test where a polled deployment reaches the store and its impact is read
back; and UI tests for the impact line, badge, and filter.

## Phase 3c: command-line client

A Cloudflare-agnostic CLI over the observe HTTP API, for terminals and
agents now and as the reference producer for non-Cloudflare services later.

- **Shape:** one TypeScript entry, `cloudflare/src/observe/client/cli.ts`, run as
  `pnpm observe <command>` with Node's built-in `parseArgs` and `fetch` and
  no dependencies. It reuses `src/observe/decode.ts`, so a response that
  fails validation fails the command.
- **Target and auth:** `--base` or `OBSERVE_URL`, and a header produced by
  a command, `OBSERVE_AUTH_COMMAND` with the required `OBSERVE_AUTH_HEADER`
  (for stats, `cf access token <host>` into `cf-access-token`); the CLI
  assumes no provider. Credentials never come
  from argv, matching the repo's token rule.
- **Read commands:** `health`; `routes [--window]`; `issues [--state] [--introduced-in]`;
  `issue <fingerprint>` with its stack and occurrences; `traces [--failed]
  [--route] [--slowest] [--window]`; `trace <id>` as a text waterfall with one row per invocation
  and a proportional bar; `deployment <rollout id>` for new issues,
  regressions, and failure rates.
- **Write commands:** `issue resolve|reopen <fingerprint>`, sending the
  base origin as `Origin` so the stats proxy's same-origin rule applies.
- **Output:** aligned text by default and `--json` for scripts; exit 0 on
  success, 1 on usage errors, 2 when the collector is unavailable, 3 when
  the item is not found or expired.
- **Not in the first cut:** `rollout record` from CI. The stats proxy
  refuses rollout POSTs on purpose, so a CI write path needs its own
  authenticated surface (an Access service token on a separate route, or a
  write token on a future public receiver). That is an owner decision.
  Source-map upload follows Phase 4.
- **Tests:** commands against a local Node HTTP server serving recorded
  responses, including malformed and 503 cases and the exit codes.

## Phase 4: source maps

Caught-error stacks point into the bundle, so issue pages need maps to show
original files and lines. At deploy, register the bundle's map with
`stats-observe` under the new version ID through an Access-gated upload in
stats, and resolve frames there with one small pinned resolver such as
`@jridgewell/trace-mapping`, measured for size. Uncaught stacks arrive
already mapped and are stored as they are. A missing map leaves the frame
generated and marked unmapped; grouping does not depend on it. Exit: a
bundled throwing fixture resolves to its original file and line, and a map
registered under the wrong version is rejected.

## Phase 5: rollout (owner-run)

Deploy `stats-observe` first, because stats cannot reference a consumer that
does not exist. Then deploy stats with `tailConsumers`, register its map, and
compare a day of stats CPU and wall time against the previous day on the
project page. Rollback removes `tailConsumers` from stats first, because a
referenced consumer cannot be deleted; deleting `stats-observe` and its data
is a separate decision.

## Budgets

The design limits that cost by construction, and measurements confirm it.
The volume figures come from 2026-11-02 readings: about 7k Worker and 3.5k
Durable Object invocations a day, so roughly 10k tail calls a day and 70k
live invocations at 7 days.

| Budget | Target | How it is checked |
| --- | --- | --- |
| Stats CPU per request | One publish per invocation; no other change outside catch paths | Project page CPU before and after Phase 5 |
| Stats bundle | Under 1 KiB gzip added | `make worker-bundle` size before and after |
| Rows written per invocation, including index entries and its later delete | 6 or fewer | Store test reading the cursor's `rowsWritten` |
| Stored bytes per successful invocation | Under 512 bytes; 351 measured with both index entries | 70k synthetic rows in `node:sqlite` |
| Collector CPU per tail call | Under 1 ms; the probe measured about 0.08 ms | Tail `cpuTime` once deployed |
| `ObservationStore` requests | One per tail call | Collector test |
| Live store size at steady state | Flat after 7 simulated days | Fake-clock test running 14 days of the measured volume |

The write and request budgets come to about 1.8M rows written and 300k
Durable Object requests a month, against 50M and 1M included on Workers Paid.

## Limits

| Limit | Value |
| --- | --- |
| Live retention | 7 days |
| Invocations per trace shown | 16 |
| Exceptions per invocation | 4, with 32 frames and 4 KiB of stack each |
| Exception message | 512 bytes; redacted unless it comes from a known error class |
| Invocations retained | 200,000, oldest successful evicted first |
| Occurrences retained | 20,000, oldest evicted first |
| Issues retained | 1,000 |
| Query page size | 100 |

## Invariants

- Viewing or polling the observability UI stores nothing.
- `stats-observe` has no tail consumer, no public route, and no binding to
  `Installation`.
- Headers, query strings, bodies, tokens, Access assertions, client IPs, and
  SQL parameters are never stored. `stats-observe` never logs a raw tail
  event; its Workers logs keep invocation records only, so its own CPU can
  be measured, and its traces are off.
- No row older than 7 days is readable, whether or not cleanup has run. Live
  retention is not erasure from Durable Object point-in-time recovery, which
  keeps 30 days.
- Missing data is absent or unavailable, never zero; a trace with a missing
  stage is shown as incomplete.

## Non-goals

Sentry or OTLP compatibility, per-statement SQL spans, browser
instrumentation, log search, profiling, alert delivery, multi-tenancy,
public ingestion, and a non-Cloudflare server. Instrumenting `stuff`,
`usr-memories`, or the agent comes after this campaign. Request-rate and CPU
charts stay on the project page.

## State

Baseline: `8043bd0`. Phases 0, 1, 2, and 3b are done and deployed (3b as
`daf404d3` and `a9204e03` on 2026-11-04). Phase 3c is built as `pnpm observe` and was checked read-only against
production. The CI rollout write path stays deferred to a write token on a
future public receiver, since the Cloudflare adapter already records every
stats deployment.

The dashboard was reworked into one route explorer on the stats page:
routes ranked by exact trace CPU with p50, p95, and p99, a latency heatmap
with the p95 line and deploy markers, a p95 view that says where slow calls
spend their time, and the trace waterfall, all following the page's time
range. It replaces the sampled CPU-by-route card for the observed project.
Drill-downs that cross cards (a deployment's issues, an occurrence's trace,
a heatmap deploy marker) open in a stacked modal with Back, kept in the
URL, instead of scrolling the page; a trace opened from an error selects
the slice that raised it. WebP goldens come from the fault-injection
scenario.

Tail delivery was checked on 2026-11-04: between 01:11 and 01:43 UTC the
hosts made 127 uploads (counted from stored samples) and the store held 127
ingest traces. Workers Logs counts for the same window read about 60%
higher because of the dataset's sampling stamp, so they are not a delivery
baseline.
`stats-observe` and `stats` are deployed (`dc8c3793`, `2221f9c2`), and
production capture started on 2026-11-04.

Phase 1 dropped the STO1 codec and the fragment benchmark: with classic tail
there is no per-invocation payload beyond columns, so a codec would encode
nothing. A future producer outside Cloudflare would bring its own protocol
decision. The core lives in `cloudflare/src/observe/core/` and is checked by
`pnpm run typecheck:observe` and `pnpm run test:observe`.

Phase 2 put the collector in `cloudflare/src/observe/worker/` and its config
in `cloudflare/observe-worker/`. Stats publishes on `stats.observe` from
`cloudflare/src/observe/mark.ts` and `report.ts`, and proxies
`/api/observe/*` after Access. `cloudflare/test/observe-e2e/tail.test.ts`
is the exit test. Two Miniflare quirks shape it: its Worker proxy rejects
any request with an `Origin` header, so the test uses `dispatchFetch`, and
persistence is the `resourcePersistencePath` shared option. Billed rows
written per invocation are not yet measured under workerd; the core tests
count rows, not billed writes.
