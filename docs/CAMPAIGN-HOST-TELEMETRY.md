# Campaign: static-musl Linux host telemetry on Cloudflare

> Extracted from Niceforge into this repository on 2026-10-31, reversing the
> original no-new-repository decision after acceptance. Paths below use the
> pre-extraction `telemetry/` prefix; here they are relative to the repository
> root, and the `make telemetry-*` targets are now `make fixtures`,
> `make agent-test`, `make agent-build`, `make cloudflare-test`,
> `make dashboard-test`, `make release`, and `make check`. The T6 runner
> association remains in the Niceforge repository.

## Status

Goal: run one small static-musl Rust agent on ordinary Debian and Alpine hosts,
batch host counters over outbound HTTPS to a Cloudflare Worker with a
SQLite-backed Durable Object, and render a bounded HTML/SVG dashboard. The
Niceforge workbench may link an opt-in runner to a telemetry host; Niceforge
execution never depends on it.

Revision: T7, T8, T9, A9, and the container-scoped aarch64 runtime accepted
2026-10-31. Bare-host aarch64 kernel/init/reboot proof and Workers Paid limits
remain unverified.
Accepted: T0, T1, T2, T3, T4, T5, T6, T7; T8; T9; A9; aarch64 runtime
(container-scoped).
Red: none locally. The existing `tests/host-clock.test.ts` cancellation case is
stabilized by bounded fixture polling.
Parked: aarch64 bare-host kernel/init/reboot proof remains Needs environment.
Next: Workers Paid limits and spend alarms.
Resume: "Run the remaining environment proofs in
docs/CAMPAIGN-HOST-TELEMETRY.md; T9 is live at
https://stats.17166969.xyz, A9 is recorded on oracle-free, and the
container-scoped aarch64 runtime is recorded in telemetry/README.md."
First command: `make telemetry-check`.

Needs environment (does not block local completion): aarch64 bare-host
kernel/init/reboot proof, Workers Paid limits and spend alarms, and a live
Niceforge runner host.

## Charter

- Decide and keep going. Record a decision only when a later slice depends on
  it. Parity and correctness before optimization.
- This campaign authorizes repository-local files, fixtures, tests, local
  Workers emulation, installing pinned public dependencies, and local
  Conventional Commits. It does not authorize pushing, deploying, creating or
  changing Cloudflare resources or Access policy, writing to remote hosts,
  provisioning production credentials, or changing CI.
- A hard stop parks the item with its cause: an irreversible outside-repo
  action, a forbidden boundary, or a check that cannot run. Never fake green.
- Fix egregious breakage met on the way in its own commit. Thresholds: a slice
  acceptance command over five minutes, a new local check over five minutes,
  or an existing check that becomes flaky or slower by more than 10% while this
  campaign changed its inputs. Otherwise record and leave it.
- One writer by default. Parallel lanes are allowed only for the disjoint
  pairs named in Sequence, in worktrees at `.work/wt/<lane>`. Scratch and
  `TMPDIR` go under `.work/tmp`; never `/tmp`.
- Every commit is a Conventional Commit scoped to the workstream with the item
  ID in the body. Code comments never cite this document. Do not reformat
  unrelated code.
- The loop has two speeds: each slice ends on its own command; `make test-fast`
  plus `make test-integration` run after T3, after T6, and at close.

## Decisions

**Owner 2026-10-30**

1. Execute T0–T7 locally and unattended. T8 is an optional follow-on, not part
   of completion. T9 stays owner-run.
2. Authorize the T6 Niceforge contract change: schema version 26, a local
   runner-to-telemetry-host mapping table, one association mutation, optional
   `telemetryHostId` and `telemetryOrigin` fields on the runner list, and the
   opt-in Runners UI. Existing runner mTLS, enrollment, execution, SQLite
   workflow authority, and audit stay unchanged.
3. Authorize adding `telemetry/cloudflare` to the pnpm workspace and new Make
   targets. This adds Vite, cf, the Vite and Vitest Workers plugins, and
   workerd to `node_modules` (several hundred MB); it does not touch the root
   Vitest version or existing build scripts.

**Prescribed**

4. Layout: `telemetry/agent/` (Rust crate, its own `.cargo/config.toml`),
   `telemetry/fixtures/v1/`, `telemetry/cloudflare/`, `telemetry/bench/`,
   `telemetry/tools/` (cross-linker wrappers), `telemetry/README.md`. No new
   standalone repository. No Rust workspace at the repository root.
   Reversal: a second Rust crate that must share target artifacts.
