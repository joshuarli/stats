Prefix: DSLP
Next: 9

Deslop campaign backlog ([plan](https://github.com/laputa-systems/stuff/blob/main/docs/campaigns/deslop.md), tier Calibration). One agent works this file with the `deslop` skill: take the lowest-numbered open ticket whose area does not start with `Needs owner ·`. After DSLP-5, work the open P1 and P2 findings, then fill in `## Report` below.

## Report

Diagnose reviewed core at `6cbab0ef155f6fc999cae8c388f82693a121740d` and the later deployment delta through `20dd37f69ff7283879a9e34ec011d27b15f1482b`; no new defect was established. [Diagnose](docs/deslop-diagnose.md) records ranked ownership, local witnesses, reused parent verification and limits. DSLP-7 is fixed in PR 18; DSLP-8 and Types, Tests, and Dead code remain open.

## Tickets



### DSLP-3 · P2 · Types: strict profile and typing findings

- **Area:** deslop · types
- **Where:** type checker and lint configuration; Rust/TypeScript sources
- **Problem:** The strict-profile candidates in the deslop skill's tools reference have not been measured here.
- **Recommendation:** Run the deslop Types step. Accept: clean at the adopted profile, escape hatches not increased, witnesses recorded.
- **Fix with:** deslop
- **Effort:** M

### DSLP-4 · P2 · Tests: coverage, boundary gaps, mutation

- **Area:** deslop · tests
- **Where:** test suites and CI
- **Problem:** Coverage and mutation results are unmeasured; no deslop mutation lane exists.
- **Recommendation:** Run the deslop Tests step. Accept: no undispositioned survivor in critical code, the test cost budget holds, and the lane is green where the tools are mirrored.
- **Fix with:** deslop
- **Effort:** L

### DSLP-5 · P2 · Dead code: tools and debloat

- **Area:** deslop · dead code
- **Where:** whole repository
- **Problem:** No dead-code scan has run.
- **Recommendation:** Run the deslop Dead code step. Accept: tools clean or allowlisted with reasons; walk-backs filed as Needs owner tickets.
- **Fix with:** deslop
- **Effort:** M






### DSLP-8 · P2 · Exercise the legacy upgrade test in CI

- **Area:** deslop · ground
- **Where:** cloudflare/test/local/upgrade.test.ts:39; .github/workflows/ci.yml
- **Problem:** The local upgrade test skips without the built baseline worktree. CI does not prepare that baseline; the baseline CI test job reports one skipped test and Ground reproduced the missing-baseline skip locally.
- **Recommendation:** Prepare a pinned baseline build in CI and verify that the upgrade test runs rather than skips.
- **Fix with:** test-audit
- **Effort:** M

