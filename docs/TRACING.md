# Tracing and profiling

Stats diagnoses its own performance with Cloudflare's built-in Workers traces
and production CPU profiles. It does not run an APM SDK or receive
OpenTelemetry data. Cloudflare's tools have been enough for every performance
question asked so far, and the heavier options all add cost to the Worker that
is being measured.

The one exception is the error-tracking product prototyped in
`docs/observability-campaign.md`. It keeps 7 days of per-invocation records
and grouped errors in a separate tail-consumer Worker, and is built around the
objections below rather than against them.

## What we use

- **Workers traces**, sampled at 10% in `cloudflare/cloudflare.config.ts`. The
  platform records handler, fetch, and binding spans on its own, including one
  span per Durable Object SQLite statement with its query and row counts. Use
  them for wall-time and I/O questions, such as which statements a slow
  ingest ran.
- **CPU profiles** of the Worker or the `Installation` object, captured on
  demand with `cf workers versions profile`. Use them for CPU-only questions;
  spans cannot split CPU work into phases. `docs/operations.md` has the
  capture steps.

A single profile on 2026-11-02 settled STA-32: JSON parsing and the garbage
it creates dominate uncached history reads. No code changes were needed to
find that out.

## Why not Sentry, an OpenTelemetry SDK, or our own trace store

- **The clock cannot time CPU work.** The Workers runtime freezes `Date.now()`
  and `performance.now()` between I/O events, so a span or stopwatch around
  pure computation reads zero. That rules out hand-made phase timers and
  makes custom spans useless for the CPU questions that matter here. Only the
  profiler sees that work.
- **The SDK costs land on the object being measured.** An SDK adds bundle
  size, startup work, and export requests to every sampled invocation. A
  receiver inside stats would make the Durable Object parse and write
  telemetry, and that object is already CPU-bound on history reads.
- **Cloudflare already provides the viewer.** Its dashboard displays the
  traces and flamegraphs. Copying them into stats means building storage,
  retention, and a waterfall UI to show data we can already see.
- **Trace volume now counts against a budget.** From 2026-12-01, logs and
  traces from every Worker on the account share one ingestion allowance (0.5
  GB per day on Free, where ingestion stops at the limit). A second trace
  pipeline would spend the same budget twice.
- **It would cross the project's non-goals.** `docs/architecture.md` lists
  OpenTelemetry, traces, and per-process profiling as non-goals for stats
  itself. Turning on Cloudflare's tracing stores nothing in stats, so it stays
  within them.

How the observability campaign meets these objections:

- It never times CPU work. CPU and wall time come from the platform's tail
  events, one figure per invocation.
- The only work on the measured Worker is one in-process diagnostics publish
  per invocation and one per caught error. Encoding, storage, and queries run
  in `stats-observe`, after the invocation.
- It does not copy spans. Per-statement SQL detail stays in Workers traces.
- Diagnostics publishes did not reach Workers Logs in a 2026-11-03 probe, so
  they stay off the shared ingestion allowance.

## Limits to keep in mind

- Traces use head sampling, so a 10% rate can miss a rare slow request.
  Raise the rate briefly when chasing one, and watch the shared allowance.
- A profile needs a loaded isolate with traffic during the capture. It
  records the capture window, not the past request you are curious about.
- Neither tool covers the Linux agent. Its cost is measured with
  `stats --bench` (see `bench/README.md`).

## When to revisit

Build custom instrumentation only after traces and profiles have both failed
to answer a specific question. Before adding one, decide whether it belongs in
stats at all or in a separate, optional tool. Examples of such questions:

- a request path spread across services Cloudflare does not trace
- a tail that head sampling keeps missing
- a Rust service outside Workers