5. Toolchain: repository `rust-toolchain.toml` (nightly 2026-09-15), Node
   26.12.1, pnpm 11.0.2, Zig from PATH. Cross-link `x86_64-unknown-linux-musl`
   and `aarch64-unknown-linux-musl` with the committed wrapper scripts; filter
   rustc's `--fix-cortex-a53-843419` argument for Zig. Proven 2026-10-30: both
   targets produce static ELF binaries with ring TLS and system roots.
6. Wire format v1 is JSON, exactly the schema in `telemetry/README.md`, with
   decimal strings for every u64 counter, monotonic millisecond value, sequence,
   timestamp, and byte count. A batch is `{v, hostId, bootId, samples}`; each
   sample carries `seq`, `atMs`, `monoMs`, optional metric groups, and an
   `unavailable` group list. All counters are cumulative; rates are derived
   from `monoMs` deltas, never from client wall-clock deltas. Unknown fields
   are rejected. Reversal: a measured payload problem that CBOR or a schema
   change solves without weakening exactness.
7. Sampling sources and filters:
   - CPU from `/proc/stat` aggregate: user+nice, system+irq+softirq, idle,
     iowait, steal. No per-core series.
   - Memory from `/proc/meminfo` (`MemAvailable`, not `MemFree`); load, uptime,
     and CPU count from `sysinfo(2)` honoring `mem_unit` and load scaling.
   - Disks from `/proc/diskstats`, whole devices only (`/sys/block`), sector
     unit always 512 bytes; exclude `loop*`, `ram*`, `zram*`, `fd*`.
   - Network from `/sys/class/net/<if>/statistics` 64-bit counters; exclude
     `lo`; an interface with any missing counter is omitted for that sample.
   - PSI from `/proc/pressure/{cpu,memory,io}`; keep it separate from iowait.
   - Filesystems from `/proc/self/mounts` plus `statfs(2)`, allow-list
     `ext2/ext3/ext4/xfs/btrfs/f2fs/vfat/exfat/ntfs3/zfs/tmpfs/overlay`,
     available-to-unprivileged (`f_bavail`), at most 16, no network filesystems.
   - Superseded: the draft's rtnetlink requirement. Sysfs exposes the same
     kernel `rtnl_link_stats64` counters without handcrafting netlink packet
     layouts or adding an async netlink crate. Reversal: a measured need for
     counters sysfs does not expose.
   - No per-process polling, io_uring, BPF, async runtime, web server, or
     dynamic libraries in the baseline agent. Reopen procfs files each sample
     and reuse bounded buffers; procfs seq-file offset behavior is not worth
     the risk.
8. Sequence is `floor(monotonic_ms / 1000)`; boot ID comes from
   `/proc/sys/kernel/random/boot_id`. A process restart keeps monotonic time,
   so no sequence state file is needed. Wall timestamps are display facts only;
   online/staleness uses server receipt time. The agent sends 15 s samples,
   uploads two at a time every 30 s, keeps at most 16 unsent samples, and drops
   the oldest on saturation with a loss counter.
9. Storage: one Durable Object per installation, SQLite tables for hosts, raw
   samples keyed by `(hostId, bootId, seq)` for exactly-once storage, and
   rollups keyed by `(hostId, resolution, bucketStartMs)`. Retain raw 48 h,
   one-minute aggregates 7 d, and hourly aggregates 90 d. Late arrival recomputes
   the affected minute and the following minute, and the affected hour; delta
   sums and coverage are stored, never counter averages. A bucket with less
   than 80% interval coverage is marked partial. Cleanup runs on a Durable
   Object alarm in bounded batches. Reversal: measured per-object contention or
   the 10 GB ceiling.
10. Authorization is two boundaries. Humans use Cloudflare Access: the Worker
    verifies the `Cf-Access-Jwt-Assertion` RS256 signature against the team
    JWKS, plus issuer, audience, expiry, and not-before with 60 s leeway.
    Hosts use `Authorization: Bearer nft_<43 base64url chars>`; only a SHA-256
    verifier is stored, compared in constant time, bound to one host ID,
    individually revocable and rotatable. No production auth bypass. Test mode
    injects a JWKS and is ignored unless `ENVIRONMENT=test`. Static assets run
    through the Worker (`assets.run_worker_first`); `workers_dev` and preview
    URLs are disabled. Reversal: a measured Access or routing requirement that
    still keeps both boundaries.
