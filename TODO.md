Prefix: STA
Next: 129

Production measurements quoted below are dated evidence, not a fresh account audit. Work in other repositories and owner acceptance remain open unless explicitly verified.











### STA-128 · P2 · Measure observation overhead after the tenfold fixture is usable

- **Area:** Performance
- **Where:** docs/CAMPAIGN-STATS-PERFORMANCE.md W4; bench/results/2026-11-15-scale-prep-review/README.md; Stuff STUF-87
- **Problem:** P7 freshness passes but enabled instrumentation overhead and collector-failure outcome parity remain unmeasured. The required combined W2 workload cannot run because the single allowed complete-fixture rebuild failed with native volume fencing. No CPU or request-latency bound has been established. P2 assumed for the unresolved production instrumentation cost.
- **Recommendation:** After STUF-87 permits a complete exact-output-verified tenfold fixture, run five interleaved enabled/disabled rounds with representative ingestion and ten real dashboard clients, separating Stats CPU from Engine CPU. Require less than 3 percent CPU and 5 percent latency overhead, preserve failed outcomes, verify collector failure leaves application results unchanged, and report inconclusive when same-variant spread exceeds either threshold. Do not extend the closed campaign budgets.
- **Fix with:** make-it-fast
- **Effort:** M

### STA-122 · P3 · A refresh re-decodes the top-level lists and remounts every row

- **Area:** Concurrency
- **Where:** cloudflare/src/client/Shell.tsx (`createMemo(loadHosts)`), queries.ts (loadHosts/loadProjects/loadServices), api.ts (getJson has no conditional or ETag path for JSON lists), ProjectsPage/ServicesPage/FleetPage rows in <For> keyed by reference
- **Problem:** The manual and automatic refresh re-fetches the top-level lists and decodes fresh objects on every tick, so <For> remounts every row: expanded panels (trend charts), local row state and rows' retention identity are lost on every five-minute tick. The replay harness proves the expand-state loss in the projects overview after a manual Refresh.
- **Recommendation:** Give the /api/v1 projects/hosts/services lists static validators so an unchanged list resolves to the same decoded value (reuse the conditional machinery histories already use), or reconcile the decoded array by identity before handing it to <For>. Verify with the UI harness: manual and automatic refresh must not remount rows or collapse an expanded project row.
- **Fix with:** architect
- **Effort:** M

### STA-123 · P3 · A failed quiet re-ask of a top-level list replaces the whole view

- **Area:** Concurrency
- **Where:** cloudflare/src/client/Shell.tsx (hosts memo), projects and services list memos with the same pattern, and the fleet rows memo tracking the hosts signal
- **Problem:** A failed quiet re-ask of a top-level list (for example GET /api/v1/hosts or /api/v1/projects answering 503) rejects the list memo and every reader rethrows into the nearest Errored boundary, replacing the entire page with the error state and discarding last good data. Verified on 2026-11-13 with the UI harness: a manual Refresh with the host list failing flips the fleet view to the full-page error state, and effectively the projects table behaves the same. The rows memo re-tracks hosts and rethrows with it.
- **Recommendation:** Create the list memos with the same loadQuery retention shape the fleet rows use (return the previous value plus an onError warning) so a quiet re-ask failure keeps the last good data and surfaces a non-fatal refresh warning instead of replacing the view. Verify both completion orders and retain the last good same-key data; keep the fleet page's independent host and row error states intact.
- **Fix with:** lifecycle-concurrency
- **Effort:** M

### STA-125 · P3 · Host-page data tables crush and clip on mobile viewports

- **Area:** Frontend
- **Where:** cloudflare/src/client/pages/HostPage.tsx (Filesystems, Network INTERFACE, Disk DEVICE tables), the table/row layout in those cards, replay goldens lisa-*/m1-max-*/sentry-*/threadripper-*charts-mobile-darwin.webp
- **Problem:** On mobile viewports the host-page data tables collapse to single-character columns and values clip at the card edge: the Filesystems MOUNT/CAPACITY table shows e.g. "5.9%" cut off, the Network INTERFACE table wraps every character ("e/n/0" stacked vertically) and the Disk DEVICE table does the same; m1-max (short interface names) is cramped but legible, desktop renders fine, and the stuff project pages handle mobile well. Reproduced across lisa, sentry, threadripper and m1-max goldens for 1h, 24h and 7d. Related: the FILESYSTEM "Elevated" chip in tiles and host rows sits flush against or beyond the card edge when the capacity value and chip exceed the tile width (see threadripper-24h-tiles-desktop-darwin.webp).
- **Recommendation:** Give the host-page tables the mobile treatment the other dashboard tables get: horizontal scroll within the card (overflow-x auto) or container-query layout that drops/truncates secondary columns (TREND, IOPS READ/WRITE secondaries) below the mobile breakpoint instead of wrapping mid-token, and keep the value cells on one line. Verify with the mobile replay goldens (they can only be regenerated on a host whose rendering matches the committed goldens); bump the tiles/rows layout so the Elevated chip never overhangs its card.
- **Fix with:** refactor-dashboard-ui
- **Effort:** M

