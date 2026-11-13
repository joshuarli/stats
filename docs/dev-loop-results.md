# Development loop verification

## Delivered behavior

`make dev` provides frontend HMR and automatic Worker rebuilds against one
offline Miniflare backend. Backend replacement serializes disposal and startup
on the same persistent state. A compilation failure keeps the previous backend.
An activation failure reports unavailable service until a corrected build starts.
Neither failure resets stored history.

The [command guide](development.md) describes bootstrap, state ownership, test
selection, build preparation and candidate validation. Production compatibility
dates remain `2026-10-30`. No production deployment belongs to this work.

## Corrected test coverage

The original aggregate declared 74 files, including 24 nonexistent paths, and
omitted 36 ordinary current files. Node ignored the missing paths when other
paths matched. Its attempted run failed in the local collection benchmark:
`observationRowsPerInvocation` differed between two runs, at 3.2 and 3.75.
That run is recorded as a failure, rather than a passing baseline gate.

The repaired inventory discovers 140 files: 125 default files and 15 explicit
opt-ins. The opt-ins comprise 11 browser specs, the agent and Node end-to-end
files, and two external service or producer files. Both Make gates include
profile tests. The full gate also owns browser and both end-to-end routes.
External checkout tests require their documented inputs and remain opt-in.

Discovery lists ownership and prerequisites. File selectors, missing declared
paths and unowned tests fail clearly. Real per-file Node summaries prevent
unmatched name filters from passing as successful coverage. Pure ingest tests
run without Worker output or starting Vite or workerd.

## Comparable measurements

The raw [baseline](dev-loop/baseline.json), [candidate](dev-loop/candidate.json),
and [summary](dev-loop/comparison.json) contain five alternating trials per
version. Every trial passed host readiness checks before and immediately after
measurement. No measured trial failed. Each snapshot was clean and isolated.

The baseline uses repaired discovery with original dependency pins at
`5d70ae3`, whose application, fixture and build inputs match reachable commit
`a3407a4`. The candidate is `c63f2ce`. Subsequent fixes cover served-document
ownership, runtime pin enforcement and isolated test-module paths. The table
reports the measured revisions, rather than claiming those fixes were timed.

The shared harness is identified by SHA-256
`ec13e32949583a19421af62e310710f85e2b3979a97dd1ff2afbe315f14615d6`.
The host runs Darwin 27.0.0 on an 18-core Apple M5 Max, with Node 26.13.1
and pnpm 12.18.0. Raw files retain lockfile and fixture hashes, actual runtime
paths, compatibility dates, build environment and driver revision.

Readiness includes authenticated seeded API data and a visible browser table.
Dependencies and committed fixtures are prepared before timing. Cold trials
remove generated outputs and use empty state. Warm trials retain valid outputs
and existing state. The baseline has no edit watcher, so edits include manual
build and restart. Candidate frontend edits use HMR.

Times are milliseconds, shown as median [minimum–maximum]. Compilation counts
are baseline → candidate and agree across all five trials.

| Scenario | Baseline | Candidate | Compilations |
| --- | ---: | ---: | ---: |
| Cold readiness | 1119 [1034–1342] | 1878 [1803–2216] | 2 → 2 |
| Warm readiness | 1061 [1011–1093] | 903 [885–983] | 2 → 0 |
| Frontend CSS edit visible | 1047 [1030–1072] | 134 [107–134] | 2 → 0 |
| Worker edit visible | 1020 [993–1113] | 1261 [1232–1431] | 2 → 1 |
| Focused ingest, 3 cases | 235 [217–248] | 271 [261–290] | 0 → 0 |
| Focused Worker/Node parity, 1 case | 2256 [2147–2512] | 2708 [2669–2787] | 2 → 1 |
| Unchanged build | 541 [525–581] | 114 [110–116] | 2 → 0 |

The parity scenario includes prerequisite work after restoring the preceding
Worker edit. Its candidate rebuilds stats once and reuses observe. Neither
focused scenario drops test cases to improve timing.

Warm process-tree RSS rises from 397488 KiB [397200–399344], across two processes,
to 719248 KiB [709040–727792], across three. The sum includes the development
process and descendants, excluding the browser and measurement driver. Shared
pages can be counted more than once. These figures establish neither physical
memory consumption nor long-running leak behavior.