11. HTTP surface is closed and bounded: ingest batch (64 KiB, 16 samples, six
    requests per host per minute), host list (500), latest sample, bounded
    history (`1h`, `6h`, `24h`, `7d`, `90d`; `summary`, `disks`, `nets`,
    `filesystems`; at most 900 returned points), health, and Access-protected
    host provisioning/rotation/revocation/hard delete. No arbitrary SQL, PromQL,
    labels, or unbounded ranges.
12. Dashboard is plain TypeScript/HTML/CSS with esbuild, one HTML entrypoint
    and one JavaScript bundle, native SVG charts, no framework or chart
    dependency, no animation. Playwright tests intercept `fetch`; no test
    bypass exists in production assets.
13. T6 is local only. The controller stores the mapping in its own SQLite and
    never calls Cloudflare. The Runners page shows the host ID and, when
    `NICEFORGE_TELEMETRY_ORIGIN` is a valid http(s) origin, a deep link. With
    no origin and no mapping, no telemetry UI or request appears.
14. Performance is measured, not claimed. Local acceptance proves the release
    build and harness. Real numbers require named Linux hardware (Needs
    environment). Targets: <= 16 MiB steady RSS and < 0.1% of one logical CPU
    at 15 s on an idle representative host. Compare with Node Exporter only on
    the same host/interval; report median and spread, never a cherry-picked
    partial metric set.
15. Test tooling is isolated: `@stats/telemetry` pins
    `@cloudflare/vitest-plugin` 1.4.11, `@cloudflare/vite-plugin`
    2.0.0-beta.v.8, Vite 8.3.5, cf 1.0.0-beta.26, and workerd 1.20261023.1.
    The Vitest plugin vendors Wrangler 4.156.0 for its Workers test runtime;
    the project does not declare Wrangler or use the Wrangler CLI. Builds and
    deploys use `cloudflare.config.ts`, `vite.config.ts`, and cf. The plugins
    accept the root Vitest 5.0.5, so no second Vitest version is installed.
    Root tests and the root toolchain are unchanged.
16. T8 eBPF was deferred until T1–T7 were accepted and a capable Linux host and
    owner authorization existed. The owner authorized it 2026-10-31; the
    optional `block` group is integrated and the baseline agent never depends
    on BPF or the collector.

**Delegated**

17. Within the bounds above, the executor chooses exact crate patch versions,
    config key spelling, internal module split, fixture case names, log line
    shape, CSS, chart geometry, and test organization. Log in the commit body
    only when a later slice depends on the choice.

**Owner 2026-10-31**

18. Authorize the T9 cloud-half deployment on `stats.17166969.xyz`: create the
    Worker and SQLite Durable Object, create Access applications and policies,
    set Worker secrets, deploy the Worker custom domain, provision one
    disposable verification host, and revoke it. Billing changes remain
    owner-run.
19. Authorize the T9 host proof on `ubuntu@oracle` (Ubuntu, passwordless sudo)
    and `josh@threadripper` (Alpine, passwordless doas): install the agent and
    service, start it, and run restart, rotation, and stale-state checks.
20. Authorize T8. Executor scope: an optional eBPF block-latency path under
    `telemetry/bpf/`, bpftrace installed on `oracle-free`, and a bounded host
    proof, integrated as the optional protocol v1 `block` group, Worker
    rollups, and dashboard chart. The baseline agent still runs without BPF.
21. Retire Wrangler from the deploy path and the declared dependency graph: cf
    builds and deploys through `cloudflare.config.ts` and the Cloudflare Vite
    plugin. `@cloudflare/vitest-plugin` may keep its transitive Wrangler
    runtime for Workers tests; remove `wrangler.jsonc` and the direct Wrangler
    dependency. Do not invoke the Wrangler CLI.

## Baseline

Recorded 2026-10-30 at `e1ca79c`, before implementation.

- Toolchain: Node 26.12.1, pnpm 11.0.2, rustc nightly 2026-09-15, Zig 0.17.0,
  Chromium 1248 present for Playwright. Both musl targets installed.
- Foundation proofs: a hello-world and a ring/rustls binary cross-link
  statically for `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`;
  the host build of the same TLS probe loads the macOS system trust store and
  returns HTTP 200. A Durable Object SQLite probe runs under
  `@cloudflare/vitest-plugin` with workerd.
