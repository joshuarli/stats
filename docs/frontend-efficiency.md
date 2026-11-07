# Frontend efficiency and lifecycle

This reference records the measurement method, baseline tables, and verification results for the dashboard client (`cloudflare/src/client/`).

## Commands

Run these commands from the repository root with the pinned Node and pnpm versions:

```sh
make dashboard-bench BENCH_ARGS="--runs 5 --json --out .work/frontend-browser-baseline.json"
node cloudflare/scripts/bench-bundle.mjs --json --out .work/frontend-baseline.json
node cloudflare/scripts/bench-bundle.mjs --compare .work/frontend-baseline.json
PREVIEW_SCALE=large node cloudflare/scripts/bench-ui.mjs --runs 3 --json --retention 100 --out .work/frontend-retention.json
```

## Method and caveats

- `cloudflare/scripts/bench-bundle.mjs` inspects the built client assets in `cloudflare/.cloudflare/output/v0/workers/default/assets/assets/`, records raw, gzip (level 9 and level 6), and Brotli (quality 11 and quality 5) byte sizes per chunk, walks static and non-entry dynamic import graphs per route, and checks module markers (`uplot`, `projects-trends`, `project-signals`, `observe-issues`, `observe-requests`).
- `cloudflare/scripts/bench-ui.mjs` drives Chromium against `cloudflare/scripts/preview.mjs` under a 150 ms RTT, 1600 kbps downlink, 800 kbps uplink CDP network profile and records five-run medians for cold load and warm SPA navigation across seven route targets: `fleet`, `host`, `projects`, `project` (all collapsible sections closed), `services`, `service`, and `project-open` (`?open=errors,requests`).
- `cloudflare/scripts/preview.mjs` serves static assets without HTTP compression, so `jsBytes` and `cssBytes` in `bench-ui.mjs` reflect raw asset transfer sizes. Compare compressed bundle sizes with `bench-bundle.mjs`.
- Heap measurements call `HeapProfiler.collectGarbage` before `Runtime.getHeapUsage` and `Performance.getMetrics` to record `usedSize` (`heapUsedKb`), `backingStorageSize` (`heapBackingKb`), `Nodes`, `JSEventListeners`, `TaskDuration`, and `ScriptDuration`.
- Server-side Node response times in `previewNodeTimings` are local preview HTTP timings, not `workerd` or Cloudflare edge timings (`workerd` does not expose wall-clock timing inside the Worker execution context).

## Baseline at `576c99d` (F0a)

Environment: Apple Silicon macOS, Node `26.12.1`, Vite `8.3.5` (`pnpm --dir cloudflare build` client + SSR wall time: `139 ms`).

### Emitted chunks

