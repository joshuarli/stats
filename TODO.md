Prefix: STA
Next: 135

Production measurements quoted below are dated evidence, not a fresh account audit. Work in other repositories and owner acceptance remain open unless explicitly verified.

### STA-129 · P1 · Investigate deployment stall and interrupted rollback

- **Area:** Deployment
- **Where:** docs/DEPLOYMENT-STALL-INVESTIGATION.md; deploy/orange/deploy.mts; deploy/orange/command.mts; deploy/deployed-smoke.sh; cloudflare/test/scripts/orange-deploy.test.ts; Makefile deploy
- **Problem:** The cancelled deployment built and restarted its image, then rollback selected the old image but failed to restart it. Read-only inspection still finds stats:6cc06db247a3 selected at node version 26 while stats:c9a71b2ba127 runs at version 25. The exact stalled request remains unproven. The command now performs early identity checks, displays timed stages, bounds subprocesses and smoke requests, settles in-flight OpenRC transitions before cancellation rollback, verifies restored image and node version, preserves both failures, and avoids the duplicate smoke pass. Stateful tests cover activation failures and real process cancellation on macOS and Linux. No production mutation or end-to-end deployment timing has run. P1 remains assumed for the unresolved live release state.
- **Recommendation:** Obtain the owner's choice of production release and reconciliation authorization. Reconcile Stats without changing the shared Engine, then run one authorized live deployment through the new command, retain phase logs, verify selected and running identity and deployment recording, and measure the complete workflow without skipping release checks. Keep the original stall cause unclassified unless new evidence identifies it.
- **Fix with:** root-cause
- **Effort:** M

### STA-130 · P1 · Supervise the standby writer and alert when Stats is down

- **Area:** Operations
- **Where:** deploy/orange/recovery/stats-recovery-vm.openrc; docs/openorange.md standby record; docs/CAMPAIGN-INFRA-RELEASE.md
- **Problem:** On 2026-11-20 the standby guest's qemu exited at about 13:51 UTC with no recorded cause. `stats-recovery-vm` starts qemu with `start-stop-daemon --daemonize`, so nothing restarted it, and no observer outside Stats noticed the 1 h 50 min outage. The same outage exposed Lisa's DHCP client overwriting MagicDNS, now disabled.
- **Recommendation:** Run the guest under a supervisor that restarts it after an unexpected exit while keeping the graceful guest poweroff on stop, and install it at the next planned stop. Add an external health check on a host other than Threadripper and Lisa that alerts on sustained public-health failure. Record the qemu exit cause if it recurs (keep console.log and the host log).
- **Fix with:** root-cause
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
