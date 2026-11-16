Prefix: STA
Next: 129

Production measurements quoted below are dated evidence, not a fresh account audit. Work in other repositories and owner acceptance remain open unless explicitly verified.











### STA-128 · P2 · Measure observation overhead after the tenfold fixture is usable

- **Area:** Performance
- **Where:** docs/CAMPAIGN-STATS-PERFORMANCE.md W4; bench/results/2026-11-15-scale-prep-review/README.md; Stuff STUF-87
- **Problem:** P7 freshness passes but enabled instrumentation overhead and collector-failure outcome parity remain unmeasured. The complete tenfold W2 workload is unavailable after the single permitted fixture rebuild failed with native volume fencing. Rechecked during backlog reconciliation: Stuff STUF-87 is still open, and docs/CAMPAIGN-STATS-PERFORMANCE.md explicitly prohibits another rebuild or an automatic campaign restart. Instrumentation cost remains unproven; no CPU or request-latency bound is established.
- **Recommendation:** First resolve STUF-87 in the owning runtime and obtain renewed authority for an isolated exact-output-verified tenfold fixture; preserve the failed fixture and fixed campaign budgets. Then run five interleaved enabled/disabled rounds with representative ingestion and ten real dashboard clients, separating Stats CPU from Engine CPU. Require less than 3 percent CPU and 5 percent latency overhead, preserve failed outcomes, verify collector failure leaves application results unchanged, and report inconclusive when same-variant spread exceeds either threshold.
- **Fix with:** make-it-fast
- **Effort:** M