| Chunk | Role | Raw (B) | Gzip-9 (B) | Brotli-11 (B) | Markers |
| --- | --- | ---: | ---: | ---: | --- |
| `index-DzdgVo1H.js` | `entry` | 95,975 | 40,075 | 34,615 | — |
| `ui-C1A3hv8E.js` | `modulepreload` | 63,446 | 24,445 | 22,014 | — |
| `effect-BV0kPjJe.js` | `modulepreload` | 47,105 | 15,396 | 13,835 | — |
| `ProjectPage-Dg9u4SZI.js` | `lazy` | 85,645 | 25,388 | 22,578 | `observe-issues`, `observe-requests`, `project-signals` |
| `shared-Rp-nYvJs.js` | `lazy` | 73,914 | 30,214 | 27,242 | `uplot` |
| `HostPage-CsZ3flOd.js` | `lazy` | 31,748 | 9,105 | 8,167 | — |
| `ledger-load-D9jsLdX3.js` | `lazy` | 24,943 | 7,851 | 7,182 | — |
| `Deployments-BGCNpSAZ.js` | `lazy` | 12,475 | 4,624 | 4,148 | — |
| `ProjectsPage-fqEFTSYV.js` | `lazy` | 10,815 | 3,800 | 3,429 | `projects-trends` |
| `ServicePage-CYL2vHDm.js` | `lazy` | 9,894 | 3,380 | 3,045 | — |
| `ServicesPage-BprpZ6PK.js` | `lazy` | 3,434 | 1,478 | 1,331 | — |
| `Info-DwfrGUyy.js` | `lazy` | 2,995 | 1,298 | 1,150 | — |
| `NotFoundPage-RZ2i1rAm.js` | `lazy` | 502 | 355 | 279 | — |
| `PageHeader-CSvtRoUB.js` | `lazy` | 405 | 264 | 226 | — |
| `DeploymentEvents-BLqzFkBP.js` | `lazy` | 64 | 81 | 67 | — |
| `index-CKgo0eI9.css` | `stylesheet` | 39,017 | 8,149 | 7,320 | — |
| `ProjectPage-9AdNqr7c.css` | `lazy` | 19,832 | 4,003 | 3,558 | — |
| `Deployments-CNU-YOjj.css` | `lazy` | 3,978 | 1,144 | 955 | — |
| `project-CMhgH885.css` | `lazy` | 2,370 | 770 | 648 | — |
| `services-Dnope6AL.css` | `lazy` | 1,646 | 637 | 502 | — |
| `shared-CnsZ1jie.css` | `lazy` | 1,644 | 690 | 545 | — |
| `projects-B3BmKXJ7.css` | `lazy` | 1,565 | 596 | 480 | — |
| **Total JS** | — | **463,360** | **167,754** | **149,308** | — |
| **Total CSS** | — | **70,052** | **15,989** | **14,008** | — |
| **Total all** | — | **533,412** | **183,743** | **163,316** | — |

### Initial route payload graph (`bench-bundle.mjs`)

| Route | JS Raw (B) | JS Gzip-9 (B) | JS Brotli-11 (B) | CSS Raw (B) | CSS Gzip-9 (B) | CSS Brotli-11 (B) | Markers in initial graph |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `fleet` | 206,526 | 79,916 | 70,464 | 39,017 | 8,149 | 7,320 | — |
| `host` | 315,652 | 120,878 | 107,316 | 40,661 | 8,839 | 7,865 | `uplot` |
| `projects` | 331,732 | 127,784 | 113,682 | 46,204 | 10,579 | 9,300 | `projects-trends`, `uplot` |
| `project` | 406,967 | 149,636 | 133,057 | 66,841 | 14,756 | 13,026 | `observe-issues`, `observe-requests`, `project-signals`, `uplot` |
| `projectOpen` | 406,967 | 149,636 | 133,057 | 66,841 | 14,756 | 13,026 | `observe-issues`, `observe-requests`, `project-signals`, `uplot` |
| `services` | 225,430 | 87,316 | 77,093 | 46,206 | 10,526 | 9,257 | — |
| `service` | 232,359 | 89,563 | 79,100 | 47,011 | 10,700 | 9,425 | — |

### Browser route baseline (`bench-ui.mjs`, 5-run medians, default 4-host / 5-project fixture)

