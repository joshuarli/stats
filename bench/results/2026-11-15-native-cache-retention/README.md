# Native cache retention trial

Verdict: no useful improvement. Production settings remain unchanged.

The trial compares `RIVETKIT_SQLITE_OPT_VFS_STAGING_CACHE_TTL_MS=30000` with
`300000` in five interleaved rounds on Lisa. The pinned application image is
`stats:05cc14f183f7`. The fixture contains all 20,395 frozen corpus events.
Every read checks exact summary equality against the original fixture outputs.
There are zero failed reads. Host timing gates exit 0 before and after the trial.

Each round starts the actual two-Worker descriptors and embedded pinned Engine
in a container with two CPUs, 3 GiB memory and Lisa filesystem storage. Nothing
is published. Production state and the shared Engine are inaccessible. This
combines the isolated Engine and runners under one resource limit. Production
runs the shared Engine separately. Startup measurements include that topology's
node transition waits and are not production restart acceptance.

A small authenticated health read every two seconds keeps the actor active
through a 35-second pause after the initial summaries. The next summaries test
page retention in an awake actor. The initial startup reads remain separate.
There is no profiler attached and no disk-cache flush.

| Awake after 35 seconds | Baseline median (range) | Candidate median (range) |
| --- | ---: | ---: |
| 1h | 50.3 ms (39.3–64.9) | 56.3 ms (46.8–64.0) |
| 6h | 101.2 ms (86.8–119.0) | 104.1 ms (87.7–106.9) |
| 24h | 172.3 ms (161.8–208.7) | 187.7 ms (162.8–361.2) |
| 7d | 181.9 ms (174.1–281.0) | 198.4 ms (177.7–247.6) |

Each cell has five samples. The overlap does not support a speedup. Both sides
still spend seconds loading SQL data during initial queries. Summed process RSS
stays roughly 0.9 GiB on both sides. There is no image or bundle-size change.
This is a configuration experiment, not percentile acceptance.

[results.json](results.json) contains every read, server timings and process RSS.
[trial.mjs](trial.mjs) is the executed container-side harness. It expects `/app`
from the production image and a protected `/bench/corpus.json` with the recorded
checksum. Preparation and fixture writes stay outside measured reads.

The [pinned optimization flags](https://github.com/rivet-dev/rivet/blob/v3.1.2-rc.1/engine/packages/sqlite-embedded/src/optimization_flags.rs)
define this setting and its 300,000 ms maximum. Current upstream tuning docs
also describe startup-preload variables absent from that pinned flags file.
Those variables have not been treated as functioning controls for this artifact.
