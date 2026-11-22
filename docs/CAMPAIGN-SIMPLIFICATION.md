# Stats simplification and self-optimization campaign

Status: in progress since 2026-11-22 (S0 and S1 started); no step is complete.
Owner direction: 2026-11-21. Review baseline: Stats
`73a576e4fc6d20f1f083b52225293be2c6517fb4`, Stuff
`501db1136f4c64c478401fc92201fb44671cb386`. These are source-review identities,
not a fresh inspection of production.

## Outcome

Make Stats, OpenOrange and Rivet straightforward to change, diagnose and recover.
Stats must supply enough trustworthy evidence to identify a dominant cost or
failure, test one change, qualify the exact resulting deployment, and establish
whether the improvement survives operation. Preserve the option to run Stats on
real Cloudflare through the existing portable cores and Cloudflare adapters.

Success means fewer independently managed deployment paths and configuration
facts, reliable behavior under contention, faster iteration, and demonstrated
improvements. Collecting more metrics or completing more infrastructure work is
useful only when it advances those outcomes.

This is the active implementation sequence for that outcome. The
[infrastructure release campaign](CAMPAIGN-INFRA-RELEASE.md) remains the evidence
record for completed releases and the owner of its established release contracts.
The [performance campaign](CAMPAIGN-STATS-PERFORMANCE.md) and
[resumption record](STATS-PERFORMANCE-RESUMPTION.md) retain their thresholds,
protected fixtures, failed attempts and unresolved acceptance. This document
does not mark their open work complete or reset their consumed attempt budgets.

## Decisions

1. **Keep the current OpenOrange/Rivet deployment while reducing its operating
   surface.** Begin with the supported Threadripper standby writer. A move back
   to Lisa is a separate fenced transfer with its own evidence.
2. **Keep the portable application boundary.** `InstallationCore`, observation
   and metric cores, SQL/clock/scheduler ports, HTTP contracts and producer
   protocols remain the basis of portability. Keep the two Workers and existing
   actor ownership unless measurements justify a particular boundary change.
3. **Converge on the existing Stuff rollout transaction.** Extend its adapters
   and manifests to cover app, runtime and collector releases. Reuse its lease,
   journal, receipt verifier and watchdog. Physical capture must participate in
   the same mutation ownership.
4. **Separate release admissibility from demonstrated improvement.** A safe
   release can be unchanged. An optimization needs a declared objective,
   trustworthy comparison and an improvement beyond the noise floor.
5. **Keep the accepted observer placement.** The observer, controller and
   watchdog run on Threadripper's host outside the candidate VM. Whole-host
   shared fate is accepted; outbound alert delivery remains deferred. Neither a
   new observer host nor an alert destination blocks this campaign.
6. **Keep runtime ownership in Stuff.** Downstream OpenOrange/Rivet source,
   patches, reproducible builds, host definitions and rollout adapters belong
   in `laputa-systems/stuff/deploy/openorange/`. Stats owns telemetry semantics,
   queries, workloads and evaluation. Preserve upstream attribution and the
   owner's private-maintenance policy; do not open upstream issues or PRs.

Do not add another monitoring database, orchestrator, provider abstraction,
query language or release controller. The existing Node/SQLite adapter is a
useful diagnostic and parity reference. Promoting it to the production backend,
replacing Rivet, merging all actors, and removing the VM/container boundary are
separate architectural decisions, justified only by measured benefit and
durability/recovery proof. They are not prerequisites for this campaign.

## What the current evidence actually establishes

