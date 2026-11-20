Prefix: DSLP
Next: 10

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

### Types at 7fc3ff9

The existing strict TypeScript profiles and source lint rules remain adopted;
no new setting met the witness and false-positive rule. The repository
measurements, counts, rejected settings, existing witnesses and platform
limits are in [the type inventory](docs/deslop-ingest-types.md). In particular,
`noPropertyAccessFromIndexSignature` yielded 448/227/18/77 diagnostics in the
four overlapping Cloudflare projects and zero in each package;
`no-non-null-assertion` yielded 380 across source trees. Clippy's all-target
agent/producer counts respectively were unsafe 148/0, wildcard enum 5/0,
single-variant wildcard 0/0, truncation 24/6, sign loss 4/2, unwrap 241/61,
expect 6/0, redundant clone 0/0 and needless pass-by-value 12/4. These include
test and duplicate compilation warnings. The extreme retry-ceiling defect is
filed as DSLP-9; the type inventory explains why blanket truncation lint still
exceeds the false-positive budget. No escape hatch or runtime behavior changed.

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
- **Where:** cloudflare/src/ingest, cloudflare/src/binary, fixtures/v2, agent/src/wire.rs, agent/tests/conformance.rs, dashboard browser lifecycle, and hosted CI
- **Problem:** Worker, Node and Rust share the v2 fixture corpus. Both decoders caught the repeated-sequence accounting fault. docs/deslop-ingest-coverage.md records exact Node ingest and Rust wire coverage and the Worker runtime cases. Linux CI exercises legacy storage migration, and the dashboard job exercises browser and history lifecycle. Broader coverage and mutation remain unqualified.
- **Recommendation:** Measure the remaining Worker and browser branches and select exact frame admission, acknowledgment accounting, producer parity and emitted agent wire decisions. Qualify whole-change controls, the supported platform and consumer boundaries, and paired suite cost.
- **Fix with:** deslop
- **Effort:** L

### DSLP-5 · P2 · Dead code: tools and debloat

- **Area:** deslop · dead code
- **Where:** whole repository
- **Problem:** No dead-code scan has run.
- **Recommendation:** Run the deslop Dead code step. Accept: tools clean or allowlisted with reasons; walk-backs filed as Needs owner tickets.
- **Fix with:** deslop
- **Effort:** M

### DSLP-9 · P3 · Preserve large retry ceilings in Rust producer

- **Area:** producer · retry
- **Where:** packages/stats-producer/src/backoff.rs:6
- **Problem:** A nonzero max_retry_after whose millisecond count exceeds u64::MAX wraps when cast, so a ceiling of u64::MAX + 1 milliseconds becomes zero and eliminates the intended backoff. Config accepts arbitrary nonzero Duration values.
- **Recommendation:** Clamp or compare Duration values without truncating the configured ceiling, and cover the boundary through the producer retry behavior.
- **Fix with:** typing-audit
- **Effort:** S

