Prefix: STA
Next: 116

Production measurements quoted below are dated evidence, not a fresh account audit. Work in other repositories and owner acceptance remain open unless explicitly verified.

### STA-113 · P3 · A retained project ledger makes the successful fallback history request redundant

- **Area:** Performance
- **Where:** `cloudflare/src/client/pages/ProjectsPage.tsx:229–254`, `cloudflare/src/client/pages/project/ledger-load.ts:48–76`
- **Problem:** After a same-window ledger refresh fails, retained ledger histories still win `ledgerHistories() ?? fallbackHistories()`, but the error starts the fallback history request. Its successful response is ignored. Scope and exact-window guards already prevent reuse across another project or window; the remaining issue is redundant work and an unused fallback, carried forward from the frontend review.
- **Recommendation:** Skip the fallback while usable ledger history is retained, or deliberately render its successful result. Preserve the existing subject/window guards and visible refresh warning.
- **Fix with:** make-it-fast
- **Effort:** S

### STA-114 · P3 · A successful fleet-row refresh can clear the host-list failure warning

- **Area:** Concurrency
- **Where:** `cloudflare/src/client/pages/FleetPage.tsx:157–172`, `cloudflare/src/client/queries.ts:26–31`
- **Problem:** Manual refresh starts host-list and row loads together, but both write one `refreshError`. The host-list rejection sets the warning; a later successful row load calls `onError(null)` and can clear it. This inherited frontend finding remains reachable in source; final browser error-boundary behavior was not reproduced in this review.
- **Recommendation:** Keep the two error states distinct or derive the warning after both outcomes settle. Verify both completion orders while retaining the last good same-key data.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### STA-115 · P3 · Client and server independently choose project history bucket widths

- **Area:** Architecture
- **Where:** `cloudflare/src/client/pages/project/ledger-load.ts:16–20`, `cloudflare/src/projects/history.ts:11–16`, `cloudflare/src/projects/history.ts:71`
- **Problem:** The client duplicates the server's 5m/15m/1h/3h widths and 900-point limit to align settled ledger windows. They match today. Changing only one side can align the requested window differently from the returned history and clip edge buckets. This is the remaining maintenance risk from the frontend review, not an observed mismatch.
- **Recommendation:** Share one pure width-selection function and constants, without importing storage or server dependencies into the client. Use the existing range-boundary checks to keep alignment consistent.
- **Fix with:** single-source-of-truth
- **Effort:** S

### STA-101 · P3 · Cloudflare target records no service health probes

- **Area:** Operability
- **Where:** `cloudflare/src/deployments/service-compare.ts` (`This target runs no health probes`), `cloudflare/src/cloudflare/installation.ts` (`probesServices: false`), `cloudflare/src/node/installation.ts` (`probesServices: true`)
- **Problem:** The Cloudflare installation never probes service health URLs, so service pages show `Health probe: unavailable` permanently. Operators get the health URL in `service create` but the dashboard can never show a probe series for services hosted elsewhere.
- **Recommendation:** Probe health URLs on a schedule in the Cloudflare Worker (or record manual `service check` probes as the source) so the comparison has probe rows; otherwise document the limitation and hide the probe tile when `probesServices` is false.
- **Fix with:** architect
- **Effort:** M

### STA-98 · P3 · A retried deployment marker is stamped with its receive time, not the activation time

- **Area:** Data
- **Where:** `cloudflare/src/cli/commands/services.ts` (`statsctl deploy mark`), `POST /ingest/services/:name/deployments`, `docs/integration.md` (rollback markers, `atMs`)
- **Problem:** The integration contract says a rollback marker's `atMs` is the rollback time, but `statsctl deploy mark` has no way to pass one, so the server stamps the receive time. A producer that records a pending marker durably and retries it later (Niceforge `2d4ba07`, tansu's `deploy-sync`) moves the deployment to whenever Stats accepted it, which shifts the comparison windows.
- **Recommendation:** Accept an optional activation time on the marker (`--at-ms`, bounded by the 7-day retention and no more than 5 minutes in the future, as for events) that is part of the marker's identity for the 409 rule, and have producers send the time they recorded at activation.
- **Fix with:** do
- **Effort:** S

### STA-91 · P3 · Block-latency histograms need bpftrace and root on every host

