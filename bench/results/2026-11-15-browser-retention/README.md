# Browser retention

Verdict: the browser portion of P8 passes on the deployed frontend.
After 20 warmup cycles, 200 measured navigation cycles retain 527,136 additional
JavaScript heap bytes (0.50 MiB), below the 5 MiB limit. Each cycle enters Stats,
selects all five ranges, waits for nonempty charts, then returns to Projects.
DOM nodes remain at 556 and event listeners at 15. The complete series is in
[retention.json](retention.json).

The harness loads assets extracted from production image `stats:1ea3e6af2dc3`.
It verifies the entry HTML against production and replays frozen, nonempty
production responses over loopback. Browser journey delivery is enabled; the
local server admits 1,319 transport requests with HTTP 202. It does not retain
journey events or response history in the page. Production query latency and
server producer behavior are outside this test.

At every 20-cycle checkpoint, with the project unmounted, CDP forces garbage
collection and reads heap usage and DOM counters. This measures retained memory,
not transient allocation peaks. It is one 200-cycle series on Chrome
157.0.8103.79. No timing or relative-speed claim is made. The 24-hour native
resource soak remains required; this result does not satisfy all of P8.

Run with the pinned Node and an authorized tailnet connection:

```sh
node bench/project-retention.mjs \
  --assets PRIVATE_EXTRACTED_IMAGE/app/stats/assets \
  --origin https://stats.17166969.xyz \
  --cycles 200 --output .work/tmp/retention.json
```

`node --check bench/project-retention.mjs` and the command above exit 0.
An earlier replay omitted the telemetry-enabling response header and is excluded
from acceptance. The accepted run explicitly checks that delivery is enabled
and transport requests occur.
