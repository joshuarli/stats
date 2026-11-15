# Covering-index experiment

Verdict: the covering index removes the demonstrated canonical-row lookup cost.
Production browser acceptance remains separate from this isolated comparison.

The fixture contains the frozen 20,395-event corpus. It runs the pinned Stats
image, OpenOrange 1.0.2 and RivetKit/Engine 3.1.2-rc.1 on Lisa. The container has
two CPUs, 3 GiB memory, an embedded Engine and filesystem storage. No ports are
published. The shared production Engine and application state are inaccessible.

Five interleaved rounds compare the original time index with an expression
index that also contains `payload`. Both indexes exist during the read trial.
Each variant explicitly selects its index. Every complete response equals the
frozen baseline output. Both cache TTLs remain 30 seconds. The harness's numeric
selectors choose query variants. They do not change that TTL.

| Query sequence | Baseline SQL median (range) | Covering SQL median (range) |
| --- | ---: | ---: |
| First 1h read | 2,465.4 ms (2,437.4–2,480.4) | 123.3 ms (114.9–127.6) |
| Following 6h read | 2,436.0 ms (2,411.2–2,514.0) | 147.1 ms (108.1–173.3) |
| Following 24h read | 402.1 ms (384.0–417.3) | 723.8 ms (681.5–760.3) |
| Following full-corpus read | 161.7 ms (157.3–187.1) | 160.8 ms (133.7–163.7) |

Each cell has five samples. The first two SQL phases improve outside the
observed spread. The following 24h read regresses after the preceding reads
have warmed different pages. The complete four-window workload does less SQL
work. This does not establish every range's latency target. The fixture spans
about 25 hours, not a full seven-day history. Percentile and tenfold acceptance
remain open.

Initial HTTP timings include embedded-Engine node transitions, which sometimes
add seconds outside SQL. They are not production navigation measurements.
Awake repeated reads remain separately labeled in [reads.json](reads.json).
Lisa timing gates exit 0 before and after the accepted run. An earlier run ended
with a busy gate and is excluded from these numbers.

A separate native profile attributes about 2.43 of 2.53 seconds to storage,
with 881 page misses on the original first read. The compact expression-only
index still executes `NotFound` against the canonical WITHOUT ROWID table.
The payload-containing index reports `USING COVERING INDEX` and has no such
lookup. Merely counting payload-column reads missed this distinction.
[native-profile.json](native-profile.json) contains sanitized original timings.

The native `dbstat` inspection reports 10,285,056 bytes for the canonical table
and 8,925,184 bytes for the new index. This is derived SQLite storage, not an
estimate of Engine log or object-tier space. Summed process RSS in the read
trial is 987,764–1,014,268 KiB for the baseline and 921,308–946,736 KiB for the
candidate. Both use the same image. [resources.json](resources.json) records
these costs. The source adds one index and does not alter canonical rows.

The write comparison uses fresh actors, five interleaved rounds per schema,
and eight durable 64-event batches per round. Every round accepts 512 events,
then acknowledges 64 exact duplicates without adding rows.

| Eight-batch workload | Baseline median (range) | Covering median (range) |
| --- | ---: | ---: |
| HTTP acknowledgment wall time | 626.2 ms (600.8–672.1) | 641.4 ms (563.0–717.7) |
| Container CPU time | 1,034.5 ms (975.6–1,067.0) | 1,034.5 ms (972.8–1,128.9) |
| SQLite allocation after 512 events | 593,920 bytes | 872,448 bytes |

There is no measurable acknowledgment or CPU difference within this spread.
The new index adds 278,528 bytes in this small fixture. Timing gates exit 0
before and after the write trial. [ingest.json](ingest.json) records every batch.
[read-trial.mjs](read-trial.mjs) and [ingest-trial.mjs](ingest-trial.mjs) are the
executed container-side harnesses. They require the protected corpus checksum
and the `/app` layout of the pinned image.

The Linux rehearsal also accepts 64 events, acknowledges 64 duplicates,
rejects a changed duplicate with 409, and retains identical summaries across
restart. Node regressions prove old-data backfill, exact export fingerprints,
HTTP status classification and duplicate identity. Native pilot, backup/restore
and self-observation tests pass. No wire or export format changes.

Before production rollout, the existing CLI exports the fenced Stats observation
object to the protected off-host backup directory. The snapshot contains 16
tables and 207,188 rows, including 26,221 valid canonical event payloads. Its
44.4-second write fence is reopened and verified. The new index is rebuildable.
Rolling back the application retains canonical data and can leave the index in
place. Old readers remain compatible.
