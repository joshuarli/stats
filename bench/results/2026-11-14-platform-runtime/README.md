# Native platform tracing overhead

The rehearsal compares native Stats summary reads with tracing disabled and with
10% root sampling. Both replicas run OpenOrange 1.0.2 and pinned RivetKit
3.1.2-rc.1 on Node 26.13.1. The native exporter self-reports 3.1.1.

The host is the development Mac, an Apple M5 Max with 48 GiB RAM. Each replica
uses its own embedded local Engine and the same 1,847 captured Stats events.
The input SHA-256 is
`751939a91b75d632ec7fbe5d1c9548c79a677339d04c7fcc1dc5645bda822d6b`.
The sampled replica exports through the real OTLP receiver and producer into its
own reserved observation sink. Both use the same application code.

Five interleaved rounds perform eight complete HTTP reads per side. The script
checks every response against the same full summary. Requests are paced outside
the timed intervals so native exports and producer deliveries run during the
measurement. Both host load gates pass.

| Native configuration | Median round mean | Range of round means |
| --- | --- | --- |
| Tracing disabled | 9.96 ms | 9.03–11.82 ms |
| 10% root sampling | 9.42 ms | 9.16–11.17 ms |

The observed difference is within the run-to-run spread. No measurable latency
regression is established by this rehearsal. This is a local native-runtime
overhead check, not a production Lisa speedup or a universal overhead bound.
The replicas share an otherwise quiet machine. The client and receiver share
the harness process.

The bridge receives 407 spans, translates 331 selected observations and filters
76. All 331 are acknowledged by Stats. The queue drains with no drops, retries,
invalid spans or failed HTTP reads. The JSON records harness memory separately
from the application containers. Production receiver memory is checked against
its 128 MiB container limit.

`deploy/orange/platform.test.mts` separately verifies real actor failures,
SQLite timings, source releases, authenticated export, no recursive ingestion,
and 30 successful actor reads after the collector is disconnected. Its 100%
sampling fixture is a correctness test, not the production sampling setting.
