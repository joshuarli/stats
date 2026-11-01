# Agent benchmark method

Run on a named Linux host only:

```sh
bench/bench.sh agent/dist/niceforge-telemetry-x86_64-unknown-linux-musl 4 15000 .work/tmp/bench-idle.json
```

The agent's `--bench <iterations> <interval_ms>` mode samples without network,
reports collection latency, process user/system CPU, and max RSS, and exits.
`/usr/bin/time -v` records the process RSS ceiling; `perf stat` records cycles,
instructions, context switches, and page faults when available. Record the
kernel, CPU model, filesystem, capabilities, load, and interval with every run.

Compare with Node Exporter only on the same host and interval. Report median and
spread across repeated runs; never mix partial metric sets. Local numbers from a
development macOS host are not evidence. The campaign's targets are
aspirations: at most 16 MiB steady RSS and under 0.1% of one logical CPU at 15 s
on an idle representative host.

## Recorded 2026-10-31

Host `oracle-free`: Ubuntu 24.04.4 LTS, kernel 6.17.0-1007-oracle, x86_64,
AMD EPYC 7551 (2 vCPU), ext4, about 1 GiB RAM, load 0.00-0.07 during the runs.
The telemetry service was stopped and the two tools ran interleaved: five runs
of four samples at 15 s, plus one agent run under `/usr/bin/time -v` and
`perf stat`. Node Exporter 1.12.1 used its default collectors, scraped four
times per run. Median [minimum-maximum]:

| Metric | Agent | Node Exporter |
| --- | --- | --- |
| CPU per sample | 0.93 ms [0.89-1.15] | 22.5 ms [15.0-32.5] |
| CPU over the run | 0.0082% [0.0079-0.0102] | 0.199% [0.133-0.288] |
| Max RSS | 1.70 MiB | 20.45 MiB [20.38-20.58] |

The agent's collection latency median was 0.92 ms [0.87-1.05]. The separate
perf run recorded 136.5 ms task-clock, 10,001,322 cycles, 6,011,430
instructions, 5 context switches, and 51 page faults over 45.14 s; `/usr/bin/time`
reported 1,124 KiB maximum RSS for that run. The event set did not include
syscalls, and the collection-only benchmark did not measure bytes sent. The
agent met both targets on this
host. Node Exporter's default collectors expose a broader metric set than the
agent's fixed groups, so this is a same-host, same-interval cost comparison,
not a like-for-like metric-set comparison. `threadripper` was not used because
its load average was above 5.5 on 32 CPUs; no performance claim is made for it.