The [dependency-only trials](dev-loop/dependency-only.json) use the supported
new SDK group with the old development loop at `be1f880`. Their medians include
1103 ms cold readiness, 1034 ms warm readiness and 1006 ms Worker edits.
Their ranges overlap the original-pin baseline. Updating dependencies alone
does not establish a repeatable latency improvement.

HMR, warm reuse and unchanged builds improve the edit workflow. Snapshot copying,
output verification and separate frontend/backend ownership add cold-start and
memory costs. Worker replacement remains a serialized restart and is slower
than the measured manual baseline. Structured focused-test logging also adds
overhead. These costs are retained for state ownership, isolation and diagnostic
coverage. No existing latency budget was relaxed. These measurements say
nothing about billable Worker CPU.

## Runtime attribution and upstream limits

The direct harness, Vite plugin, Vitest plugin and cf tooling resolve
Miniflare `5.20261110.2-beta` and workerd `1.20261110.1`.
The exact direct pins are cf `1.0.0-beta.31`, Vite plugin `2.0.0-beta.v.16`
and Vitest plugin `1.8.1`. Node, pnpm, Vite, Vitest and workers-types pins remain
unchanged. `make dev-doctor` checks installed paths and actual supported dates.

The separately published workerd `1.20261112.1` is ahead of this SDK group.
No override forces that runtime into the group. Existing release-age and build
script policies remain, with exact documented package exceptions.

Vite's frontend server owns HMR. Direct Miniflare retains the production-derived
offline topology because the application requires an Analytics SQL substitute,
strict outbound interception and fixture producer tails. Ordinary Cloudflare
Analytics SQL development reaches the remote service. A second Vite-owned
Worker topology would not preserve these contracts. The removable adapter is
the local frontend proxy and build supervisor. Reconsider that adapter when a
supported Vite API can supply those same services and offline guarantees.

The backend runs in an IPC child so Miniflare's process signal handlers cannot
exit the frontend supervisor before awaited disposal. Reload keeps that child,
refreshes build metadata and Durable Object handles, and replaces its runtime.
No promise of rollback follows a successful build that fails during activation.

The daily and manual candidate workflow records source/merge status, selected
SDK versions, newest independent workerd, release-containment uncertainty and
actual contract results. It creates no promotion, deployment or notification.
At the recorded check, workers-sdk #16684 and workerd #8176 remained drafts.
Neither proposal is treated as released behavior or permission to migrate data.

The final [isolated candidate report](dev-loop/upstream-candidate.json) passed
17 Node cases, 31 Worker cases, configuration validation and typechecks at
`95fdf98`. Its proposal diff is empty because the installed group already
matches the supported channels. The [doctor output](dev-loop/doctor.json)
records Node 26.13.1 and every resolved runtime path. The accompanying
[inventory](dev-loop/inventory.json) preserves the 140-file ownership report.

## Acceptance evidence

Behavioral regressions cover complete generation publication, concurrent build
consumers, dirty imported sources, corrupted outputs, failed builds and dead
owners. Independent fixture checkouts cover HMR without page reload, Worker
and observe edits, activation failure and recovery, persistent fixture identity,
raw anonymous API rejection and shutdown without stopping the other instance.
Browser fixtures own port-zero servers, state and registry namespaces.

`RUSTC_WRAPPER=kache make check` passed at `95fdf98` with pinned Node 26.13.1.
The gate validated fixtures, 114 Rust cases, both static Linux binary builds,
879 passing Node cases and one documented historical-upgrade skip, 347 Worker
cases, one agent end-to-end case, five Node end-to-end cases, deployed smoke,
262 browser cases, lint and typechecks. WebP goldens were unchanged.

The macOS offline route additionally passed 41 local cases with the same
historical-upgrade skip, four browser cases and the development-loop regression.
The skip requires the separately prepared pre-schema-8 build described in
the testing guide. It is not counted as executed upgrade coverage.

macOS supplies the OS-enforced offline route. Linux retains
application-level outbound rejection, with its OS sandbox gap tracked as STA-83.
External checkout suites and native Linux collector execution are outside this
macOS verification. STA-116 packaged Node startup remains a real staged-bundle
regression, rather than a source-only check.
