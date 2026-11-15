# Live cached range acceptance

Stats `05cc14f183f7`, Orange node version 17, Lisa. One authorized tailnet
client runs Chromium 157 at 1280 × 720. Assets and API responses come directly
from production. The five windows contain real retained data.

The probe warms 1h, 6h, 24h, 7d and 30d. It then cycles through those ranges
1,000 times within the same refresh generation. Each range has 200 samples.
Completion requires the warmed request count, identical chart window timestamps,
three charts, an idle overview and two animation frames. Errors are retained.
The browser reports all 1,005 navigation, warmup and cached journeys separately.

| Range | Samples | p95 | p99 |
| --- | ---: | ---: | ---: |
| 1h | 200 | 33.5 ms | 34.4 ms |
| 6h | 200 | 33.6 ms | 34.1 ms |
| 24h | 200 | 33.7 ms | 34.2 ms |
| 7d | 200 | 33.5 ms | 34.0 ms |
| 30d | 200 | 33.5 ms | 34.1 ms |

There are five warmup summary reads and zero measured summary reads. Timing
gates exit 0 before and after the run. [browser.json](browser.json) contains
all samples, actual journey phases, viewport and user agent. This establishes
P1 for the live corpus. It does not establish cold navigation, tenfold scale,
forced-GC heap retention or relative speedup against another application build.
The reported 9.4 MB heap includes retained probe observations.

An earlier diagnostic crossed the five-minute automatic refresh boundary after
874 switches. Its attempted next selection required a new summary and failed
the cached-output check. That run is excluded. The accepted run begins after a
fresh document load and completes inside one generation.

Browser delivery is best effort. A later completeness check found 643 of the
1,005 traces in storage, with reported transport drops. P4 and P7 delivery
acceptance remain open. Local DOM measurements do not prove durable delivery.