### STA-127 · P3 · Linux hosts do not report CPU package or battery power

- **Area:** Agent
- **Where:** agent/src/linux.rs; agent/src/model.rs (Power); fixtures/v2/; cloudflare/src/client/pages/host/Power.tsx; docs/protocol.md; removed Linux power campaign in Git history
- **Problem:** The Linux sampler has no powercap or battery reader, and Power only models GPU energy and system readings. Linux hosts therefore cannot populate CPU package power or discharging-battery power. The old campaign was never started and describes the superseded JSON v1 protocol.
- **Recommendation:** Design Linux power support against the current STB2/STA2 contract and coordinate receiver, fixtures, history and UI changes before agent emission. Read only top-level powercap package zones and discharging batteries; use checked cumulative counters with explicit wrap/reset handling and omit unreadable or incomplete sources. Keep the agent unprivileged and permissions opt-in, document the OpenRC/no-udev case, and defer Linux GPU energy until a reliable GPU-only source exists. Verify Linux behavior and cross-language fixture parity; do not carry forward the obsolete v1 rollout instructions.
- **Fix with:** architect
- **Effort:** L




### STA-38 · P4 · Review the redesigned goldens and the live dashboard

- **Area:** Tests
- **Where:** deployed #/project/stats and #/host/... pages; replay goldens reviewed 2026-11-13
- **Problem:** The dashboard replay goldens were reviewed on 2026-11-13 and yielded STA-125 and STA-126. The deployed project and host pages still need visual acceptance. Production now runs on OpenOrange with tailnet identity; the previous Cloudflare Access prerequisite is obsolete.
- **Recommendation:** From a tailnet device, review the deployed project and host pages and file or fix concrete issues. Imported Cloudflare history is retained data, not current provider collection. Close this ticket when the live pages are reviewed.
- **Fix with:** none
- **Effort:** S


### STA-49 · P4 · Nanoshop route and operation parity needs external verification

- **Area:** Operability
- **Where:** `cloudflare/src/observe/core/nanoshop-policy.ts` (`NANOSHOP_ROUTES`, `NANOSHOP_RPC_METHODS`, `NANOSHOP_OPERATIONS`); Nanoshop's `src/routes/routes.ts` and `src/cloudflare/observe/operations.ts`
- **Problem:** Stats owns static Nanoshop route and operation lists in `nanoshop-policy.ts`. The earlier review found no cross-repository parity check, so route changes could silently fall out of collection. This checkout cannot establish whether Nanoshop has since added that check; reverify the external repository before implementing or closing this item.
- **Recommendation:** In Nanoshop's Stats integration tests, compare its `ROUTES` patterns and `ErrorOperation` set with the exported Stats lists.
- **Fix with:** single-source-of-truth
- **Effort:** S


### STA-79 · P4 · The 45 minute settle time rests on one day of ingestion-lag samples

- **Area:** Data
- **Where:** `cloudflare/src/limits.ts:11` (`PROJECT_SETTLE_MS`), `docs/operations.md` (Verified environments)
- **Problem:** `PROJECT_SETTLE_MS` decides when a missing counter bucket reads as zero. It was set from 2026-11-01 readings only: the newest Worker event was 6.7 minutes old under steady traffic and 22 minutes old in a quiet period. Too short a settle time writes zeros that late rows would have filled, too long delays charts and verdicts. A parity re-run on 2026-11-06 found one bucket (11:10 on 2026-11-05) that stored 44 events against 8 from the source, which the lag explanation does not cover.
- **Recommendation:** Measure the newest-event age against now over several days of traffic, including quiet nights, and change `PROJECT_SETTLE_MS` only if the 99th percentile approaches it. Investigate the 11:10 bucket with `node cloudflare/scripts/check-parity.mjs`.
- **Fix with:** root-cause
- **Effort:** S




### STA-82 · P4 · Service cgroup I/O may count one I/O twice on stacked devices

- **Area:** Data
- **Where:** `agent/src/cgroup.rs:64` (`parse_io_stat`), `docs/protocol.md` (services group)
- **Problem:** The agent sums `rbytes`, `wbytes`, `rios`, and `wios` over every device `io.stat` lists. On a host where a unit's I/O goes through a device-mapper or md device, the same bytes can be listed for the virtual device and for its backing devices, so `service.io` overstates throughput. It has not been measured on such a host.
- **Recommendation:** Read `io.stat` on a host with stacked storage and compare the per-device lines with `iostat`. If devices double count, sum only devices that are not holders of another listed device, and add a fixture for it.
- **Fix with:** none
- **Effort:** M


### STA-83 · P4 · The offline local stack has no Linux network sandbox

