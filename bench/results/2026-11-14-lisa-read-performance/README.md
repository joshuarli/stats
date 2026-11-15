# Lisa application-summary read results

The application-summary query reads event payloads once and shares extracted
fields between time buckets and operation totals. The former query reads each
payload twice and repeats HTTP-status extraction in each aggregate.
The HTTP response and stored event schema are unchanged.

## Measurement

Host: Lisa, AMD Ryzen 5 PRO 2400GE, eight logical CPUs, Alpine Linux.
The replay uses the production Node 26.13.1 image with two CPUs, 3 GiB memory,
a read-only root, and writable temporary storage. Each request traverses the
Node HTTP adapter, authentication, service lookup, summary API and SQLite,
then consumes and checks the complete JSON response.

The 1,847-event input is a captured Stats application window. Its SHA-256 is
`751939a91b75d632ec7fbe5d1c9548c79a677339d04c7fcc1dc5645bda822d6b`.
The larger case repeats that capture ten times with distinct database keys.
Each case runs five interleaved rounds of ten completed requests per side.
Each round reports mean elapsed time per request. The table reports the median
and range of those five round means.
The baseline is `ea3fabdf2`. The summary change starts at `8744257bb`. The final query also uses the
SELECT-first form described below.

Both recorded timing runs pass `perf-gate-ready` before and immediately after.
A separate V8 profile places most sampled CPU in SQLite execution.
All returned totals, buckets, operation ordering and availability flags match.
Neither case has failed HTTP requests.

| Workload | Baseline median (range) | Candidate median (range) | Median process CPU per request |
| --- | --- | --- | --- |
| 1,847 captured events | 35.86 ms (35.62–47.09) | 14.99 ms (14.15–15.65) | 36.86 → 16.56 ms |
| 18,470 repeated events | 367.40 ms (312.63–434.13) | 124.97 ms (105.41–137.25) | 367.32 → 125.55 ms |

The replay uses warm, in-memory SQLite and HTTP loopback. It isolates backend
read cost on Lisa. It does not measure Caddy, Tailscale, Rivet actor routing,
production queueing or cold disk latency. The load generator shares the process
with the server. The CPU reduction follows the removed SQL work.

Separate single-implementation resource runs peak at 157,720 KiB RSS for the
baseline and 156,308 KiB for the candidate on the larger workload. These are
single-run resource checks, not evidence of a memory improvement.
The baseline resource run overlapped a load increase, so its timings are excluded.
The materialized projection contains scalar fields rather than complete payloads.
SQLite can spill temporary aggregation state. Production already supplies
writable `/tmp` on its read-only application container.

The rebuilt Stats Worker grows from 298,670 to 299,027 bytes. The observation
Worker grows from 202,115 to 202,426 bytes. Those totals include the separately
verified service-catalog batching change. No dependency is added.

## OpenOrange read classification

Pinned OpenOrange 1.0.2 routes a leading `WITH` through its implicit write turn.
Its `DurableObjectTurnDatabase.executeSync` read classifier recognizes a leading
`SELECT`. The query therefore wraps the shared CTE in an outer SELECT.
That form keeps the same SQLite plan and response while using the read path.
The guard can be removed when the pinned runtime recognizes read-only CTEs.

The summary regression test enforces that runtime boundary. Removing the outer
SELECT makes the test fail. The real Orange diagnostics test also executes
the complete telemetry query and verifies persistence across a restart.

## Related service-catalog change

`3cd438730` replaces one catalog read plus seven latest-marker reads with one
indexed statement for Lisa's seven services. It projects public fields only.
Malformed marker JSON affects only its service. An unavailable history table
still returns the catalog with unavailable deployment summaries.

A separate five-round Node core replay of the captured seven-service catalog
falls from 0.0719 ms median (0.0695–0.0795) to 0.0297 ms (0.0283–0.0328).
That macOS measurement establishes reduced local work, not a production latency
claim. The application-summary query is the material performance change.

## Reproduction

Use the protected captured-event file and a baseline module beside its original
relative imports. From the repository root:

```sh
mkdir -p .work/tmp
git show ea3fabdf2:cloudflare/src/observe/application/telemetry.ts > cloudflare/src/observe/application/.baseline-telemetry.ts
perf-gate-ready
node cloudflare/scripts/bench-application-summary.mjs \
  --baseline cloudflare/src/observe/application/.baseline-telemetry.ts \
  --events /Users/josh/backups/openorange/stats/performance-overview/application-window.json
perf-gate-ready -1
```

Add `--repeat 10` for the larger workload. Use `--implementation baseline` or
`--implementation candidate` in separate processes for resource checks.
The checked-in JSON files contain measurements, not captured event payloads.

## Production verification

Lisa runs `stats:1215ac973d62`, Orange node version 10. Deployment preflight,
security headers, STB2 smoke checks and deployment-marker delivery pass.
A fixed production window retains exactly the same aggregates for 1,715 events.
All seven original service associations remain unchanged. A concurrent Agentctl
rollout adds an eighth service.

The live overview renders three charts at desktop and mobile widths without
horizontal overflow. One desktop reload completes its summary read in 624 ms.
That observation is a functional check, not a controlled production speedup.
The final shared-stack health check has 110 passes, one existing disk warning
and no failures. Some earlier checks time out on Stuff and npm landing pages
while separate build jobs load Lisa. The last retry passes those checks.

The selected image restarts only Stats. Engine and other application containers
remain running. The previous image remains available through the deployment
rollback path. Native Orange diagnostics, 27 focused Node tests, 12 workerd
service tests, type checks and type-aware lint pass.
