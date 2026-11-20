# Infrastructure release campaign

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
- **Landed:** INF-1 release gate (`0eb1b4a`, delivery reconciliation fixed in
  `6740e06` after INF-8 showed no producer reports the counters it required);
  INF-3 source registry and live-verified `release-inspect` (Stuff `0597838`
  to `d17b054`): exit 0, no drift, writer = standby, release
  `stats-accd14a0364c`, Engine `Rivet 3.1.1`. STA-130 watchdog installed on
  Threadripper (`673975b`).
- **Accepted, held off master:** INF-2 OpenOrange patch (exported as Stuff
  `patches/open-orange-1cabf2e-multi-worker-metrics.patch`); INF-4 on branch
  `campaign/drop-services` (`make orange-test` 6/6 and a Linux image without
  Services, but no Linux container run against an Engine yet).
- **Running:** INF-5 owned OpenOrange build (byte-identical offline builds of
  `open-orange-1.0.2-laputa.1.tgz`; freezing the pinned pnpm into the acquired
  inputs). INF-8 canary pair (second attempt, on the fixed contract). INF-7
  design RFC.
- **Next:** INF-9, the rollout transaction, using INF-5's artifact as the first
  runtime release class.

## Deliverables and backlog

Priority order. Each item has one acceptance command, which runs locally unless
the item is listed under Needs environment.

| ID | Phase | Deliverable | Owner repo | Acceptance | State |
| --- | --- | --- | --- | --- | --- |
| INF-1 | 5 | `statsctl verify release`: offline evidence bundle that yields `pass`, `reject`, `pending` or `inconclusive`, with stable reasons and replay | Stats | `pnpm --dir cloudflare -s test:cli` with `verify-release.test.ts` | landed |
| INF-2 | 3 | OpenOrange serves RivetKit metrics for every Worker, with Worker identity and start time | OpenOrange downstream | `tests/orange-serve.test.ts` two-Worker case | accepted (patch) |
| INF-3 | 1–2 | Source ownership registry, release manifest schema `openorange-release-manifest/1`, read-only `release-inspect` | Stuff | `test_sources.py`, `test_release_inspect.py`, `bin/sources verify` | landed |
| INF-4 | 2 | Drop `@rivet-dev/services` from the Stats runtime closure, with a packaged-runtime proof | Stats | `make orange-test` plus packaged image evidence | accepted (branch) |
| INF-5 | 2 | Import INF-2 as the first OpenOrange downstream patch; build an identified release (package tarball and manifest) from a clean checkout with the network disabled after acquisition | Stuff | `bin/sources verify` and a release build that reproduces its digest | running |
| INF-6 | 3 | Independent observer: a pinned Node/SQLite Stats instance on a host that shares neither the candidate's Engine nor its storage, plus external health alerting | Stats + Stuff | Observer ingests host and service events; stopping the writer raises an alert | needs owner (alert channel) |
| INF-7 | 3 | Typed infrastructure metrics path: allowlisted OpenOrange, RivetKit and Engine Prometheus series stored with counter, gauge or histogram semantics, Worker identity and reset detection | Stats | ingest and readback tests over real scrapes of INF-2 output | design (RFC) |
| INF-8 | 4 | Isolated baseline and candidate stacks (separate Engine, depot, namespace, credentials, ports) and a deterministic workload driver with an independent request ledger that validates response bodies | Stats + Stuff | A wrong HTTP-200 body fails the workload; both cohorts reconcile every durable result | running |
| INF-9 | 6 | Resumable rollout transaction (`staged` → `qualified` → `prepared` → `activated` → `verifying` → `promoted` / `recovering`), host maintenance lock, journal outside Stats and Rivet, watchdog | Stuff | Interrupt-and-resume tests at every transition; concurrent lock refusal | after INF-3/8 |
| INF-10 | 7 | State-safe promotion and recovery: previous runtime reads candidate-written state, one authoritative writer, bounded write pause | Stats + Stuff | Good candidate promotes, bad one rejected pre-production, post-activation failure recovers without losing acknowledged writes | after INF-9 |
| INF-11 | 8 | Qualify the existing private Rivet Engine patches through the loop | Stuff | INF-1 `pass` on the Engine release class | after INF-10 |
| STA-130 | ops | Supervise the standby VM; alert on Stats downtime | Stats | See TODO.md | open |

## Rulings

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

- INF-6, INF-8 and INF-10 live steps need a host that is neither Lisa nor
  Threadripper, plus capacity for two isolated stacks.
- INF-11 needs every registered consumer of the shared Engine (Stats, Discover,
  Tansu, Stuff) to have a representative contract check.

## Needs owner

- INF-6: the channel for downtime alerts, and which host runs the independent
  observer.
- INF-10: whether native failback to Lisa ([native Lisa](native-lisa.md))
  precedes runtime promotion, or promotion targets the standby writer.
