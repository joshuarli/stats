# Stats runtime observations

Stats translates selected native Rivet spans into the existing application-event
pipeline. The private bridge observes Stats' Installation actor and the
ObservationStore actor for Stats' own events. The shared Engine and the other
application containers are outside this collection scope.

## Native coverage

OpenOrange 1.0.2 and pinned RivetKit 3.1.2-rc.1 export actor `onRequest` and SQLite
execute and transaction spans over OTLP HTTP/JSON. The native resource reports
3.1.1. Observation releases retain the application image tag, OpenOrange pin,
RivetKit package pin and native self-report separately.

Orange routes several logical methods through the same native `onRequest`
handler. These spans do not identify methods such as `applicationSummary`.
The validated Orange path supplies no separate outbound actor-RPC spans.
Runtime gauges are not collected. With multiple Workers, the documented metrics
port covers only the first Worker, so that endpoint would omit ObservationStore.
The dashboard marks those capabilities unavailable.

The Engine persists actor data in its filesystem tier. The separate S3-compatible
store is not that persistence path. This feature changes neither storage backend.

## Privacy and authentication

The receiver requires a dedicated bearer credential and an exact resource,
actor-name and actor-key allowlist. It emits role-based operation names,
checked durations, valid trace and span IDs, fixed failure codes and source
releases. It discards arbitrary attributes, actor identifiers, SQL, bindings,
bodies, headers and raw error messages.

The container uses the internal Docker bridge without published ports or an
ingress route. It runs without root on a read-only filesystem. Its memory limit
is 128 MiB. The receiver admits at most four bodies concurrently, caps each body
at 1 MiB and caps a batch at 256 spans. The producer queue holds 128 events plus
a bounded batch in flight. Full queues drop old events and report those drops.

The reserved `stats-platform` sink uses the existing event protocol and a
separate credential. The Worker stores its SHA-256 verifier. This credential is
owned by protected platform configuration, so the ordinary service registry
cannot create a competing credential for that name.

Verifying bridge ingestion does not call Installation. Its destination is a
separate ObservationStore actor that the receiver excludes. The existing HTTP
capture also excludes observation ingestion. A native test proves the resulting
stream settles. Disabling or losing the receiver does not fail actor work.

## Counts, distributions and delivery

The Stats project's Platform tab reads the private, read-only endpoint
`GET /api/observe/stats-platform/platform?from=<ms>&to=<ms>`.
The normal gateway and tailnet identity adapter authorize the request.
The endpoint is unavailable when platform configuration is disabled.

Counts describe received samples. They are not estimated request totals.
Actor duration includes nested SQLite work, so those categories must not be
summed. Durations are checked as integer nanoseconds, rounded to microseconds
for event work and to milliseconds for the existing event envelope.

The histogram uses fixed microsecond bounds. The displayed p50 and p95 values
are bin upper bounds, not exact percentiles. Responses keep at most 80 complete
operation/release groups and expose truncation explicitly.

Bridge delivery reports show process-lifetime received, admitted, filtered,
invalid, dropped, queued and sent counts, plus the configured root sampling rate.
A missing or stale report stays unavailable. Restarting the bridge resets its
counters. Native exporter loss remains unknown because the pinned OTLP payload
does not report it. Sampling and export failures can omit observations.

## Verification

The native rehearsal exercises both real actors, SQLite spans, a real actor
failure, authenticated translation, source releases and downstream ingestion.
It checks feedback exclusion and continued actor reads with the collector down.
The [overhead record](../bench/results/2026-11-14-platform-runtime/README.md)
contains the controlled native comparison and its limits.

Upstream references: [OpenOrange monitoring](https://openorange.dev/docs/operations/monitoring/),
[Rivet tracing](https://rivet.dev/docs/tracing/) and
[pinned native instrumentation](https://github.com/rivet-dev/rivet/blob/e5ed3911ebff8ddc35c08b3f6c6eb3f795d042f9/rivetkit-rust/packages/rivetkit-core/src/telemetry.rs).
