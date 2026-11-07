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

## Scale fixture and 100-navigation retention baseline (F0b)

`PREVIEW_SCALE=large` synthesizes 24 hosts (spanning 3 fleet pages: 10 + 10 + 4), 12 projects, and 1 service from the repository captures in `cloudflare/scripts/preview.mjs`.

### Browser route baseline (`PREVIEW_SCALE=large`, 3-run medians)

| Route | Mode | FCP (ms) | LCP (ms) | Ready (ms) | JS (B) | CSS (B) | API (B) | Reqs (asset / json / history / observe) | Heap Used (KiB) | Backing (KiB) | DOM Nodes | Listeners | Task / Script (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| `fleet` | cold | 1,600 | 2,364 | 2,386.0 | 206,526 | 39,017 | 1,017,138 | 26 (`5 / 11 / 10 / 0`) | 6,248.0 | 1,196.4 | 2,534 | 74 | 83.9 / 11.7 |
| `fleet` | warm | — | — | 784.4 | 0 | 0 | 2,778 | 20 (`0 / 10 / 10 / 0`) | 6,931.4 | 1,216.4 | 4,806 | 121 | 34.2 / 1.7 |
| `host` | cold | 2,384 | 2,596 | 2,608.4 | 315,652 | 40,661 | 71,685 | 14 (`11 / 2 / 1 / 0`) | 5,528.8 | 382.9 | 1,948 | 217 | 120.4 / 21.7 |
| `host` | warm | — | — | 59.5 | 0 | 0 | 301 | 2 (`0 / 1 / 1 / 0`) | 7,510.1 | 1,374.8 | 5,473 | 339 | 55.9 / 6.2 |
| `projects` | cold | 2,500 | 2,696 | 3,146.7 | 331,732 | 46,204 | 509,099 | 84 (`14 / 10 / 60 / 0`) | 4,494.8 | 750.3 | 940 | 93 | 114.7 / 28.5 |
| `projects` | warm | — | — | 280.8 | 0 | 0 | 336,907 | 69 (`0 / 9 / 60 / 0`) | 6,635.8 | 1,836.6 | 4,267 | 185 | 53.9 / 10.8 |
| `project` | cold | 2,984 | 3,384 | 3,690.9 | 406,967 | 66,841 | 521,898 | 29 (`16 / 4 / 4 / 5`) | 4,512.8 | 877.9 | 990 | 88 | 92.3 / 28.0 |
| `project` | warm | — | — | 779.3 | 0 | 0 | 518,082 | 12 (`0 / 3 / 4 / 5`) | 6,134.1 | 1,622.3 | 2,399 | 160 | 36.5 / 7.4 |
| `services` | cold | 1,928 | 1,952 | 1,962.7 | 225,430 | 46,206 | 4,088 | 14 (`11 / 3 / 0 / 0`) | 2,720.6 | 223.1 | 234 | 45 | 50.3 / 13.6 |
| `services` | warm | — | — | 26.7 | 0 | 0 | 272 | 2 (`0 / 2 / 0 / 0`) | 4,600.1 | 1,216.1 | 2,665 | 89 | 10.0 / 2.0 |
| `service` | cold | 2,016 | 2,028 | 2,040.3 | 232,359 | 47,011 | 4,088 | 16 (`13 / 3 / 0 / 0`) | 2,770.9 | 230.0 | 273 | 41 | 66.4 / 14.9 |
| `service` | warm | — | — | 25.8 | 0 | 0 | 272 | 2 (`0 / 2 / 0 / 0`) | 3,014.1 | 234.1 | 447 | 47 | 15.7 / 1.7 |
| `project-open` | cold | 2,988 | 3,480 | 4,204.4 | 406,967 | 66,841 | 560,178 | 32 (`16 / 4 / 4 / 8`) | 6,563.8 | 884.7 | 2,832 | 102 | 156.1 / 43.3 |
| `project-open` | warm | — | — | 1,287.4 | 0 | 0 | 556,362 | 15 (`0 / 3 / 4 / 8`) | 9,162.9 | 1,628.7 | 5,665 | 188 | 75.7 / 15.6 |

### 100-navigation retention trace (`--retention 100`, `PREVIEW_SCALE=large`)

The trace cycles across 24 hosts (`1h`, `6h`, `24h`, `7d`, `30d`), 12 projects, `ProjectsPage`, and all 3 `FleetPage` pagination pages (`fleetPagesExercised: 3`), recording forced-GC heap and DOM checkpoints every 25 navigations:

| Step | Heap Used (KiB) | Backing Store (KiB) | DOM Nodes | Listeners | `.uplot` Roots |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 6,194.1 | 1,196.5 | 2,534 | 74 | 0 |
| 25 | 38,530.9 | 32,440.8 | 27,544 | 1,035 | 0 |
| 50 | 61,237.7 | 56,966.8 | 50,204 | 1,927 | 0 |
| 75 | 82,866.2 | 84,395.0 | 73,181 | 2,839 | 0 |
| 100 | 105,535.4 | 107,984.3 | 97,023 | 3,767 | 0 |
| Final on Fleet | 104,991.3 | 108,522.8 | 97,229 | 3,771 | 0 |

## Async lifecycle verification and fixes (F1)

`cloudflare/test/ui/lifecycle.spec.ts` exercises 13 lifecycle scenarios using deferred route gates (`createGate`) and Playwright's fake clock (`page.clock`) with zero `sleep` calls:

1. Host A to Host B navigation while Host A's history is deferred: aborts Host A's in-flight request (`requestfailed`) and renders only Host B.
2. Project A to Project B navigation at the same range while Project B's history is deferred: clears Project A's ledger immediately, shows Project B's skeleton, and settles on Project B.
3. Host A to Host B navigation where Host B's history returns `500`: disposes Host A's view and renders only Host B's `<ErrorState>`.
4. Rapid Host A → B → C → A navigation with B and C deferred: aborts B and C and settles on A without late-resolution overwrite.
5. Range change (`1h → 7d → 30d`) across resolution boundaries while `7d` is deferred: aborts `7d` and renders `30d` with its 30-day window.
6. Live, paused, hidden (`document.hidden = true`), visible, and zoomed states across 15-second clock boundaries: issues exactly 1 history request per visible host per tick while live and visible, and 0 while paused, hidden, or zoomed.
7. Manual refresh during an automatic 15-second tick and overlapping `304` conditional revalidation: coalesces cleanly without warning banners or duplicate renders.
8. Auth `401` and malformed history frames during refresh: retains the last good telemetry on screen and surfaces an explicit `<Notice tone="warn">` banner.
9. Route disposal during an active chart load: aborts the in-flight history request and leaves `0` `.uplot` roots.

Confirmed lifecycle defects fixed in F1:

- **Unbounded lazy-route suspension (`Shell.tsx`):** `<main class="content">` rendered `{props.children}` without a `<Loading>` boundary, causing `lazy()` route imports (`HostPage`, `ProjectsPage`, `ProjectPage`, `ServicesPage`, `ServicePage`) to open a root held transaction that blocked `<PageHeader>` and route skeletons until inner telemetry fetches settled. Wrapping `{props.children}` in `<Loading fallback={null}>` lets each route's own `<Loading>` boundaries render headers and skeletons immediately.
- **Unkeyed `<HostView>` (`HostPage.tsx`):** `<Show when={host()}>` was not keyed by `hostId`, so navigating from Host A to Host B reused Host A's component instance and held Host A's telemetry under Host B's `<PageHeader>` during the transition. Keying `<Show when={host()?.hostId} keyed>` (matching `ProjectPage.tsx` and `ServicePage.tsx`) disposes Host A immediately.
- **Refresh error tearing down settled data (`queries.ts`, `FleetPage.tsx`, `HostPage.tsx`, `ProjectPage.tsx`):** A failed `refresh()` rejected the memo's promise even when `previous` telemetry was already settled, triggering `<Errored>` to tear down the active charts/table in addition to showing the `refreshError` `<Notice tone="warn">`. Passing `previous` and `onRefreshError` into `loadQuery` preserves the settled telemetry on refresh failure while surfacing the warning notice.