- Existing checks and timings: `make test-fast` green in 52 s; `make
  test-integration` green in 68 s. Both measured on this host before any
  campaign change.
- Final local timings: `make telemetry-check` green in 15 s; `make test-fast`
  green in 26-30 s; `make test-integration` green in 64 s. The final full runs
  were green; one earlier `host-clock` case timed out at 15 s under suite load
  and passed standalone and on rerun.
- Known red: none locally.
- No generic fleet agent, Cloudflare deployment, per-host credential, storage
  benchmark, or field result exists before this campaign.

## Sequence

Slices run in order unless a parallel pair is named. Each owns its files; a
slice that shares files runs after the earlier owner. T1/T3 and T5/T6 are
disjoint and may run in parallel lanes. Red work never lands.

- **T0 — protocol, fixtures, cost arithmetic.** Owns
  `telemetry/README.md`, `telemetry/fixtures/`, `telemetry/scripts/`,
  `telemetry/cloudflare/` package scaffolding, root `Makefile` telemetry
  targets, `pnpm-workspace.yaml`. No prerequisite. Acceptance:
  `make telemetry-fixtures` validates every fixture and prints the ingestion
  and storage arithmetic for 1/10/100 hosts. Sets the canonical wire spec and
  the shared accept/reject oracle used by T1 and T3.
- **T1 — native collector without network.** Owns `telemetry/agent/` and
  `telemetry/tools/`. Prerequisite: T0 fixtures. Acceptance:
  `make telemetry-agent-test` runs parser, hostile-input, synthetic counter,
  clock, reboot, counter-reset, device-churn, and fixture-parity tests on the
  host target, then `make telemetry-agent-build` cross-builds both musl targets
  and proves `PT_INTERP` and `NEEDED` are absent. A real Linux sample is Needs
  environment.
- **T2 — independent transport and lifecycle.** Owns
  `telemetry/agent/src/transport*`, `config*`, `main*`, `contrib/`, and their
  tests. Prerequisite: T1 types. Acceptance: `make telemetry-agent-test`
  covers offline, timeout, partial acceptance, 429/5xx retry, restart, reboot,
  queue saturation, duplicate delivery, and a self-signed TLS rejection against
  a loopback TLS server; no Niceforge or Cloudflare credential is read.
  Parallel-safe with T3.
- **T3 — ingest, store, dedupe.** Owns `telemetry/cloudflare/src/protocol*`,
  `src/installation*`, `src/ingest*`, `cloudflare.config.ts`,
  `vite.config.ts`, worker tests, and the package build script. Prerequisite: T0 fixtures, T2 wire behavior (docs
  only). Acceptance: `make telemetry-cloudflare-test` ingests the full fixture
  corpus, proves exact-once storage under replay, accepts out-of-order
  retries, rejects every invalid fixture, and reads persisted data after a
  Durable Object abort. Parallel-safe with T2.
- **T4 — query, rollups, retention, authorization.** Owns the remaining
  `telemetry/cloudflare/src/` modules, `telemetry/cloudflare/test/`, and the
  package scripts. Prerequisite: T3. Acceptance:
  `make telemetry-cloudflare-test` proves the negative authorization matrix,
  rotation/revocation, bounded history for all five ranges and four kinds,
  partial/late-arrival rollups, expiry via alarm, and no secret in built
  assets.
- **T5 — dashboard.** Owns `telemetry/cloudflare/src/client/`,
  `telemetry/cloudflare/dashboard/`, its Playwright config and tests.
  Prerequisite: T4 response types. Acceptance: `make telemetry-dashboard-test`
  builds the bundle, runs the browser suite at 390x844 and 1280x720, and proves
  every time range, keyboard use, no-data/stale/unavailable rendering, and
  network fixtures with no test bypass. Parallel-safe with T6.
- **T6 — opt-in Niceforge association.** Owns
  `packages/database/src/telemetry-hosts.ts`, `schema-version.ts`,
  `packages/database/src/index.ts`, the runner group in
  `packages/contracts/src/index.ts`, `apps/controller/src/server.ts`,
  `packages/client/src/index.ts`, `web/src/views/runners.ts`, and their tests.
  Prerequisite: owner decision 2. Acceptance:
  `make telemetry-association-test` proves schema 25→26 migration, set/clear,
  operator auth, disabled default, and zero telemetry network calls; the
  workbench mock test renders the link and the unavailable state. Parallel-safe
  with T5.