- **Area:** Architecture
- **Where:** `bpf/`, `agent/src/` (`blockLatencyFile`), `README.md` (agent config), `AGENTS.md` (invariants)
- **Problem:** The only latency distribution the dashboard can show comes from the optional `bpf/` bpftrace collector, which needs bpftrace installed, root, and a separate unit that writes `blockLatencyFile`. Almost no host runs it. The unprivileged per-disk means from `/proc/diskstats` hide tails: a few multi-second stalls inside a 15 second interval move a mean far less than they hurt, and a mean cannot show a bimodal device.
- **Recommendation:** Add an opt-in block-latency histogram inside the agent: a pure-Rust eBPF loader (for example `aya`) with an embedded, prebuilt probe, so a host needs no bpftrace and no second service. Loading needs `CAP_BPF` and `CAP_PERFMON` (or `CAP_SYS_ADMIN` on older kernels) and a kernel with BTF, and the agent runs as the unprivileged user `stats`, so grant them with ambient capabilities in the unit, or run a separate helper, and fall back to an absent `block` group when the load fails. It complements the diskstats means and does not replace them. It would supersede the optional `blockLatencyFile` and the `bpf/` collector, which then get deleted. The static musl build, the dependency weight, and the "baseline agent never loads BPF" invariant need an owner decision first: the loader must stay opt-in and out of the baseline path.
- **Fix with:** architect
- **Effort:** L

### STA-100 · P3 · The h12tiny 0.8 upgrade still needs its transitive registry dependencies

- **Area:** Dependencies
- **Where:** `agent/Cargo.toml`, `agent/Cargo.lock`, `agent/.cargo/config.toml`, `docs/dependencies.md` (Agent crates)
- **Problem:** The direct `h12tiny-client-sync` dependency now uses the native `mycrates` registry at 0.7.0. Its normalize and TLS dependencies still resolve through the crates.io mirror. The earlier 0.8 attempt was blocked by those transitive packages; switching the direct dependency's registry alone does not resolve that blocker. The 0.8 mirror availability has not been rechecked in this review.
- **Recommendation:** Recheck the exact 0.8 dependency closure in both registries, import any missing transitive packages, then update and verify the callers and static builds. Delete the ticket if the upgrade is no longer needed.
- **Fix with:** upgrade
- **Effort:** S

### STA-38 · P4 · Review the redesigned goldens and the live dashboard

- **Area:** Tests
- **Where:** `cloudflare/test/ui/replay.spec.ts-snapshots/`
- **Problem:** The 2026-11-01 dashboard rewrite regenerated 16 golden images with `--update-snapshots`. Only the threadripper 1 h charts and tiles and the stuff 1 h charts and tiles were looked at, and only on desktop for stuff. The 24 h and 7 d goldens, the mobile stuff pages, and the deployed page were not.
- **Recommendation:** The replay suite has since grown; inventory its current images rather than treating the original 16 as exhaustive. Open the remaining unreviewed goldens and the deployed `#/project/stats` and `#/host/...` pages, and file or fix anything that reads wrong.
- **Deferred (owner, 2026-11-05).**
- **Fix with:** none
- **Effort:** S

### STA-49 · P4 · Nanoshop does not check its routes and operations against Stats' lists

- **Area:** Operability
- **Where:** `cloudflare/src/observe/core/nanoshop-policy.ts` (`NANOSHOP_ROUTES`, `NANOSHOP_RPC_METHODS`, `NANOSHOP_OPERATIONS`); Nanoshop's `src/routes/routes.ts` and `src/cloudflare/observe/operations.ts`
- **Problem:** Stats generates its matcher and operation set from exported data, but the data is copied by hand from Nanoshop. Nothing fails when Nanoshop adds a route or an error operation: the new route is excluded and the new operation is rejected, losing data silently.
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
- **Problem:** The loop that deploys `stats`, runs `statsctl verify`, and keeps or rolls back on the verdict is run by hand. Its precondition was met: two production verdicts (`improved` and a `regressed` with a named confound) matched their offline predictions, and the `new-issue-group` guardrail now reports a regrouped issue as `confounded`. It stays unscheduled because no cost candidate is left worth a deploy: `stats` runs about $0.29 a month at list price and $0 on the invoice.
- **Recommendation:** Decide whether to schedule it only when a candidate worth a deploy exists. If so, run it as a job that deploys with `make stats-deploy`, verifies with a committed policy, and rolls back on exit 7 to the previously validated version, with a spend ceiling that stops it.
- **Fix with:** orchestrate
- **Effort:** M

### STA-86 · P4 · Deployment polling parses up to 2,000 version payloads to read their ids

- **Area:** Performance
- **Where:** `cloudflare/src/core/installation/installation.ts:377` (`knownDeploymentVersions`), `cloudflare/src/cloudflare/deployments/collector.ts:91`
- **Problem:** Each poll loads every stored version payload only to read its id. At the retention cap that is about 2,000 JSON parses per poll, worth about $0.006 a month at list price, the largest remaining `stats` lead after the ingest path. `deployments.poll` is now observed, but it has no normalized work denominator for a per-work verdict; the historical saving estimate has not been remeasured.
- **Recommendation:** Store the version id in its own column, or select only ids with `json_extract`, and add a `deployments.poll` work field if the saving needs a verdict. Skip it unless poll cost grows; the saving is small.
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
