# Producer boundary verification

Stats `506b622debb4`, Orange node version 19, Lisa. The receiver keeps its
120-batches-per-service-per-minute cap. Queue and retry limits are unchanged.

A controlled transport regression establishes the defect: records arriving
during a send extended the same drain and created a trailing one-event batch.
The fixed producer leaves that event for the next coalescing interval. Explicit
flushes cover their accepted boundary. Shutdown drains preceding events and
cancels timers. The private adapter gives later arrivals their own background
promise. Twenty-three focused tests and the native persistence test pass.

In production, 1,000 cached switches emit 1,005 observations including warmup.
The browser reports 97 dropped observations. All 908 admitted observations reach
storage with unique trace IDs and zero server-producer drops. This is bounded
best-effort delivery, not lossless browser transport. The stress run is not an
interleaved latency comparison against the previous producer.

Cached switch p95 stays below 35 ms in every range, with 200 samples per range
and zero additional summary reads. [browser.json](browser.json) contains every
sample and the zero-exit timing gates. Heap values include probe observations.

A separate paced run emits 200 real cached journeys, with 200 ms between
switches. A 500 ms poll records the first response containing each observation.
Completion and discovery use the same browser monotonic clock. These are upper
bounds on queryability, including polling and response-reading delay.

| Measurement | Result |
| --- | ---: |
| Observations found | 200 / 200 |
| p50 queryability upper bound | 852.2 ms |
| p95 queryability upper bound | 1,448.5 ms |
| p99 queryability upper bound | 1,484.2 ms |
| Maximum upper bound | 1,517.9 ms |
| Browser drops, producer drops, read errors | 0 |
| Mac and Lisa timing gates, before and after | All exit 0 |

[freshness.json](freshness.json) records every observed latency.
[stress-delivery.json](stress-delivery.json) records the separate burst's coverage.
CPU and request-latency overhead against disabled instrumentation, ten clients,
and tenfold data remain separate campaign goals.
