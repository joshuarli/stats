# Native platform tracing overhead

The rehearsal compares native Stats summary reads with tracing disabled and with
10% root sampling. Both replicas run OpenOrange 1.0.2 and pinned RivetKit
3.1.2-rc.1 on Node 26.13.1. The native exporter self-reports 3.1.1.

The host is the development Mac, an Apple M5 Max with 48 GiB RAM. Each replica
uses its own embedded local Engine and the same 1,847 captured Stats events.
The input SHA-256 is
`751939a91b75d632ec7fbe5d1c9548c79a677339d04c7fcc1dc5645bda822d6b`.
The sampled replica exports through the real OTLP receiver and producer into its
own reserved observation sink. Both use the same application code.

Five interleaved rounds perform eight complete HTTP reads per side. The script
checks every response against the same full summary. Requests are paced outside
the timed intervals so native exports and producer deliveries run during the
measurement. Both host load gates pass.

| Native configuration | Median round mean | Range of round means |
| --- | --- | --- |
| Tracing disabled | 9.25 ms | 8.53–12.11 ms |
| 10% root sampling | 9.26 ms | 8.49–16.71 ms |

The observed difference is within the run-to-run spread. No measurable latency
regression is established by this rehearsal. This is a local native-runtime
overhead check, not a production Lisa speedup or a universal overhead bound.
The replicas share an otherwise quiet machine. The client and receiver share
the harness process.

The bridge receives 274 spans, translates 223 selected observations and filters
51. All 223 are acknowledged by Stats. The queue drains with no drops, retries,
invalid spans or failed HTTP reads. The JSON records harness memory separately
from the application containers. Production receiver memory is checked against
its 128 MiB container limit.

`deploy/orange/platform.test.mts` separately verifies real actor failures,
SQLite timings, source releases, authenticated export, no recursive ingestion,
and 30 successful actor reads after the collector is disconnected. Its 100%
sampling fixture is a correctness test, not the production sampling setting.

## Production acceptance

Lisa runs Stats image `stats:1f6774609d70` at Orange node version 11. The bridge
bundle is built from `9fdd75d8338` and selected by the immutable image ID
`sha256:5f01c33d55f8fa3dcb15801f3512ffad36d6d5142828ed434c4ec7b92da549e2`.
Its bundle is 25,786 bytes, SHA-256
`8eac3cef821a47bdcc5e9037b540608fe5c8509e4257dd8829abdbbdcb1f7cb1`.
The runtime has no added package dependencies.

The authorized browser loads the Stats project's Platform tab over HTTPS.
It displays both real actor roles, nested SQLite operations, source releases,
histograms and configured root sampling of 100,000 ppm. Desktop and 390-pixel
mobile views support refresh and navigation without page overflow. The
sanitized `production.json` records the operation groups and delivery report.
The shared Engine view remains at `/rivet`.

Sixty alternating host and application-summary reads all return HTTP 200.
These are functional checks under production traffic, not a controlled latency
comparison. Production samples include long actor calls alongside much shorter
individual SQLite statements. The aggregate histograms cannot attribute the
remaining time to RPC, scheduling or storage and must not be subtracted as a
causal breakdown. Further diagnosis needs paired operation evidence. Lisa also has unrelated
builds using several cores and heavy disk I/O during the later checks (load
average 10.46 on eight logical CPUs). No production speedup or latency bound
is inferred from these checks.

Initial delivery used a one-second timeout. Slow production writes exceeded it
and the bridge reported drops. The final bridge permits five seconds per
attempt with one retry; its live queue drains and valid observations continue to arrive. A longer
observation during validation and backup load records 28 abandoned observations after retry timeouts. These are SDK abandonments, not proof
that none committed before the timeout. Delivery is best effort; the dashboard
reports these drops, and native exporter loss remains unknown.

An isolated production-image probe with ingest unavailable admits 8,192 valid
spans, drops excess observations and keeps the queue within 128 events. It uses
30.12 MiB against the 128 MiB cap. The live receiver uses about 24 MiB. The
receiver remains non-root and read-only, without published ports. Native tests
separately prove actor requests continue after the collector is closed.

Unauthenticated OTLP writes return 403; private telemetry reads without gateway
authentication return 401. Checks find no bridge or Engine credentials in eight
normal API and asset responses. Exporter credentials are excluded from Worker
secret bindings. Restarting only the bridge leaves the Engine and every
application container's start time unchanged.

Shared-stack health finishes with 116 passes, one existing disk-space warning
and no failures. Protected configuration, bundle and selected bridge image are
copied to `/Users/josh/backups/openorange/platform/2026-11-14` on the Mac, with
archive integrity and checksums verified. The dedicated browser is closed.
