# Optional eBPF block latency

`biolatency.bt` is a standalone bpftrace probe for block-layer request latency.
`biolatency-collector.bt` and `collector.sh` write 15-second snapshots for the
agent's optional `blockLatencyFile`. The baseline agent never loads BPF and
works without this directory; the Worker and dashboard accept the optional
`block` group only when an agent attaches a fresh snapshot.

Requirements:

- Linux with BTF at `/sys/kernel/btf/vmlinux` and mounted tracefs.
- `bpftrace` and root or `CAP_BPF`/`CAP_PERFMON`.
- No `libbpf` headers or build toolchain are needed.

Run the probe in one terminal:

```sh
sudo bpftrace bpf/biolatency.bt
```

Generate bounded block I/O in another terminal:

```sh
dd if=/dev/zero of=/tmp/stats-bpf-io bs=4k count=1000 oflag=dsync
```

The probe exits after 10 seconds and prints the `@latency_us` histogram. The
measured interval is from `block_rq_issue` to `block_rq_complete`, so it includes
queueing and device service time. It is not application latency, and requests
that were already in flight when the probe started or still in flight when it
exited are not counted.

## Collector

Run the collector as root so bpftrace can attach the tracepoints:

```sh
sudo bpf/collector.sh /run/stats/block-latency.json \
  bpf/biolatency-collector.bt
```

`collector.sh` replaces the snapshot atomically every 15 seconds. Set the
agent's optional `blockLatencyFile` to the same path. The agent accepts the
snapshot only when it is a regular, non-group/world-writable file owned by the
agent user or root and modified within 30 seconds; otherwise the sample omits
`block`. A systemd unit is in `contrib/systemd/stats-block-latency.service`;
install the collector and scripts under `/usr/local/lib/stats/` and the unit
under `/etc/systemd/system/`.

The snapshot is JSON with `v`, `buckets` (16 decimal strings), `count`,
`totalUs`, `minUs`, and `maxUs`; the agent revalidates it before attaching it
to a sample. The histogram is stored and rolled up by the Worker, and the host
view renders p95, p99, and maximum latency.

Recorded 2026-10-31 on `oracle-free` (Ubuntu 24.04.4 LTS, kernel
6.17.0-1007-oracle, x86_64, BTF present, bpftrace 0.20.2) with 1000 synchronous
4 KiB writes. The probe attached and recorded 3037 completions:

```text
@latency_us:
[256, 512)          1364
[512, 1K)           1524
[1K, 2K)              74
[2K, 4K)              12
[4K, 8K)              22
[8K, 16K)             36
[16K, 32K)             1
[32K, 64K)             1
[64K, 128K)            0
[128K, 256K)           3
```

The baseline telemetry service stayed active and continued accepting samples
after the probe exited; no verifier rejection or kernel panic occurred. The
Alpine host has BTF but was not used for this probe.

