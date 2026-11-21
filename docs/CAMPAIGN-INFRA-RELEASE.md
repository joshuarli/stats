# Infrastructure release campaign

For the active follow-on implementation sequence, see
[Stats simplification and self-optimization](CAMPAIGN-SIMPLIFICATION.md).
This file retains release contracts, qualification evidence and owner rulings;
the follow-on campaign reuses this machinery and does not reset unresolved gates.

Goal: take a small OpenOrange or Rivet patch from a clean checkout to production
through one loop. The patch is built into an identified release, evaluated as an
isolated candidate against a verified baseline under deterministic traffic, and
judged by Stats with a replayable verdict. Only the exact tested artifacts are
promoted, post-promotion regressions trigger proven recovery, and the run leaves
a resumable record.

Stats owns telemetry contracts, storage, queries, verification policies,
synthetic workloads and operator-facing evidence. Stuff
(`laputa-systems/stuff`, `deploy/openorange/`) owns source imports, patch
series, builds, release manifests, host tooling and the rollout transaction.
OpenOrange and Rivet are maintained downstream: no upstream issues or pull
requests, upstream attribution and licenses preserved.

The machine-readable execution record is
[`campaign-infra-release.json`](campaign-infra-release.json). Git history is the
log. Failed runs stay recorded there and in their evidence directories.

## Status

Started 2026-11-20 from Stats `7fc3ff9` and Stuff `9fb6f1d`.