- **T7 — benchmark, release, qualify.** Owns `telemetry/bench/`,
  `telemetry/agent/scripts/`, and the release/qualification sections of
  `telemetry/README.md`. Prerequisite: T1, T2, T4. Acceptance:
  `make telemetry-release` reproduces both static binaries, writes SHA-256
  receipts, runs the ELF checks, and self-tests the benchmark script; measured
  RSS/CPU/billing numbers are recorded only when runnable and otherwise listed
  as Needs environment.
- **T8 — optional eBPF block latency.** Accepted and integrated 2026-10-31:
  the probe and collector loaded on `oracle-free` (Ubuntu 24.04, kernel
  6.17.0-1007-oracle, bpftrace 0.20.2, BTF present), captured 3037 block
  completions from 1000 synchronous 4 KiB writes, and the optional `block`
  group flows through protocol validation, Worker rollups/history, and the
  dashboard p50/p95/p99 chart. The baseline agent runs without BPF; the
  collector is optional.
- **T9 — deployment proof.** Accepted 2026-10-31 at
  `https://stats.17166969.xyz`: Worker, SQLite Durable Object, Access allow
  policy, public `/health` and bearer-token `/ingest/*` bypass paths, live
  ingest, replay dedupe, latest/history, dashboard, rotation, and revocation.
  Host proof: Ubuntu 24.04.4 LTS (kernel 6.17.0-1007-oracle) under systemd and
  Alpine edge (kernel 7.2.9-2-stable) under OpenRC, both x86_64 and static;
  both uploaded live samples, sequence continued across restarts, a stopped
  host became offline after 45 s, and Alpine reported PSI as unavailable.
  aarch64 bare-host runtime and reboot persistence remain unverified; a
  container-scoped aarch64 runtime passed 2026-10-31.

Milestones: run `make test-fast` and `make test-integration` after T3 and after
T6, and again at close. T3 is the first point that changes the pnpm workspace;
T6 is the only slice that changes Niceforge contracts.

## Acceptance

- **A1 protocol parity.** The same fixture corpus is accepted or rejected
  identically by the Rust validator and the Worker validator. Command:
  `make telemetry-fixtures`. Failure: any disagreement, any fixture without a
  manifest expectation, or non-deterministic output.
- **A2 collector.** Parsers handle short reads, changing sizes, missing files,
  hostile input, u64 boundaries, clock jumps, reboots, counter resets, and
  device churn without inventing values. Command:
  `make telemetry-agent-test`. Failure: panic on hostile input, zero substituted
  for unavailable, or a rate derived from a non-positive interval.
- **A3 static binary.** Both targets have no `PT_INTERP`, no `NEEDED`, and pass
  `llvm-readobj`; a host-linked TLS probe loads system roots. Command:
  `make telemetry-agent-build`. Runtime passed on Ubuntu 24.04.4 LTS and Alpine
  edge x86_64, and container-scoped on Debian 13 and Alpine edge aarch64 on
  2026-10-31; a bare-host aarch64 kernel/init/reboot proof remains Needs
  environment.
- **A4 transport.** Offline, timeout, partial acceptance, 429/5xx, restart,
  reboot, saturation, duplicate delivery, and TLS rejection behave as specified.
  Command: `make telemetry-agent-test`. Failure: blocking collection on upload,
  unbounded queue, secret in argv/log, or retry storm.
- **A5 backend.** Ingest, dedupe, out-of-order repair, rollups, retention,
  bounded queries, and persistence across object abort pass locally with no
  real Cloudflare account. Command: `make telemetry-cloudflare-test`.
- **A6 authorization.** Missing, wrong host, wrong audience, expired JWT,
  revoked key, stale/replayed sample, and alternate-route cases are rejected;
  rotation and provisioning work; no secret appears in built assets. Command:
  `make telemetry-cloudflare-test`.
- **A7 dashboard.** Every range and kind renders honest gaps, idle/loaded
  states, keyboard focus, and mobile/desktop layouts from deterministic
  fixtures. Command: `make telemetry-dashboard-test`.
- **A8 Niceforge isolation.** Schema 25→26 migrates; association is opt-in;
  no telemetry request occurs when disabled; execution and audit tests stay
  green. Command: `make telemetry-association-test` then `make test-fast`.
