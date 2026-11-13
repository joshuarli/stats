Prefix: STA
Next: 122

Production measurements quoted below are dated evidence, not a fresh account audit. Work in other repositories and owner acceptance remain open unless explicitly verified.






### STA-117 · P3 · Producer batch sizing serializes every growing prefix

- **Area:** Performance
- **Where:** `packages/producer/src/index.ts:186–200,246`, `packages/stats-producer/src/lib.rs:410–435,448–490`
- **Problem:** Both producers clone and encode each growing prefix to enforce the 64 KiB body limit, then encode the chosen batch again. The real TypeScript public flush path with 64 valid events performs 65 batch serializations visiting 2,144 event representations, sends 64 and drops none. The Rust source performs the same repeated work while holding the queue mutex used by record(); Rust contention and production CPU were not measured. Work grows quadratically with events per batch despite the 128-event cap.
- **Recommendation:** Compute a conservative encoded UTF-8 size per normalized event once, including worst-case delivery fields and batch framing, then select the fitting FIFO prefix and encode it once for sending. Preserve byte/event caps, oversized-event drops, retry identity and queue semantics. Compare work at 64 and 128 events and near the byte cap, including multibyte strings; keep sizing outside the shared lock where ownership allows.
- **Fix with:** make-it-fast
- **Effort:** M

### STA-118 · P3 · Overview pages fetch full deployment histories to display the latest deployment

- **Area:** Performance
- **Where:** `cloudflare/src/client/pages/ServicesPage.tsx:91–114`, `cloudflare/src/client/pages/ProjectsPage.tsx:207–220,292–304`, `cloudflare/src/client/pages/project/Deployments.tsx:20–54`, `cloudflare/src/core/installation/installation.ts:835–843`, `cloudflare/src/core/installation/services.ts:308–316`
- **Problem:** Each overview row loads and decodes a complete retained history but uses its first deployment for the latest marker/title. Projects return up to 1,000 deployments plus 2,000 versions; services return up to 1,000 markers. The real project API/decoder probe grows from 1,113 bytes for 3 deployments/6 versions to 344,983 at the caps while selecting the same latest marker. Visible live overviews repeat this fan-out every five minutes. These synthetic payload counts do not establish production latency.
- **Recommendation:** Expose a bounded latest summary, preferably in the existing list responses, and fetch only metadata referenced by that deployment. Preserve empty/unavailable states, ordering and version-label behavior; retain full histories for detail/comparison routes. Resolve the response contract in the linked RFC and prove bounded SQL rows, decoded payloads and overview bytes at retention caps.
- **Fix with:** make-it-fast
- **Effort:** M
- **Design:** docs/rfc/STA-118-deployment-summaries.md

### STA-119 · P3 · Rollout impact copies growing timing distributions for every distinct value

- **Area:** Performance
- **Where:** `cloudflare/src/observe/core/store.ts:1112–1135` (`routeComparisons`), `cloudflare/src/observe/core/store.ts:1188` (`rolloutImpact`)
- **Problem:** The CPU and wall grouped queries rebuild each per-version timing array with `[...previous, pair]` for every distinct value. For n groups this copies n(n-1)/2 previous pairs per distribution. The real rolloutImpact path over synthetic grouped rows grows from 11,577 array-iterator steps at 100 timing values to 1,015,707 at 1,000, including helper iterations. The top-20 route limit applies after construction; retained invocations allow much larger inputs. This proves repeated copying, not a production latency estimate.
- **Recommendation:** Append to arrays privately owned by each version/distribution rather than rebuilding them. Preserve SQL value order, weighted exact percentiles, stage/route grouping and the final top-20 ordering. Compare identical impact results and linear construction work across increasing distinct timing counts.
- **Fix with:** make-it-fast
- **Effort:** S

### STA-120 · P3 · External-event cleanup scans retained history to find expiry and backlog

