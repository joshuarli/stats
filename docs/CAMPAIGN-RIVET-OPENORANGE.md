# Campaign: evaluate Rivet 3 and OpenOrange

## Status

- **Goal:** decide, with reproducible Stats evidence, whether Rivet 3/OpenOrange
  earns a simpler or faster local loop and a useful non-Cloudflare hosting path.
  A justified rejection is a successful evaluation; adoption is not predetermined.
- **State:** complete, 2026-11-13. R0–R7 executed; evaluation closed with a
  **rejection** (self-host path `reject`; local default `keep-current`).
- **M2 gate:** not green as a single-shot run on this host; five attempts
  failed on four razor-margin timing assertions under co-tenant load (code
  untouched by this campaign; every leg passes on this tree — attempt five
  green through dashboard-test including lint; integration-local green in
  isolation). A sixth attempt is in flight; see the evaluation report for
  the honest accounting. Not `M2 accepted`.
- **Outcome:** the candidate matched the baseline on portable behavior (1444/1444
  parity assertions; byte-identical history across restart; kill/restore/soak
  green) and lost the required self-host behavior D5 (no supported consistent
  export; fresh-namespace restore impossible — only same-namespace stop-the-world
  copy proven). R6 performance verdict is inconclusive (no candidate dev-loop
  harness; the campaign bans building one), so the local-adoption hurdle was
  never evaluated. Verdicts, costs and exit paths:
  [evaluation report](rivet-openorange-evaluation.md#r7--verdict-cleanup-and-close)
  and [two decisions](rivet-openorange-evaluation.md#verdict--two-decisions).
- **Baseline:** unchanged and passing. Reuse [development](development.md), the
  [verification report](dev-loop-results.md) and its raw evidence. `make dev`,
  suite ownership, build freshness, lifecycle and isolation are implemented.
- **Accepted slices:** R0 (scope/pins), R1 (pilot), R2 (accounting), R3 (parity,
  1444/1444 + negative controls), R4 (native control), R5a (kill/restore/offline/
  packaged), R5b (30-min/100-cycle soak), R6 (baseline arm re-measured; candidate
  arm unavailable — inconclusive), R7 (verdict, `report --check` pass).
  **Observed runtime failures:** two full-soak failures (single-host design
  rate-limited under the frozen clock; both retained in raw evidence) — fixed and
  re-measured green. **Parked:** none.
- **Resume:** not applicable — the campaign is closed. Reassess only with a
  supported export from Rivet (see the reassess path in the evaluation report).
- **Needs environment (unchanged):** Linux/musl ABI proof; alarm delivery across
  restart; fresh-namespace export; multi-host durability; receiver backlog under
  load; live telemetry-tail parity.

## Charter

Decide within the bounds below and keep going. Record only decisions that later
slices depend on. This document plans local evaluation; committing this plan is
not permission to deploy, migrate production, or replace the default runtime.
When execution is requested, use local edits, local commits, disposable test
state, and explicitly bootstrapped pinned dependencies. External effects remain
subject to the execution boundary below.

One writer owns shared contracts, manifests, lockfiles, and orchestration.
Parallelism is limited to the disjoint pair specified in Sequence. Use parent-owned
worktrees under `.work/wt/`, logs/state under `.work/`, and the repository's
existing process helpers. Never use `/tmp` or change global tool installations.
Use Conventional Commits scoped to the workstream, with the item ID in the body.
Do not push during campaign execution without a separate explicit grant.

Functional parity comes before optimization. Each slice ends with its focused
acceptance command on the integrated tree; run the existing full gate at M1,
M2, and close. Reuse unchanged evidence with matching inputs. Do not shrink the
suite, turn failures into skips, or regenerate UI goldens to conceal differences.
Invoke the `orchestrate` skill's parent steering checkpoint after each accepted
slice and after two failed attempts. A reproduced candidate incompatibility may
be committed as an isolated negative evaluation result, never described as passing parity.

Each compatibility blocker gets a minimal reproducer and at most **two**
root-cause-backed repair attempts. Then record its upstream version, cause,
retry condition, and affected verdict; stop investing in that path. A second
package combination is allowed only to test a specific identified upstream fix.
No unbounded upstream chase, general platform rewrite, or recurring audit loop.
An acknowledged write loss, repeated request timeout over 30 seconds, process
tree RSS above 4 GiB on the small fixture, or unexplained growth beyond R6's
settled-window bounds is egregious. Give its cause one owner. Apply the same
two-attempt repair bound, then reject or park that path with evidence.

## Decisions

### Owner decisions — November 12, 2026

- **O1:** evaluate Rivet 3 and OpenOrange in Stats; no celld workstream.
- **O2:** assume the new development-loop handoff is complete. Preserve its gains
  and evaluate against that outcome, not the historical audit deficiencies.
- **O3:** value cheaper/faster iterations, a small command surface, offline local
  execution without external S3, and freedom to host outside Cloudflare.
- **O4:** this request authorizes planning and committing the campaign directly
  to Stats. It does not authorize starting a production migration.

### Prescribed decisions

- **D1 — Separate verdicts.** Decide local-default suitability and self-hosting
  suitability independently. A hosting option can be useful without winning the
  edit loop; a fast local runtime does not prove production durability or cost.
- **D2 — Preserve one default.** `make dev` continues to use the completed official
  Cloudflare path throughout this evaluation. Candidate launches are explicit
  experiments, not `dev-celld`/`dev-rivet`/`dev-workerd` product modes. Do not
  switch the default, remove Miniflare/workerd, or create a provider framework.
  A later approved adoption slice would leave one default, not a permanent matrix.
- **D3 — Three comparisons, not three rewrites.** A is the improved Cloudflare
  development path; B is OpenOrange running the actual Stats application; C is
  a small native Rivet storage/lifecycle probe. Use the existing Node/SQLite
  adapter as a diagnostic control for shared core work. C and Node are not
  additional supported developer modes or substitutes for B's Stats parity.
- **D4 — Application boundaries stay portable.** Reuse `InstallationCore`, the
  observation core, SQL/clock/scheduler ports, existing HTTP contracts, and
  producers. Rivet/OpenOrange imports belong only in experimental adapters.
  No database/ORM substitution and no async rewrite of the synchronous core
  merely to accommodate a native SDK. Discover the supported SDK API first;
  an incompatible storage interface is a bounded result, not an invitation
  to implement a blocking bridge or fork the core.
- **D5 — Honest metering.** Cloudflare billing-counter equivalence is not an
  adoption gate. Logical changed records, returned rows, scanned rows, and
  billable writes are different quantities. Application behavior must not
  depend on optional billing instrumentation. Keep trustworthy production
  Cloudflare metering; never price Rivet counters as Cloudflare billable usage.
- **D6 — Honest observability.** Prefer existing application telemetry and
  `OperationSink` boundaries to reproducing Cloudflare's entire tail system.
  An explicit adapter may provide equivalent application events, but must not
  call them Cloudflare platform CPU/tail measurements. Unsupported measurements
  remain unavailable, not zero. No mock may replace the candidate's actual
  ingestion, storage, scheduling, or observed application operations.
- **D7 — No local external service requirement.** Use persistent filesystem/local
  storage supported by the pinned Rivet Engine. No external S3, Redis, Postgres,
  NATS, cloud login, or Docker daemon in the ordinary candidate dev path.
  Necessary local Engine/Services processes count in startup, RSS, CPU, disk,
  teardown, and failure testing. One command need not mean one process.
- **D8 — Bootstrap is separate.** Pin the complete candidate closure and binary
  hashes in an isolated evaluator workspace; keep it out of the normal install,
  lockfile, build graph, and default CI path. Honor current package-manager
  release-age/build-script policies. No `latest`, unreviewed install scripts,
  global override, or package download during serving/testing after bootstrap.
- **D9 — Small experiment budget.** Reuse the completed handoff's supervisor,
  suite registry, build cache, and measurement helpers. Candidate-specific
  adapter/config glue is capped at **800 nonblank, non-test source lines**;
  the native control is capped at **300**. A materially changed upstream runtime
  fork, a third compatibility workaround after two blockers, or exceeding those
  caps is a defer/reject result. Existing shared helpers do not count as new
  glue; moving code to evade the cap does. Report the counted paths and method.
- **D10 — No silent public contract change.** Preserve STB2/STA2, API/auth contracts,
  storage semantics and current application telemetry v1. Internal capability
  metadata and the evaluation report may distinguish unavailable measurements.
  If the current public schema cannot express a capability honestly, omit only
  where its contract permits, or mark that feature blocked. Do not overload a
  numeric field or change a numbered integration-contract section in this campaign.
- **D11 — Synthetic state only.** Candidate state starts empty under
  `.work/rivet-eval/<run>/state`. Reset only an explicitly owned, stopped run.
  Reject symlinks and paths outside that run. Never open the baseline's
  `.work/local/state` from a candidate, copy a live SQLite file, or claim state
  format compatibility. Restore uses supported consistent exports of synthetic
  data. Keep the working baseline and every unrelated worktree.
- **D12 — Closed evaluation outcomes.** Results distinguish passing behavior,
  demonstrated incompatibility, missing environment and cancellation. A failed
  required behavior rejects the affected recommendation after the repair bound.
  An unavailable host limits the verdict without becoming passing evidence.
  Cancellation unwinds owned resources and retains diagnostics for resumption.
  Positive evidence never comes from a timeout, empty selection or both sides
  returning the same error.

### Delegated choices and tie-breaks

R0 selects one published OpenOrange bundle with its supported RivetKit/Engine
closure and one matching native Rivet 3 control. Record resolved versions, not
just package declarations. A prerelease SDK is allowed only when required by the
chosen upstream bundle, explicitly recorded, and permitted by existing install
policy; never force a stable SDK underneath it. Prefer a supported published
bundle over a custom source build. Keep Stats' Node/pnpm pins unless a concrete
incompatibility is proven; isolate an experimental toolchain rather than
upgrading the application to rescue a candidate.

Start with published `open-orange@1.0.1`, whose registry metadata selects
`rivetkit@3.1.2-rc.1`, `@rivetkit/engine-cli@3.1.2-rc.1` and optional
`@rivet-dev/services@^0.2.5`. The Services version is independent of the SDK
version. Resolve that range once under existing release-age policy, lock the
complete isolated closure, and record the actual executable versions/hashes.
This metadata check proves publication, not installability or runtime behavior.
The Engine CLI lists macOS x64/ARM64 and Linux x64/ARM64 musl packages.
Services 0.2.5 lists macOS x64/ARM64 and Linux x64/ARM64 GNU packages.
An Engine target therefore does not establish the Services ABI or complete
candidate target support. Do not add a libc shim or binary-build workstream
to rescue an unsupported target. Record the exact target limitation.
Use a different bundle only for a demonstrated blocker and the one permitted
fix-specific comparison. Honor existing build-script policy without adding a
global exception. A required binary that cannot be bootstrapped under policy
is a precise blocker, not permission to enable arbitrary install scripts.
Bootstrap uses `pnpm --dir experiments/rivet --ignore-workspace install`, with
an evaluator-local manifest, policy and lockfile. Carry over the effective
release-age floor and build allowlist before resolving. Do not copy unrelated
package exceptions or weaken the inherited floor. Verify the application
manifests and lockfile hashes are unchanged. Subsequent runs use the isolated
frozen lock and make no network requests. A toolchain mismatch is a clear error.

Choose the smallest supported configuration translation and lifecycle adapter.
When several methods pass, prefer less maintained code, fewer processes, and
reuse of existing commands; then measured iteration time. When evidence is tied,
noisy, or incomplete, keep the current default. Do not retune acceptance thresholds
after observing the winner.

## Baseline and evidence limits

The planning checkout contains a portable Node/Cloudflare core and a documented
external application-event ingestion path. Its SQL interface exposes synchronous
operations and numeric meters. This makes a bounded compatibility experiment
plausible; it does not prove a native Rivet adapter or OpenOrange can execute it.
The source map identifies the current implementation paths.

The existing [full gate and measurements](dev-loop-results.md) supply the
post-handoff reference. Five alternating clean trials measured 903 ms median
warm readiness, 134 ms frontend edits, 1261 ms Worker edits and 114 ms unchanged
builds. The measured Cloudflare revision is `c63f2ce`; later fixes and their
attribution limits are recorded there. Do not treat those numbers as a fresh
R0 run or infer a candidate result from them. Reuse unchanged correctness
evidence, and rerun comparable A/B timings at R6. Do not repeat the old audit
or upgrade the dependency family as an entry fee.

The existing ingest conformance plus Worker/Node parity selection has executable
evidence on Node 26.13.1 at `3c5bab6`. The selection passes four cases, including
real persisted history. One invocation takes 3.00 seconds including one necessary
stats build. The exact command is
`node cloudflare/scripts/run-tests.mjs --file test/ingest/conformance.test.ts --file test/node/parity.test.ts`.
This is a loop check, not a performance comparison.

A real `nodeSqlScopes` probe with an `AFTER DELETE` trigger deletes one logical
record while `rowsWrittenBy` returns two, because Node counts the trigger write.
The same probe confirms rollback leaves no inserted row. It runs in 0.05 seconds.
`SqlDatabase` is synchronous and mandatory numeric meters currently drive
retention/cache decisions. R2 must separate those meanings before a candidate
can claim equivalent behavior. This is a demonstrated semantic distinction,
not evidence of production data loss or a new public-contract requirement.
Reproduce the pre-repair distinction from the repository root:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { nodeSqlScopes } from './cloudflare/src/node/sql.ts';
import { rowsWrittenBy } from './cloudflare/src/operations.ts';
const db = new DatabaseSync(':memory:');
try {
  db.exec('CREATE TABLE records (id INTEGER); CREATE TABLE audit (id INTEGER); CREATE TRIGGER deleted AFTER DELETE ON records BEGIN INSERT INTO audit VALUES (old.id); END; INSERT INTO records VALUES (1)');
  assert.equal(rowsWrittenBy(nodeSqlScopes(db).open(), 'DELETE FROM records'), 2);
  assert.equal(db.prepare('SELECT changes() AS n').get().n, 1);
} finally { db.close(); }
JS
```

R2 replaces this diagnostic with behavioral regression coverage for logical
counts and scheduling. Do not preserve the coupling to keep this diagnostic green.

Record any baseline failures once with exact command, revision, environment and
whether they intersect this evaluation. Current TODO state wins over historical
handoff issue numbers. If the executor has the wrong/pre-handoff checkout, park
baseline comparison pending the completed revision; do not silently implement
that separate campaign or report a candidate speedup against stale infrastructure.

Two **candidate hypotheses**, rather than assumptions of a positive verdict,
must be exercised early:

1. Pinned OpenOrange can run the actual Stats ingestion/history path on durable
   local state without credentials, remote services, or executing workerd.
2. Application-observation and mutation semantics can be preserved with a small,
   explicit adapter rather than a replacement Cloudflare platform.

R1 proves or rejects the first with a real pilot; R2/R3 address the second.
An unsupported candidate is a valid bounded evaluation outcome. Source inspection,
the Node control and a hello-world actor do not discharge candidate parity.

## Sequence

The commands below are **planned interfaces**, not commands claimed to exist
already. R0 adds a thin `scripts/rivet-eval.mjs` dispatcher over existing helpers;
subcommands are implemented only as their slice lands. Keep candidate code and
its isolated toolchain in `experiments/rivet/`, tests under
`cloudflare/test/rivet-eval/`, raw evidence in `.work/rivet-eval/<run>/`, and a
compact final report at `docs/rivet-openorange-evaluation.md`. Make the existing
suite inventory list these tests as explicit experimental coverage. Do not add
another hand-maintained test-file registry or an unconditional default-CI job.
R0 owns the narrow `cloudflare/scripts/test-suites.ts` registration for this
directory, with `optIn: true`. Candidate fixture startup checks its pinned local
bootstrap manifest before spawning and fails with the bootstrap command if absent.
Listing tests never starts or installs the candidate. Default selection must
continue excluding experimental files, including when they intentionally retain
a demonstrated incompatibility. The dispatcher uses the shared runner's file
and name selection, real execution counts and process owner.
R0 also adds `node scripts/rivet-eval.mjs bootstrap --json` as the only
network-capable dependency-install command. Every measurement/test command fails
on missing prerequisites rather than installing or resolving updates implicitly.
Keep the initial dispatcher at most 150 nonblank source lines, forwarding to
existing helpers and the first pilot. Do not build future subcommands, a schema
framework or a result dashboard before R1. Record unsupported subcommands as
explicit errors. Add later commands only when their owning slice needs them.

| Item / size | Prerequisites | Owned files / outcome | Local acceptance command |
| --- | --- | --- | --- |
| **R0 / S — freeze the improved baseline** | Completed handoff | Dispatcher, evidence manifest, evaluator dependency policy; reuse existing suite/build/dev helpers | `node scripts/rivet-eval.mjs baseline --json` |
| **R1 / M — real OpenOrange pilot** | R0 | `experiments/rivet/openorange/`, generated config adapter, isolated pins, pilot tests | `node scripts/rivet-eval.mjs pilot --candidate openorange --json` |
| **R2 / S — separate behavior from meters** | R1 pilot or demonstrated relevant blocker | Shared SQL/mutation boundary, retention consumers and focused regressions; coordinator alone | `node scripts/rivet-eval.mjs accounting --json` |
| **R3 / M — complete the required Stats slice** | R1, R2 | Candidate observation adapter and full required parity corpus, existing auth/analytics fixture composition | `node scripts/rivet-eval.mjs parity --candidate openorange --json` |
| **R4 / S — native Rivet control** | R0; R1 establishes version/runtime identity or records its blocker | `experiments/rivet/native/`, native-only tests and result file | `node scripts/rivet-eval.mjs native --json` |
| **R5a / M — offline lifecycle and packaged self-host** | R3; independent native checks follow R4 even if B is rejected | Failure, restore, network and packaging tests and self-host manifest | `node scripts/rivet-eval.mjs resilience --quick --json` |
| **R5b / S — bounded soak** | R5a for each surviving path | Soak fixture and retained resource/acknowledgment evidence | `node scripts/rivet-eval.mjs resilience --soak-minutes 30 --reloads 100 --json` |
| **R6 / M — measure and optimize only proven paths** | R3, R5a, R5b for B performance conclusions | Existing bench-dev integration, candidate-only small fixes, raw measurements | `node scripts/rivet-eval.mjs bench --pairs 7 --json` |
| **R7 / S — verdict, cleanup, close** | Every local item accepted, rejected with evidence, or explicitly parked | Report, minimal reproducible probes, dependency cleanup and this Status | `node scripts/rivet-eval.mjs report --check --json` and `make check` |

Run **M1** (`make check`) after R2/R3 are integrated, **M2** after
R5b, and the full required candidate corpus at both milestones. If B is rejected
early, skip its dependent implementation/bench work explicitly, still complete
the bounded native control, report, and unaffected baseline gate. Rejection does
not turn a failing candidate test into a passing test.

Default execution is serial. After R2 fixes the shared contracts, **R3 and R4 may
run in parallel** only if R4 owns exclusively `experiments/rivet/native/` and its
native-only tests/result file. Freeze shared versions first; the coordinator
alone changes the dispatcher, shared schemas, root configuration, and lockfiles.
Never run competing performance jobs in parallel.
Routine focused commands target five minutes or less. If a command exceeds that
bound twice, isolate the smallest decisive case before adding more machinery.
The 30-minute soak and seven-pair benchmark are announced milestone checks,
not the edit loop. Time them separately and never substitute a quick smoke
for their required evidence.

### R0 — evidence and scope, not another tooling campaign

Reuse the handoff's readiness/build identity, test selection and bench-dev output.
Capture revision/dirty state, lock hashes, fixture identity, hardware/OS/arch,
Node/pnpm, runtime paths and versions, SQLite version/options, test counts,
compilation counts and network enforcement. Discover the actual Engine and
Services executables selected by the SDK. Record dependency versions separately
from processes that execute; Wrangler in a dependency tree is not proof that
workerd ran, and a wrapper's version is not the Engine version.

Create one behavior register from existing contracts/tests with categories:
portable application, Cloudflare-specific sensor/billing feature, dev lifecycle,
and self-host operation. Each row has its oracle, test, required/optional status,
intentional difference and result. Freeze required/optional classifications before
seeing candidate results; a failure cannot reclassify a required behavior. Every
required row must eventually execute for a positive verdict.
Record CLI exit codes, auth failures, ordering, persisted effects, and errors,
not just successful response bodies. Keep the register small by referencing
existing test groups rather than duplicating their cases.

Use host-side monotonic timing for the completed baseline's cold/warm readiness,
backend edit, observation edit, frontend HMR, pure focused test and built-artifact
focused test. Baseline correctness must be meaningful before timing it. R0 may
add a missing wrapper/measurement, not redesign the already-completed dev loop.

**Exit:** attributable post-handoff baseline, complete required-behavior inventory,
known-red list, exact candidate pins/checksums or a precise bootstrap blocker.
A missing baseline means performance remains inconclusive, not that R0 succeeded.

### R1 — an end-to-end pilot before building the evaluator out

Translate the authoritative built/configured Worker descriptors into the pinned
OpenOrange input format. Generate both Stats and observation topology; preserve
exports, SQL DO identities, service bindings, assets/auth ordering, compatibility
flags, triggers and required modules. No second hand-written production config.
Reject unknown/unmapped fields before launching; explicitly bind the offline
analytics provider, and fail on unknown query text/parameters. Remote Analytics
SQL is not Analytics Engine and not an automatically available local binding.

Launch one candidate session on loopback with private persistent state. Seed
only empty state through existing fixtures. Exercise authenticated host creation,
a valid STB2 batch, byte-correct STA2 acknowledgment, a duplicate retry, a
conflicting retry, a history response through the real decoder, restart and the
same history again. Assert actual persisted records and expected status codes.
Prove that corrupting an acknowledgment or dropping a write makes the pilot fail.
No dashboard screenshot, happy health response, or toy actor substitutes for this.

**Exit:** real Stats path and restart pass, no unexpected outbound traffic,
no workerd executable launched in the candidate process tree, no external S3.
Count all Engine/Services/app processes. R1 may initially enumerate telemetry
as unproven, but cannot claim full Stats parity until R3 closes it. A fatal
required binding/storage gap after two repair attempts rejects B early.

### R2 — remove the actual accounting coupling, minimally

Audit every counter used for control flow, especially `rowsWrittenBy`, retention
batch fullness, cache invalidation and project cleanup. Use affected **primary
records** or an explicit bounded remaining-work check for application decisions.
Prefer bounded DML `RETURNING` where supported or a narrowly specified adapter
result; neither metered index writes nor trigger-inclusive totals may masquerade
as deleted application rows. Do not rename a billing counter and leave its
semantics unchanged. Reuse any fix already completed; do not redo it.

Test deletion cases 0, 1, 999, 1000 and 1001 against both existing SQL adapters
and the candidate where available. Add an index/trigger and vary or remove
optional metering: cache invalidation, retained data and cleanup scheduling must
remain correct. Cache invalidation follows actual committed mutation, not an
instrumentation estimate. Verify transaction rollback and stale-history reads.

This slice may change internal SQL and operation ports with their callers and
tests. It may not change persisted schemas, public producer types or wire data.
Use a typed internal capability/result when availability changes. Keep malformed
external values at the adapter boundary. Reuse existing clocks and schedulers,
and keep Rivet imports out of `cloudflare/src/core/` and its dependency graph.
If truthful candidate instrumentation cannot pass the existing public contract,
mark that feature blocked and apply the verdict rules. Do not emit fabricated
`OperationRun` rows through Cloudflare summaries to keep the path running.

Keep Cloudflare's genuine meters for Cloudflare reports. Evaluation metrics carry
backend, measurement meaning and availability. Test that unavailable read scans
or CPU never become zero, that returned rows are not reported as scanned rows,
and that Cloudflare cost projection refuses non-Cloudflare metering. Do not
change public telemetry v1 to make these tests convenient. Any portable repair
lands separately with the narrowest existing suites and M1, even if B is later
rejected; candidate-specific code stays isolated.

### R3 — preserve product quality without emulating every Cloudflare service

Complete the following required corpus against A and B, with identical inputs
and independently isolated state. The actual existing tests/oracles take priority
over approximate new assertions. Normalize only declared nondeterminism such as
fixture IDs and clocks; never normalize away missing data or incorrect errors.

| Required area | Proof |
| --- | --- |
| Wire, ingestion, exactness | STB2/STA2 fixture parity, malformed whole-frame rejection, exact u64/bigint boundaries, canonical duplicate identity and conflict behavior |
| SQL and history | Transactions/rollback, dedupe, out-of-order inputs, current rollups, time boundaries, history bytes/decoded values, ETags and post-mutation cache invalidation |
| Scheduling and recovery | Persisted alarms, maintenance after restart, no lost scheduled cleanup, bounded backlog draining; real scheduler delivery, not only calling the handler directly |
| Auth and routing | Valid/invalid local auth fixtures, protected API and assets, token-free responses/logs, service isolation and no unauthenticated direct actor/control-plane bypass on exposed surfaces |
| Offline collection | Existing deterministic Analytics SQL/probe/deployment fixtures; unknown request/query fails; remote metadata is not silently fetched |
| Observation | Actual candidate operations and failures arrive, are attributed to the correct service/release, deduplicated, retained and visible in the supported API/dashboard; gaps are explicit |
| Application producers | Current `/ingest/observe/v1/:service/batches` contract: retries, idempotency/conflicts, caps, rejection, service scope, provenance and deployment comparison |
| UI/CLI | Existing seeded dashboard routes and focused CLI workflows preserve data, missing states, auth and errors; existing WebP goldens remain the reference |

First exercise OpenOrange's real tails, then use one explicit application-event
adapter for missing interior DO/operation events if necessary. Reuse the existing
producer, ingestion contract and `OperationSink`; do not build a general tracing
platform or patch every callsite. Keep `provenance: application` and
application duration distinct from platform wall/CPU. External event work fields
may convey correctly named logical counts, not invented billable figures.
Do not route both a tail and an application event into the same counter twice.

Test at-least-once redelivery, overlapping requests, receiver failure/recovery,
bounded queues/backpressure, dropped-event reporting, token redaction, and
suppression of recursive self-observation. A selected user operation must not
silently disappear just because its DO event is not traced upstream. Where
Cloudflare-specific per-invocation CPU or billing cannot be collected, require
correct unavailable UI/report behavior and preserve the deployed Cloudflare path.
Do not equate that deliberate sensor difference with complete Cloudflare parity.

**Exit:** every required portable/product row passes; every platform-specific
exception is named, tested for honest presentation, and excluded from comparisons
that require it. Lost essential observation or excessive adapter cost rejects B.

### R4 — measure the platform underneath the compatibility layer

Use one native Rivet actor with the same representative SQL statements and fixture
values as the pilot: persist a bounded batch, query it, reject/roll back a failed
transaction, schedule work, sleep/wake where supported, restart and read again.
Use its real persistent storage, not an unrelated Node database behind an actor.
Confirm durability acknowledgment and ordering from the pinned implementation.
If its supported DB interface cannot satisfy Stats' synchronous ports, demonstrate
that limitation with the small SQL probe; do not port the whole core to async.

Reuse Node/SQLite as a same-SQL diagnostic control. Compare only the common work;
a tiny actor result cannot claim superiority over the complete Stats application.
Report the cost of native API adoption and missing application integration.
Native success plus B failure means "platform promising, compatibility path not
ready", not "Stats on Rivet passed".

Actor forking is **optional and bounded to one probe**, after the required native
pilot: fork a seeded actor, independently mutate parent and two children, restart,
and verify isolation. Record clone time and storage growth. Test only documented
supported behavior; no copying live SQLite files. A per-actor fork is not an
atomic snapshot of Stats plus observation actors, credentials, alarms and streams.
Failure or absent support does not block the main evaluation.

### R5a/R5b — restart, offline, growth and an actual packaged process

Reuse worktree/run identities and cancellation from the handoff. Run two isolated
sessions; verify no shared ports, resource IDs, files, seed data or cleanup.
Test frontend-only HMR, main/observe edits, burst edits, syntax error then fix,
startup/activation failures, and SIGINT/SIGTERM. Normal edits retain state and do
not reseed. No two runtimes may write the same persistent state concurrently.
Any rollback claim must account for schema changes, not just old bundle bytes.
The command owner starts processes with argv arrays and an explicit local
environment. It strips ambient production credentials, retains owned handles
and unwinds partial startup. Use bounded queues and retry deadlines from the
existing producer. A full queue reports rejection or counted drops. Await
shutdown, escalate only owned children after five seconds, and preserve the
primary error when cleanup also fails. Publish ready only after state and
required services are usable. An activation failure is distinct from a build
failure and cannot publish a partially ready generation.

Kill separately the app, local Engine, and required Services process. Track the
requests acknowledged before each kill. After recovery, no acknowledged host
write may be lost; retries must not duplicate or corrupt it. Unacknowledged
requests may retry under existing idempotency. For observation, separately prove
delivery guarantees and bounded, visible loss; do not promise exactly-once tails.
Exercise a transaction failure, an alarm during restart, and receiver backlog.

Run after bootstrap with credentials stripped and non-loopback network denied at
the OS boundary where supported, plus the application's outbound guard. Include
runtime/update checks and telemetry exporters, not only Worker `fetch`. A deliberate
outbound canary must fail and be reported. State the enforcement layer per OS;
credential removal and an app guard alone are not proof of full offline execution.
R5a runs this with the existing macOS `scripts/offline-run.sh` wrapper when
available. A locally self-hosted candidate's control and Services endpoints stay
on loopback. Probe exposed actor/control ports directly for unauthorized access,
as well as the authenticated front door. Any missing auth is a required failure.

Use a **30-minute** bounded-data soak with **100** reload cycles, host ingestion
within its rate limits, observation and cleanup. Record process-tree RSS/CPU,
WAL/data/offload/stream/log bytes, latency, crashes, rejected requests and events.
Use a fixture with bounded live data and report actual live-record counts. Separate
legitimate retention growth and one-time caches from unexplained accumulation;
never hide growth by resetting state. Test graceful restart and restore into a
fresh namespace from a supported consistent backup/export of synthetic data.

Start a packaged, watcher-free candidate against a locally self-hosted Engine,
with no Rivet Cloud login or external S3. Exercise the same authenticated pilot
and restart it. Verify artifacts from a clean staging directory, not source-only
imports; list runtime-native libraries, license and supported CPU/OS/libc targets.
Keep ARM macOS dev evidence separate from Linux self-host evidence. Do not present
a glibc-only image as a verified Alpine/musl solution, or one laptop as an HA test.
An unavailable packaging/target environment goes to Needs environment.

**Exit:** documented local durability and operational proof, zero cross-run
interference/orphaned listeners, accurately demonstrated offline operation, and
explicit platform limitations. Neither a dev server nor a dry-run Dockerfile
alone establishes deployable independence.

### R6 — benchmark the improved loop, not the old one

No product-performance gate before parity, other than stopping an unusable
experiment: repeated request timeouts over 30 seconds, process-tree RSS over
4 GiB on the small fixture, unbounded growth, or acknowledged data loss. Diagnose
rather than tune broken semantics. Performance is an outcome to judge, not a
reason to waive correctness.

Measure A/B using at least **seven interleaved pairs** on the same machine with
no competing benchmark jobs. Record load, versions, compatibility dates, fixture
size, warm/cold state, compilation count, test count, all child processes, exact
commands and failures. Include Engine/Services startup and teardown. Keep initial
dependency installation separate from cold installed-checkout readiness. Bootstrap
bytes/time and cached footprint still belong in the maintenance/cost report.
Run `perf-gate-ready` immediately before and `perf-gate-ready -1` immediately
after each timed trial. Discard overlapping-load trials. If the host remains
busy, mark the required performance verdict inconclusive and retain the exact
retry command. Always record memory and artifact size. Vet the candidate's
license, maintenance and transitive closure at bootstrap. Track build time,
startup, package bytes and installed bytes separately. The existing application
size/build budgets remain intact because the candidate closure is opt-in.

| Metric | Timed boundary / work proof |
| --- | --- |
| Cold and warm readiness | Command start to a verified authenticated API response and usable seeded UI; do not stop at a port opening |
| Backend and observe edits | Actual source edit to verified new request/event behavior, including required compile/reload; revert edits safely |
| Frontend edit | Browser-visible hot update; assert zero backend build/restart/reseed |
| Pure focused test | Selection through completed assertions; no platform process or Worker artifact prerequisite |
| Integration-focused test | All necessary freshness/setup, actual selected assertions, cleanup and test counts |
| Application latency/throughput | Valid ingest/history/observation workload at fixed offered load; count successful persisted work, retries, drops and errors |
| Resource cost | Whole process-tree RSS and CPU, idle CPU, build CPU, stored/WAL/stream bytes, binary/package footprint and number of supervised processes |

Use existing valid small fixtures and a reproducible larger set targeting
100,000 valid history records across appropriate hosts/time windows. Record real
counts rather than forcing invalid fixtures. Keep rate limits active; fast
rejections are not throughput. Use at least 1,000 successful history requests
per load trial for tail latency; sparse dev-edit samples get medians/ranges, not
unsupported p99 claims. Keep observation enabled at equivalent supported scope;
report missing platform sensors separately. Do not time a telemetry-disabled
candidate against a fully observed baseline without naming the difference.

Fix at most two measured candidate bottlenecks within the adapter budget, each
with before/after proof; do not restart the handoff's optimization work. Report
median, spread, errors and limiter. A gap inside run-to-run variation is
inconclusive. CPU comparisons use host/process measurement where per-invocation
CPU is unavailable. Same-process resource totals are not request-level attribution.

**Prescribed local-adoption hurdle, fixed before measurement:** all required
functional/operational gates pass; either backend-edit or focused-integration
median improves by at least **20% and 100 ms**, beyond observed noise. No other
hot-loop median may exceed baseline by more than `max(10%, 100 ms)`; total steady
RSS may not exceed baseline by more than `max(15%, 128 MiB)`. For a baseline
latency B, the first limit is `B + max(0.10 × B, 100 ms)`. The RSS limit uses
the same formula with 0.15 and 128 MiB. Frontend-only edits
must trigger no backend build/restart; pure tests launch no backend runtime. Sustained workload
p95 must stay within 10% at equal successful offered load. No unexplained growth
under fixed live data may exceed `max(10% of settled RSS, 128 MiB)` or
`max(10% of settled disk footprint, 64 MiB)` from the first to last settled soak
window; include logs/streams and allow documented maintenance to finish.

These are decision thresholds, not predicted gains. A simpler hosting option that
misses the loop hurdle can receive a positive self-host verdict, never a fabricated
speed win. Do not optimize only to these numbers while worsening unmeasured work.

### R7 — close with a decision and a small retained footprint

Produce two independent verdicts: **local default** (`adopt-candidate`, `keep-current`,
`inconclusive`) and **self-host path** (`viable-single-host`, `promising-needs-environment`,
`reject`). `adopt-candidate` is a recommendation for a subsequent approved change,
not permission to alter `make dev`. A single-host verdict names the proven OS/architecture/libc. Native-only success
must remain identified as a platform probe, not a complete Stats hosting option.

The report includes required-behavior coverage and intentional differences,
actual version/process/dependency inventory, baseline/candidate measurements,
SQL/telemetry semantics, bootstrap/offline proof, backup/restore result, source
and data exit paths, adapter maintenance size, and remaining external evidence.
Cost analysis separates local CPU/wait time, existing-host marginal cost,
new-host fixed cost, storage/backup/network costs and operator work. Any price
input is dated and sourced. No marketing multiplier or per-row Cloudflare tariff
stands in for measured self-host expense or a bill.

Delete abandoned adapters, unused packages, temporary config and duplicate
supervisors; retain the minimal reproducer/results needed to reassess a rejection.
Do not delete the working baseline, existing Node target, development guide,
verification evidence or unrelated work. A retained experimental package stays opt-in and outside ordinary install
and CI. Review with the current `ultrareview` process, fix in-scope P1/P2 findings,
and close when all local deliverables have evidence or a bounded rejection.
Needs-environment items remain explicit and do not become passing proof.

## Acceptance and evidence format

Every planned subcommand emits machine-readable results with source revision,
artifact/config/toolchain hashes, run identity, test inventory, executed counts,
raw evidence paths, result (`pass`, `fail`, `blocked`, `not-applicable`), and reason.
Evidence reuse requires matching inputs. Wrong-runtime health, stale artifacts,
zero selected tests and unmatched selectors fail. Do not implement a general
benchmark/evaluation framework to provide this small schema.
On the dispatcher, use exit 0 for successful work, 1 for a demonstrated failed
check, 2 for invalid arguments or unavailable prerequisites, and signal death
for interrupted execution after cleanup. Preserve the underlying command status
and structured cause in the result. `report --check` returning 0 means the
evaluation record is complete, including a documented rejection. It cannot
convert the rejected candidate's failing command to exit 0.

A candidate correctness command returns nonzero on failure. `report --check`
may validate a **completed rejection** only when the actual failed commands and
reproducers are retained, downstream work is explicitly rejected/deferred, and
the baseline gates remain honest. It must fail on missing required evidence
for a positive verdict. Build a deliberate write-loss/ack-corruption negative
control for parity, plus a missing-metric and unmatched-test negative control.
No assertion may be satisfied merely by both implementations returning an error.

Milestone full gates preserve existing default coverage; experimental cases are
reported separately. Gate failures with unchanged baseline inputs remain known
red, not newly green or silently excluded. A required behavior with no executable
proof cannot support adoption. Runtime/architecture suitability remains unproven
until the relevant item has run on the recorded target.

## Needs environment

List each unavailable proof with target, cause and exact command. Execute the
available local work rather than waiting for these items, but qualify conclusions.
The planned commands become runnable as their slices land. The current macOS
ARM64 host and OS sandbox are available. Candidate installation and execution
are pending R0/R1, rather than missing-environment claims. A native Linux host
has not been verified for this task. Do not use SSH or provision one to close
that gap under this local-only execution grant.

| Proof / target | Command / consequence if unavailable |
| --- | --- |
| Linux target, including declared musl support | `node scripts/rivet-eval.mjs resilience --target linux --json`; report build/ABI failures separately from an absent machine |
| OS-enforced network isolation on a future unsupported host | `node scripts/rivet-eval.mjs offline --json`; R5a supplies it; STA-83 remains the Linux OS-sandbox gap, and app interception alone gives no full offline claim |
| Packaged watcher-free self-host on an unavailable target | `node scripts/rivet-eval.mjs package-smoke --json`; R5a supplies it; no single-host viability verdict from a dev server only |
| Multi-host durability, actual object-store cost or live Cloudflare parity | Not authorized here. Record a future command/runbook only; these results are not implied by local process kills or filesystem persistence |

## Execution boundary and non-goals

This plan commit changes documentation only. Future local execution, when
requested, may install the pinned evaluator closure into repository-owned paths,
start and kill only owned local processes, create/reset explicitly named synthetic
state, and make local commits. Network is allowed only for explicit bootstrap and
read-only upstream verification; measured execution is offline. No production
secrets, production-data copies, paid resources, remote accounts, SSH writes,
cloud provisioning, DNS changes, deployment, data migration, global service
installation, system configuration changes, privilege elevation or remote push.
Never run `orange login`, `link`, `deploy` or `migrate` against a live account.
Any packaging command must be verified as local-only before execution.

No celld launcher, S3 server, replacement developer platform, fleet-wide migration,
Rivet SDK rewrite of Stats, new auth product, or recreation of every Cloudflare
service. Queues, Workflows, KV, R2 and actor forking are evaluated only where a
required Stats path needs them or the single optional native-fork probe permits.
Do not convert other repositories. Do not create another upstream watch: the
existing Cloudflare compatibility workflow and notification watch already cover it.

Allowed correctness cleanup is bounded to actual migration prerequisites: mutation
versus metering, truthful unavailable reporting without public contract changes,
and a minimal shared orchestration defect that otherwise makes proof impossible.
Unrelated application performance work belongs to current TODO owners. After two
failed repairs, park it with evidence; do not expand this campaign to finish it.

## Reference: reuse/change map and dated upstream evidence

These paths were reconciled at `3c5bab6`. Resolve intervening changes at R0
rather than restoring old implementations.

| Reuse / narrow change | Source and purpose |
| --- | --- |
| Reuse | [Development guide](development.md), [verification](dev-loop-results.md), `cloudflare/scripts/dev.ts`, `cloudflare/local/dev-backend.ts`, `cloudflare/scripts/ensure-build.ts`, `cloudflare/scripts/processes.ts`, `cloudflare/scripts/ownership.ts`, `cloudflare/scripts/test-suites.ts`, `cloudflare/scripts/run-tests.ts`, `cloudflare/bench/dev-loop.ts`: completed baseline and shared facilities |
| Reuse | [Architecture](architecture.md), `cloudflare/src/core/installation/`, `cloudflare/src/core/http.ts`, `cloudflare/src/core/ports.ts`: application logic and ports |
| Narrow audit/repair | `cloudflare/src/core/sql.ts`, `cloudflare/src/operations.ts`, `cloudflare/src/core/installation/installation.ts`, `cloudflare/src/projects/store.ts`: counters versus logical mutation |
| Preserve/control | `cloudflare/src/cloudflare/sql.ts`, `cloudflare/src/node/sql.ts`: platform-specific SQL adapters; Node is already a non-Cloudflare path |
| Reuse | `cloudflare/cloudflare.config.ts`, built `worker.config.json`, `cloudflare/local/topology.ts`, `analytics.ts`, `outbound.ts`: authoritative config and explicit external-input fixtures |
| Reuse | [Integration contract](integration.md), `packages/producer/`, `cloudflare/src/observe/ingest/`, `cloudflare/src/observe/core/`: existing authenticated application telemetry and observation storage |
| Reuse/protect | [Testing](testing.md), [profiling](profiling.md), [dependencies](dependencies.md), `fixtures/v2/`, `cloudflare/test/node/boundary.test.ts`: oracles, attribution, policy and portable-core boundary |
| New, isolated | `experiments/rivet/`, `cloudflare/test/rivet-eval/`, thin `scripts/rivet-eval.mjs`, final evidence report; not a replacement default dev stack |

Primary upstream sources inspected November 12, 2026. Statements below are source
findings, not observed Stats results. Reverify only the execution-time candidate;
keep this dated evidence distinct from measured acceptance.

- [Rivet 3 announcement](https://rivet.dev/changelog/2026-10-26-introducing-rivet-3-0-preview/):
  October 26 preview, updated November 1 as out of preview, with some features
  still pending. Do not equate a 3.x version label with every advertised feature.
- [Rivet architecture](https://rivet.dev/docs/architecture/) and
  [self-host control plane](https://rivet.dev/docs/deploy/self-host/control-plane/):
  SDK nodes and control plane are separate; production involves durable disks
  and object storage. A filesystem/local trial is not replicated HA proof.
- [OpenOrange README at the inspected SHA](https://github.com/rivet-dev/open-orange/blob/0f3c2eac56d7f67d16398d54c4560543621f5582/README.md):
  Cloudflare compatibility over Rivet, partial bindings and local persistent
  development. This is a different bet from directly targeting native Rivet APIs.
- [OpenOrange manifest](https://github.com/rivet-dev/open-orange/blob/0f3c2eac56d7f67d16398d54c4560543621f5582/package.json):
  source manifest `open-orange` 1.0.1 pins `rivetkit` 3.1.2-rc.1 and `wrangler`
  4.129.0. Package metadata confirms those versions and the distinct Engine/Services
  dependencies described above. It does not verify the installed closure or actual
  binary behavior. Inspect both at R0.
- [OpenOrange SQL storage](https://github.com/rivet-dev/open-orange/blob/0f3c2eac56d7f67d16398d54c4560543621f5582/packages/runtime-node/src/bindings/durable-objects/storage.ts):
  the source exposes synchronous execution and transactions, but maps rows read
  to returned rows and writes to SQLite change counts. This is a concrete
  metering mismatch with Cloudflare, rather than a reason to assume the SQL
  interface is async or to report platform billing counters.
- [OpenOrange Tail Workers](https://github.com/rivet-dev/open-orange/blob/0f3c2eac56d7f67d16398d54c4560543621f5582/docs/modules/tail-workers.mdx):
  local tails require a Services process; delivery is at least once. The inspected
  implementation lacks DO/alarm/RPC traces, reports CPU as zero and emits no
  diagnostics-channel events. These are tests/adapter constraints, not permission
  to publish false zeros or ignore observation. It also differs in retry/retention.
- [Native actor forking](https://rivet.dev/changelog/2026-11-11-introducing-actor-forking-for-sqlite/):
  an optional experiment opportunity, not verified whole-application snapshots or
  a reason to use marketing timings as this campaign's baseline.

Follow the current `usr` campaign/preflight, reference-parity, durable-state,
benchmark-checklist and orchestrate guidance when executing. The source observations
above establish only source-level plausibility; R1/R3 must provide runtime proof.
