# Experimental Rivet / OpenOrange evaluation tests

Explicit experimental coverage for the Rivet 3 / OpenOrange campaign
(docs/CAMPAIGN-RIVET-OPENORANGE.md). These files are opt-in through the shared
runner and never start or install the candidate by themselves; each candidate
fixture checks the pinned bootstrap manifest from `experiments/rivet/` and
fails with the bootstrap command when it is absent. Default selection excludes
this directory. See docs/rivet-openorange-evaluation.md for verdicts.