- **Area:** Performance
- **Where:** `cloudflare/src/observe/core/store.ts:434,959–962,986–990`, `cloudflare/src/observe/core/service.ts:137–140`, `cloudflare/src/observe/cloudflare/store-object.ts:38–40`
- **Problem:** Cleanup counts all expired external events before a bounded deletion, then nextCleanupAt computes `MIN(MIN(received_at, event_at))` across the table. The primary key starts with service/event ID and the time index with service, so these global expiry queries scan retained rows. Real SQLite store cleanup over 10,000 unexpired events deletes none but still produces full-scan plans for both queries; exact-SQL VM work scales linearly at 100,000. External events have seven-day retention without a row cap. This cost is on maintenance alarms, not every ingest, and production latency/billed rows were not measured.
- **Recommendation:** Determine remaining work with a bounded existence/overflow query rather than a full count, and make expiry discovery indexable using time-leading indexes with separate received/event branches or a validated expiry key. Preserve expiry by either timestamp, deduplication, deletion bounds, health counters and next-alarm/backlog behavior. Measure added ingest writes and storage before choosing indexes.
- **Fix with:** make-it-fast
- **Effort:** M

### STA-121 · P3 · Cost reports repeatedly rebuild coverage across all route series

- **Area:** Performance
- **Where:** `cloudflare/src/cost/ledger.ts:170–193,294–318`, `cloudflare/src/cost/report.ts:521`, `cloudflare/src/client/project-ledger.ts:68–74`, `cloudflare/src/cli/cost-load.ts:99`, `cloudflare/test/ui/captures/stuff/`
- **Problem:** Per-route usage normalization repeatedly calls coveredMs for the whole route history; coveredMs enumerates every name and materializes column cells on each call. On the retained stuff 30-day capture with 406 route series and 720 rows, the real buildLedger makes 166,866 route cells() calls. The full buildCostReport makes 169,708 such calls and 4,264 names() calls enumerating 1,731,184 names. The probe preserves the captured monthly total and 68,424 billed Worker requests. planBill alone makes only two Worker and three R2 cell lookups, so the demonstrated repetition is in coverage/report construction, not its bucket arithmetic. Counts are not elapsed timings.
- **Recommendation:** Compute whole-history and per-series coverage once per report invocation and window, and reuse it through usage normalization and report diagnostics. Keep current and previous histories/windows distinct and preserve unknown, partial and known-idle semantics. Require captured parity and partial-coverage tests plus operation-count scaling with routes/rows before reporting a speedup.
- **Fix with:** make-it-fast
- **Effort:** M

### STA-38 · P4 · Review the redesigned goldens and the live dashboard

- **Area:** Tests
- **Where:** `cloudflare/test/ui/replay.spec.ts-snapshots/`
- **Problem:** The 2026-11-01 dashboard rewrite regenerated 16 golden images with `--update-snapshots`. Only the threadripper 1 h charts and tiles and the stuff 1 h charts and tiles were looked at, and only on desktop for stuff. The 24 h and 7 d goldens, the mobile stuff pages, and the deployed page were not. Deferred by the owner on 2026-11-05.
- **Recommendation:** The replay suite has since grown; inventory its current images rather than treating the original 16 as exhaustive. Open the remaining unreviewed goldens and the deployed `#/project/stats` and `#/host/...` pages, and file or fix anything that reads wrong.
- **Fix with:** none
- **Effort:** S

### STA-49 · P4 · Nanoshop route and operation parity needs external verification

- **Area:** Operability
- **Where:** `cloudflare/src/observe/core/nanoshop-policy.ts` (`NANOSHOP_ROUTES`, `NANOSHOP_RPC_METHODS`, `NANOSHOP_OPERATIONS`); Nanoshop's `src/routes/routes.ts` and `src/cloudflare/observe/operations.ts`
- **Problem:** Stats owns static Nanoshop route and operation lists in `nanoshop-policy.ts`. The earlier review found no cross-repository parity check, so route changes could silently fall out of collection. This checkout cannot establish whether Nanoshop has since added that check; reverify the external repository before implementing or closing this item.
- **Recommendation:** In Nanoshop's Stats integration tests, compare its `ROUTES` patterns and `ErrorOperation` set with the exported Stats lists.
- **Fix with:** single-source-of-truth
- **Effort:** S

