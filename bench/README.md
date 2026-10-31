# Agent benchmark method

Run on a named Linux host only:

```sh
telemetry/bench/bench.sh telemetry/agent/dist/niceforge-telemetry-x86_64-unknown-linux-musl 4 15000 .work/tmp/bench-idle.json
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
on an idle representative host. Performance remains unverified until the
recorded host proof exists.
