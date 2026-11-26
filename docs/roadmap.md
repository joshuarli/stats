# Roadmap

This is the single plan for this repository: all current and future work, and the handoff for resuming it. Campaigns are sections below, and their items interleave in **Sequence**. "Resume the roadmap" means continue from **Status**.

## Status

- Native migration (NS): active since 2026-11-26 and supersedes Decision 1 of the simplification campaign (keep OpenOrange/Rivet) and the "reference adapter only" status of the Node backend. Production Stats runs on Node in the Threadripper guest since 04:57 UTC (fresh installation, credentials rebuilt; see [operations](operations.md#production-in-the-threadripper-guest)). Open: NS4 (24 h soak, removal of OpenOrange/Rivet from the guest after 04:57 UTC on 2026-11-27, STA-140). The post-cutover quality pass is recorded under the campaign. Resume from [Campaign: Native Stats](#campaign-native-stats); shared Stuff stages are campaign NM in the [Stuff roadmap](https://github.com/laputa-systems/stuff/blob/main/docs/roadmap.md#campaign-native-stats-and-stuff).
- Active: simplification and self-optimization, S1, S2 and S5; S0 is complete.
- Last accepted repository revision: `c5855db751141c82e9a90bfa3fe6644ab56c4a14`; integration green at this revision is not established. S0 recorded a green fresh-checkout `make cloudflare-test`.
- S1 app and collector use the rollout transaction; capture and disposable guest recreation were exercised. S2's log-shard mechanism was repaired; the CPU spin remains open (STA-135).
- S5 compared two builds, but host confounding remains asserted and no improvement experiment has run. The S6 soak failed after an Engine restart (STA-138); no valid 24-hour soak is established.
- Performance P6–P9 remain unqualified. The fresh fixture preparation and first overhead study are consumed; the tenth Engine shutdown failed (STUF-90).
- INF-11 Engine promotion is held pending its adapter, representative consumers and sustained qualification. Observer alert delivery is deferred (STA-130).
- On 2026-11-24 the Lisa-to-Threadripper DNS regression was repaired durably in `~/usr` (`ts.net.` forwarded to MagicDNS plus the tailnet search domain), and Stats was re-verified end to end: health 200, dashboard 200, `statsctl check ingest` all seven steps pass.
- On 2026-11-24 Stuff's write primary was handed to the Threadripper guest under the [Stuff cutover runbook](https://github.com/laputa-systems/stuff/blob/main/docs/roadmap.md#campaign-stuff-primary-on-threadripper): Lisa's coordinators frozen, buckets copied, exports imported byte-identically, route switched to `127.0.0.1:18491` and guest coordinators thawed. An OCI canary publish passed, the exposed guest store key was rotated, and Lisa's `oo-app.stuff` and `oo-replica-sync` were removed from the default runlevel. No R2 replica is fed. Lisa's edge and the other apps (Discover, discover-preview, nanoshop, agentctl, discover-wine) are **explicitly parked** on Lisa by owner decision on 2026-11-24; no cutover is planned for them, and their Engine/store and ingress units stay in place.
- Parked performance drafts `feat/perf-overview`, `fix/perf-producer-drain`, `test/perf-live-reads`, `test/perf-native-recovery`, `test/preview-production`, and `test/native-dashboard-bench` are unreviewed retained drafts; consult them only if the corresponding work needs missing material. Their individual parking causes are not recorded here.
- Other checked-out lanes: `deslop/acc-sandbox`, `deslop/finish`, `deslop/diagnose-core`, `deslop/ingest-types`, `fix/command-tree-cancel`, `fix/development-shutdown`, `refactor/btree-to-hash`, `chore/solid-2-stable`, `upgrade/npm-deps`, `upgrade-the-world/stats`, `upgrade-the-world/todos`, and `repomod/fix/7ec736dab90843dcbce1f6d6870e7b22`.
- Checked-out release lanes: `campaign/drop-services`, `campaign/musl-artifact`, `campaign/release-gate`. Lane owners, parking causes and retry conditions are not established by this checkout; preserve these worktrees and reconcile with their owners before reuse.
- Next: exercise STA-138 on a disposable guest and continue S1/S2, bringing forward only the S3 measurements needed for diagnosis.

## Charter

Preserve exact acknowledged data, authentication, bounded queues and gap semantics. Keep failed fixtures and consumed attempt budgets. Time measurements require clear host gates before and after each run. Use the existing rollout transaction and do not treat this roadmap as authority for shared Engine changes, writer transfer or destructive resets.

## Sequence

| ID | Campaign | Owned files | Prerequisites | Acceptance command |
| --- | --- | --- | --- | --- |
| NS | Native Stats | `cloudflare/src/node/`, `deploy/node/`, `deploy/observer/` | Parity lane `campaign/native-stats-parity` accepted | Per-stage acceptance in the campaign below |
| STA-138 | Simplification S1/S6 | `deploy/orange/recovery/guest/`, `bench/standby-soak-faults.py` | Restored disposable capture and functional ingest check | `deploy/orange/recovery/guest/test-native-stats-respawn.sh`; real-app restart and new soak also required |
| STA-135 | Simplification S2 | Stuff Engine configuration and `deploy/orange/recovery/` | Validated capture and isolated reproduction | `deploy/orange/recovery/contention-drill.sh start`; reproduce the spin and verify the repair |
| S3 | Simplification | `cloudflare/src/metrics/`, release evaluator | Bring forward the measurements needed by S2 | `make cloudflare-test`; verify the investigation scenarios below |
| S4 | Simplification | `deploy/orange/`, Stuff runtime build | Isolated runtime baseline | `make orange-test`; compare edit-to-ready and closure against baseline |
| STA-128 | Performance W4 | `bench/observation-overhead*.mjs` | Classify original browser failure, preserve attempt ledger; no new allowance is implied | `node --test bench/observation-overhead-analysis.test.mjs`; full five-pair study requires its original conditions |

## Campaign: Native Stats

### Goal and state

Run production Stats on the existing Node backend (node:http, node:sqlite),
portable cores, Rust agents and dashboard, with no OpenOrange or Rivet. The
canonical origin, tailnet trust boundary, ingest and service credentials and
host registrations are preserved; telemetry history may restart from an
explicit reset marker. Stats must then observe the Stuff migration (Stuff
roadmap campaign NM) and one bounded improvement cycle. Failed fixtures,
consumed attempt budgets and STA-128/135/138 remain evidence; removing the
runtime does not close them as repaired.

### Baseline (2026-11-26, read-only)

| Fact | Observed |
| --- | --- |
| Route | Lisa Caddy `stats.17166969.xyz` (tailnet only, identity sidecar, `Stats-Gateway-Secret`) → `127.0.0.1:18489` → `oo-stats-live-tunnel` → Threadripper `127.0.0.1:49177` → guest `127.0.0.1:8080`; direct ingest/markers via `oo-stats-direct-proxy` |
| Guest | `stats-recovery-vm` (`~/.local/share/stats-live-recovery/20261118`, 8 vCPU, 4 GiB, `cpu.weight 10000`, `memory.min 5G`); root filesystem 91% used (2.2 GiB free) |
| Processes | `native-stats` (`orange serve` + two runners, 13 respawns recorded), rivet-engine container (≈4 cores busy continuously, the STA-135 spin), `stats-infra-collector` |
| Observer | Threadripper `stats-observer` (Node 26.13.1 musl), 60 s probes of Stats health, synthetic ingest and registry status codes |
| Host | Threadripper load ≈20; the Stats VM's qemu is the largest CPU consumer (≈415%) |

### Stages

| Stage | What | Acceptance | Recovery | Status |
| --- | --- | --- | --- | --- |
| NS1 | Node parity: gateway auth adapter, operation sink, HTTP capture and browser journeys, runtime/SQLite observations, SQLite WAL/FULL policy, bounded shutdown, loaded identity | `pnpm --dir cloudflare run typecheck lint test:node test:observe test:node-e2e test:metrics` | n/a | Done (merge `0d9d04b3`) |
| NS2 | Guest packaging and isolated candidate | Candidate `stats-node.candidate` on `127.0.0.1:8180`: health, gateway 401 without secret, registration restore rehearsal | Old unit untouched | Done |
| NS3 | Cutover | 04:56:54–04:57:18 UTC; synthetic ingest all seven steps pass; lisa, threadripper and sentry resumed; ten restarts 0.66–1.03 s to ready with exact readback; `statsctl` targets `node` at the canonical origin (`5b26fc4e`) | `rc-update add native-stats default && rc-service native-stats start && docker start live-stats-engine` after stopping `stats-node.main` | Done |
| NS4 | Soak and self-improvement cycle; then remove OpenOrange/Rivet from the guest | 24 h soak and 24 h post-cutover; one recorded hypothesis | Retained OpenOrange data on the guest disk | Open |

Before the cutover the OpenOrange deployment answered `/health` but returned
503 for `/api/v1/hosts`, `/api/v1/admin/objects` and the service list, and
Lisa's ingress logged about 60 Stats 5xx every ten minutes; inside the guest
the Rivet Engine container used about four cores continuously (STA-135). Stuff's
application events had also been lost since 2026-11-24: its endpoint named the
old Lisa container address. They now go to the canonical origin.

The independent observer on Threadripper records the effect: from 03:00 to
04:56 UTC synthetic ingest failed 18 of 18 rounds and host freshness 89 of 89
while health stayed 200; after the cutover ingest passed 10 of 10 and hosts 52
of 53, the one miss at 05:00:12 inside the deliberate ten-restart check. Stuff
content probes over the same span (04:05–05:50, 10,948 probes on public and
direct paths) recorded no failure. Production cannot yet demonstrate a browser
journey: the journey fires from the project overview and native Stats has no
projects configured; the receiver is covered by `test/node` and
`test/node-e2e`. The observation-overhead gate (STA-128's protocol) assumes the
Engine runtime and has not been run against the native backend; it remains
open.

Post-cutover quality pass (2026-11-26, after an independent review of
`d62a0708..master`):

- **Removed:** the `synthetic-check` host and the `statsctl check ingest`
  command (`d6de8886`). Real-host freshness from `check hosts` replaces both.
  The deploy-verification safety check now reads a `check hosts` document.
  The observe store dropped its `synthetic` column in one forward migration.
- **Health checks:** mandatory and strict (`69a86f5f`, contract in
  [integration](integration.md#4-health-semantics)):
  - Registration requires a health URL.
  - Probes run every 60 s with a 2 s timeout. Only a 200 with a valid body
    counts as up.
  - The latest result is persisted and shown in the services list, CLI and
    dashboard.
  - Stats' own `/health` follows the contract.
  - stats, stuff and tansu probe `ok`. agentctl and discover-wine are `down`
    (`invalid body`: parked apps that still answer in the old format), and
    nine rows are `missing`.
- **Security fixes:**
  - Plaintext registration input shredded on the guest;
    `restore-registrations.mjs` now takes verifiers only (`4cd581a0`).
  - `STATS_AUTH` is now required (`f3e250d6`).
- **Observer fixes:**
  - It no longer stalls silently when evidence space runs out, and rotated
    files are pruned (12 kept, about 14 days).
  - Large artifacts are probed every 5 minutes instead of every 15 s.
- **Backup:** the Node logical backup covers the installation only
  (`fc59fad9`). Node observation stores never implemented export or
  maintenance, so `backup fence` created empty stores and then failed.
- **Hosts and memory:** `m1-max` re-registered from its own verifier.
  `synthetic-check` purged. The guest has 2 GiB with free page reporting:
  host residency fell from about 4.1 GiB to about 640 MiB (`e41da366`).
- **Diagnostics:** `request_failed` records now carry the method, the path
  and the cause (`1d18d6e6`). Two earlier processes that logged it shut down
  slowly once; the cause is unknown until it recurs with the new detail.
- **Credentials:** the eight credentials left unusable by the reset were
  rotated and verified without writes (STA-139 closed). STA-141 records the
  parked Lisa producers that still send to the retired container.

Follow-ups: STA-140 (remove OpenOrange from the guest after 24 h),
STA-141, STA-142 (disk-usage RFC), STA-143 (agents in the guests),
STA-144 (tim), STA-145.

## Campaign: Simplification and self-optimization

### Goal and state

Make Stats, OpenOrange and Rivet straightforward to change, diagnose and recover. S0 is complete; S1 and S5 are in progress, and the unreproduced part of S2 remains open. The ticket backlog is [TODO.md](../TODO.md).

### Outcome

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
[infrastructure release campaign](roadmap.md#campaign-infrastructure-release) remains the evidence
record for completed releases and the owner of its established release contracts.
The [performance campaign](roadmap.md#campaign-performance) retains its thresholds,
protected fixtures, failed attempts and unresolved acceptance. This document
does not mark their open work complete or reset their consumed attempt budgets.

### Decisions

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

### What the current evidence actually establishes

| Finding | Evidence at the review baseline | Consequence |
| --- | --- | --- |
| Full runtime identity, bound receipts, two owned OpenOrange patches and unattended recovery exist | [INF qualification record](openorange.md#runtime-release-record-2026-11-20) | Extend these mechanisms; preserve their negative controls. |
| Standby app deployment has a separate activation/rollback implementation | [standby-deploy.sh](../deploy/orange/standby-deploy.sh) reads selection before the lease, checks public health after releasing it, and obtains a new lease for unconditional rollback | A failed deployment can restore its old selection after another deployment has taken ownership. This is a source-level race, not an attributed incident cause. |
| The supported standby Engine has manually maintained configuration | [standby incident record](openorange.md#standby-incident-2026-11-21) records an untracked Engine definition and manually applied limits | Reproduction and recovery currently depend on facts outside the checkout. |
| The November 21 alarm/registration failure is unresolved | [STA-135](../TODO.md), [Stuff degradation investigation](https://github.com/laputa-systems/stuff/blob/501db1136f4c64c478401fc92201fb44671cb386/docs/openorange-engine-degradation.md) | CPU contention alone did not reproduce it; the latest drill substituted a fresh depot after the copied depot proved inconsistent. |
| Runtime canaries hold the app bundles constant | [promotion.mts](../deploy/orange/qualification/promotion.mts) assigns the same Worker digests to both sides; [stack.mts](../deploy/orange/canary/stack.mts) uses shared build outputs | This path cannot yet evaluate a baseline Stats build against a different candidate Stats build. |
| Infrastructure metrics are ingested, but their historical behavior is poorly exposed | [MetricStoreCore](../cloudflare/src/metrics/store-core.ts) has `series`; [metric HTTP](../cloudflare/src/metrics/http.ts) exposes batches and sources; [release evaluator](../cloudflare/src/cli/verify/release-decide.ts) checks required family availability | A healthy scrape does not establish healthy queues, retries or storage. |
| The qualification harness asserts no host confounding | [promotion.mts](../deploy/orange/qualification/promotion.mts) writes `hostConfounded: false`; [resource sampling](../deploy/orange/canary/evidence.mts) synchronously invokes Docker from the load-driver process | Small CPU/latency gains are not established by this harness without stronger controls. |
| The fast profile is deliberately small | [promotion profile](../deploy/orange/qualification/profiles/promotion.json): 60-second warmup, 600-second measurement, 10 requests/second, 25% relative resource tolerances | Retain its useful functional checks; add representative and failure-specific qualification. Do not label a pass as a performance win. |
| Metric history has a different recovery contract | [metric store](../cloudflare/src/metrics/store-core.ts) retains 24 hours; [logical backup](../cloudflare/src/cli/commands/backup.ts) covers Installation and observations | Freeze optimization evidence independently of metric retention; explicitly define metrics recovery before claiming all-state portability. |
| Observation overhead is still unqualified | [STA-128](../TODO.md), [resumption](roadmap.md#campaign-performance) | Preserve the <3% CPU and <5% latency targets and the failed-study record. The 38.8% insertion-batching component win does not close this gate. |

The November 18 clocksource/HPET incident has a separate recorded mechanism.
Do not use it to claim the November 21 spin is explained. Native deployment also
reproduced a depot/registration failure, as recorded in [native Lisa](roadmap.md#campaign-native-lisa-deployment).
Deleting Docker or increasing timeouts is not evidence of fixing that failure.

### Target operating model

An operator or agent should need to know the target and proposed change, then
use one supported path to inspect, build, compare, qualify, activate and recover.
The implementation can retain separate components and narrow adapters.

#### One inspectable deployment

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

#### A small path from evidence to action

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

#### S0 — Refresh truth and set the baseline

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

#### S1 — Consolidate deployment and capture ownership

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

#### S2 — Explain and repair Engine degradation

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

#### S3 — Make observations useful for diagnosis and comparison

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

#### S4 — Shrink production startup and the development loop

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

#### S5 — Turn the existing release loop into an improvement loop

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

#### S6 — Prove portability, recovery and sustained operation

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


### Acceptance and execution boundary

Complete the campaign only when the supported target is reproducible; deployment and capture share ownership; the Engine failure is explained and repaired; observations and overhead are qualified; two improvements across application and infrastructure have valid comparisons; sustained operation, recovery and portability pass; and complexity and iteration time decrease against baseline. Unexplained Engine failure or unqualified overhead prevents closure. The existing transaction and authorizations remain binding.

### Needs environment and reference

Use isolated state for stress and recovery. A real Cloudflare staging rehearsal needs an available, authorized account; local workerd parity does not establish production readiness. Read the [S0 baseline](../bench/results/2026-11-22-sim-s0-baseline/README.md), [standby soak](../bench/results/2026-11-22-standby-soak/README.md), [incident record](openorange.md), and [metrics RFC](rfc/INF-7-infrastructure-metrics.md).

## Campaign: Infrastructure release

### Goal and state

Qualify exact owned OpenOrange and Rivet artifacts against a verified baseline, promote only bound receipts, and recover unattended. INF-1–5 and INF-8–10 landed or were promoted; INF-7 metrics are live but dashboard and gate reads remain open. INF-11 is held pending an Engine-replacement adapter, sustained qualification and representative checks for Stats, Discover, Tansu and Stuff. The Threadripper-host observer shares fate with the host; alert delivery is deferred under STA-130.

### Baseline and reference

The original review started from Stats `7fc3ff9` and Stuff `9fb6f1d`. The bound-receipt promotion and unattended recovery are documented in [OpenOrange operations](openorange.md#runtime-release-record-2026-11-20); the [metrics RFC](rfc/INF-7-infrastructure-metrics.md) remains the contract. RivetKit and the N-API addon still need owned rebuilds.

### Deliverables and backlog

Priority order. Each item has one acceptance command, which runs locally unless
the item is listed under Needs environment.

| ID | Phase | Deliverable | Owner repo | Acceptance | State |
| --- | --- | --- | --- | --- | --- |
| INF-1 | 5 | `statsctl verify release`: offline evidence bundle that yields `pass`, `reject`, `pending` or `inconclusive`, with stable reasons and replay | Stats | `pnpm --dir cloudflare -s test:cli` with `verify-release.test.ts` | landed |
| INF-2 | 3 | OpenOrange serves RivetKit metrics for every Worker, with Worker identity and start time | OpenOrange downstream | `tests/orange-serve.test.ts` two-Worker case | accepted (patch) |
| INF-3 | 1–2 | Source ownership registry, release manifest schema `openorange-release-manifest/1`, read-only `release-inspect` | Stuff | `test_sources.py`, `test_release_inspect.py`, `bin/sources verify` | landed |
| INF-4 | 2 | Drop `@rivet-dev/services` from the Stats runtime closure, with a packaged-runtime proof | Stats | `make orange-test` plus packaged image evidence | promoted (`rt-a26798107529`) |
| INF-5 | 2 | Import INF-2 as the first OpenOrange downstream patch; build an identified release (package tarball and manifest) from a clean checkout with the network disabled after acquisition | Stuff | `bin/sources verify` and a release build that reproduces its digest | landed |
| INF-6 | 3 | Independent observer: a pinned Node/SQLite Stats instance on a host that shares neither the candidate's Engine nor its storage, plus external health alerting | Stats + Stuff | Observer ingests host and service events; stopping the writer raises an alert | runs on Threadripper's host (shared-fate risk accepted); alert delivery out of scope |
| INF-7 | 3 | Typed infrastructure metrics path: allowlisted OpenOrange, RivetKit and Engine Prometheus series stored with counter, gauge or histogram semantics, Worker identity and reset detection | Stats | ingest and readback tests over real scrapes of INF-2 output | live on the standby; dashboard and gate reads open |
| INF-8 | 4 | Isolated baseline and candidate stacks (separate Engine, depot, namespace, credentials, ports) and a deterministic workload driver with an independent request ledger that validates response bodies | Stats + Stuff | A wrong HTTP-200 body fails the workload; both cohorts reconcile every durable result | landed |
| INF-9 | 6 | Resumable rollout transaction (`staged` → `qualified` → `prepared` → `activated` → `verifying` → `promoted` / `recovering`), host maintenance lock, journal outside Stats and Rivet, watchdog | Stuff | Interrupt-and-resume tests at every transition; concurrent lock refusal | landed; receipt-bound, watchdog recovery shown live |
| INF-10 | 7 | State-safe promotion and recovery: previous runtime reads candidate-written state, one authoritative writer, bounded write pause | Stats + Stuff | Good candidate promotes, bad one rejected pre-production, post-activation failure recovers without losing acknowledged writes | promoted `rt-2c70c316ce8d`; unattended watchdog recovery shown |
| INF-11 | 8 | Qualify the existing private Rivet Engine patches through the loop | Stuff | INF-1 `pass` on the Engine release class | qualified; production held |
| STA-130 | ops | Supervise the standby VM; alert on Stats downtime | Stats | See TODO.md | open |

### Rulings

- Runtime promotion targets the current writer, the native standby. Native
  failback to Lisa stays a separate, fenced migration.

- Only `pass` from INF-1 authorizes promotion. `verify --service` remains an
  improvement judgment and is not a promotion gate.
- Synthetic traffic uses isolated service identities. It is never relabelled
  as organic.
- A Stats-only pass qualifies only Stats' deployment scope, never a shared
  Engine promotion.
- The standby deploy refuses runtime-closure changes. INF-4 and INF-5 land on
  master only once INF-9 can deploy runtime releases, or with an explicit
  runtime upgrade of the standby.
- The observation-overhead objectives (STA-128) remain targets needing fresh
  qualification.

### Needs environment

- INF-11 needs every registered consumer of the shared Engine (Stats, Discover,
  Tansu, Stuff) to have a representative contract check.


## Campaign: Performance

### Goal and state

The original campaign closed with blocked goals; later authorized work continues without resetting its thresholds or budgets. P1 and P3 passed only for the recorded production cohorts, P4 for its observed cohort, P5 for local cases, and browser heap for its recorded cohort. Tenfold P6, observation overhead P7, native soak P8 and repeated recovery P9 remain unqualified. P2 natural sleep still needs positive sleep evidence (STUF-86).

The fresh fixture contains 203,950 verified rows. Its fresh preparation allowance is consumed. The first complete overhead study aborted on two incomplete browser journeys; classify that failure before a further accepted comparison, and do not infer a new allowance. Native insertion batching is component evidence, not P6/P7 acceptance. Nine recovery cycles passed; the tenth TERM failed before restart. Preserve the stopped failed depot at `/home/josh/.work/stats-perf-campaign/sta128-20261117/fresh/`; copy the entire stopped root and rewrite both storage paths before reopening. Resolve STUF-90 before another ten-cycle acceptance cohort. P8 needs STUF-88 and complete queue coverage.

### Decisions and baseline

Keep the frozen corpus, failed receipts and existing attempt budgets. W2 has at most three full runs, W3 two attempts, W4 one study and W5 one investigation; diagnostics do not reset consumed allowances. The seven-day test requires a complete window through ordinary tailnet ingress. Do not use the retention-clamped historical endpoint as seven-day evidence. The pre-rollup ten-client 24-hour HTTP p95 was 5,513 ms; maintained rollups measured 398 ms. These do not establish combined browser and ingest performance.

### Next acceptance

STA-128 requires five interleaved enabled/disabled pairs, ten real browsers, representative ingestion, separate Stats and Engine CPU, exact outputs, and collector-failure parity. Report inconclusive when same-variant spread exceeds 3% CPU or 5% latency. P9 requires ten ordinary restart cycles with exact acknowledged state and readiness below 15 seconds. P8 needs a valid representative 24-hour soak and complete queue coverage. See [STA-128](../TODO.md), the [overhead evidence](../bench/results/2026-11-17-observation-overhead/README.md), [fence diagnosis](../bench/results/2026-11-17-term-fence-diagnosis/README.md), and [closeout evidence](../bench/results/2026-11-16-campaign-closeout/README.md).

### Acceptance goals

| ID | Outcome | Passing evidence |
| --- | --- | --- |
| P1 | Instant cached ranges | Selection to complete charts p95 <50 ms and p99 <100 ms. Zero summary fetches within the valid generation |
| P2 | Fast uncached ranges | Awake actor, empty client range cache: 1h, 6h and 24h p95 <750 ms. After actor sleep: p95 <1,500 ms. Seven-day views p95 <2,000 ms |
| P3 | Fast navigation | Initial project navigation to useful health p95 <1,000 ms and complete overview charts p95 <2,000 ms |
| P4 | Explain slow journeys | Browser input, fetch, server, actor, SQL, decode and render phases correlate. At least 99% of delivered journeys over one second identify the dominant phase. Missing phases stay explicit and do not count as successful attribution |
| P5 | Actionable overview | Scripted healthy, failing, slow, stale and post-deployment incidents expose state, onset and a useful investigation target within ten seconds |
| P6 | Maintain performance at scale | P1–P3 pass against ten times the frozen production corpus, with representative ingestion and ten concurrent dashboard clients. Acknowledged samples remain exact and duplicate handling remains correct |
| P7 | Cheap self-observation | Events queryable p95 <5,000 ms. Enabled instrumentation adds <3% CPU and <5% request latency against disabled instrumentation. Collector failure does not change application outcomes |
| P8 | Stable resource use | Retained browser heap grows <5 MiB after 200 warmed navigation and range cycles. During a 24-hour representative soak, memory, actor counts and queue depths plateau |
| P9 | Proven native recovery | Repeated ordinary restart, idle eviction, overdue alarms and interrupted requests preserve acknowledged state. Ordinary restart readiness <15 seconds |

A goal fails if it relies on any of the following: a cache hit substituted for
a cold read, an empty response, a missing event, a relaxed durability boundary
or a rejected request. The seven-day target uses the actual retention window.

### Measurement contract

The tenfold fixture is derived from a frozen, checksummed capture of the retained
corpus. It preserves size, operation mix, outcomes and time distribution, and it
assigns independent event identities
([corpus](../bench/results/2026-11-15-tenfold-corpus/README.md)).

Measure complete browser journeys from the Mac over the normal tailnet route,
with a fixed viewport, browser build and device settings. Record request, asset
and response bytes. A journey ends when useful health and every expected chart
show committed data for the new window. Errors and cancellations stay in the
result set.

Cached, awake uncached, actor-sleep and process-start conditions are measured
separately. Never flush Lisa's caches to simulate coldness. Resource figures
separate Stats from the shared Engine.

Comparisons use at least five interleaved rounds. Percentile acceptance needs
at least 200 successful journeys per condition, keeps per-range distributions
separate, and reports counts, spread, p50, p95 and p99. Timing gates must pass
before and after each accepted run. Results from a busy host are diagnostics
only. Profiling runs stay out of timing comparisons.

### Execution boundary

There is no Engine upgrade, credential rotation, durable-data migration, new
database, orchestrator or trace backend. S3 backups remain deferred as STUF-75
P1. Explain candidate API, schema, permission or transaction changes before
implementing them, and verify them with their affected callers.


## Campaign: Native Lisa deployment

### Goal and state

Native failback to Lisa is a separate fenced migration. Threadripper remains the supported writer until a fresh verified export, transfer of newer writes, rollback proof and soak pass. Isolated restore and Docker readback were demonstrated; production cutover was not established. The historical rehearsal details remain in [Lisa recovery](lisa-operational-recovery.md#native-lisa-rehearsal).

### Decisions and baseline

Keep network trust boundaries, single-writer authority and a verified rollback. The earlier all-Docker Lisa inventory was a historical baseline, not current production state. Native startup does not itself repair the Engine registration or depot failure.

### What native means here

No container runtime in the serving path. OpenRC supervises host binaries
directly. Docker may remain for offline builds (`make agent-build` already
does this) and for image creation during the transition only. The plan assumes
Alpine stays (not a glibc reinstall): every component has a musl path.

Costs ~2–4 days of engineering plus rehearsal and a soak; touches every app on
the host, not just Stats. It is a platform change owned in the `stuff` repo
(`deploy/openorange/`), with `stats` gaining a native deploy path.

### Component by component

| Component | Native candidate | Notes |
| --- | --- | --- |
| Rivet Engine | `@rivetkit/engine-cli-linux-x64-musl@3.1.2-rc.1` (static-pie Rust, `libc: [glibc, musl]`, published on npm; pin sha256) | open-orange declares Linux x64/arm64 musl a supported host and resolves this package at runtime. Engine command is `rivet-engine --config /etc/rivet/config.json` with `RIVET__AUTH__ADMIN_TOKEN`. Data dirs unchanged → no state migration. Verify `--version` prints 3.1.1 and `/health` answers before trusting it; the deployed glibc image reports the same, so version string cannot distinguish them — pin by npm tarball sha256 + verify report, not `--version`. Re-check what the **image** actually ships: the musl build is a few MB, the image is Debian; the engines differ only by libc, but that is unproven until run. |
| versitygw | Go binary; no apk package; build with `apk add go` or pin a release/static build + sha256 | codelist pins it by image digest today; native replaces digest pin with binary sha256 in `images.lock.json` equivalent. posix backend paths unchanged. |
| Caddy ingress | xcaddy build (caddy 2.11.9 + caddy-dns/cloudflare v0.2.4), static musl; `apk caddy` 2.11.4 lacks the module | `cap_net_bind_service=ep` on the binary or uid 10001; binds only 100.68.104.43:443 and the public 127.0.0.1:18480 listener. The xcaddy build is reproducible today; the ingress Dockerfile does exactly this, minus the musl target. |
| identity sidecar | `apk add python3` (stdlib only) | Already a plain script; runs native with `--network none` semantics replaced by "only listens on /run/openorange/identity/identity.sock, no egress" (tailscaled LocalAPI whois probing stays). |
| CoreDNS | `apk add coredns` 1.15.0 (static Go) | Corefile unchanged. |
| cloudflared | no apk package; pin GitHub release binary + sha256, or build from tag | Same config; health is the tunnel's own metrics. |
| Platform collector and Rivet dashboard | Package their existing entry points and assets for OpenRC | Preserve Stats observation delivery and the authenticated Rivet operator route. |
| Node apps | `apk add nodejs-current` 26.13.1-r0 (edge/community) — exact match to the image's Node 26.13.1 | `orange serve --config stats.jsonc --config observe.jsonc`. The app closure installs on lisa with `pnpm install --prod --ignore-workspace` (same lockfile as the image), assets come from the Mac-side build (build-image.sh minus the docker build), synced to `/opt/openorange/app-releases/stats/<sha>`; `/opt/openorange/apps/stats` is a symlink switched atomically. |
| Tansu, stats-perf | already native | unchanged |

### Layout and networking

- Loopback only: engine `127.0.0.1:6420`, store `127.0.0.1:7070`, each app
  `127.0.0.1:808x`. No bridge, no static IPs, no per-app /24 reservation.
- Caddy binds the tailnet HTTPS address and the loopback public origin.
  Split DNS continues to bind the tailnet address on port 53. Caddy's app
  upstreams move to loopback as each app moves.
- Unix sockets for host IPC that already uses them (identity).
- `/etc/openorange`, `/var/lib/openorange`, `/var/log/openorange`,
  `/run/openorange` unchanged; engine/store state paths unchanged.
- Preserve the current network trust boundaries. Use distinct service UIDs
  and private credentials, drop capabilities and apply cgroup resource limits.
  Loopback listeners restrict incoming connections. Apply and verify separate
  egress controls for apps currently confined by the internal Docker bridge.

### OpenRC and tooling changes (stuff repo)

- `deploy/openorange/openrc/*`: drop the `docker run` command, exec the
  binary directly as the service user. Keep supervise-daemon, respawn limits,
  `output_log`, and `oo_wait` readiness gates.
- `lib/oolib.py`: `run_args` produces `env`+`exec` plans instead of docker
  argv. `bin/pin-verify` grows a `binaries.lock.json` (sha256 per binary)
  replacing image digest checks; keep `images.lock.json` until cutover is
  complete.
- Engine unit: `--user rivet` equivalent, `ulimit -n 1048576`, tmpfs /var/lib/rivet
  equivalent is unnecessary since state dirs are host paths already.
- `oo render` unchanged in behavior (same files it writes today), plus it
  rewrites app upstreams to loopback.
- Stats repo: `deploy/orange/deploy.mts` becomes build+rsync+`swap` (symlink
  switch, restart `oo-app.stats`, health/smoke) instead of image build+set-image.
  `make stats-deploy` is unchanged from the operator's point of view.
- `oo set-image`/`record-deployment` become `oo set-release`/markers; the
  deployment-marker contract (`docs/deployments.md`) is preserved — a native
  release id `<git-sha>` replaces the image tag, carried the same way.

### Rollout

1. **Back up the current writer.** Identify the authority before copying
   data. While Threadripper owns writes, use the
   [current writer capture procedure](lisa-operational-recovery.md#current-writer-backup)
   and verify logical export on an isolated copy. Seal and transfer the
   newer writes during the final handoff.
2. **Rehearsal on a scratch Alpine VM or spare host** (x86_64): install the
   native stack with the rehearsal overlay (demo app, demo bucket/namespace),
   verify ingest→actors→dashboard end-to-end with fixtures, then rehearse
   *restore from the fenced export* into the native stack. This is the one
   step that proves the plan; don't skip it.
   Check `Max open files` in `/proc/<engine-pid>/limits` before the rehearsal.
   Lisa's SSH shell inherited a soft limit of 1,024. The native Engine hit
   `EMFILE` during an isolated import and fail-stopped. Both the planned
   native value and Lisa's production Docker Engine use 1,048,576. Set
   that limit before starting the unit or the isolated rehearsal.
3. **Cutover, separate windows, on lisa:** (a) store+engine first with stats
   fenced, apps stopped, units swapped; verify engine `/health`, store
   multipart probe, then apps; (b) stats app next (`make stats-deploy` native
   path); (c) remaining apps, platform collector, Rivet dashboard, ingress,
   DNS, identity and tunnel last. To roll back a step, restore the fence,
   swap its units back to Docker and start them. Verify application reads and
   resume writes after the rollback passes.
4. **Soak 2 weeks** (docker units and images kept), then delete the image
   references, and only then retire `images.lock.json` and the docker paths.

The first cutover window must preserve reachability for applications still
on the internal Docker bridge. Rehearse restricted listeners on the existing
bridge addresses during the transition, or move the shared runtime and its
remaining clients in the same window. A loopback-only Engine and store
cannot serve the existing container network.

### Known risks / unknowns

- **The engine-musl path is unproven in production** (musl binary exists and
  open-orange supports it, but the tested/rehearsed production engine is the
  glibc image). Mitigation: step 2, plus engine cutover with instant docker
  rollback and pre-staged verification.
- **Ops tooling parity**: every `docker inspect`-based check (`deploy.mts`
  verify, bench harnesses, `docs/openorange.md`) must be reimplemented;
  incomplete parity fails loudly but expensively. Inventory:
  `rg -n "docker (inspect|run|ps|exec)"` in both repos.
- **Niceforge co-tenancy** is unchanged in shape but now invisible to docker;
  make sure ops tooling does not assume `docker ps` covers host capacity.
- **The 2026-11-17 class of failure (ENOSPC) is unaffected** by this plan.
  If this work is ordered to fix that outage, it will not. Disk budgets,
  alerting, and the niceforge cleanup are the actual fix.
- caddy-dns/cloudflare musl static build needs re-verification of ACME
  DNS-01 against the real zone before cutover.

### Decision gates

1. Do the step-2 rehearsal with the engine-musl binary and restore-from-export
   before committing to the cutover. If that fails, stop: either stay on
   docker/OpenOrange, or move lisa to a glibc distro and keep the same native
   layout (that path needs no musl trust).
2. Cutover only after a fenced full backup verifies by import into the
   rehearsal environment.
3. Native cutover on lisa only with the stats fence procedure rehearsed and
   a tested rollback to docker.

### Ship the fixes in order

The targets are proposals for the first drill. Adjust them with the owner
after measuring the available restore paths. Report time to detection,
time to degraded reads, time to safe writes, and data age separately.

| Order | Owner and work | Acceptance evidence |
| --- | --- | --- |
| 1. Detect failures | OpenOrange and app owners. Add external capability probes and one incident status view. Separate ingress, Engine liveness, runner registration, stateful application reads, accepted ingest age and fallback snapshot age. Classify and retain upstream error codes. Stats owns the misleading HTTP 400 mapping. | With Engine `/health` green and runner registration blocked, alert within two minutes. Cover an actual crate download, Stats ingest and readback, Agentctl hosts, Discover search and operator readiness. A dated snapshot shows degraded status even when all read requests return 200. A synthetic storage deadline reports upstream unavailability. |
| 2. Enforce incident ownership | OpenOrange. Add a shared maintenance lock spanning changes to the Engine, deployments, fence and ingress. Give the operator a read-only incident preflight and a handoff with start time, command, owner, deadline, success check and escape path. Keep a separate channel for status updates. | Start two competing recovery commands in the drill. One acquires ownership and the other reports the active owner and operation. Interrupt the first during a simulated restart and recover its state without a blind second mutation. |
| 3. Make deploy and rollback predictable | Stats and OpenOrange. Extend the STA-129 preflight to reconcile selected, running, supervisor and persisted node version before mutation. Retain the active and last verified rollback images in a recovery-accessible store. Bound startup and verify the selected and restored runtime over a real request. | Reproduce stale `starting`, a surviving orphan container, a missing selected image, interrupted activation and rollback. Preflight refuses ambiguity while the current path remains available. A clean rollback survives signalled cancellation and verifies the previous data reads. |
| 4. Make degraded recovery a supported operation | OpenOrange, Stuff, Stats and Discover. Build pinned reader bundles and prepare a warm standby with supervised startup, scoped access to storage, timestamp labeling, and a rollback command. Represent incident routes as inputs to the normal renderer. Keep the original write authority explicit. | In a black-box Engine outage, restore registry pulls and published reads within 15 minutes using only the documented operator entry point. Re-render ingress and reboot the standby during the drill. Protected paths and unsafe methods stay denied. Disable each fallback independently without affecting the others. |
| 5. Verify backups and restore | OpenOrange and Stats. Implement a bounded Engine-only capture and an independently stored full physical and logical recovery set. Carry bucket data, release identities, protected configuration and deployment receipts. Make logical export resume by object and verified page. Disable self-observation before the first restore boot. Track STUF-75 in Stuff. | The drill starts from a fresh copy on a spare host, verifies every table and required bucket hash, and accepts new data. A failed export page never publishes a complete index and never leaves writers fenced. Establish a daily verified off-host recovery point as the interim target. Measure the recovery point and time for each dataset against an owner-approved data-loss budget. |
| 6. Protect host capacity and the release supply chain | Lisa and Stuff operators. Separate build and depot capacity, set disk reservations for startup and verified copies, record co-tenant workload, and retain recovery binaries without a live registry dependency. Pin tools and artifacts before an incident. | Fill the build allocation in a drill. Engine, store and off-host backup can still start and complete. Restore artifacts from their protected copies while the package mirrors are offline. Set alerts from the measured requirement for a full copy and Engine startup. |
| 7. Diagnose the Engine failure and reduce coupling | OpenOrange. Compare paired Lisa and standby trials from identical stopped state at the same image, Node version, limits and workload. Change one environmental variable per trial. Preserve registration failures, lease events, command admission and task scheduling evidence. Check STUF-88 and STUF-90 for relevant previous evidence. Give package pulls a serving path independent of publication coordination. | Produce a failing baseline and a working control for the demonstrated mechanism. Exercise a controlled graceful restart under production-like load. Hold the coordinator offline and verify package pulls and published HQ reads without granting a second writer. Close the root-cause item only when the explanation predicts the original failure and the regression catches it. |
| 8. Rehearse failover, then resume native cutover | OpenOrange with all app owners. Rehearse failover and reverse transfer with real state and isolated receivers. Capture recovery time and loss by dataset. Then return to the [native deployment gates](roadmap.md#campaign-native-lisa-deployment). | Complete a clean drill from an unavailable primary through protected snapshot restoration, read-only service, verified writes under a single authority, and reverse transfer. Propose a 60-minute live recovery target for the first drill. Preserve actual timings and gaps. The native drill still requires the fresh verified export, rollback proof and soak. |

### Close the incident

- Publish per-app verification with probe time, release identity, active
  authority, data freshness and any intentionally offline hosts.
- Record the outage window per Stats host and reconcile acknowledged
  samples against available history. Keep gaps visible where recovery
  cannot restore the missing samples.
- Retire the temporary routes, credentials and VM after the restored
  services pass their checks and the recovery artifacts are archived.
- Convert the proposed targets to agreed budgets and run a second drill
  with a different operator. Track any unproven checks as open work.


## Later

- STA-130: deliver observer alerts when the owner names a destination.
- STA-137: typecheck the canary and qualification harness.
- STUF-75: resume shared S3 backup work when it returns to scope.
