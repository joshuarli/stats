# Maintained application rollups

The maintained rollups reduce native ten-client read latency while preserving
complete responses. These are component results, not P6 browser acceptance.

The isolated Lisa fixture contains 203,950 independent event identities. Two
production-mode Workers and an independently managed pinned Engine share the
same two-CPU, 3 GiB container. Networking is disabled; no production state or
credentials are mounted. Instrumentation is disabled. A private selector runs
either the prior compact-projection query or the maintained rollup query in the
same compiled Worker. Both derived structures exist for both variants.

Five alternating rounds start ten simultaneous HTTP requests per variant and
window. Every response body is consumed and compared with its complete baseline
SHA-256. All 480 responses, including 80 priming reads, match. The client and both
Lisa timing gates exit zero. An earlier trial failed its post-run load gate;
its timings are excluded.

| Historical window | Warm responses per variant | Projection median (range) | Rollup median (range) | Projection / rollup p95 |
| --- | ---: | ---: | ---: | ---: |
| 1h | 50 | 492.7 ms (449.9–585.0) | 196.3 ms (162.6–239.7) | 581.0 / 236.8 ms |
| 6h | 50 | 2,226.8 ms (2,170.9–2,506.5) | 296.0 ms (55.9–327.3) | 2,502.1 / 324.3 ms |
| 24h | 50 | 5,411.9 ms (552.9–5,520.0) | 338.3 ms (269.4–402.2) | 5,513.4 / 397.8 ms |
| 144h, covering the corpus | 50 | 5,749.8 ms (591.7–5,808.1) | 248.4 ms (214.9–317.4) | 5,806.4 / 314.1 ms |

[reads.json](reads.json) records each response, query-source marker, phase timing,
compiled-source checksum and fixture checksum. The prior CPU diagnostic identified
aggregate-query CPU and actor queueing as the bottleneck. Rollups reduce the rows
aggregated for aligned intervals; fractional edges still read exact event rows.
This run does not measure ingestion contention, browser rendering, seven-day
coverage or 200 journeys per condition.

[ingest.json](ingest.json) verifies a fresh native actor acknowledges 512 events,
detects 64 exact duplicates, rejects a changed duplicate with HTTP 409 and returns
the complete independent reference summary. Its logical snapshot excludes derived
tables. [canonical.json](canonical.json) verifies the original 203,950-event
corpus retains its exact canonical SHA-256 and 16-table schema fingerprint.
Both private observation fences reopen successfully.

The implementation passes 214 observation tests, targeted type checks and lint,
and a native backup/restore test. Additional mutation tests cover fractional
windows, minute boundaries, dense cells, nullable legacy measures, missing versus
empty operation names, updates and deletion of maxima.

Code revision `af4890a3bb5` is deployed in `stats:6cc06db247a3`, node version 24.
HTTPS deployment smoke and deployment-marker delivery pass. Rollback uses
`stats:03d3d4f1fcb8`, node version 23, whose snapshot policy excludes both derived
tables. Keep their triggers and canonical data during rollback.
