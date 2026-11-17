Prefix: STA
Next: 130

Production measurements quoted below are dated evidence, not a fresh account audit. Work in other repositories and owner acceptance remain open unless explicitly verified.











### STA-129 · P1 · Investigate deployment stall and interrupted rollback

- **Area:** Deployment
- **Where:** docs/DEPLOYMENT-STALL-INVESTIGATION.md; deploy/orange/deploy.sh; deploy/deployed-smoke.sh; scripts/step.sh; Makefile deploy
- **Problem:** The owner cancelled make deploy after worker deploy stalled. Its log proves image creation and restart completed, then rollback selected the old image but failed to restart it. Read-only inspection observes old image stats:6cc06db247a3 selected at version 26 while the container runs stats:c9a71b2ba127 with node version 25 and OpenRC reports starting. Public health and data routes answer. Exact original blocked request is unproven. Smoke curl requests lack deadlines and the single progress label hides all deployment phases. P1 assumed for the demonstrated incomplete release and rollback path.
- **Recommendation:** Preserve the cancelled log and inspect selected versus running state. Obtain production reconciliation authorization, then restore the selected image and verify readiness. Independently reproduce blocked HTTP and cancellation with local stubs. Bound smoke requests and rollback, expose deployment substages, and measure the full authorized workflow without skipping release checks.
- **Fix with:** root-cause
- **Effort:** M

### STA-128 · P2 · Measure observation overhead after the tenfold fixture is usable

- **Area:** Performance
- **Where:** docs/CAMPAIGN-STATS-PERFORMANCE.md W4; bench/results/2026-11-15-scale-prep-review/README.md; Stuff STUF-87
- **Problem:** STUF-87 is repaired in merged Stuff PR39. The single fresh preparation verifies all 203,950 events. The first full overhead study aborts in its disabled round after two incomplete browser journeys; a bounded full-length diagnostic does not reproduce them. Distinct per-variant documents fix independently demonstrated delivery-counter contamination. Profiled diagnostics preserve exact outcomes and zero delivery failures, but establish no overhead bound. Native canonical insertion batching passes five component pairs with full readback and reduces median whole-container CPU 38.8 percent; this is not P7 acceptance. Nine Engine-only recovery cycles pass before the tenth TERM exits 1; STUF-90 tracks the unproven lease-fence trigger. Preserve the failed depot and original attempt budgets. Current evidence and next conditions are in docs/STATS-PERFORMANCE-RESUMPTION.md.
- **Recommendation:** Resolve STUF-87 in the owning runtime, then prepare an isolated exact-output-verified tenfold fixture under a bounded ticket-specific attempt budget. Preserve failed state and the original campaign thresholds. Run five interleaved enabled/disabled rounds with representative ingestion and ten real dashboard clients, separating Stats CPU from Engine CPU. Require less than 3 percent CPU and 5 percent latency overhead, preserve failed outcomes, verify collector failure leaves application results unchanged, and report inconclusive when same-variant spread exceeds either threshold.
- **Fix with:** make-it-fast
- **Effort:** M

