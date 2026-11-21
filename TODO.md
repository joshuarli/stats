Prefix: STA
Next: 137

Production measurements quoted below are dated evidence, not a fresh account audit. Work in other repositories and owner acceptance remain open unless explicitly verified.

### STA-135 · P1 · Keep the standby Engine out of its alarm retry loop under host CPU contention

- **Area:** Operations · Engine
- **Where:** docs/openorange.md#standby-incident-2026-11-21; the guest's `live-stats-engine` container; deploy/orange/recovery/stats-recovery-vm.openrc
- **Problem:** On 2026-11-21 Threadripper reached load 68 on 32 cores from unrelated builds plus an 8.5 GB copy onto its 95%-full disk. At 02:10:00 the Engine's storage host refused volume alarms as overloaded; the alarm frontier filled (16 of 16), alarm callbacks and envoy registration missed their deadlines, and three Engine workers spun at full CPU. Ingest returned 503 from 02:10:51 to 03:33. Engine restarts, an Engine CPU cap, and raising qemu's priority did not clear it while the host stayed saturated; once host load fell to 12 the Engine went idle and `native-stats` registered on the first start. The envoy-lost pattern also occurred on 2026-11-20 at 02:41, 09:28 and 10:35.
- **Recommendation:** The VM's cgroup now reserves CPU weight, memory without swap and disk latency (docs/openorange.md#standby-incident-2026-11-21). A 10-minute drill at host load 76–81 passed with baseline latency, and the guest now has 8 vCPUs with the Engine capped at 4. Stuff's `docs/openorange-engine-degradation.md` (2967626c) traces each refusal to source at Rivet `e5ed3911` and ranks the remaining levers: raise `storage.max_background_cold_reads` (4), then `storage.alarms.max_operations` (16), then set `storage.command_timeout_ms` (unset; commands time out at 5 s); code changes to the inventory read edge's retries and RivetKit's fixed 30 s registration limit come last. The full frontier queues rather than refuses, and the 100% CPU spin is not explained by source. Remaining: under INF-11, reproduce the loop in an isolated guest under CPU contention with a profiler, try the config levers one at a time against that reproduction, then apply the winners to `live-stats-engine` through a tracked definition with its limits.
- **Fix with:** root-cause
- **Effort:** M

### STA-129 · P1 · Investigate deployment stall and interrupted rollback

- **Area:** Deployment
- **Where:** docs/DEPLOYMENT-STALL-INVESTIGATION.md; deploy/orange/deploy.mts; deploy/orange/command.mts; deploy/deployed-smoke.sh; cloudflare/test/scripts/orange-deploy.test.ts; Makefile deploy
- **Problem:** The cancelled deployment built and restarted its image, then rollback selected the old image but failed to restart it. Read-only inspection still finds stats:6cc06db247a3 selected at node version 26 while stats:c9a71b2ba127 runs at version 25. The exact stalled request remains unproven. The command now performs early identity checks, displays timed stages, bounds subprocesses and smoke requests, settles in-flight OpenRC transitions before cancellation rollback, verifies restored image and node version, preserves both failures, and avoids the duplicate smoke pass. Stateful tests cover activation failures and real process cancellation on macOS and Linux. No production mutation or end-to-end deployment timing has run. P1 remains assumed for the unresolved live release state.
- **Recommendation:** Obtain the owner's choice of production release and reconciliation authorization. Reconcile Stats without changing the shared Engine, then run one authorized live deployment through the new command, retain phase logs, verify selected and running identity and deployment recording, and measure the complete workflow without skipping release checks. Keep the original stall cause unclassified unless new evidence identifies it.
- **Fix with:** root-cause
- **Effort:** M

### STA-130 · P3 · Deliver observer alerts

- **Area:** Operations
- **Where:** deploy/observer/observer.mjs; docs/openorange.md#independent-observer
- **Problem:** The observer on Threadripper's host records alert transitions with `delivery: unconfigured`, so a sustained health, host or ingest failure reaches nobody. The VM crash watchdog (`673975b`) restarts the standby guest. The owner accepted that a Threadripper outage stops both the writer and the observer, and deferred alert delivery on 2026-11-21.
- **Recommendation:** When the owner names a destination, deliver each outbox transition durably with retry, keeping the token out of argv. A hosted dead-man check would also cover a Threadripper outage.
- **Fix with:** error-model
- **Effort:** S

### STA-128 · P2 · Measure observation overhead after the tenfold fixture is usable

- **Area:** Performance
- **Where:** docs/CAMPAIGN-STATS-PERFORMANCE.md W4; bench/results/2026-11-15-scale-prep-review/README.md; Stuff STUF-87
- **Problem:** STUF-87 is repaired in merged Stuff PR39. The single fresh preparation verifies all 203,950 events. The first full overhead study aborts in its disabled round after two incomplete browser journeys; a bounded full-length diagnostic does not reproduce them. Distinct per-variant documents fix independently demonstrated delivery-counter contamination. Profiled diagnostics preserve exact outcomes and zero delivery failures, but establish no overhead bound. Native canonical insertion batching passes five component pairs with full readback and reduces median whole-container CPU 38.8 percent; this is not P7 acceptance. Nine Engine-only recovery cycles pass before the tenth TERM exits 1; STUF-90 tracks the unproven lease-fence trigger. Preserve the failed depot and original attempt budgets. Current evidence and next conditions are in docs/STATS-PERFORMANCE-RESUMPTION.md.
- **Recommendation:** Resolve STUF-87 in the owning runtime, then prepare an isolated exact-output-verified tenfold fixture under a bounded ticket-specific attempt budget. Preserve failed state and the original campaign thresholds. Run five interleaved enabled/disabled rounds with representative ingestion and ten real dashboard clients, separating Stats CPU from Engine CPU. Require less than 3 percent CPU and 5 percent latency overhead, preserve failed outcomes, verify collector failure leaves application results unchanged, and report inconclusive when same-variant spread exceeds either threshold.
- **Fix with:** make-it-fast
- **Effort:** M

### STA-132 · P3 · Complete benchmark attribution and scenario preflight

- **Area:** bench · observability
- **Where:** bench/run.mjs; bench/README.md
- **Problem:** The local collection replay supplies CPU and work counts, but dashboard and ingest scenarios lack a unified cross-process attribution and automatic freshness check for every external artifact. Native observation and agent studies require named hosts and private fixtures.
- **Recommendation:** Add representative cross-process CPU, allocation and I/O attribution and validate external fixture and artifact identities before scenario runs; retain separate instrumented and timed runs.
- **Fix with:** bench-pyramid
- **Effort:** M