| Route | Mode | FCP (ms) | LCP (ms) | Ready (ms) | JS (B) | CSS (B) | API (B) | Reqs (asset / json / history / observe) | Heap Used (KiB) | Backing (KiB) | DOM Nodes | Listeners | Task / Script (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| `fleet` | cold | 1,608 | 1,964 | 2,394.8 | 206,526 | 39,017 | 336,426 | 14 (`5 / 5 / 4 / 0`) | 4,242.3 | 535.2 | 1,253 | 50 | 80.2 / 15.8 |
| `fleet` | warm | — | — | 281.0 | 0 | 0 | 1,102 | 8 (`0 / 4 / 4 / 0`) | 4,701.8 | 554.9 | 2,250 | 73 | 23.4 / 2.3 |
| `host` | cold | 2,364 | 2,568 | 2,601.6 | 315,652 | 40,661 | 68,505 | 14 (`11 / 2 / 1 / 0`) | 5,505.1 | 382.8 | 1,828 | 217 | 132.2 / 26.0 |
| `host` | warm | — | — | 56.9 | 0 | 0 | 301 | 2 (`0 / 1 / 1 / 0`) | 6,677.6 | 712.9 | 4,078 | 315 | 60.2 / 6.4 |
| `projects` | cold | 2,484 | 2,660 | 3,146.4 | 331,732 | 46,204 | 119,246 | 33 (`14 / 4 / 15 / 0`) | 3,565.8 | 434.0 | 560 | 65 | 89.7 / 22.5 |
| `projects` | warm | — | — | 184.7 | 0 | 0 | 4,602 | 18 (`0 / 3 / 15 / 0`) | 4,807.2 | 765.9 | 2,166 | 105 | 29.0 / 4.7 |
| `project` | cold | 2,960 | 3,336 | 3,644.3 | 406,967 | 66,841 | 515,528 | 29 (`16 / 4 / 4 / 5`) | 4,497.5 | 877.9 | 990 | 88 | 91.0 / 27.8 |
| `project` | warm | — | — | 779.1 | 0 | 0 | 29,844 | 12 (`0 / 3 / 4 / 5`) | 5,521.3 | 966.6 | 2,026 | 132 | 36.1 / 7.8 |
| `services` | cold | 1,932 | 1,932 | 1,947.5 | 225,430 | 46,206 | 908 | 14 (`11 / 3 / 0 / 0`) | 2,714.5 | 223.1 | 234 | 45 | 57.1 / 16.6 |
| `services` | warm | — | — | 24.7 | 0 | 0 | 272 | 2 (`0 / 2 / 0 / 0`) | 3,792.1 | 554.8 | 1,390 | 65 | 8.8 / 1.2 |
| `service` | cold | 1,988 | 2,012 | 2,015.8 | 232,359 | 47,011 | 908 | 16 (`13 / 3 / 0 / 0`) | 2,764.8 | 230.0 | 273 | 41 | 55.6 / 15.6 |
| `service` | warm | — | — | 24.5 | 0 | 0 | 272 | 2 (`0 / 2 / 0 / 0`) | 3,008.0 | 234.1 | 447 | 47 | 14.3 / 1.3 |
| `project-open` | cold | 2,968 | 3,420 | 4,147.1 | 406,967 | 66,841 | 553,808 | 32 (`16 / 4 / 4 / 8`) | 6,580.4 | 884.5 | 2,832 | 102 | 130.6 / 37.6 |
| `project-open` | warm | — | — | 1,282.5 | 0 | 0 | 68,124 | 15 (`0 / 3 / 4 / 8`) | 8,581.4 | 973.1 | 5,269 | 160 | 61.8 / 14.2 |

#### Baseline API request lists (cold load)

- `fleet` (9 API requests): `/api/v1/hosts`, 4 `/api/v1/hosts/:id/history?range=1h&kinds=summary,disks,nets,filesystems`, and 4 `/api/v1/hosts/:id/system`.
- `host` (3 API requests): `/api/v1/hosts`, `/api/v1/hosts/:id/system`, and `/api/v1/hosts/:id/history?range=1h&kinds=summary,disks,nets,filesystems,block`.
- `projects` (19 API requests for 3 worker-enabled projects): `/api/v1/hosts`, `/api/v1/projects`, 2 `/api/v1/projects/:id/deployments`, 3 `/api/v1/projects/:id/history?range=1h&kinds=...`, 6 bogus `/api/v1/projects/:id/history?from=0&to=0&kinds=...` before the settled window resolves, and 6 windowed `/api/v1/projects/:id/history?from=...&to=...&kinds=...` for current and previous ledger windows.
- `project` (13 API requests with all collapsible sections closed): `/api/v1/hosts`, `/api/v1/projects`, `/api/observe/stats/health`, `/api/observe/stats/issues?state=open&limit=100`, `/api/v1/projects/stats/deployments`, `/api/v1/projects/stats/history?range=1h&kinds=...`, `/api/v1/projects/stats/deployments/:id/comparison?window=1h` (requested while `deploys` is closed), 2 `/api/observe/stats/objects?from=...&to=...`, `/api/observe/stats/issues/:id/occurrences?limit=100` (requested while `errors` is closed), 2 windowed ledger histories, and 1 month-to-date history.
- `project-open` (16 API requests with `?open=errors,requests`): adds `/api/observe/stats/explore?from=...&to=...`, `/api/observe/stats/traces?limit=100&from=...&to=...`, and `/api/observe/stats/traces/:traceId`.

### Conditional history revalidation (`200` vs `304`)

| Target | Range | Initial Status | Initial Frame (B) | Revalidate Status | Revalidate Body (B) |
| --- | --- | ---: | ---: | ---: | ---: |
| `host` (`lisa`) | `1h` | 200 | 67,568 | 304 | 0 |
| `host` (`lisa`) | `24h` | 200 | 20,048 | 304 | 0 |
| `host` (`lisa`) | `7d` | 200 | 4,880 | 304 | 0 |
| `project` (`stats`) | `1h` | 200 | 9,952 | 304 | 0 |
| `project` (`stats`) | `24h` | 200 | 177,344 | 304 | 0 |
| `project` (`stats`) | `7d` | 200 | 599,144 | 304 | 0 |

### Client history decode baseline (Node `26.12.1`, 15 rounds of 50 operations)

| Case | Frame (B) | Min (µs) | Median (µs) | Max (µs) |
| --- | ---: | ---: | ---: | ---: |
| `m1-max` `1h` `decodeFleetHistories` | 30,296 | 39.64 | 44.33 | 70.23 |
| `m1-max` `1h` `decodeHostHistories` | 30,584 | 42.38 | 49.93 | 60.97 |
| `m1-max` `24h` `decodeHostHistories` | 31,832 | 41.40 | 44.72 | 61.82 |
| `threadripper` `1h` `decodeFleetHistories` | 85,392 | 44.36 | 45.06 | 47.88 |
| `threadripper` `1h` `decodeHostHistories` | 85,688 | 47.34 | 49.98 | 76.76 |
| `threadripper` `24h` `decodeHostHistories` | 249,208 | 90.33 | 94.03 | 192.72 |
| `stats` `1h` `decodeProjectHistories` | 9,952 | 22.73 | 29.25 | 59.64 |
| `stats` `24h` `decodeProjectHistories` | 177,344 | 114.40 | 116.78 | 120.81 |

### Chart baseline (`HostPage`, 11 active `uPlot` instances)

| Metric | Value |
| --- | ---: |
| Initial host navigation to `.chart-plot .uplot` (`chartReadyMs`) | 52.1 ms |
| Active `.uplot` roots on `HostPage` (`activePlotsOnHost`) | 11 |
| Range-switch sequence (`1h → 24h → 7d → 1h`) wall time | 538.2 ms |
| Range-switch sequence CDP `TaskDuration` / `ScriptDuration` | 61.8 ms / 7.2 ms |
| 10 `Fleet ↔ Host` cycles forced-GC heap before / after | 8,863.4 KiB / 13,882.6 KiB (+5,019.2 KiB) |
| 10 `Fleet ↔ Host` cycles backing store before / after | 2,094.7 KiB / 2,094.5 KiB (-0.2 KiB) |
| `.uplot` roots remaining after returning to `FleetPage` | 0 |

### Local preview Node response times (`previewNodeTimings`, 15-iteration medians)

| Endpoint | Payload (B) | Min (ms) | Median (ms) | Max (ms) |
| --- | ---: | ---: | ---: | ---: |
| `/api/v1/hosts` | 636 | 0.25 | 0.42 | 0.80 |
| `/api/v1/hosts/:id/history?range=1h&kinds=summary,disks,nets,filesystems,block` | 67,568 | 2.86 | 3.09 | 4.16 |
| `/api/v1/projects/stats/history?range=1h&kinds=worker,routes,r2,collector,durable-objects` | 9,400 | 0.74 | 0.82 | 1.28 |
| `/api/observe/stats/health` | 335 | 2.60 | 2.70 | 3.02 |