- **Area:** Tests
- **Where:** `scripts/offline-run.sh`, `Makefile:228` (`OFFLINE_SANDBOX_CHECK`), `docs/testing.md` (Local stack)
- **Problem:** `scripts/offline-run.sh` exits 2 off macOS, so `make check` runs `make integration-local` only on Darwin. On Linux the stack still fails any undeclared outbound Worker request and removes `CLOUDFLARE_*` and `CF_*`, but nothing denies network to the browser or to `statsctl`, so a Linux run proves less than the macOS one. The Linux namespace alternative has not been verified; this review did not run it.
- **Recommendation:** On a Linux host, run the same commands under `unshare -rn` with a loopback interface brought up, confirm Chromium launches under it, add that branch to `scripts/offline-run.sh`, and drop the Darwin-only condition from `OFFLINE_SANDBOX_CHECK` if it passes.
- **Fix with:** none
- **Effort:** M


### STA-87 · P4 · Whether the Analytics SQL binding bills for the rows the collector reads is unconfirmed

- **Area:** Performance
- **Where:** `cloudflare/src/projects/queries.ts`, `docs/operations.md` (Project collection)
- **Problem:** One collector run reads about 8M analytics rows, plus about 2.2M for D1 when a project lists databases. Operations records the rows read per query but not whether the binding bills for them. Widening the 90 minute window multiplies the reads, and the settle time and parity checks both argue for a wider window.
- **Recommendation:** Read the account's billing or usage view for the binding after a week of collection and record whether reads are billable. Widen the window only after that.
- **Fix with:** none
- **Effort:** S


### STA-89 · P4 · usr-memories snapshot writes and database growth were left unchanged by decision

- **Area:** Data
- **Where:** `cloudflare/cloudflare.config.ts` (`usr-memories` project), the `agent-memory` repository's snapshot write path
- **Problem:** A snapshot POST writes one `snapshot_object` row and one `remote_object` update per referenced object, about 32k each. Eight snapshots wrote about 220k rows per burst, roughly $8 a month at list price over the included amount, or about $3 if `last_referenced_at` skipped unchanged rows. The owner chose not to change it: it touches garbage-collection marking in a backup system, and the per-snapshot object list is a stored-format change. Separately, the database grew about 39 MB an hour at steady state during measurement, which would reach D1's 10 GB cap in about ten days if it continued.
- **Recommendation:** Revisit the snapshot write path if snapshots become more frequent or the object count grows by an order of magnitude. Check the D1 storage chart on the project page for growth against the cap.
- **Fix with:** none
- **Effort:** M


### STA-124 · P4 · windowUsage rebuilds the coverage index per route row in the UI

- **Area:** Performance
- **Where:** cloudflare/src/cost/ledger.ts (windowUsage and fieldFactor), client/pages/project/CostLedger.tsx:306, client/pages/ProjectsPage.tsx:264
- **Problem:** The shared CoverageIndex from STA-121 covers buildLedger and buildCostReport, but the UI's per-row windowUsage calls still construct a fresh CoverageIndex per line (worker, each route, R2, objects, and each D1 line), re-enumerating the whole route history per displayed route on every render. On the stuff capture that is a full 406-series by 720-row enumeration per route line per render.
- **Recommendation:** Thread an optional CoverageIndex into windowUsage and have callers (CostLedger row, ProjectsPage row) reuse one per render window, or precompute per-line windowUsage inputs with a shared index from the report assembly. Keep current and previous histories distinct; preserve the ledger and unknown/partial/known-idle semantics unchanged; verify with the captured stuff test and an operation-count assertion.
- **Fix with:** make-it-fast
- **Effort:** S


### STA-126 · P4 · Merged chart-event annotations label every merged cluster as deploys

- **Area:** Frontend
- **Where:** cloudflare/src/client/components/event-layout.ts (textsOf), TimeChart.tsx (drawEvents), host/shared.tsx (rebootEvents emits ChartEvent with no short), DeploymentEvents.ts
- **Problem:** placeEvents labels a multi-member cluster with the hardcoded texts `N deploys` and the fallback `N`, regardless of what the events are. Host pages emit reboot annotations ("↻ reboot") with no short, so two reboots within mergePx render as "2 deploys" on mobile (sentry-7d-charts-mobile-darwin.webp, every chart) or a bare "2" at the plot edge on desktop (sentry-7d-charts-desktop-darwin.webp) — the annotation reads as a deploy when it is a host reboot. Deploy events on project pages are correctly labeled only because they are deploys.
- **Recommendation:** Give ChartEvent an optional plural (or make textsOf take the caller's cluster noun), have rebootEvents set plural "reboots" and deployment events set "deploys", and keep the numeric fallback as `N reboots` when neither full label fits. Add a unit test for placeEvents with mixed and single-member clusters. Note any canvas text change invalidates the replay goldens; those can only be regenerated on a host whose rendering matches the committed goldens.
- **Fix with:** none
- **Effort:** S