### STA-77 · P4 · Rollouts have no CI write path

- **Area:** Operability
- **Where:** `cloudflare/src/observe/http/api.ts` (`POST /rollouts`), `cloudflare/src/cloudflare/index.ts` (observe proxy), `docs/observe.md`
- **Problem:** The stats proxy refuses rollout writes on purpose, so only the Cloudflare deployment poll records rollouts. A service deployed outside Cloudflare, or a deploy a CI job wants to record before the poll sees it, has no authenticated way to write one. Choosing the surface is an owner decision: an Access service token on a separate route, or a write token on a future public receiver.
- **Recommendation:** Decide the surface when a non-Cloudflare producer exists. Service deploy markers (`POST /ingest/services/:name/deployments`) already give servers a token-authenticated write; reuse that shape if the decision is to extend it to observed services.
- **Fix with:** architect
- **Effort:** M

### STA-78 · P4 · The stuff site probe reported down once in its first runs

- **Area:** Data
- **Where:** `cloudflare/cloudflare.config.ts:19` (the `site` probe), `docs/operations.md` (Verified environments)
- **Problem:** On 2026-11-01 the `site` probe of `stuff` was down in one of the first five collector runs and returned 200 on every later check. Probes measure from Cloudflare's edge and a failed fetch records down, so a cold-start or edge blip reads as an outage. Whether it recurs is unknown.
- **Recommendation:** Read `kind=probes` history for `stuff` over 7 days. If `site` shows isolated single-bucket downs, decide between keeping the signal as is and requiring two consecutive failures before it scores; if it shows none, delete this ticket.
- **Fix with:** none
- **Effort:** S

### STA-79 · P4 · The 45 minute settle time rests on one day of ingestion-lag samples

- **Area:** Data
- **Where:** `cloudflare/src/limits.ts:11` (`PROJECT_SETTLE_MS`), `docs/operations.md` (Verified environments)
- **Problem:** `PROJECT_SETTLE_MS` decides when a missing counter bucket reads as zero. It was set from 2026-11-01 readings only: the newest Worker event was 6.7 minutes old under steady traffic and 22 minutes old in a quiet period. Too short a settle time writes zeros that late rows would have filled, too long delays charts and verdicts. A parity re-run on 2026-11-06 found one bucket (11:10 on 2026-11-05) that stored 44 events against 8 from the source, which the lag explanation does not cover.
- **Recommendation:** Measure the newest-event age against now over several days of traffic, including quiet nights, and change `PROJECT_SETTLE_MS` only if the 99th percentile approaches it. Investigate the 11:10 bucket with `node cloudflare/scripts/check-parity.mjs`.
- **Fix with:** root-cause
- **Effort:** S

### STA-80 · P4 · The projects page on the Node target points at a Cloudflare config file

- **Area:** Docs
- **Where:** `cloudflare/src/client/pages/ProjectsPage.tsx:98–106`
- **Problem:** The Node server has no project collector, so its project registry is always empty and the page shows "Projects are declared in cloudflare/cloudflare.config.ts." That tells a Node user to edit a file that has no effect on their instance.
- **Recommendation:** Show an empty-state detail that says the target has no project collector when the server reports an empty registry on the Node target, and keep the current text for Cloudflare.
- **Fix with:** none
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

### STA-85 · P4 · The verify loop is not scheduled to run unattended

- **Area:** Operability
- **Where:** `cloudflare/src/cli/commands/verify.ts`, `docs/operations.md` (Verifying a candidate)
- **Problem:** The loop that deploys `stats`, runs `statsctl verify`, and keeps or rolls back on the verdict is run by hand. Earlier production verdicts matched offline predictions, and the new-issue-group guardrail can report regrouping as confounded. Scheduling remains an owner decision. The earlier account prices are historical; this review identifies new local efficiency candidates but does not establish their production savings or authorize an unattended deployment loop.
- **Recommendation:** First measure a candidate on a representative workload. Decide whether automation is worthwhile after that evidence. If scheduled, use a committed verification policy, restore the previously validated version on exit 7, and stop at an explicit spend ceiling.
- **Fix with:** orchestrate
- **Effort:** M

