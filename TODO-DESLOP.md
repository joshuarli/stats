Prefix: DSLP
Next: 9

Deslop campaign backlog ([plan](https://github.com/laputa-systems/stuff/blob/main/docs/campaigns/deslop.md), tier Calibration). One agent works this file with the `deslop` skill: take the lowest-numbered open ticket whose area does not start with `Needs owner ·`. After DSLP-5, work the open P1 and P2 findings, then fill in `## Report` below.

## Report

Diagnose at `6cbab0ef155f6fc999cae8c388f82693a121740d` found no independently reproduced new defect. Risk order, local harness commands, the unproven Rust uploader lead, and review limits are in [diagnose](docs/deslop-diagnose.md). DSLP-7 and DSLP-8 remain known; Types, Tests, and Dead code are pending. Full-suite and mutation evidence is not claimed for Diagnose.

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




### DSLP-7 · P2 · Local macOS make test fails: development test runs setuid ps inside sandbox-exec

- **Area:** deslop · ground
- **Where:** cloudflare/test/scripts/development.test.ts:59; scripts/offline-run.sh:26; Makefile:192
- **Problem:** Since 78de162 the development hot-update test reads the process tree with execFileSync("ps", ...). make test runs it through scripts/offline-run.sh, whose sandbox-exec profile forbids exec of the setuid /bin/ps: `sandbox-exec -p "(version 1)(allow default)(deny network-outbound)" ps` fails with Operation not permitted (exit 71). So local make test exits 2 on every Mac (integration-local is Darwin-only, so Linux CI never runs this test). Reproduced at d06efa5: make -k test leaves this as the only failure.
- **Recommendation:** Read the process tree and RSS without a setuid binary inside the sandbox (for example sample it from outside the sandboxed command, or use a non-setuid source), keep the RSS and no-workerd assertions, and verify make test on macOS.
- **Fix with:** root-cause
- **Effort:** S


### DSLP-8 · P2 · Exercise the legacy upgrade test in CI

- **Area:** deslop · ground
- **Where:** cloudflare/test/local/upgrade.test.ts:39; .github/workflows/ci.yml
- **Problem:** The local upgrade test skips without the built baseline worktree. CI does not prepare that baseline; the baseline CI test job reports one skipped test and Ground reproduced the missing-baseline skip locally.
- **Recommendation:** Prepare a pinned baseline build in CI and verify that the upgrade test runs rather than skips.
- **Fix with:** test-audit
- **Effort:** M