- **A9 release.** Both architectures build reproducibly, checksums match,
  ELF checks pass, and the benchmark harness self-tests. Command:
  `make telemetry-release`. Recorded 2026-10-31 on `oracle-free`: agent median
  0.0082% of one logical CPU, 1.70 MiB max RSS, 0.92 ms collection median;
  both targets met. Node Exporter 1.12.1 default collectors on the same host
  and interval: 0.199% CPU, 20.45 MiB RSS. `threadripper` was not idle, so no
  performance claim is made there. Method and spread are in
  `telemetry/bench/README.md`.
- **A10 full suite.** `make test-fast`, `make test-integration`, and
  `make telemetry-check` pass at close. Known-red baseline items are not
  attributed to this campaign.

## Needs environment

- aarch64 bare-host kernel/init/reboot proof. The x86_64 Ubuntu and Alpine
  proofs passed, and the container-scoped Debian 13 and Alpine edge aarch64
  runtime passed 2026-10-31 on native arm64 Docker. That container proof does
  not cover Debian/Alpine kernel behavior, systemd boot, reboot persistence, or
  host-level block/eBPF telemetry.
- Workers Paid limits, spend alarms, and overage behavior. The T9 cloud half
  runs on the account's current free plan; Durable Object storage and request
  limits at fleet scale remain unverified. A $1 email budget alert exists but
  does not cap spend.
- A live Niceforge runner host on which the owner authorizes write/install for
  T6's live deep-link proof.

## Execution boundary, non-goals, and stop conditions

Authorized: new files under `telemetry/`, the listed Niceforge contract files,
local dependency installation from pinned public registries, local loopback and
Workers emulation, local compiler/bench scripts, local Conventional Commits, the
T9 cloud-half deployment in decision 18, and the T9 host proof on
`ubuntu@oracle` and `josh@threadripper` in decision 19.

Forbidden: pushing; changing CI; deploying or deleting Cloudflare resources
beyond decision 18; changing other Access policy; writing to hosts other than
the two named in decision 19; changing billing; changing runner mTLS,
enrollment, admission, or execution; making execution depend on monitoring;
adding telemetry to workflow/audit evidence; starting T8 beyond the standalone
probe in decision 20.

Contract changes to surface to the owner: schema version 26 and the
`runner_telemetry_hosts` table; `PUT/DELETE
/api/v1/runners/:runnerId/telemetry-host`; optional `telemetryHostId` on each
runner and `telemetryOrigin` on the runner list; `NICEFORGE_TELEMETRY_ORIGIN`;
new Make targets and the pnpm workspace entry. No existing endpoint changes
meaning, and no existing field becomes required.

Non-goals: per-process profiling, continuous event streaming, eBPF-only
observability, OpenTelemetry, PromQL, Grafana, logs/traces, alert routing, fleet
scheduling, cgroup or guest semantics beyond the observed host, multi-tenant
SaaS, and changing Niceforge's SQLite authority.

Hard stops: a required check that cannot run and cannot be replaced by a local
equivalent; an auth or storage design that cannot be bounded; a Niceforge
invariant regression; or a benchmark that cannot be reproduced. Park the slice
with the cause and keep accepted work.

## Reference

- Wire spec and operator setup: `telemetry/README.md` (created by T0).
- Existing run-scoped sampling to preserve:
  `apps/controller/src/resource-sampler.ts`,
  `apps/controller/src/resource-observation.ts`,
  `packages/database/src/resource-samples.ts`,
  `packages/database/src/run-metrics.ts`.
- Existing runner transport to preserve: `apps/controller/src/runner-main.ts`,
  `apps/controller/src/runner-server.ts`, `apps/cli/src/runner-enroll.ts`.
- Workbench rules: `web/README.md`, `docs/product-contracts.md`,
  `web/src/views/metrics.ts`, `web/src/views/runners.ts`, `web/src/shell/`.
- Cloudflare: Durable Object SQLite
  https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/,
  limits https://developers.cloudflare.com/durable-objects/platform/limits/,
  static assets https://developers.cloudflare.com/workers/static-assets/,
  Workers testing https://developers.cloudflare.com/workers/testing/vitest-integration/,
  Access JWTs https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/.
- Linux: procfs, PSI, statfs, rtnetlink statistics, io_uring fallback, and BPF
  map flags as documented by the running kernel; verify the actual kernel
  before optimizing.