| Finding | Evidence at the review baseline | Consequence |
| --- | --- | --- |
| Full runtime identity, bound receipts, two owned OpenOrange patches and unattended recovery exist | [INF qualification record](CAMPAIGN-INFRA-RELEASE.md#qualification-and-unattended-recovery-2026-11-20) | Extend these mechanisms; preserve their negative controls. |
| Standby app deployment has a separate activation/rollback implementation | [standby-deploy.sh](../deploy/orange/standby-deploy.sh) reads selection before the lease, checks public health after releasing it, and obtains a new lease for unconditional rollback | A failed deployment can restore its old selection after another deployment has taken ownership. This is a source-level race, not an attributed incident cause. |
| The supported standby Engine has manually maintained configuration | [standby incident record](openorange.md#standby-incident-2026-11-21) records an untracked Engine definition and manually applied limits | Reproduction and recovery currently depend on facts outside the checkout. |
| The November 21 alarm/registration failure is unresolved | [STA-135](../TODO.md), [Stuff degradation investigation](https://github.com/laputa-systems/stuff/blob/501db1136f4c64c478401fc92201fb44671cb386/docs/openorange-engine-degradation.md) | CPU contention alone did not reproduce it; the latest drill substituted a fresh depot after the copied depot proved inconsistent. |
| Runtime canaries hold the app bundles constant | [promotion.mts](../deploy/orange/qualification/promotion.mts) assigns the same Worker digests to both sides; [stack.mts](../deploy/orange/canary/stack.mts) uses shared build outputs | This path cannot yet evaluate a baseline Stats build against a different candidate Stats build. |
| Infrastructure metrics are ingested, but their historical behavior is poorly exposed | [MetricStoreCore](../cloudflare/src/metrics/store-core.ts) has `series`; [metric HTTP](../cloudflare/src/metrics/http.ts) exposes batches and sources; [release evaluator](../cloudflare/src/cli/verify/release-decide.ts) checks required family availability | A healthy scrape does not establish healthy queues, retries or storage. |
| The qualification harness asserts no host confounding | [promotion.mts](../deploy/orange/qualification/promotion.mts) writes `hostConfounded: false`; [resource sampling](../deploy/orange/canary/evidence.mts) synchronously invokes Docker from the load-driver process | Small CPU/latency gains are not established by this harness without stronger controls. |
| The fast profile is deliberately small | [promotion profile](../deploy/orange/qualification/profiles/promotion.json): 60-second warmup, 600-second measurement, 10 requests/second, 25% relative resource tolerances | Retain its useful functional checks; add representative and failure-specific qualification. Do not label a pass as a performance win. |
| Metric history has a different recovery contract | [metric store](../cloudflare/src/metrics/store-core.ts) retains 24 hours; [logical backup](../cloudflare/src/cli/commands/backup.ts) covers Installation and observations | Freeze optimization evidence independently of metric retention; explicitly define metrics recovery before claiming all-state portability. |
| Observation overhead is still unqualified | [STA-128](../TODO.md), [resumption](STATS-PERFORMANCE-RESUMPTION.md) | Preserve the <3% CPU and <5% latency targets and the failed-study record. The 38.8% insertion-batching component win does not close this gate. |

The November 18 clocksource/HPET incident has a separate recorded mechanism.
Do not use it to claim the November 21 spin is explained. Native deployment also
reproduced a depot/registration failure, as recorded in [native Lisa](native-lisa.md).
Deleting Docker or increasing timeouts is not evidence of fixing that failure.

## Target operating model

An operator or agent should need to know the target and proposed change, then
use one supported path to inspect, build, compare, qualify, activate and recover.
The implementation can retain separate components and narrow adapters.

### One inspectable deployment

Extend the existing release records with a small deployment description that
references immutable components: app Worker bundles/assets, OpenOrange/RivetKit
runtime, native addon, collector, Engine image/binary and configuration,
supervision/resource profile, and required compatibility versions. Reference
unchanged components by digest. App-only changes must reuse the installed runtime
and Engine artifacts.

Distinguish **desired**, **staged** and **actually loaded** identities. Have running
processes publish a startup identity or equivalent verified witness for the
deployment they loaded. A mutable descriptor, package version or symlink alone
does not prove the running program's identity. Include target and active writer
generation in prepare/activation checks; derive writer authority from the
existing authoritative fence/route record.

Use the existing rollout journal for activation and recovery. A single read-only
inspection must show writer authority, loaded identities, resource limits,
operation owner/deadline, last functional check, telemetry freshness, backup
capture age and independently verified restoration age. Missing facts are
unknown. Historical documents must not supply live-state answers.

### A small path from evidence to action

1. Observe a bottleneck or failure with exact release/workload/source identity.
2. Record one falsifiable hypothesis and one primary objective.
3. Change the relevant layer in an isolated checkout and namespace.
4. Run the cheapest relevant correctness checks and a controlled comparison.
5. Qualify the exact deployment through the existing release evaluator.
6. Activate through the existing transaction when the applicable deployment
   authority and gates permit; independently verify behavior afterward.
7. Preserve the result, rejected candidates and a next action that can resume.

The candidate may emit observations about itself. The workload ledger, raw
resource evidence, evaluator, qualification receipt and recovery journal must
survive the candidate's failure outside its storage. Reuse the current host
observer and evidence files; a second full Stats installation is unnecessary.

## Execution order and progress

The table is the single progress index for this campaign. Keep detailed run
evidence in the existing benchmark/release locations and incident issues in their
owning repository. Do not create another status database or duplicate every
entry into a new campaign framework.

| Step | Deliverable | Owner | State |
| --- | --- | --- | --- |
| S0 | Refresh actual topology, baseline and protected-evidence inventory | Stats + Stuff | in progress: topology, identities, limits and first timings recorded ([partial baseline](../bench/results/2026-11-22-sim-s0-baseline/README.md)); repeated timings, resource baseline and recovery budgets open |
| S1 | One deployment/capture ownership path and reproducible standby definition | Stuff, Stats adapters | in progress: app and collector deploy through the transaction, cases 1–5 tested, promoted in production; Engine declared, drift-checked and rendered by `standby-engine create-args`; capture runs under the lease and restores its recorded service intent (case 6, tested); the first production capture failed safely; a stopped-copy capture on 2026-11-22 succeeded with a 16 s outage and was verified off-host and validated by an isolated Engine with production's actor inventory ([record](../bench/results/2026-11-22-engine-capture/README.md)). Recreation (case 7): a tracked guest build exists (`deploy/orange/recovery/guest/`) and found and fixed five definition gaps, but has not passed; it is parked because its disk writes degraded production on Threadripper ([record](../bench/results/2026-11-22-guest-recreation/README.md)). [Record](../bench/results/2026-11-22-standby-app-transaction/README.md) |
| S2 | Reproduce and repair the Engine degradation mechanism | Stuff + Stats workload | planned |
| S3 | Queryable causal evidence and truthful resource comparisons | Stats | planned |
| S4 | Smaller production serve closure and faster edit/build/start loop | Stuff + Stats build integration | planned |
| S5 | App/runtime/Engine improvement experiments through one qualification path | Stats + Stuff | in progress: `promotion.mts` takes independent app releases per side and names the changed layer; a smoke run qualified two different app builds on one runtime (`pass`, replayed). No improvement experiment has run. [Record](../bench/results/2026-11-22-two-build-qualification/README.md) |
| S6 | Portability/recovery rehearsal and sustained operational acceptance | Stats + Stuff | planned |

Start S0 and the focused S1 race regression immediately. Bring forward the
minimum S3 measurements needed to diagnose S2. S4 can proceed independently on
an isolated runtime. Do not wait for dashboard work to diagnose the Engine.

### S0 — Refresh truth and set the baseline

Read current `AGENTS.md`, the runtime/recovery runbooks, existing campaign
records and the referenced Stuff investigations. Inspect authorized hosts
read-only before relying on the dated topology. Record changes since the review
identities and reconcile contradictory current-state prose.

Produce one compact baseline in the existing evidence location:

- Process/listener/supervision graph from ingress through both Workers, actor
  storage, Engine and collector, including which host owns every writable path.
- Desired and loaded app/runtime/Engine/config identities; active writer and
  fence generation; target CPU/memory/IO limits; host and guest clocksource.
- Existing source ownership and build gaps. OpenOrange is rebuilt downstream;
  RivetKit/N-API ownership is still incomplete; patched Engine promotion remains
  held until its release-class qualification is satisfied.
- Clean/warm timings for dependency preparation, app build, focused test,
  backend edit-to-ready, runtime build, staging, restart-to-functional readiness,
  rollback and restore. Separate acquisition, build, transfer and activation.
- Idle and representative-load whole-stack CPU, component CPU, memory, disk
  growth, request latency, verified work counts and observation overhead status.
- Preserved failed depots, original attempt allowances and required environments.
  The old tenfold fixture remains protected; an expired workload window does not
  authorize reimporting it or claiming seven-day coverage.

Record each baseline fact in one canonical location; repeat measurements as
prescribed and refresh live identity before mutations. Freeze workload and
success criteria before changing the implementation. New diagnostic profiles
have their own explicit bounded run budgets; they do not reset earlier campaign
allowances. All started runs, including invalid and interrupted runs, consume
the declared profile budget; renaming a profile or relabeling an acceptance-sized
run as diagnostic does not create another allowance. An unavailable host blocks
that measurement, not unrelated source work. Report it precisely as environment-blocked.

Freeze separate detection, recovery-to-safe-writes, backup data-age/RPO and
restore-time budgets for the supported Stats writer. The recovery runbook's
daily verified off-host recovery point is an interim objective, not an achieved
result or a new shared-S3 project. Preserve stricter existing recovery limits;
record the final budgets before qualifying recovery.

Acceptance: another agent can identify the current supported target and reproduce
the isolated baseline without a developer home directory, guessed branch head,
production secrets, or an undocumented Engine recreation command.

### S1 — Consolidate deployment and capture ownership

Extend Stuff's `oorollout` native adapter and existing manifest/receipt format.
Use one renewable lease across authority recheck, prepare, activation, functional
verification and conditional recovery. Cover app and collector bytes as well as
the required runtime. Keep build and transfer outside the activation lease;
verify their staged digests again inside it. Holding the maintenance lease
through verification must not pause normal ingest. A write-admission fence is a
separate, bounded operation used only where capture or state transfer requires
it, with explicit buffering limits and post-pause acknowledgment reconciliation.

Prestage immutable app directories. Preserve mutable `.open-orange` state outside
them. Replace the standby script's in-place remove/copy and unconditional
rollback with a thin call into the existing transaction. Reuse adapters for
environment differences; retire the duplicate state machine after parity proof.
Also converge the container app path when it targets an authorized writer.

A rejected lease must cause no mutation. Recovery may affect only the selection
and writer generation owned by the failed operation. Handle partial activation
and controller death from journaled facts. Recheck authority at prepare and
activation; a guest lease cannot make a Lisa-to-Threadripper writer transfer
atomic. Keep cross-host transfer as the existing explicit fence protocol.

Track the current standby Engine definition in Stuff: image digest, config,
storage paths, namespace/pool, network exposure, user, resource limits and startup
dependencies. The review record describes 8 guest vCPUs and an Engine limit of
4 CPUs/3 GiB; verify these before adopting them as the declaration. Recreate the
target in a disposable guest and inspect it against that declaration.

Physical capture currently takes a per-depot lock and stops/restarts the Engine.
Retain its useful precopy and checksum design, but acquire the common mutation
lease, preserve the previous running/stopped intent and journal cleanup. Prove
functional readiness and durable readback after restart before publishing
success. An interrupted capture must not silently leave the writer stopped or
fenced. Keep logical export distinct from a physical Engine capture.

Focused acceptance cases:

1. Lease refusal leaves app, collector and selected runtime unchanged.
2. Deployment A cannot roll back a later deployment B after losing ownership.
3. A writer-authority change between build and prepare prevents activation.
4. Changed app, collector or required runtime bytes invalidate qualification;
   an app-only change reuses unchanged runtime artifacts.
5. Killing the controller after selection and after restart produces one
   journaled completion/recovery and exact readback of acknowledged test writes.
6. Capture and rollout cannot overlap mutations. Interrupted capture restores
   the prior service intent and leaves a truthful failed or successful receipt.
7. A clean disposable guest can recreate, reboot and recover the declared
   deployment, then ingest, read history and replay duplicates correctly.

### S2 — Explain and repair Engine degradation

Close STA-135 through a prediction, reproduction and fix. Preserve the original
failure state and current availability mitigations while doing this privately.

Begin with a consistent copy of representative persisted state. Validate both
Engine storage paths, startup, canonical readback and actor inventory before
injecting stress. If capture is invalid, diagnose capture. A fresh depot is a
separate control and must be labeled as such.

Run bounded cases for CPU scheduling pressure, disk-write contention on the
relevant filesystem, actor/alarm lifecycle, and then the minimum combination
needed to reproduce the symptom. Include a recovery interval after pressure is
removed. Use the existing contention driver and fixture tools; extend them only
where a missing measurement or control prevents a conclusion.

Capture host/guest CPU PSI and throttling, memory/IO pressure, disk latency and
space, clocksource, process/incarnation identity, Engine admission/refusals,
alarm/frontier work, retries and registration state. Capture a bounded native
CPU profile when the spin appears; distinguish runnable CPU work from blocked
storage and scheduling delay. Profile timing runs separately from accepted
performance comparisons.

The current source investigation says alarm retries already back off and a full
frontier queues work. Check effective configuration, not only configuration prose.
Try cold-read concurrency, alarm concurrency, command deadlines or a code patch
one at a time against the reproducer. State the predicted change in queue,
retry, CPU and recovery behavior. A longer timeout that merely delays errors is
not an improvement. Never remove fencing, heartbeat protection, durability
barriers or admission bounds to make a test pass.

Acceptance requires the baseline symptom or a proven equivalent regression,
followed by a candidate that survives that same condition with exact durable
results. After pressure ends, registration, ingest, queue drainage and CPU must
return to their recorded healthy envelopes within a finite deadline fixed before
the run. Use 120 seconds as the initial pressure-recovery objective, retain
stricter existing restart/recovery thresholds where they apply, and justify any
capacity-driven change before a new comparison rather than after a failure.
Repeat at least three independent pressure/recovery cycles on the validated
state. Include a negative control that can still detect the old defect.

If no reproduction is obtained within the recorded diagnostic budget, leave
STA-135 open, preserve profiles and narrow the next hypothesis. Do not close it
based on higher VM priority, a fresh-depot stress pass or a blind restart loop.

Every Engine replacement needs a journaled, conditional replacement/recovery
adapter and persisted-state compatibility proof, including configuration changes
that affect storage or recovery. The current native runtime adapter does not
replace the Engine. Qualify a dedicated Stats Engine in that scope; a shared
Lisa Engine additionally needs contract checks for every registered consumer.
Stats-only evidence cannot authorize a shared Engine promotion. Existing held
Engine artifacts stay held until the applicable conditions pass.

### S3 — Make observations useful for diagnosis and comparison

Build a narrow vertical slice using the existing collector, metric catalog,
MetricStoreCore, application events, platform bridge and `statsctl`.

Expose bounded historical metric queries through the authenticated API and CLI.
Retain allowlisted metrics/labels, explicit result limits and truncation. Add
release, collector instance and process incarnation selection before treating
series as comparable: the present `series` method is not a complete query API.
At the current 900-point series limit, 24-hour maximum age and global 20,000-row
eviction cap, long runs need bounded paging or periodic evidence export. Export
before either age expiry or capacity eviction and reconcile every checkpoint;
24 hours is not a guaranteed history window at arbitrary source counts. Never
silently truncate a soak.

Start with questions that select an action:

| Question | Minimum evidence | Useful distinction |
| --- | --- | --- |
| Why is ingest or a dashboard request slow? | Per-operation wall latency/work counts; worker event-loop delay; host/guest CPU pressure; Engine/store queues; bounded profile when needed | Scheduler delay, app work, actor queue, SQLite/VFS work, or Engine storage wait |
| Does the Engine recover after pressure? | Refusal/retry deltas, registration/incarnation, queue/backlog trajectory and independent ingest/readback | Transient overload, draining backlog, stuck retry/spin, or lost registration |
| Did this change reduce resource cost? | Whole-stack and component CPU per verified work, memory, IO/storage growth, same workload mix | Moved work, reduced work, or dropped work |
| Can the evidence be trusted? | Expected/received sequences, gaps, queue/drop counts, reset identity, timestamps, actual loaded deployment | Complete, missing, stale, mixed or confounded data |
| What is safe to do next? | Current lease/writer identity, last recovery verification, selected release and workload verdict | Continue, recover, reject, or gather missing evidence |

Add only missing instrumentation that answers those questions. Engine-wide
metrics remain Engine-wide; do not attribute a shared Engine's total CPU to
Stats. Record accounting boundaries so VM, container and process CPU are not
added together and double-counted. Normalize cost by exactly verified samples,
events or complete dashboard journeys, with operation mixes held constant.
Always retain offered, accepted, rejected and completed counts alongside ratios.

Do not call dispatch-minus-storage a precise queue measurement or a native span
duration pure CPU time. Unavailable native export-loss counters remain unknown.
Distinguish monotonic elapsed time from wall-clock event alignment. Counters
reset across incarnation; histogram comparisons require compatible buckets and
coverage; missing series remain gaps rather than zeros.

Extend release evaluation from family presence to a small set of relevant
behavior gates: bounded backlog, recovery slope/settling, refusal/retry rates per
verified work, unexpected restarts, sustained pressure and source completeness.
Policies are versioned, frozen before the candidate run, and bound into existing
receipts. Add no arbitrary SQL or generic policy language.

Keep recursive telemetry bounded. Telemetry ingestion/export and the destination
actor must not create an unbounded observation cycle. Preserve existing route
exclusions, queue/size limits and failure isolation. Collector failure, queue
overflow and telemetry-store outage must leave application results correct and
make missing evidence explicit. Preserve the STA-128 study's <3% CPU and <5%
latency goals, five complete interleaved pairs and ten real browser clients.
Do not increase sampling or delete difficult samples to manufacture that result.

List the included observation components: application self-events, native bridge,
infrastructure collector and host observer. Charge each enabled component once;
report driver/sampler overhead separately. The historical STA-128 workload
predates parts of INF-7. Passing its original scope does not establish total
shipped-observability overhead unless those additional components were included
in the measurement. Qualify that combined scope explicitly.

**New planned study, SIM-OBS-1.** To make this follow-on executable, allocate one
new bounded acceptance study after classifying the original incomplete-browser
failure as far as retained evidence allows and validating the measurement fixes.
If its cause remains unattributable, preserve that conclusion and first prove
that the new diagnostics distinguish request failure, cancellation and incomplete
rendering; do not relabel the old failure as resolved. Preserve the historical failed
study and spent allowance; this is a separately identified follow-on, with the
same <3% CPU/<5% latency thresholds, representative load, ten browser clients,
exact outputs and collector-failure checks. Include the current shipped
observation components and state which original acceptance conditions it meets.
Allow at most seven attempted pairs to obtain the first five valid pairs in the
frozen order. Only predeclared environmental/measurement invalidity permits
replacement; application defects and guardrail failures reject the candidate.
Every started pair counts, and all results remain in the report.

Reuse a validated isolated state copy where its time coverage is suitable. This
new study plans at most one new isolated timestamped fixture from the same frozen
corpus, with the existing 1,800-second preparation bound, if coverage requires it.
Its preparation attempt is consumed on failure. Never overwrite, reopen or
reimport the protected original for this purpose. Declare and verify the new
fixture's complete identity, logical contents and time coverage. No further
acceptance run or preparation is implied by diagnostics; retain a specific next
proposal if this new budget is exhausted. Historical goals keep their historical
outcomes until fresh evidence satisfies every applicable condition.

The host observer needs a bounded round deadline, isolated check timeouts and
visible late/skipped checks; its present serial checks can delay unrelated
results. Bound its history/outbox storage while preserving incident receipts.
Keep its accepted location and deferred delivery. Readiness must include a fresh,
target-bound write/readback; public `/health` alone is insufficient.

Acceptance: an agent can retrieve a time-bounded incident or experiment and
identify the implicated layer, evidence quality, release and next diagnostic
action without parsing ad hoc logs. Demonstrate this for Engine pressure, a slow
application operation, and missing telemetry. Add a compact dashboard view over
the same queries after the CLI/evaluator slice works.

### S4 — Shrink production startup and the development loop

The pinned OpenOrange [deployment builder](https://github.com/rivet-dev/open-orange/blob/1cabf2e9db300361c9f0b751c7723da7eb706f5e/src/commands/deploy.ts)
already conditionally omits sandbox/Worker Loader dependencies from generated
deployment images. Stats' custom runtime installs
the broader package closure. First reuse or adapt that capability-based pruning
for the actual Stats workload, with a supported frozen lockfile and reproducible
build. Make this a Stats-specific supported production profile; preserve
capabilities required by other Stuff applications in their profiles. Verify
installed and imported code separately; package presence does not prove a
service runs.

Then measure moving configuration normalization and module rewrites/bundling
into release preparation. At pinned upstream `1cabf2e`, [orange serve](https://github.com/rivet-dev/open-orange/blob/1cabf2e9db300361c9f0b751c7723da7eb706f5e/src/commands/serve.ts)
parses Wrangler configuration and calls [bundleForServe](https://github.com/rivet-dev/open-orange/blob/1cabf2e9db300361c9f0b751c7723da7eb706f5e/src/serve/session.ts);
`no_bundle` still reaches the bundler. A narrow downstream serve entrypoint should consume validated,
prebuilt output if the measured startup/build/closure benefit justifies it.
Keep runtime secrets and environment-specific credentials out of frozen
artifacts. Bind compatibility settings, routes, assets, service bindings and
actor identities into the artifact, preserving their existing semantics.

Reuse upstream runtime modules. Avoid implementing a second Cloudflare runtime.
Remove Wrangler/esbuild from the serve closure only after the selected startup
path no longer imports or invokes them. Keep tooling needed for development and
the official workerd parity oracle in their respective build/test environments.
Do not hand-prune foreign-platform lock entries or make incidental deletion the
definition of success. Abandon the frozen-launch experiment if its new format
and maintenance cost outweigh the measured operational benefit.

Separate build environments deliberately. The musl production target does not
require the Cloudflare Vite plugin's glibc workerd to execute in a musl build
container. Use the pinned compatible build environment, record its identity,
and qualify the resulting runtime on native Linux/musl. Remove the current
dependence on a particular developer's Mac for Worker bundles. Reuse existing
buildlib/capsule support where the owning repositories already prescribe it.

Fix root-owned canary scratch and slow transfer on the measured path. Correct
permissions/lifecycle and content-addressed reuse are preferable to retries or
larger deadlines without explanation. App-only changes should rebuild only
app outputs; frontend edits should not restart the Engine. Preserve failed-build
recovery, retained state, exclusive ownership and clean cancellation in `make dev`.

Acceptance: the chosen serve artifact needs no package downloads or source
checkout at startup, uses only declared runtime endpoints, preserves both
Workers and all configured actor classes, and passes the
exact packaged-runtime canary and recovery checks. Report installed bytes,
package closure, startup CPU/time, staging bytes/time and warm edit-to-ready
before/after. Target at least a 30% reduction in a measured material iteration
or startup bottleneck; use that target to select experiments, not to weaken
correctness or force an unnecessary rewrite. Retire the superseded production
entrypoint only after the new one is qualified.

### S5 — Turn the existing release loop into an improvement loop

Allow baseline and candidate to select independent immutable app, runtime and
Engine/config inputs. `generate` already accepts an output root; pass per-side
outputs rather than the current shared default. Hold runtime constant for app
experiments and app bundles constant for runtime experiments. Label combined
changes explicitly and attribute their result to the combined deployment.

Keep the current fast profile and its exact acknowledgment/history/event tests.
Add representative qualification using existing corpus and browser machinery,
with distinct profiles for steady mixed traffic, bursts/overload, idle/alarms,
and post-pressure recovery. Include cold and warm state when the hypothesis
depends on them. Do not silently replace protected historical fixtures.

Make the load generator independent of request completion for capacity tests.
Record scheduled, actually offered, completed, timed-out, rejected and correctly
verified work. Measure dispatch lateness and end-to-end deadlines. A slow
candidate must not appear healthy because the driver quietly reduced its load.
Keep concurrency, queues and experiment duration bounded.

Replace hardcoded host-confounding status with evidence. Run the resource sampler
outside the request-driver event loop and record its own cost. Prefer interleaved
paired rounds on the same controlled host; simultaneous runs require verified
resource isolation. Account for CPU/IO/clocksource/thermal conditions relevant
to the host. Run an A/A control before accepting small gains. Preserve every
round and its validity classification; never cherry-pick the fastest runs.

Each experiment record contains:

- Baseline/candidate deployment and source identities, target scope and state
  snapshot/corpus identity.
- Hypothesis, predicted mechanism, one primary metric, meaningful improvement
  floor, absolute limits and guardrails, all fixed before measurement.
- Workload mix/rate, sampling settings, resource envelope, warmup, duration,
  paired-round order and environment admission evidence.
- Exact correctness/durability ledger; source coverage and gaps; component and
  whole-stack resources; per-operation latency and backlog/recovery evidence.
- Existing evaluator/receipt identity and two conclusions: admissible release,
  and improved/unchanged/regressed/insufficient evidence.
- Attempt outcome, raw evidence location/digests, rollback compatibility, and
  next action. Preserve rejected and interrupted experiments.

Default optimization evidence uses at least five valid paired rounds, a median
paired effect and uncertainty/within-variant spread. Predeclare a maximum number
of attempted rounds and an invalid-round replacement rule before starting;
invalid rounds remain visible, and repeated sampling until a favorable result
is prohibited. A claim must exceed the
measured noise floor and a predeclared useful effect. For initial resource
experiments, prefer changes capable of at least 10% improvement in the selected
cost; smaller changes need correspondingly stronger precision. Do not apply
the fast profile's 25% tolerated regression as an optimization target. Establish
tighter per-operation guardrails before the run; begin with a 5% relative
regression bound plus an explicit, justified absolute latency floor. Always
retain hard correctness, durability, delivery and resource limits.

Rank outcomes in this order: correct durable results and recovery; availability
under the declared load; simpler/faster operation; whole-stack resource cost;
per-operation latency and footprint. A weighted score must not let speed
compensate for lost writes, reduced workload, missing metrics or broken recovery.

Complete representative end-to-end experiments in all three layers:

1. A Stats app change, using different app bundles under the same runtime.
2. An OpenOrange packaging/startup change with the same application contract.
3. A Rivet Engine/config change driven by the S2 diagnosis or measured cost.

Use the same comparison, receipt and rollout path. A validated stability fix
counts as an improvement; a forced cosmetic optimization does not. At least two
adopted improvements must span the application and infrastructure layers. Record
an unchanged candidate honestly, then pursue the next measured bottleneck.
Engine promotion remains incomplete until its actual target scope is qualified.

Negative controls must reject a wrong successful HTTP body or lost acknowledged
write, make missing sources/confounded hosts/late load generation inconclusive,
refuse altered staged components before activation, and demonstrate journaled
recovery after controller interruption.
Choose focused fault tests; avoid expanding broad test/mutation suites without
a concrete remaining risk.

### S6 — Prove portability, recovery and sustained operation

Preserve the existing import boundary test and extend it to keep direct
OpenOrange/Rivet dependencies out of portable cores. Run the shared service/store
corpus through the plain Node reference, OpenOrange and official workerd/Miniflare:
STB2/STA2 identity and integer precision, duplicate/conflicting replay,
transactional failures, authorization and canonical history/observation output.

Exercise adapter-specific concurrency, response durability/output gates,
persisted/overdue alarms, restart/idle rehydration and service bindings against
OpenOrange and workerd. Test logical restore through each supported HTTP
maintenance path. Node's current observation HTTP adapter does not expose the
Cloudflare adapter's administrative maintenance dispatch; portable snapshot unit
tests do not qualify Node HTTP backup or full actor-lifecycle semantics. Keep
Node's reference role precise instead of expanding it into another runtime project.

Cloudflare's current contracts include strongly consistent per-object storage,
transaction/input/output-gate behavior, and at-least-once alarm handling. Test
the semantics Stats relies on rather than broad API-shape compatibility. Keep
unsupported provider CPU/billing/tail capabilities explicitly unavailable on
OpenOrange. Sources: [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[alarms](https://developers.cloudflare.com/durable-objects/api/alarms/),
[object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

Include all configured state owners: Installation, ObservationStore and
MetricStore. Default metric-history policy for this campaign: raw infrastructure
scrapes remain bounded/expiring; frozen incident/qualification evidence is
durable outside that store. Declare this in backup manifests so a restore never
claims full metric-history preservation. Add metric export/import only if a
specific retained-history requirement needs it. Prove fresh collection and
source identity after restore, and replay of independently frozen evidence;
do not claim expired raw scrapes were reconstructed or restored.

Prove logical export/restore into a fresh namespace with exact canonical
readback and replay. A copied Engine directory is not a Cloudflare migration
format. A real Cloudflare staging rehearsal, when the account/environment is
available and authorized, must verify deploy, import, post-import ingest,
alarm/restart behavior and compatibility before a later Cloudflare cutover.
Local workerd parity establishes local compatibility; it does not establish
production Cloudflare readiness. Record the distinction without blocking
independent self-hosted work.

Run one valid 24-hour operational soak of the selected deployment after focused
qualification, with representative traffic, ordinary ingress, complete source
coverage and frozen evidence exported before retention. Include scheduled
private fault/recovery phases and report them separately while retaining the
inclusive user-visible failure accounting. Require no lost acknowledged writes,
no unplanned restart or sustained post-pressure failure, bounded memory/storage,
and the frozen per-operation latency/availability limits. Missing intervals
make the relevant acceptance inconclusive; a collection of short successes is
not a complete soak. Preserve the earlier P8 constraints when claiming P8.

Rehearse recovery on independent state, verify its exact scope and data horizon,
and record both capture and restoration age against the frozen S0 budgets.
Report detection, safe-write recovery and full restoration time separately;
a stale successful restore does not qualify a current recovery point. Keep
backup RPO separate from the
agent's temporary upload queue and from application-runtime rollback. Do not
restore an old database snapshot over newer acknowledged writes to simplify
rollback. Irreversible state changes require their own verified migration and
recovery plan before activation.

## Completion, autonomy and reporting

The enabling campaign is complete only when:

- The supported target is reproducible and current state is inspectable.
- App/runtime/collector deployment and physical capture use shared ownership;
  stale rollback and controller interruption controls pass.
- The Engine failure is explained and repaired. Resource reservations alone
  do not satisfy this condition.
- Infrastructure history and evidence-quality information are usable from the
  CLI/evaluator; observation overhead has a valid result under its original
  conditions, and the additional shipped instrumentation has qualified overhead.
- Separate Stats builds and infrastructure builds have completed valid
  experiments through the same path, with at least two adopted improvements
  across application/infrastructure and valid Rivet stability/optimization proof.
- The selected deployment passes sustained operation and state-safe recovery;
  portability evidence states exactly which environments were exercised.
- Superseded state machines and production recipes are retired; one concise
  current runbook links to historical evidence. Operating complexity and
  iteration time are lower than the refreshed baseline, with measured results.

An unmet requirement keeps this campaign open or blocked. In particular,
unexplained Engine failure or unqualified observation overhead prevents closure;
partial implementation still retains its own verified results.

Use existing owner authorization, repository workflows and release rules.
Routine source changes, focused tests and isolated experiments should proceed
autonomously. Keep production promotion within the established authority and
receipt-bound transaction. This campaign does not expand authority for a shared
Engine, writer handoff, destructive state reset, DNS change or upstream action.
Finish available implementation/qualification before presenting a concrete
environment or owner dependency; do not repeatedly ask about settled decisions.

When a measurement fails, preserve its state and explain the missing evidence.
Fix the cause, improve a specific diagnostic, or continue another unblocked
step. Changing the evaluator, workload, threshold or sampling contract creates
a new comparison identity and cannot retroactively qualify old results.

At each checkpoint, update this progress table and provide: the user-visible
problem addressed, code/configuration removed or consolidated, measured result,
qualification scope, remaining blockers and the exact next command or task.
Distinguish implemented, locally verified, privately qualified and promoted.
Never report the whole campaign complete while Engine stability, evidence
quality or required recovery remains unproven.

Once these enabling conditions pass, continued optimization is open-ended:
select the largest measured cost or operational burden, propose one small
change, and repeat the established loop. Keep extending evidence and reducing
operating work; avoid accumulating another campaign framework around it.