- **Production incident first.** On arrival, public health returned 502. The
  standby writer's VM had exited at about 13:51 UTC, and Lisa's tunnels could
  not reconnect because DHCP had replaced MagicDNS. Service was restored at
  15:41 UTC. See the [standby record](openorange.md#standby-operations-record-2026-11-20)
  and STA-130. This outage is the concrete case for INF-6: nothing outside Stats
  noticed it.
- **Landed in Stats:** INF-1 release gate (`0eb1b4a`, `6740e06`); INF-8 local
  canary pair (`7491093`): pass, `body-mismatch` reject and `source-missing`
  inconclusive, each replayable; the runtime canary (`3a80e2a`): upstream
  `1.0.2` baseline against the owned `1.0.2-laputa.1` candidate judged
  `pass`, with both Workers' metrics served; INF-7 design RFC (`c8cb9c4`) and
  first slice (`516a19a`, `43bc01a`): catalog, parser, codec and MetricStore
  over real captures. STA-130 watchdog (`673975b`).
- **Landed in Stuff:** INF-3 registry and live-verified `release-inspect`;
  INF-5 owned OpenOrange package (`open-orange-1.0.2-laputa.1.tgz`,
  `sha256:2a3932cd…`, reproduced three times offline; kept in
  `~/.local/share/openorange-releases/`); INF-9 rollout engine (`d1eef39`)
  and native standby adapter (`4dff3f6`), whose live read-only `observe`
  reports baseline `rt-13b896622da5`.
- **Promoted to production (INF-10):** the standby writer runs
  `rt-3abd20d29960`, the owned OpenOrange `1.0.2-laputa.1`, through the whole
  loop. The source patch was built reproducibly, published to the Stuff
  registry, built as the exact musl artifact and canaried in-container on
  those bytes (`pass`). It was staged, promoted under the journaled
  transaction with a five-minute verification window, and the app deploy path
  accepts it. See the [runtime release record](openorange.md#runtime-release-record-2026-11-20).
- **Recovery drill (INF-10):** a second rollout activated upstream
  `rt-13b896622da5` on state the owned release had written; with the
  controller killed mid-verification, `rollout abort` re-activated
  `rt-3abd20d29960` and ended `recovered` in 4.8 s.
- **INF-4 promoted as its own release:** `rt-a26798107529` is
  `rt-3abd20d29960` without `@rivet-dev/services` (Stats `97cdf2b`;
  `make orange-artifact-test` from `cff96db`). Rollout `58dfe686…` passed 20
  of 20 checks and ended `promoted`. It is the production runtime.
- **INF-7 live:** ingest route, MetricStore and collector (Stats `46ac802`);
  the standby serves per-Worker metrics and runs the collector (`0b31213`).
  Engine and both Worker sources report every round. The dashboard does not
  show them yet, and the release gate does not read them yet.
- **INF-9 oo-containers adapter** for Lisa's containers (Stuff `868479a`).
- **INF-11 qualified, held:** the private Engine patches build
  byte-identically offline (`sha256:9c1f1c7a…`), pass their regression
  suites, and open each other's data in both directions over ten restarts
  (Stuff `2a82e0b`, `cd3b3ac`, `7dc8712`;
  `docs/openorange-engine-qualification.md`). Production is held: the
  evidence is a short fixed workload, and no rollout adapter replaces the
  standby's Engine container.
- **Second patch promoted with bound receipts and unattended recovery:**
  `rt-2c70c316ce8d` (`open-orange 1.0.2-laputa.2`) is the production
  runtime. See [qualification and unattended recovery](#qualification-and-unattended-recovery-2026-11-20).
- **Open:**
  - INF-6: the observer runs on Threadripper's host, outside the standby VM.
    Alert delivery is out of scope for now.
  - INF-7: dashboard display.
  - INF-11: an Engine-replacement adapter and a sustained soak before
    promotion. The Engine stays held.
  - RivetKit and the N-API addon are still the published packages; the
    rebuild each needs is recorded in Stuff's `sources/sources.toml`.

## Qualification and unattended recovery (2026-11-20)

This pass bound promotion to the exact artifact and showed recovery without an
operator. Evidence, receipts and journals are on the workstation under
`~/.local/state/openorange/` (releases, `rollout/journals/`) and
`~/.local/state/stats-observer/`.

### Demonstrated

- **Artifact identity.** A runtime is identified by its full content manifest
  (`openorange-runtime-manifest/1`: every file's SHA-256, size and executable
  bit, and every symlink target; only top-level `release.json` is excluded).
  Stats (`deploy/orange/qualification/manifest.mts`) and Stuff
  (`lib/oomanifest.py`) compute the same digest on the real artifact. Tests
  show that an edited OpenOrange JS file or transitive dependency changes the
  identity. They also show that a different `--artifact` cannot activate, and
  that missing or changed evidence, policy or evaluator cannot reuse an old
  pass.
- **Clean-machine second patch.** From fresh clones on Threadripper (native
  x86_64 Linux, pinned `node@sha256:6bd9ab43…`), Stuff's
  `bin/build-runtime-artifact` built both runtimes twice, byte-identically,
  from pinned descriptors that name a Stats revision and the SHA-256 of
  each closure input. These builds replaced the retired Stats builder, which
  depended on a developer home path, `origin/main` and a hardcoded checksum.
  - Production `runtime-production.json` → `rt-64e03bb8519a`, whose content
    equals the running `rt-a26798107529`.
  - Candidate `runtime-candidate-laputa.2.json` (Stats `9185524`) →
    `rt-2c70c316ce8d`: tar `sha256:6cb79216…`, `open-orange-1.0.2-laputa.2.tgz`
    `sha256:7a3d1bf5…`, built from upstream `1cabf2e` with the metrics and
    serve-version patches.
- **Promotion profile on native Linux.** `promotion.mts` ran
  `rt-64e03bb8519a` against `rt-2c70c316ce8d` on Threadripper. Each side had
  its own `orange serve`, Engine container and the deployed config structure.
  The frozen profile (`promotion.json`, `sha256:305cef65…`) set a 60 s warm-up
  and a 600 s measured window at 10 requests/s. Results per side:
  - 5500 of 5500 requests, 0 body mismatches.
  - 1220 acknowledged writes, each read back exactly before and after the
    recovery state copy.
  - Peak memory 1.30 GiB (limit 1.5 GiB), 0 restarts.
  - The Engine and both Workers delivered 39 usable samples of every required
    family through the INF-7 collector.

  `statsctl verify release` judged `pass`. Receipt `receipt-p1.json`
  (`sha256:e46724b0…`) binds:
  - the baseline and candidate content digests and archive SHA-256s;
  - the Stats and observe Worker bundles, the collector and the container
    image;
  - the policy and workload digests;
  - the evaluator (`sha256:41b2bbb6…`), the observation windows and all
    eight evidence files.
- **Qualified bytes are staged bytes.** `rollout stage` recomputed
  `sha256:2c70c316…` on the guest from the archive whose SHA-256 the receipt
  records. Rollout replays the receipt, freezes it in the journal before
  preparation, and refuses activation if the staged content changed.
- **Unattended controller-kill recovery** (run
  `cfa3af9232c245f280576fd13a54ae5c`). The watchdog ran under launchd on the
  workstation, outside the candidate.

  | UTC | Event |
  | --- | --- |
  | 22:15:44 | candidate activated, `verifying`; first adapter and functional check pass at 22:15:50 |
  | 22:15:51 | controller SIGKILLed |
  | 22:18:44 | heartbeat deadline passes; the watchdog reports `lock-held` while the dead controller's lease runs |
  | 22:20:02 | watchdog takes the lease (fencing token 9 → 10) and enters `recovering`, `recovered-by: watchdog` |
  | 22:20:13 | baseline `rt-a26798107529` re-activated |
  | 22:20:17 | adapter and functional checks pass: identity, fresh target-bound ingest, exact readback, replay idempotency, stable process |
  | 22:20:18 | `recovered`; lease released; no manual abort |

- **Supervised promotion** (run `4130c23316344b789076ccb401d55e04`).
  `rt-2c70c316ce8d` passed 13 of 13 checks over the 600 s window and was
  `promoted` at 22:38:35. The serve log reports `open-orange 1.0.2-laputa.2`.
- **Independent observation, partially.** `deploy/observer/observer.mjs` ran
  from the workstation, with its state outside the candidate. Across the
  drill, recovery and promotion it recorded public health 34/34, host
  freshness 34/34 and synthetic ingest with exact readback 7/7, with no alert
  transitions. Its outbox records `delivery: unconfigured`; nothing is sent.

### Defects found by the live runs

Each was fixed with a regression test:

- **Receipt schema field** (Stuff `92e7046c`). Stats writes `schema` in
  receipts, but Stuff's verifier and its fixture omitted it, so the first
  live start was rejected as `invalid-evidence`. A test now pins the fixture
  to a receipt Stats produced.
- **Verifying deadline** (Stuff `bd1f4b69`). `verifying` used the
  per-transition deadline, so run `32eba287…` abandoned a 600 s window after
  200 s with every check passing. Its recovery to baseline was correct.
- **Watchdog environment** (Stats `a9031cb`, Stuff `54a9192e`). Under launchd
  the watchdog would have run under an unchosen Python, discarded its output,
  and failed the functional check for lack of `STATS_ROLLOUT`. The service now
  takes an explicit interpreter and log, and the check takes every input as
  an argument.

### Remaining dependencies

- **Observer host (owner ruling, 2026-11-21).** The observer moved from the
  workstation to Threadripper's host, outside the standby VM. It runs as the
  unprivileged `stats-observer` user, which cannot read the VM's directory.
  The owner accepted the shared-fate risk: an outage of Threadripper itself
  stops both the writer and its observer, and nothing reports it. Alert
  delivery is out of scope for now; the outbox records
  `delivery: unconfigured`. See [OpenOrange](openorange.md#independent-observer).
- **Rollout control moved to Threadripper (2026-11-21).** The controller and
  watchdog now run on Threadripper's host, because the watchdog reads only
  its own host's journals. The watchdog runs under `supervise-daemon` as of
  Stuff `49b03cc2`; its OpenRC template had backgrounded it as root with no
  restart. See [OpenOrange](openorange.md#rollout-control).
- **Engine (INF-11) stays held.** It needs sustained qualification on the
  promotion profile and an Engine-replacement adapter.
- **RivetKit and N-API rebuild.** Production still runs
  `@rivetkit/rivetkit-napi-linux-x64-musl@3.1.2-rc.1` and the prebuilt Engine
  CLI from npm; Stuff's inventory lists the work.
- **Harness gaps:**
  - Worker bundles cannot build in the musl container, because
    `@cloudflare/vite-plugin` starts glibc-only workerd and hangs silently.
    This run used bundles built on macOS at the same tree, bound by digest
    in the receipt.
  - The canary containers run as root and leave scratch files the runner
    cannot delete, so `promotion.mts` exits with EACCES after writing its
    evidence.
  - `rollout stage` took 251 s of its 300 s bound for the 150 MB archive.
  - `lifecycle.test.mts` failed once in a full `orange-test` run and passes
    alone; one Stuff rollout test failed once and passed in all reruns. The
    causes of both are unknown.

## Deliverables and backlog

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

## Rulings

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

## Needs environment

- INF-11 needs every registered consumer of the shared Engine (Stats, Discover,
  Tansu, Stuff) to have a representative contract check.

## Needs owner

- None open for INF-6; alert delivery is deferred by the owner.
