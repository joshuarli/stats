Prefix: DSLP
Next: 14

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
adapter behavior. `health.test.ts`, `services.test.ts`, `deployments-api.test.ts`
and `observe-e2e/` guard health, service management, deployment and observation
HTTP contracts; the live gateway and every endpoint/error combination are not
covered by this inventory. `fixtures/v2/`, `cloudflare/test/ingest/`,
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
at the longer bound. Frame, broader producer and whole-change mutation, and
Worker and browser coverage counts, stay advisory and unrun; mutation CI is
unchanged. Legacy upgrade needs the baseline build; the historical hosted run
supplied it. The existing CI lanes and retention policy are unchanged. Coverage and elapsed-time evidence from
prior runs is in `docs/deslop-ingest-coverage.md` and `docs/deslop-diagnose.md`;
no comparable paired suite-cost measurement is claimed on this busy host.

Test tiers: Edit uses the targeted ingest, binary, producer and Rust
conformance commands in AGENTS.md; Change uses the affected component suite;
Scenario uses local integration and dashboard lifecycle; the explicitly
requested `make test` covers the full local release-shaped suite. Historical
warm cost is about three minutes on macOS, not a current paired measurement.


**Test dispositions (DSLP-4 closed).** Survivors: TypeScript ACK decoder two
unreachable (varint loop); Worker ACK two unreachable (empty-rejection
fallback); Rust ACK none; producer `readAck` three equivalent (count type
checks behind `Number.isSafeInteger`). Producer timeouts: all 35 are detected,
none is an untested behavior. A replay of 61 hand-made mutants of `readAck`
(`packages/producer/src/index.ts:222-258`, `node --test` on
`cloudflare/test/producer/producer.test.ts`, 20 s kill) gave 35 killed, 21
timed out and 5 survived. Rerunning the 21 timeouts showed each printing 1 to
15 failing tests before the process outlived 12 s. The 5 survivors are the
return-type annotation and the `in` and `typeof` checks that
`Number.isSafeInteger` already covers, the same equivalent classes as above.
The hang is test hygiene, filed as DSLP-12 (P3). Retention was proven by one
injected fault: replacing the raw-sample cutoff with `now - 100 *
RAW_RETENTION_MS` at `cloudflare/src/core/installation/installation.ts:494`
failed the Node retention case (1 of 7 in `node/installation.test.ts`) and two
Workerd cases in `history.test.ts` (2 of 22); the file was restored byte for
byte (`cmp`) and both suites passed again. Retention therefore has caught
guards on both runtimes. Wider runtime scope: Node and Workerd are exercised;
Linux agent, deployed Cloudflare and other browser engines are Needs
environment with no local gap shown. No test was added because no important
gap was demonstrated. The one flake seen, a fixed 5 s start deadline in the
Orange SIGTERM cancellation test at load average about 15, is DSLP-13 (P3).

**Dashboard focus finding.** DSLP-10 was observed during the full retry:
the existing back-navigation browser test failed at focus restoration. The
focused test failed twice in ten unmodified runs. Temporary instrumentation
showed the link disconnected at the sole animation frame and connected later;
it was restored byte-for-byte. The fix waits for attachment and cancels its
observer on cleanup while preserving user-selected focus. The same test
passed 20 of 20 runs afterward.

**Dead code.** Knip 6.45.1, configured with the Worker, Node, dashboard,
CLI, bridge, producer, script and test entries, passed its default scan.
The five documented allowlist entries cover captured fixtures, three host
binaries, two observation interfaces retained at an external integration
boundary, and a deliberate alias for distinct bucket concepts. Production mode reports four test-only
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

**Bench.** The local benchmark map covers harness accounting (Edit),
captured collection and producer queue counts (Change), local Workerd,
ingest and dashboard scenarios, and manual Linux agent and private observation
studies. `make bench-list`, `make bench-check`, and `make bench` now select
these workloads; unknown and empty selections fail, Full requires an explicit
flag, and private host studies are excluded with reasons. A dry run wrote no
run directory and an unmet command prerequisite failed before execution. The
Edit harness passed 10 tests; the small collection replay completed with 268
rows in the new window and zero in the repeat, and returned 7,560, 71,240 and
165,536 bytes for its three history windows. This is completion evidence,
not a timing comparison. Full was not run. The host gate reported busy;
absolute performance and the dashboard focus change's paired comparison are
Needs environment. DSLP-11 records the P3 attribution and preflight gap.

