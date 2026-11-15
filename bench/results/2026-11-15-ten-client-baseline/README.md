# Ten-client native baseline

Verdict: compact per-event reads preserve correctness but do not meet P6 latency.
The wide-query CPU cost queues simultaneous reads at the observation actor.

The frozen fixture holds 203,950 events. Two Workers use production's
`orange serve` mode against an independently managed private pinned Engine.
The same single container has two CPUs, 3 GiB memory, filesystem state, no
published ports and no access to production state. Instrumentation is disabled.
Compiled Worker checksums identify the actual sources, including the compact
projection candidate. Both Lisa timing gates and the client exit 0.

| Historical window | Warm responses | HTTP median | Range |
| --- | ---: | ---: | ---: |
| 1h | 50 | 503.3 ms | 430.3–634.5 ms |
| 6h | 50 | 2,368.2 ms | 293.9–2,487.9 ms |
| 24h | 50 | 5,958.0 ms | 619.9–6,169.3 ms |
| 144h, covering the corpus | 50 | 6,066.4 ms | 613.5–6,178.7 ms |

Each of five rounds starts ten real HTTP requests together per range. The
client consumes complete bodies and waits for all requests to settle. All 240
responses, including 40 priming reads, match complete baseline response hashes.
There are no failed responses. [reads.json](reads.json) retains every response.
This is a component lower bound without representative ingest, browser rendering
or 200 samples per range. The six-day query does not establish seven-day latency.

The separate [CPU diagnostic](profile.json) runs ten warmed 24h reads. Container
CPU grows by 8.21 seconds, including 6.10 seconds in one Worker process and
1.78 seconds in the Engine. Disk reads grow by 323,584 bytes and CPU throttling
by 2.3 ms. This single profiling trial supports reducing aggregate-query work;
its wall time is not percentile acceptance or an A/B speedup. Request timings
also show queueing outside each SQL phase: simultaneous responses pay several
queries' cost while their individual SQL phases remain much shorter.

After the embedded development bootstrap failures, the same Engine state opens
under independent ownership. [canonical.json](canonical.json) verifies all
203,950 canonical rows against the original import SHA-256 and unchanged
16-table schema fingerprint. The private observation fence is reopened and
verified. No production fence occurs in this trial. This proves preserved
acknowledged data in this recovery, not automatic recovery or a restart SLO.

The loader now supports an explicit loopback `RIVET_ENDPOINT` for serving
already prepared state. It requires `RIVET_NAMESPACE` and the Engine credential
in the protected fixture auth file. The pinned `serve` command has no `--json`
option; its real listening announcement is followed by HTTP and actor readiness
checks. [native-scale-reads.mjs](../../native-scale-reads.mjs) adds
`--clients 10` and records source checksums and all rejected requests.

```sh
node /bench/native-scale-reads.mjs --root /bench --clients 10 \
  --output /bench/ten-client-reads.json
```

Run inside the existing isolated container after the Engine and both Workers
are ready. The command and both harness syntax checks exit 0. The next query
experiment must preserve exact window boundaries while scanning fewer rows.
