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
The baseline is `ea3fabdf2`. The summary change is `8744257bb`.

Both recorded timing runs pass `perf-gate-ready` before and immediately after.
A separate V8 profile places most sampled CPU in SQLite execution.
All returned totals, buckets, operation ordering and availability flags match.
Neither case has failed HTTP requests.

| Workload | Baseline median (range) | Candidate median (range) | Median process CPU per request |
| --- | --- | --- | --- |
| 1,847 captured events | 38.54 ms (37.05–40.42) | 15.40 ms (14.36–19.23) | 39.68 → 16.89 ms |
| 18,470 repeated events | 329.57 ms (321.24–348.99) | 109.25 ms (104.71–120.60) | 330.80 → 110.59 ms |

The replay uses warm, in-memory SQLite and HTTP loopback. It isolates backend
read cost on Lisa. It does not measure Caddy, Tailscale, Rivet actor routing,
production queueing or cold disk latency. The load generator shares the process
with the server. The CPU reduction follows the removed SQL work.

Separate single-implementation resource runs peak at 157,720 KiB RSS for the
baseline and 157,896 KiB for the candidate on the larger workload. These are
single-run resource checks, not evidence of a memory improvement.
The baseline resource run overlapped a load increase, so its timings are excluded.
The materialized projection contains scalar fields rather than complete payloads.
SQLite can spill temporary aggregation state. Production already supplies
writable `/tmp` on its read-only application container.

The rebuilt Stats Worker grows from 298,670 to 299,027 bytes. The observation
Worker grows from 202,115 to 202,410 bytes. Those totals include the separately
verified service-catalog batching change. No dependency is added.

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
