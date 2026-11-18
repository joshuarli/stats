Prefix: DSLP
Next: 9

Deslop campaign backlog ([plan](https://github.com/laputa-systems/stuff/blob/main/docs/campaigns/deslop.md), tier Calibration). One agent works this file with the `deslop` skill: take the lowest-numbered open ticket whose area does not start with `Needs owner ·`. After DSLP-5, work the open P1 and P2 findings, then fill in `## Report` below.

## Report

Diagnose reviewed core at `6cbab0ef155f6fc999cae8c388f82693a121740d` and
the deployment delta through `20dd37f69ff7283879a9e34ec011d27b15f1482b`.
The [review](docs/deslop-diagnose.md) records the owners, local witnesses
and limits. PR 18 fixed DSLP-7.

The [ingest type inventory](docs/deslop-ingest-types.md) records the existing
strict settings, rejected candidates and witnesses in the TypeScript ingest
component. Other components remain open.

[PR 24](https://github.com/joshuarli/stats/pull/24) closed the legacy upgrade
gap at `843890b`. CI checks out `e58e9885`, builds both pre-schema-8 Workers
with the pinned legacy tools, and supplies the required baseline path.
The local migration suite passed all 41 tests with zero skips. Its
missing-baseline control failed with the intended diagnostic. The hosted
Linux test, lint and macOS dashboard jobs passed.

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
- **Where:** cloudflare/src/ingest, cloudflare/src/binary, cloudflare/test/ingest, agent/src/wire.rs, agent/tests/conformance.rs, cloudflare/test/ui, .github/workflows/ci.yml
- **Problem:** At 843890b the first calibration scope is frame admission, acknowledgement mapping, and producer parity across Worker, Node, and the Rust agent. The ingest, binary, and conformance fixtures establish existing contracts. Browser and history lifecycle checks run in the separate dashboard job. Legacy migration is now executed in Linux CI. Current branch coverage, mutation selections and outcomes, and paired suite cost remain unmeasured. No whole-change gate is installed.
- **Recommendation:** Run make fixtures, make cloudflare-test and make agent-test on the named components. Bound the first mutation run to frame and acknowledgement decisions in TypeScript and emitted wire values in Rust. Record exact identities and unsupported platform decisions. Qualify Worker and Node replay and browser retention separately. Require whole-change controls, platform ownership and suite-cost evidence before closing.
- **Fix with:** deslop
- **Effort:** L

### DSLP-5 · P2 · Dead code: tools and debloat

- **Area:** deslop · dead code
- **Where:** whole repository
- **Problem:** No dead-code scan has run.
- **Recommendation:** Run the deslop Dead code step. Accept: tools clean or allowlisted with reasons; walk-backs filed as Needs owner tickets.
- **Fix with:** deslop
- **Effort:** M
