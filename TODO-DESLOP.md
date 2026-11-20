Prefix: DSLP
Next: 11

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

**Types at 7fc3ff9.**

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

**Tests inventory at 7fc3ff9.**

Public HTTP contracts: `cloudflare/test/ingest.test.ts` exercises authentication,
frame admission, duplicate and rejection accounting, rollback, limits and ACKs;
`history.test.ts`, `projects-api.test.ts`, `operations.test.ts`, and
`cloudflare/test/node/` guard history, projects, observation, access and Node
adapter behavior. `fixtures/v2/`, `cloudflare/test/ingest/`,
`cloudflare/test/binary/`, and `agent/tests/conformance.rs` guard STB2/STA2
bytes and rejection of malformed input. Dashboard routes and lifecycle are
covered by `cloudflare/test/ui/` including `lifecycle.spec.ts`, `node.spec.ts`
and `project-journey.spec.ts`. These suites do not prove every endpoint/error
combination, browser engine or deployed Access configuration. Live Cloudflare
is Needs environment and was not accessed.

Critical regions are frame admission and transaction accounting, ACK encode and
decode, producer streams, history retention, authenticated routes, and browser
navigation/cancellation. Supported shapes are macOS and Linux agent, Workerd,
Node and Chromium dashboard; Linux agent, deployed Cloudflare and other browser
engines were not newly exercised by this inventory. Acceptance is `make test`
and `make lint`; component commands and named fleet consumers are in AGENTS.md
Verification. Tests run against the checked-out source. Earlier baseline
revisions and exact bounded commands are in `docs/deslop-ingest-coverage.md`.

Historical mutation results are distinct: TypeScript ACK decoding caught
113/115, with two unreachable varint-loop survivors; Rust ACK caught 42/42;
Worker ACK caught 25/27, with two unreachable empty-rejection fallbacks.
Producer stream mutation caught 30/68, three equivalent, and 35 timed out even
at the longer bound. These 35 are unresolved, not equivalent or killed; the
repeated timeout is an untested behavior group and the scope stays outside
retained CI. Frame, broader producer and whole-change mutation remain unrun
advisory regions, as do Worker and browser coverage counts. No new mutation
sweep or boundary test is claimed. Retention is guarded by Workerd
`history.test.ts`, Node `node/installation.test.ts`, and local
`local/collection.test.ts`; retention mutation remains unrun. Wider platform
and runtime scope is unrun, not inferred from Node. Legacy upgrade needs the
baseline build; the historical hosted run supplied it. The existing CI lanes
and retention policy are unchanged. Coverage and elapsed-time evidence from
prior runs is in `docs/deslop-ingest-coverage.md` and `docs/deslop-diagnose.md`;
no comparable paired suite-cost measurement is claimed on this busy host.

Test tiers: Edit uses the targeted ingest, binary, producer and Rust
conformance commands in AGENTS.md; Change uses the affected component suite;
Scenario uses local integration and dashboard lifecycle; the explicitly
requested `make test` covers the full local release-shaped suite. Historical
warm cost is about three minutes on macOS, not a current paired measurement.
No new test was added and no new fault injection is claimed.

**Dashboard focus finding.** DSLP-10 was observed during the full retry:
the existing back-navigation browser test failed at focus restoration. The
focused test failed twice in ten unmodified runs. Temporary instrumentation
showed the link disconnected at the sole animation frame and connected later;
it was restored byte-for-byte. The fix waits for attachment and cancels its
observer on cleanup while preserving user-selected focus. The same test
passed 20 of 20 runs afterward. The full suite must still be rerun at the
final commit.

**Dead code.** Knip 6.45.1, configured with the Worker, Node, dashboard,
CLI, bridge, producer, script and test entries, passed its default scan.
The five documented allowlist entries cover captured fixtures, three host
binaries, two externally consumed observation interfaces, and a deliberate
alias for distinct bucket concepts. Production mode reports four test-only
exports and the observation budget measurement module; tests and measurement
scripts are their consumers, so they remain. `cargo rustc --offline --locked
--manifest-path agent/Cargo.toml --bin stats -- -W unreachable_pub` passed;
all-target Clippy found no dead-code warning. `cargo-machete` was unavailable
(two attempts): Needs environment. Linux-only and BPF-feature dead code was
not checked on this host.

The removed declarations were private module-only CLI target data, dashboard
formatting, scaling and probe helpers, cost wrappers and unused pricing-source
metadata, unused client reexports, and a private bridge type. Repository
source, tests, scripts, configuration and fixtures contain no consumers; the
Cloudflare and bridge packages are private. No package dependency or runtime
entrypoint was removed. Cost tests passed 62/62, bridge tests 5/5, and the
workspace typecheck and lint passed. The observation channel and mark API were
retained, including the captured external producer's use. The debloat review
kept the transactional ingest, bounded producer queues, runtime adapters and
browser lifecycle machinery because their observable guarantees have active
consumers; no live feature or public contract removal is proposed.

## Tickets

### DSLP-9 · P3 · Preserve large retry ceilings in Rust producer

- **Area:** producer · retry
- **Where:** packages/stats-producer/src/backoff.rs:6
- **Problem:** A nonzero max_retry_after whose millisecond count exceeds u64::MAX wraps when cast, so a ceiling of u64::MAX + 1 milliseconds becomes zero and eliminates the intended backoff. Config accepts arbitrary nonzero Duration values.
- **Recommendation:** Clamp or compare Duration values without truncating the configured ceiling, and cover the boundary through the producer retry behavior.
- **Fix with:** typing-audit
- **Effort:** S

