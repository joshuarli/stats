# Service deployments: deployment tracking for servers

## Status

- **Goal:** track and compare deployments of services on ordinary hosts, with the same deployments timeline, before/after table, and guardrails the project page has for Cloudflare Workers. It must work on both targets (Worker and Node).
- **Started** 2026-11-05 after the portable-core campaign closed.
- **Accepted:** S1 (`a5918ea`):
  - Schema version 8 adds the `services` and `service_deployments` tables.
  - Routes: admin create (token returned once), list and get, a marker post authenticated only by the deploy token (8 KiB limit, idempotent on `(service, markerId)`, conflicting repeats get 409), and history in the project `DeploymentHistory` shape plus `markers`. Markers expire after 30 days.
  - Tests: vitest 305, node suites green, node-e2e 5, `test/node/http-parity.test.ts` byte-identical on about 30 service exchanges, bench 7.762.
- **Accepted:** S2 (`e719a5a`, `dd3050f`, `0cbd55e`):
  - `statsctl deploy mark`, `services`, and `service deployments` on both targets; the token file is checked like the `check ingest` credential file.
  - The marker `POST` moved to `/ingest/services/<name>/deployments`, so the zone's existing `/ingest/*` Bypass covers it on Cloudflare and no Access change is needed. A `POST` to the `/api/v1` path answers 405.
  - Live: `make node-deploy` of `0cbd55e3575d` recorded marker `v-0cbd55e3575d` (deployment `0b1a438a`), `statsctl service deployments` on the tailnet origin lists it, and a repeat answers `created: false`.
  - On the threadripper instance: host `threadripper` (`h_a191bab6…`, token in `.work/credentials/node-threadripper-host.json`) and service `stats-node`. No agent reports to that host yet.
  - Tests: test:cli 124, test:node 27, node-e2e 5, vitest 305, lint clean.
- **Merged, live comparison pending:** S3 (`7efe7b6`..`9f06f82`):
  - `GET /api/v1/services/<name>/deployments/<id>/comparison?window=1h|6h|24h` on both targets: the project `DeploymentComparison` plus `hostIds` and `sources`, gated by the shared `gateDeployment`, settle 15 minutes. It compares the hosts named in the marker. `ReasonCode` gains `no-data`.
  - Node runs service probes every 5 minutes into `project_samples` under owner `service:<name>`; the Worker runs none, so probes are unavailable on Cloudflare.
  - `statsctl verify --service NAME --deployment ID|latest --policy FILE`, level metrics only, with the Decision 6 caveat; `#/services` and `#/service/NAME` pages with WebP goldens.
  - Tests: `make cloudflare-test lint dashboard-test node-e2e` green (Playwright 120, test:node 33, test:cli 129).
  - Live: a marked `make node-deploy` at or after 17:20Z, then the comparison after about 18:35Z.
- **On Cloudflare (owner-approved, 18:02:44Z):** `make stats-deploy` of master `52975f4` carries S1 to S3. It is `stats` version `8234b238`, with rollback to `d0fb1f45` (version `8ba50543`). Smoke passed, `check ingest` passed all five steps, and `statsctl services` answers `no services configured`. An unauthenticated marker `POST` gets the Worker's 401, not an Access redirect. No service exists on Cloudflare yet.
- **Merged-ready, not merged:** S4 (`893a65b`..`178a06c`, plus this Status commit) on `campaign/services`:
  - Protocol: STB2 `present`/`unavailable` bit 12 is `services` (count 0-16; per service a dictionary ref and `name` str(32), then a head u8 `MEMORY`/`PEAK`/`IO`/`DELTA`/`UNAVAILABLE`, then `cpuUsec`, `memoryCurrent`, `memoryPeak`, and four io counters). Existing golden frames and acks are byte-identical; `present-reserved-bit` now probes bit 13. Fixtures `services` and `services-boundaries` and 11 malformed service cases.
  - Storage: deltas and one-minute rollups carry per-service `cpuUsec` and io bytes with covered intervals and `memoryCurrent` as a gauge; host-only rows are unchanged.
  - Agent: `services = [{ name, unit }]`; `name.service` maps to `system.slice/<unit>`, template instances to `system.slice/system-<template>.slice/<unit>`, `docker-<id>.scope` to `system.slice`, `libpod-`/`machine-` scopes to `machine.slice`. No cgroup v2 root marks the group unavailable.
  - Comparison: `service.cpu` (cores), `service.memory`, `service.io` replace `host.cpu`, `host.memory`, `host.disk` only when present in both windows; `sources` is `hosts`, `cgroup`, `probe`. Service-page goldens refreshed for that change only.
  - Checks: `make fixtures agent-test agent-build cloudflare-test lint agent-e2e node-e2e` green (fixtures 39 batches and 65 malformed frames, agent 100 + 5, vitest 307, test:cli 130, test:node 35, agent-e2e 1, node-e2e 5). `dashboard-test` 119 of 120: `dashboard.spec.ts` "leads with a cost ledger" fails on the real clock (projected `$0.0016` on Nov 5) with S4's only client change reverted, so it predates S4. Agent musl size: x86_64 2,819,728 to 2,843,808 bytes (+24,080), aarch64 2,471,664 to 2,494,736 (+23,072); no new dependency.
  - Unverified: real cgroup reads on a live Linux host. threadripper runs OpenRC with Docker's cgroupfs driver (containers under `/sys/fs/cgroup/docker/<id>`), which no mapping covers, so `stats-node` there cannot be configured yet.