**Scorecard and limits.** First-party Rust/TypeScript source under `agent/src`,
`cloudflare/src` and package `src` paths changed from 41,779 to 41,739 lines;
tracked test files under agent, Cloudflare and package test paths remained
32,810 lines. These are newline counts, excluding other scripts and fixtures.
No whole-repository before/after line or branch coverage, paired suite-cost
comparison, or escaped-regression count was measured. Historical Node ingest
coverage was 1,112/1,128 lines and 820/855 branches; Rust wire was 608/625
lines and 126/146 branches. The four historical mutation selections totaled
210 caught, seven equivalent or unreachable, and 35 timeout results across
252 identities; the inventories are distinct, not a repository mutation score. Historical bounded coverage and mutation counts are linked above;
they are not a whole-suite score. The type scan counted 291 TypeScript and
257 Rust matching escape-hatch lines with no source typing change. The dead
code change removed private declarations and no dependencies. One P2 focus
finding was fixed; one P3 type finding and one P3 bench gap remain. No live
Cloudflare, Linux BPF, external fleet checkout, or private performance host
was exercised. The focused browser failure discovered a race that a single
passing run had missed; the repeated run and attachment diagnostic were more
informative than coverage alone. Knip's default entry detection misidentified
real entrypoints and test consumers, so its configured results are retained
with explicit exclusions. No shared fleet or skill file was changed.

**Completion review.** The cumulative diff from `7fc3ff9` was reviewed
against its callers, package entries and the available tests. Review found the
benchmark runner could wait indefinitely; it now bounds workloads and stops
the process group. With a temporary 3000 ms deadline, a deliberately stalled
workload exited 1 and its child was absent; the runner was restored byte for
byte. A second control used a child that ignored SIGTERM and confirmed that
escalation left no child. Edit and Change workloads both passed after the fix. No independent
reviewer was used because this lane is explicitly a leaf. No further defect
was demonstrated. The final full test and lint results belong to the handoff;
performance comparison remains Needs environment.

## Tickets

### DSLP-9 · P3 · Preserve large retry ceilings in Rust producer

- **Area:** producer · retry
- **Where:** packages/stats-producer/src/backoff.rs:6
- **Problem:** A nonzero max_retry_after whose millisecond count exceeds u64::MAX wraps when cast, so a ceiling of u64::MAX + 1 milliseconds becomes zero and eliminates the intended backoff. Config accepts arbitrary nonzero Duration values.
- **Recommendation:** Clamp or compare Duration values without truncating the configured ceiling, and cover the boundary through the producer retry behavior.
- **Fix with:** typing-audit
- **Effort:** S

### DSLP-11 · P3 · Complete benchmark attribution and scenario preflight

- **Area:** bench · observability
- **Where:** bench/run.mjs; bench/README.md
- **Problem:** The local collection replay supplies CPU and work counts, but dashboard and ingest scenarios lack a unified cross-process attribution and automatic freshness check for every external artifact. Native observation and agent studies require named hosts and private fixtures.
- **Recommendation:** Add representative cross-process CPU, allocation and I/O attribution and validate external fixture and artifact identities before scenario runs; retain separate instrumented and timed runs.
- **Fix with:** bench-pyramid
- **Effort:** M

### DSLP-12 · P3 · Producer tests use real retry sleeps, so a failing run outlives the runner deadline

- **Area:** producer · tests
- **Where:** cloudflare/test/producer/producer.test.ts:76-300
- **Problem:** The golden-frame and error-code tests construct the producer without the injected sleep. A fault that makes delivery fail (for example readAck returning null) fails them, and the default real backoff sleep (up to 30 s) is the likely holder of the process, not confirmed per mutant. A hand replay of 61 readAck mutants showed 21 runs that printed at least one failing test and still did not exit within 12 s; Stryker records such runs as timeouts.
- **Recommendation:** Pass the same injected no-op sleep the retry tests use, so a failing producer test exits promptly and the mutation run classifies it as killed.
- **Fix with:** test-audit
- **Effort:** S

### DSLP-13 · P3 · Orange cancellation test has a fixed 5 s start deadline that fails on a loaded host

- **Area:** deploy · tests
- **Where:** cloudflare/test/scripts/orange-deploy.test.ts:305
- **Problem:** The cancellation test waits at most 5000 ms for the stub deployment to reach its blocked state. On a host at load average about 15 the SIGTERM during smoke case failed once with AbortError and passed on the next full make test run; the other seven signal cases passed in the same run.
- **Recommendation:** Wait on the blocked marker with a deadline scaled to the test timeout, or bound the child by its own readiness signal, so the signal-handling assertion is not tied to process start time.
- **Fix with:** test-audit
- **Effort:** S