### STA-86 · P4 · Deployment polling parses up to 2,000 version payloads to read their ids

- **Area:** Performance
- **Where:** `cloudflare/src/core/installation/installation.ts:377` (`knownDeploymentVersions`), `cloudflare/src/deployments/store.ts:38–48`, `cloudflare/src/cloudflare/deployments/collector.ts:91`
- **Problem:** Each poll calls `readVersions` only to map the version IDs. A local probe of the real method at the 2,000-version retention cap performs 2,000 JSON parses; the table already has an `id` column. This is avoidable bounded work. Its production CPU cost and monetary saving have not been measured in this review.
- **Recommendation:** Select only the existing `id` column with the current project/worker scope, retention and ordering. Preserve the collector result and confirm the cap-sized probe no longer parses payloads. Profile a representative poll before claiming a production saving; no schema migration is needed.
- **Fix with:** make-it-fast
- **Effort:** S

### STA-87 · P4 · Whether the Analytics SQL binding bills for the rows the collector reads is unconfirmed

- **Area:** Performance
- **Where:** `cloudflare/src/projects/queries.ts`, `docs/operations.md` (Project collection)
- **Problem:** One collector run reads about 8M analytics rows, plus about 2.2M for D1 when a project lists databases. Operations records the rows read per query but not whether the binding bills for them. Widening the 90 minute window multiplies the reads, and the settle time and parity checks both argue for a wider window.
- **Recommendation:** Read the account's billing or usage view for the binding after a week of collection and record whether reads are billable. Widen the window only after that.
- **Fix with:** none
- **Effort:** S

### STA-88 · P4 · The stuff project has no cost baseline since its bench loop stopped

- **Area:** Operability
- **Where:** `cloudflare/cloudflare.config.ts:10` (`stuff` project), `#/project/stuff`
- **Problem:** The loop that made up about 86% of `stuff` requests stopped, so earlier cost and route readings describe it, not the service. Whether the response cache absorbs repeat reads is unchecked: compare `crates` blob requests with `stuff-mycrates` operations.
- **Recommendation:** Take one hour on the project page, rank routes by CPU and R2 operations per request, and file in the `stuff` repository whatever is worth changing. Delete this ticket after that.
- **Fix with:** none
- **Effort:** S

### STA-89 · P4 · usr-memories snapshot writes and database growth were left unchanged by decision

- **Area:** Data
- **Where:** `cloudflare/cloudflare.config.ts` (`usr-memories` project), the `agent-memory` repository's snapshot write path
- **Problem:** A snapshot POST writes one `snapshot_object` row and one `remote_object` update per referenced object, about 32k each. Eight snapshots wrote about 220k rows per burst, roughly $8 a month at list price over the included amount, or about $3 if `last_referenced_at` skipped unchanged rows. The owner chose not to change it: it touches garbage-collection marking in a backup system, and the per-snapshot object list is a stored-format change. Separately, the database grew about 39 MB an hour at steady state during measurement, which would reach D1's 10 GB cap in about ten days if it continued.
- **Recommendation:** Revisit the snapshot write path if snapshots become more frequent or the object count grows by an order of magnitude. Check the D1 storage chart on the project page for growth against the cap.
- **Fix with:** none
- **Effort:** M

### STA-90 · P4 · A current Rust dependency audit remains unrecorded

- **Area:** Dependencies
- **Where:** `agent/Cargo.toml`, `../stuff` crates, `docs/dependencies.md`
- **Problem:** The backlog records no current release/advisory audit for these workspaces. This review did not recheck upstream releases or audit the separate stuff repository; no specific vulnerable dependency is established by this ticket.
- **Recommendation:** Check current releases and advisories in each workspace, then make only justified upgrades compatible with the pinned nightly. Record material dependency decisions in `docs/dependencies.md`.
- **Fix with:** none
- **Effort:** S