- **Red:** none. **Parked:** none.
- **Next:** S3 live comparison, merge S4, then agent rollout (owner's call) and X. Carry-overs:
  - Deploy tokens have no rotate or revoke yet.
  - Host network and disk throughput, and cgroup levels, are averaged across a marker's hosts, not summed; level values are unrounded.
  - `io.stat` is summed over every device it lists; stacked devices (dm, md) may count one I/O twice. `memoryPeak` is stored but not compared.
  - Host data for `stats-node` (owner, 2026-11-05): a second agent, the OpenRC service `stats-node-agent` (`/etc/init.d/stats-node-agent`, user `stats`, `/etc/stats-node-agent/agent.json`, log `/var/log/stats-node-agent.log`, in the default runlevel), reports host `threadripper` to `https://threadripper.tailcf741.ts.net:18791`, a `tailscale serve --https` entry on the Node socket. `/etc/hosts` maps that name to `100.98.145.91`, because the host's local resolver does not forward `*.ts.net`. The container has no network, so probes stay unavailable.
- **Resume:** `Execute docs/service-deployments-campaign.md from its Status block.` First command: `git log --oneline -1 && make check`.

## Charter

- Implement; decide inside the bounds below and keep going. Record a decision in **Decisions** only when a later slice depends on it.
- One writer, one slice at a time, on branch `campaign/services` in `.work/wt/services`. After each accepted slice, run the parent steering checkpoint from the `orchestrate` campaign reference, then update **Status**.
- A failing check is root-caused before any retry. The same failure twice after a fix parks the slice with its evidence.
- Missing data is absent or `unavailable`, never zero. A comparison with too little data says so, as `compareDeployment` does for projects today.

## Decisions

1. **Source (owner, 2026-11-05): pushed markers.**
   - Deploy scripts and CI record a deployment by sending a marker; nothing polls or guesses.
   - Agent-side detection of version changes is a non-goal of this campaign.
2. **Per-service metrics (owner, 2026-11-05): yes, as their own slice (S4).**
   - The agent reads cgroup v2 counters for named systemd units and containers.
   - The protocol stays binary v2 and additive.
3. **CLI write (owner, 2026-11-05): `statsctl deploy mark`.**
   - The `AGENTS.md` invariant becomes "`check ingest` and `deploy mark` are the only mutations". `check ingest` still writes only to `synthetic-check`; `deploy mark` writes only one deployment marker for the named service.
   - Update the invariant in S2, together with the code.
4. **Services are data, not config.** A service is created through an admin API, like hosts, and stored in the Installation database, so adding one needs no redeploy on either target. Fields:
   - `name`, using the project id charset;
   - `hostIds`, the agent hosts it runs on;
   - an optional `healthUrl` to probe;
   - an optional `unit` (a systemd unit or a container name) for S4.

   Creating a service returns a deploy token once. The server stores only its SHA-256 verifier, as for host tokens.
5. **Marker shape.** It reuses `Deployment` from `deployments/model.ts`:
   - `id` is server-assigned;
   - `atMs` is the server receive time;
   - `source` is `"marker"`;
   - `message` comes from the marker;
   - `versions` is one entry, `{ id: version, percentage: 100 }`.

   The marker also carries the `hostIds` it was deployed to, which must be a subset of the service's. A marker is idempotent on `(service, version, client-supplied markerId)`.
6. **Comparison reuses `compareDeployment`.** Only the inputs are new; the windows, settling, and guardrail logic are shared with projects:
   - host rollups for the service's hosts (CPU, memory, pressure, network, disk);
   - probe uptime and latency, when there is a `healthUrl`;
   - cgroup series, after S4.

   `statsctl verify` on a service can show that resource levels changed. It cannot show "fewer resources for the same work" until a service reports its own work counts, which is a non-goal here, and its output must say so.
7. **Probes on Node** run on the scheduler port at the collector cadence (5 minutes), with the same `runProbes` the Worker cron uses.

## Execution boundary

Allowed without asking:
- local code, tests, and commits on `campaign/services`, with a merge to master per accepted slice;
- `make node-deploy` to threadripper within `docs/portable-core-campaign.md`'s boundary;
- creating one service, `stats-node`, on the threadripper instance and marking its deploys.

Forbidden:
- Cloudflare deploys beyond the owner-approved `make stats-deploy` of S1 to S3 (done 18:02Z);
- pushes;
- changing the existing STB2 sections or the acknowledgment format;
- rolling out a new agent to hosts. S4 deploys the decoder first, and agent rollout is the owner's call.

## Sequence

### S1 — Services and markers in core (M)

- Add a schema for `services` and `service_deployments`, additive tables in the Installation database, created idempotently.
- Add `POST /api/v1/admin/services`, which creates a service and returns its token once.
- Add `GET /api/v1/services` and `GET /api/v1/services/<name>`.
- Add `POST /ingest/services/<name>/deployments` (under `/ingest/` so the zone's existing `/ingest/*` Access Bypass covers it while the `GET` stays behind Access; Access matches by path, not method), authenticated with the deploy bearer token, never Access or Tailscale identity. It takes JSON `{ markerId, version, message?, hostIds }`, has a size limit, and is idempotent on repeat.
- Add `GET /api/v1/services/<name>/deployments`, in the same shape the project deployments route returns.
- Both targets use the same routes. On Node, admin and read routes need Tailscale identity, as other `/api/v1` routes do.
- Tests: create, mark, a repeat marker is a no-op, an unknown host or wrong token is rejected before any write, and a token never appears in a response other than creation. Extend the parity test with these routes on workerd and Node.
- Acceptance: `make cloudflare-test lint node-e2e`.

### S2 — `statsctl deploy mark` and `make node-deploy` marking itself (S)

- `statsctl deploy mark --service NAME --version V [--message M] [--host ID ...] --token-file FILE`.
  - The token file is checked like the `check ingest` credential file: mode 0600, never in argv, read from the invocation directory.
  - It works on both targets, prints the marker as JSON, and exits 0 on an idempotent repeat.
- `deploy/node/deploy.sh` marks `stats-node` with the commit after the health wait succeeds, using `.work/credentials/stats-node-deploy.json`.
- Update the `AGENTS.md` invariant (Decision 3) and `statsctl help`. `test/cli/docs.test.ts` must pass.
- Acceptance:
  - `test:cli` and `node-e2e` pass;
  - one real `make node-deploy` to threadripper records a marker;
  - `statsctl` on the tailnet origin lists that marker.

### S3 — Comparison and the Services page (M)

- Build `compareServiceDeployment` on `compareDeployment`, fed by host rollups and probes (Decision 6). Run probes on Node (Decision 7).
- Add a Services page and a service page that reuse the project page's deployments timeline and before/after widgets. A source the service lacks is shown as unavailable. Add Playwright goldens for both pages on the Node target.
- `statsctl verify --service NAME --deployment ID --policy FILE` reuses the policy model, limited to level metrics with the Decision 6 caveat.
- Acceptance:
  - `make cloudflare-test lint dashboard-test node-e2e`;
  - a real comparison of two `stats-node` deploys on threadripper, recorded in **Status**.

### S4 — Per-service cgroup metrics in the agent (L)

- **Agent config:** `services = [{ name, unit }]`. On Linux, it reads cgroup v2 `cpu.stat` (`usage_usec`), `memory.current`, `memory.peak` where present, and `io.stat` for each unit's cgroup. A systemd unit maps to `/sys/fs/cgroup/system.slice/<unit>`; a container maps to its scope under the container runtime's slice.
  - A missing cgroup is `unavailable`, never zero.
  - Counters are deltas within one boot.
- **Protocol:** a new section claims a reserved mask bit, documented in `docs/protocol.md`. Golden frames go in `fixtures/v2/` (`make fixtures-write`, then review the diff), plus Rust and TypeScript parity. Old decoders reject unknown bits, so:
  1. ship the Worker and Node decoder first;
  2. confirm both decode the new fixtures;
  3. only then build an agent that sends the section.
- **Rollout:** agent rollout to hosts is the owner's call (**Execution boundary**).
- **Comparison and UI:** `compareServiceDeployment` prefers the service's cgroup series over host series when present, and the page labels which one it used.
- Acceptance:
  - `make fixtures agent-test agent-build cloudflare-test lint dashboard-test agent-e2e node-e2e`;
  - the agent's binary-size and startup gates stay within the limits in `docs/dependencies.md` and `bench/README.md`.

### X — Close (S)

- Prove the moved code dead or alive (`dead-code-archaeology`).
- Run `review` on the integrated diff and fix P1 and P2 findings.
- Report:
  - what runs where;
  - how to add a service and mark a deploy;
  - what a service comparison can and cannot claim.

## Reference

Facts checked on 2026-11-05:

**Deployments model** (`cloudflare/src/deployments/model.ts`): `Deployment { id, atMs, source, message, versions[{ id, percentage }], deferred }`, with `DeploymentPoll` and `DeploymentSync` for the Cloudflare collector in `src/cloudflare/deployments/collector.ts`.

**Comparison:** `compareDeployment` in `src/deployments/compare.ts` takes window bounds and metric buckets and returns signals and guardrails. It is source-agnostic.

**Agent** (`agent/src/model.rs`): host-level sections only.
- CPU, load, memory, swap, CPU and system info;
- disks, network, pressure (PSI), filesystems;
- GPU, power, block I/O.

There are no per-process or per-service metrics.

**Protocol** (`docs/protocol.md`): sections and masks reserve bits, and a frame with a non-zero reserved bit is rejected as `invalid_frame`, which forces the decoder-first rollout in S4.

**Probes:** `runProbes` lives in `src/projects/probes.ts`; Worker projects declare probes in `cloudflare.config.ts`.
