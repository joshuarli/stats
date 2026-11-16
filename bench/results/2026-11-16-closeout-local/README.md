# Local closeout evidence

P5's scripted overview cases pass on source revision `eb69efb7fb0`.
The suite checks healthy, failing, slow, stale and post-deployment incidents
on desktop and mobile. Missing-data and historical-window cases also pass.
Each case asserts visible context and opens a working investigation target.
The failure and latency cases check the displayed onset bucket.
Stale context displays the last event time.

[overview.json](overview.json) records all 14 cases, their unchanged
10,000 ms timeout and their results. There are no skips, failures or retries.
The longest reported case duration is 2,297 ms.
The run uses Chromium 158.0.8127.18, Playwright 1.65.0 and one worker.
The desktop viewport is 1280 by 720. The mobile viewport is 390 by 844.
The test source checksum and execution timestamp are recorded in the artifact.
The run checkout has an existing uncommitted `pnpm-lock.yaml` change.
The artifact records that lockfile's checksum and modification time.
The campaign leaves the lockfile unstaged.

The Mac host gates exit zero before and after the run.
The configured gate threshold is 0.7 for one-minute load per core.
`perf-gate-ready` prints hot-process diagnostics independently of that verdict.
The gate implementation confirms that those diagnostics do not change its
load-based exit status. The raw gate logs and full Playwright report remain
under `.work/tmp/p5-closeout-20261116/`.

The recorded command is:

```sh
pnpm --dir cloudflare exec playwright test \
  test/ui/application-overview.spec.ts --workers=1 --reporter=json
```

The suite serves local static assets and intercepts incident responses.
Production smoke remains required after the deployment freeze.
The protected production soak continues without modification.

## Existing accepted cohorts

The local audit rechecks the following committed records.
Their original deployment, browser and workload qualifications still apply.

| Goal or component | Verified record | Scope |
| --- | --- | --- |
| P1 cached ranges | [Cached selections](../2026-11-15-live-cached-ranges/browser.json): 200 samples per range, zero measured summary reads, three charts and zero failed journeys | Recorded pre/post gates exit zero. Each range meets p95 below 50 ms and p99 below 100 ms |
| P2 awake reads | [Awake selections](../2026-11-15-live-reads/accepted.json): 200 successful selections for each of 1h, 6h, 24h and 7d, with no errors or cancellations | All four Mac/Lisa gates pass. Sleep remains blocked in Stuff STUF-86 |
| P3 navigation | [Initial documents](../2026-11-15-live-navigation/accepted.json): 200 successful distinct documents, useful-health and chart p95 below their bounds | Normal HTTP asset cache. All four host gates pass |
| P4 attribution | [Coverage](../2026-11-15-journey-coverage/coverage.json): 17 of 17 delivered journeys over one second have paired phases, with no gaps | Observed release cohort. No population or lossless-delivery guarantee |
| P7 freshness | [Queryability](../2026-11-15-producer-boundaries/freshness.json): 200 of 200 emitted observations found, p95 upper bound 1,448.5 ms, zero drops or read errors | All four gates pass. Overhead remains blocked in STA-128 |
| P8 browser heap | [Retained heap](../2026-11-15-browser-retention/retention.json): 527,136 bytes of growth after 200 measured cycles and 20 warmup cycles, with stable DOM/listener counts | Frozen responses and production-extracted assets. Native plateau acceptance still requires W6 |
