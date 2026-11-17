Prefix: STA
Next: 129

Production measurements quoted below are dated evidence, not a fresh account audit. Work in other repositories and owner acceptance remain open unless explicitly verified.











### STA-128 · P2 · Measure observation overhead after the tenfold fixture is usable

- **Area:** Performance
- **Where:** docs/CAMPAIGN-STATS-PERFORMANCE.md W4; bench/results/2026-11-15-scale-prep-review/README.md; Stuff STUF-87
- **Problem:** P7 freshness passes for its recorded cohort. STUF-87 is now repaired in merged Stuff PR39. The ten-browser functional rehearsal verifies exact summaries, 1,024 ingested events per condition and unchanged application outcomes with six failed collector exports. It establishes no overhead bound: Lisa gates are busy and the historical fixture uses retention-clamped windows. The owner requested continuation of the campaign. The single bounded fresh preparation and final study are tracked in docs/STATS-PERFORMANCE-RESUMPTION.md.
- **Recommendation:** Resolve STUF-87 in the owning runtime, then prepare an isolated exact-output-verified tenfold fixture under a bounded ticket-specific attempt budget. Preserve failed state and the original campaign thresholds. Run five interleaved enabled/disabled rounds with representative ingestion and ten real dashboard clients, separating Stats CPU from Engine CPU. Require less than 3 percent CPU and 5 percent latency overhead, preserve failed outcomes, verify collector failure leaves application results unchanged, and report inconclusive when same-variant spread exceeds either threshold.
- **Fix with:** make-it-fast
- **Effort:** M
