# Compact application projection comparison

Verdict: retain the compact per-event table for implementation and further
validation. Wide warmed reads improve beyond the observed spread. Production
still uses the payload-containing covering index; no projection is deployed.

The same isolated native fixture holds 203,950 events, both read structures and
the pinned production runtime. A test-only selector alternates two fixed SQL
queries through the real HTTP and actor path. A response marker comes from the
query that actually executes. Both Lisa timing gates exit 0; the client exits 0.
No second replica is added: the separate capacity gate reports fully used swap.

| Window | Payload index median (range) | Compact table median (range) |
| --- | ---: | ---: |
| 1h | 91.4 ms (74.4–104.6) | 65.2 ms (53.1–75.7) |
| 6h | 375.2 ms (358.7–578.4) | 241.7 ms (226.9–277.5) |
| 24h | 1,042.9 ms (907.9–1,084.6) | 639.7 ms (570.3–685.1) |
| 144h | 1,018.7 ms (945.4–1,077.8) | 585.4 ms (545.7–673.9) |

Each cell contains five warmed reads, alternating order by round. The client
consumes complete bodies. All 48 responses, including the eight priming reads,
match the corresponding complete baseline response SHA-256. There are no failed
responses. Priming reads are excluded from the warmed comparison; their order
does not support a cold comparison. This is not browser, concurrency or
200-sample percentile acceptance.

[reads.json](reads.json) records timings, actual query markers and response
digests. The [schema](schema.json) stores one scalar row per canonical event,
with insert, update and delete triggers; it does not aggregate or collapse
independent identities. The canonical payload and old index remain intact.
Removing payload bytes from the scanned structure reduces read work. SQL still
dominates wide reads; the improvement alone does not prove ten-client targets.

[local-proof.json](local-proof.json) records full summary equality and mutation
checks against the original 20,395-event corpus. Its SQLite page accounting is
1,794,048 bytes for the compact table versus 9,261,056 bytes for the payload
index in that database. This is added storage while the rollback index remains.
Actual sleeping-actor latency and production migration time remain unmeasured.
Snapshot-policy support is live as `stats:a309aaf60b7c`, node version 21.

The write comparison uses fresh small actors in separate disposable state, the
same two-CPU, 3 GiB limits as production, and actual compiled baseline and
candidate sources identified by SHA-256. Five alternating rounds each accept
eight durable 64-event batches, acknowledge 64 exact duplicates and reject one
changed duplicate with 409. All complete summaries match an independent
reference. Both timing gates and the client exit 0. [ingest.json](ingest.json)
contains every sample.

| Eight-batch workload | Baseline median (range) | Compact table median (range) |
| --- | ---: | ---: |
| HTTP acknowledgment | 632.4 ms (606.7–635.5) | 664.9 ms (618.0–671.0) |
| Container CPU | 1,011.8 ms (972.0–1,041.3) | 1,047.0 ms (1,015.1–1,062.1) |
| SQLite allocation after 512 events | 811,008 bytes | 856,064 bytes |

The timing ranges overlap; the median differences are smaller than the observed
candidate spreads. This does not establish zero write overhead or satisfy the
separate instrumentation-overhead goal. The compact table adds 45,056 bytes at
512 events, including its schema. The read benefit justifies retaining it.

The [earlier write trial](ingest-busy.json) is excluded because its post-run
timing gate exits 75. Two subsequent attempts stop during embedded-Engine
startup: its command volume reports quorum unavailable and the CLI terminates
on `depot/open_failed`. The original tenfold state and private logs remain
preserved. Those failures precede candidate code and do not demonstrate a
projection defect; they remain an unresolved native recovery gap. The valid
write comparison uses a fresh write-only fixture and does not claim to repair
the failed read fixture.

Earlier restart comparisons are excluded: one stops before actor readiness;
another completes but fails the post-run timing gate. They support no speedup
claim. The valid comparison uses one warmed connection without process restarts.
