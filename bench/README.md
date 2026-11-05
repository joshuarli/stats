# Agent benchmark method

Run on a named Linux host only:

```sh
bench/bench.sh agent/dist/stats-x86_64-unknown-linux-musl 4 15000 .work/tmp/bench-idle.json
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

## Dashboard load

```sh
make dashboard-bench
make dashboard-bench BENCH_ARGS="--runs 9 --cpu 4 --latency 100"
```

The target builds the client, starts the local preview, and loads the fleet,
host, and project pages in Chromium under an emulated 1.6 Mbps / 150 ms link.
It reports medians for first paint, largest paint, content-ready, JS heap, DOM
nodes, listeners, and transferred bytes. `--runs`, `--latency`, `--down`, and
`--cpu` change the workload.

The preview serves captured fixtures without the production cache headers or
the Worker's compression, so compare runs of the same build. The Worker serves
hashed `/assets/*` with `private, max-age=31536000, immutable`; a reload after
the first visit should transfer no bundle bytes.

## Ingest protocol

```sh
BASELINE_WORKTREE=.work/wt/baseline make ingest-bench
```

`bench/ingest.sh` prints request and acknowledgment bytes for the fixture
workloads (`bench/ingest-bytes.mjs`), the agent's encoder time and
allocations (`agent/examples/ingest_bench.rs`, release), the Worker's
complete decode-to-stored-string work against the v1 parser kept in
`bench/legacy-v1/` (`bench/ingest-decode.ts`), and end-to-end ingest through
the Worker and Durable Object in local workerd. With `BASELINE_WORKTREE` set
to a checkout of a v1 commit it runs the v1 end-to-end twin there too. Method,
results, and limits are in [`docs/binary-ingest.md`](../docs/binary-ingest.md).

## Durable Object rows per ingest

```sh
pnpm --dir cloudflare run bench:workerd ingest-rows
```

`cloudflare/bench/ingest-rows.workerd.ts` ingests fixture batches into the
`Installation` object in local workerd and prints `writtenPerSample`, the
SQLite rows written per persisted sample from cursor totals. The count is
deterministic; it read 7.762 at `c85450f`.
