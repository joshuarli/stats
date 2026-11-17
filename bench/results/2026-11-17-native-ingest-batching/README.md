# Native canonical event insertion

Batching canonical inserts reduces CPU and wall time in the native ingestion
workload. Five interleaved rounds per variant each acknowledge 512 captured
events through eight real HTTP batches on a fresh observation actor.
Every event reads back with identical canonical content. Full summaries match
the independent reference, duplicates acknowledge and changed duplicates return
HTTP 409. All four host gates pass around the comparison workflow.

| Metric per 512-event round | Baseline median and range | Batched median and range |
| --- | --- | --- |
| Whole-container CPU | 1.454 s, 1.428–1.521 s | 0.890 s, 0.842–0.914 s |
| HTTP ingestion wall time | 927.2 ms, 898.8–961.8 ms | 502.5 ms, 478.2–531.9 ms |
| Database growth | 667,648 bytes in every round | 667,648 bytes in every round |

The median CPU reduction is 38.8%. The wall-time reduction is 45.8%.
Both differences exceed their same-variant spreads. Container memory peaks at
588,353,536 bytes across the comparison, below its 3-GiB limit. Memory-limit,
OOM and kill counters remain zero. The observation bundle adds 343 bytes,
from 217,758 to 218,101. No dependency is added.

## Mechanism and scope

The native CPU profile places ingestion work in synchronous Rivet SQLite
transaction calls. Such sampled stacks can include native waits. They do not
separate database CPU from I/O. The canonical insert previously crossed that
boundary once per event. It now inserts up to 16 events per statement inside
the same batch transaction. Six bindings per event stay within the Workers
SQLite [100-binding limit](https://developers.cloudflare.com/durable-objects/platform/limits/).

The regression records 68 SQLite calls before the change and enforces at most
ten afterward for a 64-event batch. It checks canonical payloads, duplicates,
late conflicts and rollback when a later insert chunk fails. Failure grouping
and all-or-nothing batch behavior are unchanged. No public API, schema,
permission or transaction boundary changes.

This measures the shipped native HTTP ingest path with instrumentation disabled.
CPU includes the private Engine, both Workers and the in-container driver.
Actor initialization, reference checks and canonical readback are outside the
timed interval. This is a component result. It establishes neither the P7
instrumentation bound nor combined ten-browser P6 acceptance. The host gates
surround the whole five-round comparison, not each individual round.

## Provenance and reproduction

Lisa runs the existing production-image runtime,
`sha256:9fbc7f1418318a75a32a2273b10ed8a6794bdce6821fec8fcc96b6f61f6408a8`,
with two CPUs, 3 GiB, no extra swap and networking disabled. The release Engine
SHA-256 is `611b08f609d625ad5379c3b0801f23fc76ab4e17cc3ee0210ba608bf53ae1b01`.
The new depot and namespace are separate from every tenfold or failed fixture.

The unchanged observation source rebuilds to the exact deployed baseline SHA-256,
`4fd587b7fce9fcae776c809a913e5b842a1bef97e37e057a38265debf145da14`.
The candidate SHA-256 is
`d090049a73521020f7f69eaf78cf75437be2e772236f1138a0187ba9e1aa25b4`.
Their compiled diff changes only `ingestExternal`'s insertion loop.
The Stats bundle and runtime packages remain identical.

Use `make observe-bundle` before and after the source change to produce the
two artifacts with the pinned Node and package toolchain. Copy them into the
protected comparison mount as `baseline.js` and `candidate.js`. The existing
fixture tool creates new service actors for each round and reverses variant
order on odd rounds. Provision a fresh `stats-scale-ingest-*` namespace with
`default` and `services` pools on the independently managed private Engine.
The protected runtime-auth file contains fresh fixture credentials.

With `RIVET_ENDPOINT`, `RIVET_NAMESPACE` and `RIVET_NODE_VERSION=24` set inside
the isolated container, run:

```sh
node /bench/study/source/bench/native-scale-fixture.mjs --root /bench/study/insert-comparison --mode ingest-cost --runtime-auth-file /bench/study/insert-comparison/engine/runtime-auth.json --baseline /bench/study/baseline.js --candidate /bench/study/candidate.js
```

Supply the frozen `corpus.json` matching the tool's SHA-256 assertion. Keep
raw captured events and credentials in protected storage. Check Mac and Lisa
`perf-gate-ready` before the complete job and `perf-gate-ready -1` immediately
afterward. Reject any failed gate or failed correctness check.

[Results](results.json), [host gates](gates.json) and [bundle identities](bundles.json)
contain the accepted comparison. An earlier aggregate-only trial is retained
in protected storage and is superseded by these full canonical-readback results.

Thirty-five focused tests pass across store behavior, rollups, snapshot parity,
workerd HTTP and Node HTTP ingestion. Observation typecheck and lint pass.
Full repository tests and the release gate remain unrun. Production is unchanged.
