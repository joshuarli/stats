# Stats on OpenOrange

Stats runs on OpenOrange on `lisa`, reachable only from the tailnet at
`https://stats.17166969.xyz` (a DNS-only A record to `lisa`'s Tailscale
address). The shared host stack (Rivet Engine, S3 store, Caddy ingress with
ACME DNS-01, whois identity sidecar, OpenRC units, backups) is defined in
[`stuff/deploy/openorange/`](https://github.com/laputa-systems/stuff/tree/main/deploy/openorange)
and its [shared-stack runbook](https://github.com/laputa-systems/stuff/blob/main/docs/openorange-runtime.md).
This page covers what Stats owns.

## What runs

| Piece | Where |
| --- | --- |
| Image | `deploy/orange/Dockerfile`: Node 26.13.1 Debian (digest-pinned), the pinned `deploy/orange` closure (open-orange 1.0.2, rivetkit 3.1.2-rc.1), both Workers |
| Descriptors | `deploy/orange/generate.mts` derives `stats.jsonc` and `observe.jsonc` from the typed `cf/config` build output; Analytics SQL and the tail consumer are dropped with reasons |
| Durable state | `Installation` and one `ObservationStore` per service, as Rivet actors in namespace `stats-prod` |
| Access | The ingress asserts `Stats-Tailnet-Identity` with the per-app `GATEWAY_SECRET`; ingest and deploy markers keep their bearer tokens |

## Service telemetry

The Services view lists registered services with their health probe, CPU and
memory, and reads their native deployment markers and application events; the
former Projects routes redirect to it. Overview shows operation counts;
Requests shows the newest 50 events; Signals charts counts, reported HTTP
statuses and elapsed wall time. Errors retains issue triage and diagnostics.
Range and zoom apply within the seven-day event retention. Missing intervals
stay gaps. The API is `GET /api/observe/NAME/external/telemetry?from=MS&to=MS`;
totals cover the whole window while operation and recent-event detail are capped.

Stats captures HTTP status and time to response headers under bounded route
labels. It excludes health checks and application-event ingest, and records no
request URLs, query strings, headers or bodies. Cancelled requests have no
invented HTTP response status. Delivery runs in the request's
`waitUntil` with a five-second timeout and logs a bounded failure code; it does
not block the response or retry failed request events. Accepted events persist
in the observation actor. Other applications appear when they report events
through the producer SDK.

Cloudflare analytics, tail capture, deployment polling and cost views remain in
the Cloudflare adapter. The generated OpenOrange descriptors disable those
provider bindings; native views use application events without CPU or billing
estimates. Selecting a Cloudflare deployment with those capabilities enabled
restores its existing project views.

### Per-container resources on Lisa

OpenOrange starts each long-lived container under its own cgroup parent,
`/oo.slice/oo-ROLE.slice`, where ROLE is the unit or app name with `-` written
as `_` (`oolib.cgroup_slice` in Stuff's `deploy/openorange`). The parent
survives container recreation, so Lisa's agent lists each one in
`/etc/stats/agent.json` as `{"name": "NAME", "unit": "oo-ROLE.slice"}`; a
`NAME` that matches a registered service shows on that service's Resources
section, and every name shows on Lisa's host page. Registered services that are
not apps (`oo-engine`, `oo-store`, `oo-ingress`) carry no deploy markers.

## Deploy

```sh
make stats-deploy-check ORANGE_HOST=lisa
make stats-deploy ORANGE_HOST=lisa
```

The read-only check verifies local write authority, OpenRC's running
state, and the selected image's availability. It compares the selected
image reference, image ID, and persisted node version with the running
container. Reconcile a mismatch before deployment. If a standby
holds write authority, follow the failback procedure before deploying
on Lisa.
`make deploy` runs this check before its fixtures, Worker tests, agent tests
and agent builds. The deployment checks the state again before building.

The deploy script builds a committed tree, conditionally selects its image,
restarts Stats and runs health and live smoke checks. It displays elapsed
time, the current stage and its deadline. Silent commands print wait updates.
The full log is `.work/tmp/steps/worker-deploy.log`. `STEP_LOG_DIR` overrides
the directory. The log is private and rejects a symlink at the log filename.
Run `deploy/orange/deploy.sh --help` for the enforced deadlines.

Failure restores the previous image only after selection was acknowledged
and verified, while the observed release still matches this deployment.
Uncertain ownership requires inspection. Cancellation lets an in-flight selection or restart
finish within its deadline before rollback begins. Further cancellation
signals do not interrupt rollback. The command verifies the restored image
and runtime node version before re-raising the original signal.
If rollback cannot be verified, the command reports both errors and fails.
Command termination has a bounded grace after its deadline.
The host retains its image-conditional write contract. Deployment is not one
atomic transaction with a concurrent manual operator.

Every smoke HTTP request has a connection timeout and request deadline.
Dashboard requests also share the existing dashboard deadline. `make deploy`
runs the complete smoke inside app deployment once, then updates the agents.
The standalone `make smoke-deployed` command remains available.
Successful activations and healthy rollbacks are recorded through the shared
host's `oo record-deployment` helper. Provision the Stats service's protected
deploy credential on the host as described in
[deployment markers](https://github.com/laputa-systems/stuff/blob/main/deploy/openorange/DEPLOYMENTS.md).
Delivery failures retain the exact marker for `oo sync-deployments stats` and
leave the healthy app selected. Repeated releases after a rollback get a new
marker because the selected node version changes.
Read the selection with `ssh lisa doas -n /opt/openorange/bin/oo deployment stats`.
For manual rollback, conditionally select the previous image with
`oo set-image stats PREVIOUS --if-current CURRENT`, then restart `oo-app.stats`.
The actor schema migrates forward on start; rolling back an image across a
schema migration needs a restore.

### Deploying to the standby writer

While Threadripper's standby VM holds write authority, `make stats-deploy`
refuses Lisa. Deploy the committed tree to the standby instead:

```sh
deploy/orange/standby-deploy.sh --check   # access, authority and runtime pins only
deploy/orange/standby-deploy.sh
```

The script reaches the guest through the SSH configuration named by
`STANDBY_SSH_CONFIG` (host alias `stats-standby`, jumping through
Threadripper with the pinned guest host key). It refuses unless Lisa's
recovery route names the standby as writer and `deploy/orange/package.json`
and `pnpm-lock.yaml` match `/opt/native-rehearsal/orange`. It builds with
`deploy/orange/build-context.sh`, copies the running release's `stats`,
`observe`, `stats.jsonc` and `observe.jsonc` to
`/opt/native-rehearsal/releases/<release>`, swaps in the new ones (keeping the
`.open-orange` runtime state), restarts OpenRC `native-stats`, and requires the
guest health route, the new release in the descriptor and the public health
route. A failure restores the previous release the same way.

### Standby operations record (2026-11-20)

- **Access.** The guest key, pinned host key and SSH config live in
  `~/.config/stats/standby/` on the workstation; `deploy/orange/standby-deploy.sh`
  uses them.
- **Reboot.** `rc-service stats-recovery-vm stop` shut the guest down
  gracefully, `qemu-img snapshot -c pre-reboot-20261120 stats.qcow2` recorded a
  rollback point, and `rc-service stats-recovery-vm start` booted it. Docker,
  the Engine and `native-stats` started unattended (`native-stats` respawned
  once while the Engine settled); the public health route answered after 76 s,
  the release was unchanged, and all five hosts reported again. Delete the
  internal snapshot at the next planned stop (`qemu-img snapshot -d
  pre-reboot-20261120 stats.qcow2` with the guest down), since it grows the
  image.
- **Deployment markers.** Lisa's relay at `172.29.80.20:8080`
  (`deploy/orange/recovery/stats-direct.Caddyfile`) also forwards
  `POST /ingest/services/NAME/deployments`, which Stats authenticates with the
  service deploy token. OpenOrange's `record-deployment` and `sync-deployments`
  deliver again; the queued Discover and Wine markers were drained.
- **Outage (13:51–15:41 UTC).** The guest's qemu process exited around 13:51
  (last `stats.qcow2` write; OpenRC reported `crashed`; no OOM or qemu
  segfault in the host log at that time, so the cause is unknown). Lisa's
  `oo-stats-live-tunnel` and `oo-stats-direct-tunnel` then could not
  reconnect: udhcpc's 07:50 lease renewal had replaced `/etc/resolv.conf`
  with `nameserver 10.0.1.1`, tailscaled did not repair it as it had at
  19:50 the day before, and `threadripper` stopped resolving. The open
  tunnels hid this until the guest died. Public health returned 502 for
  about 1 h 50 min and nothing alerted. Recovery: `qemu-img check -U` found
  no errors, `rc-service stats-recovery-vm restart` booted the guest
  (`native-stats` listening with 2 Workers after about a minute),
  `tailscale set --accept-dns=false` then `--accept-dns=true` on Lisa
  restored MagicDNS, and health answered 200 at 15:41:34 on release
  `accd14a0364c`. Lisa's `/etc/udhcpc/udhcpc.conf` now sets
  `RESOLV_CONF="no"` (original kept as `udhcpc.conf.pre-20261120`) so
  renewals leave tailscaled's file alone. Agents buffer about four minutes,
  so samples from most of the window are lost and read as gaps. STA-130
  tracks guest supervision and independent alerting.
- **Crash watchdog.** `deploy/orange/recovery/stats-recovery-vm-watchdog`
  (installed as `/usr/local/libexec/stats-recovery-vm-watchdog` with the
  OpenRC unit `stats-recovery-vm-watchdog.openrc`, default runlevel) checks
  `stats-recovery-vm` every 30 s. Only an OpenRC `crashed` state triggers it:
  it copies `console.log` to `console.log.crash-EPOCH` (newest five kept),
  restarts the VM, and gives up after three restarts within an hour, logging
  through syslog tag `stats-recovery-vm-watchdog`. A stopped VM stays stopped,
  so planned stops and the graceful guest poweroff are unchanged.
- **Failback.** Native Stats on Lisa with its own Engine remains a planned
  migration: production units, the ingress move, a soak and a fenced handoff
  are still gated in [native Lisa](native-lisa.md). Until then the standby is
  the supported writer, and `stats-prod` on Lisa keeps its 17 stranded actors.

### Runtime release record (2026-11-20)

The standby writer runs runtime release `rt-3abd20d29960` (closure
`sha256:3abd20d2996009547bc188653d6d7607203f67cdc3d92c967afceaa7b1b51151`):
the repository closure with `open-orange@1.0.2-laputa.1` from the Stuff npm
registry, which is upstream `1cabf2e` plus the per-Worker metrics patch
(tarball `sha256:2a3932cd…`). The previous release `rt-13b896622da5`
(upstream 1.0.2) remains in `/opt/native-rehearsal/runtime/` as the recovery
artifact.

- Qualification: the musl artifact was built in a pinned linux/amd64 Alpine
  container (`deploy/orange/runtime-artifact/build.sh`); a baseline built the
  same way reproduced the live digest exactly. The in-container canary ran
  the exact extracted bytes for both releases and `statsctl verify release`
  returned `pass`. The evidence is in
  `~/.local/state/openorange/releases/rt-3abd20d29960/` on the workstation.
- Promotion: Stuff's `rollout stage` then `rollout start --target-kind
  native` (journal `~/.local/state/openorange/rollouts/83a31437381647c29cb9034ca32c5046`).
  Converting the in-place runtime took 2 s and activation, including the
  `native-stats` restart and health wait, 5 s. Twenty checks over the
  five-minute window passed, and the run ended `promoted`. Public health
  answered 200 throughout. All five hosts reported within two minutes
  afterwards, and `standby-deploy.sh --check` reports matching runtime pins.
- Recovery drill (17:56 UTC): a second rollout activated `rt-13b896622da5`
  (upstream 1.0.2) as the candidate against `rt-3abd20d29960`, with
  reverse-direction artifact canary evidence (`pass`). The previous runtime
  started on the state the owned release had written and passed two checks.
  The controller was then killed with SIGKILL mid-verification. `rollout
  abort --run …/4da37e92a8f54c83932b74e1b1a7aee6` reconciled the orphaned
  run, re-activated `rt-3abd20d29960` and ended `recovered` (exit 3) in 4.8 s.
  Public health stayed 200 and all five hosts kept reporting.
- Services removal (18:14 UTC): `rt-a26798107529` (closure
  `sha256:a26798107529…`) is `rt-3abd20d29960` without `@rivet-dev/services`
  and its platform packages. `make orange-artifact-test` built both artifacts
  (the baseline reproduced `3abd20d2…`) and the exact-bytes canary returned
  `pass`. Rollout `58dfe686ce674848873f5173cf4a6350` passed 20 of 20 checks
  and ended `promoted`. The standby has no services package installed, and
  `rt-3abd20d29960` stays as its recovery artifact.

### Infrastructure metrics on the standby

`deploy/orange/collector/install.sh` installs the INF-7 collector on the
standby guest; it is idempotent. It runs as OpenRC `stats-infra-collector`
(user `stats-infra`, log `/var/log/stats-infra-collector.log`) and scrapes
`engine:live` (`127.0.0.1:6430`), `worker:stats:0` (`:9100`) and
`worker:stats-observe:1` (`:9101`) every 15 s, posting to the local
`/ingest/metrics/v1/batches`. The script generates the `stats-infra` token on
the guest in `/etc/stats-infra/token` and writes only its SHA-256 verifier
(`INFRA_METRICS_TOKEN_SHA256`, added to `ORANGE_WORKER_SECRETS`) and
`RIVETKIT_METRICS_PORT=9100` into `/etc/conf.d/native-stats`. The first run
kept the previous file as `native-stats.pre-infra-metrics`. The collector
needs `native-stats`, so every runtime rollout and `standby-deploy.sh` restart
restarts it, and its `start_pre` rewrites `/run/stats-infra/release.json` from
the `orange` symlink and the deployed descriptor.

Read the sources over the tailnet:

```sh
now=$(($(date +%s)*1000))
curl -sS "https://stats.17166969.xyz/api/observe/stats-infra/metrics/sources?from=$((now-900000))&to=$now&release=runtime"
```

Enabled 2026-11-20 with app `stats-46ac80216376` on runtime
`rt-a26798107529`. All three sources reported every round with no scrape
failures. A `native-stats` restart restarted the collector and rewrote the
release file; the read then showed two incarnations per Worker and one
`refused` scrape while the Workers started, counted as a gap. `resets` counts
only restarts seen by one collector instance, so it stayed 0. Metrics are stored outside the installation and observation
objects and are not in logical backups. The dashboard does not show them yet.

### Engine load record (2026-11-19)

Lisa's Engine used 1.7 cores with idle applications. Its Prometheus endpoint
(`172.29.80.11:6430/metrics`) and per-app stop tests attributed the load:

- About 1.05 cores came from the `discover-wine` space alarm. Wine queued
  `page.published` and `page.withdrawn` outbox rows that nothing delivers, so
  each re-arm landed in the past and the alarm re-fired about 1.4 times a
  second from the first publications on 2026-11-18. Discover
  [#49](https://github.com/joshuarli/discover/pull/49) (`discover-wine:8d6580a4ea6d`)
  removed the rows and the loop; Engine CPU fell to 0.65 cores.
- About 0.35 cores came from alarms of Stats actors in namespaces with no Stats
  runner on Lisa, which the Engine retries forever. The Nov 14 rehearsal
  namespaces `stats` and `stats-r1` were archived (irreversible in this Engine),
  leaving 0.33 cores.
- `stats-prod` still holds 17 such actors, the pre-failover Stats copy kept
  for failback. Failback to Lisa ends their retries; if Stats stays off Lisa,
  archive `stats-prod` once the sealed copy under
  `/var/lib/openorange/recovery/stats-live-failover-20261118/engine` is no
  longer needed.

Stats shows the Engine's share on Lisa's host page and the `oo-engine`
service's Resources section.

### Runtime artifacts

Build a baseline with `TMPDIR="$PWD/.work/tmp" sh deploy/orange/runtime-artifact/build.sh --out .work/tmp/artifact-baseline`. Build the candidate with `TMPDIR="$PWD/.work/tmp" sh deploy/orange/runtime-artifact/build.sh --candidate /path/to/open-orange-1.0.2-laputa.1.tgz --out .work/tmp/artifact-A`. The builder reads Stuff's rollout adapter from `origin/main` in `/Users/josh/repos/stats/.work/tmp/stuff`; fetch that checkout before building. Build the Worker bundles with `make worker-bundle observe-bundle`, then run `TMPDIR="$PWD/.work/tmp" node --experimental-strip-types --test deploy/orange/runtime-artifact.test.mts`. The test consumes these two archives, saves its evidence path, and checks the release verdict and replay. After qualification, pass the same `runtime.tar` to Stuff's `deploy/openorange/bin/rollout stage --target-kind native --host HOST --ssh-config CONFIG --archive .work/tmp/artifact-A/runtime.tar --source SOURCE`. Compare the returned digest with `artifact.json` and the qualified `runtime-closure` before promotion. See the [artifact results](../bench/results/2026-11-20-musl-runtime-artifact/README.md) for the recorded build and verification.

## Back up and restore

The application export is the recovery contract; it does not depend on the
Engine's directories.

The observation store maintains `observe_application_projection` and
`observe_application_rollups` as rebuildable read state. Logical exports omit
both tables and retain the 16-table canonical schema fingerprint. A fresh import
clears derived rows before canonical mutation triggers rebuild them; resuming an
import retains work from acknowledged pages.

Before creating rollups, deploy the snapshot-policy reader that excludes both
derived tables. That compatible reader is `stats:03d3d4f1fcb8` (node version 23).
It retains the compact projection query. Keep both derived tables and their
triggers during rollback. Earlier projection-only readers do not exclude the
rollup table and are unsuitable rollback targets after its creation.

```sh
pnpm --dir cloudflare -s statsctl backup fence --state fenced
pnpm --dir cloudflare -s statsctl backup export --out .work/backups/<name>
pnpm --dir cloudflare -s statsctl backup fence --state open
STATSCTL_TARGET=orange pnpm --dir cloudflare -s statsctl backup import --in .work/backups/<name> --origin https://<fresh-origin>
```

A fence pauses writes (503 with `Retry-After`; agents retry) and alarms; agents
buffer about four minutes (`maxQueueSamples` 16 at 15 s). Export writes
per-table NDJSON checked against each object's row counts and SHA-256 digests;
`index.json` is written last. Import requires empty objects with identical
table definitions and resumes from recorded progress. The server re-verifies
every table before reopening the object. The CLI checks the returned table
counts and digests against the archive before reporting success. Backups
contain token verifiers: keep them
owner-only and off shared storage. `make orange-test` proves the round trip
into a fresh namespace.

Use `backup import --serial` to restore one object at a time if the
destination cannot sustain concurrent imports. After an interrupted
restore, inspect the recorded progress and resume the unfinished objects
individually with `backup import --object OBJECT`.

On an isolated copy that is still fenced, resume an interrupted export
into a new output directory.

```sh
pnpm --dir cloudflare -s statsctl backup export \
  --out ~/backups/openorange/stats/retried \
  --resume-from ~/backups/openorange/stats/original.partial
```

Use the same origin and object selection. The command fetches each
manifest again, checks the schema and table digests, and resumes after
the last verified page. A completed object needs only a manifest
request. The earlier directory is left intact. The published archive
uses `stats-backup/1`. Keep the partial directory until the retry
verifies. Use `--serial` if parallel export overloads the source.
Archives from older exporters without page checkpoints need a fresh
export.

For a live source, reopen writes within the agent queue budget even
when export fails. If source data changed after reopening, start with
a fresh fence and export. Checkpoint reuse does not extend a production
maintenance window. Batch reopening attempts each object and lists any
unconfirmed results. An exit of 4 means state remains unconfirmed for
the listed objects. Retry each with `backup fence --state open --object`.

Use `statsctl backup status --object observe:stuff --json` to inspect
acknowledged row offsets during a restore. This is a read-only request.
A finished import reports `open` and clears its per-table offsets.

## Cutover record (2026-11-14)

| Step | UTC | Result |
| --- | --- | --- |
| Export routes deployed to Cloudflare (branch `migration/cloudflare-export`) | 05:29 | stats `c8c216af`, stats-observe `9565445b`; smoke passed |
| Rehearsal: export 10 objects (686k rows), import into `stats-r1` | 05:32–05:46 | 6 hosts byte-identical 6 h history, services equal; found and fixed an OOM in digests, schema text normalization, and Engine write backpressure |
| First fence | 05:49–05:51 | Export failed with repeated 500s under concurrent export; fence lifted after 2 min 05 s, nothing imported |
| Final fence | 05:52 | Export 64 s, import into fresh `stats-prod` 7 min |
| Parity | 06:00 | 24 h history byte-identical for all 6 hosts, host records equal |
| DNS | 06:00:42 | Workers custom domain detached; A `stats` → `100.68.104.43`, DNS-only, TTL 60 |
| Agents on `lisa` | 06:06 | sentry, threadripper, lisa, m1-max delivering; tim offline before cutover |

Writes were refused from 05:52 to about 06:06 depending on each host's DNS
cache, longer than the agent queue, so hosts lost the oldest samples of that
window; the gap reads as missing data, never zero.

## Recovery

On 2026-11-14 the Cloudflare `stats` and `stats-observe` Workers were deleted
after their old tail consumer references were removed. Their Durable Object
namespaces are gone, so a DNS reversal cannot restore those stores.

The source cutover export is at `/Users/josh/backups/openorange/stats/source-cutover`;
all 10 objects and 627,253 rows were reverified. Recover by importing a logical
backup into a fresh OpenOrange namespace. This cutover export predates subsequent
Orange writes. Physical snapshot `20261114T184204Z` passed independent Engine/S3
restoration and an off-host SHA-256 check. Its protected
Mac copy is `/Users/josh/backups/openorange/lisa/post-stuff-cutover/state.tar`;
the shared-stack runbook records recovery tooling and the archive digest.

The later fenced snapshot `20261114T214525Z` includes the native deployment
outbox and delivery receipts. Its 76,609 files are preserved in
`/Users/josh/backups/openorange/lisa/post-native-observability/state.tar.gz`.
The 5,112,712,834-byte Mac archive matches Lisa's SHA-256:
`7a7b33689724196b34f22291d1642c742541efa3bbf963de8e5eeba2676db8ca`.
Matching runtime images and restore instructions are under
`/Users/josh/backups/openorange/stats/native-observability/`.
Restore the selected image, node version and marker state from the same snapshot.
The recovery notes distinguish that snapshot's Stats image from the newer
production image. Writes after the fence are outside this backup.

## Retained Cloudflare adapter

OpenOrange skips Cloudflare Analytics SQL, provider deployment polling, tail
capture and the project probes that ran inside the provider collector. Imported
Worker, R2, D1 and cost histories remain historical. The Cloudflare adapter keeps
its collection and billing implementation for a separate provider deployment.

The Orange tail shim supplies no usable CPU or caught-error diagnostics.
Stats reports its operations, HTTP requests and errors through application
events instead. The default Projects dashboard uses those native events and
service markers. `/api/v1/capabilities` reports the enabled sources.

## Shared migration recovery

Stuff, Discover and Tansu cutover records live in their owning repositories.
The shared stack's [runbook](https://github.com/laputa-systems/stuff/blob/main/docs/openorange-runtime.md)
records resource retirement, the off-host archive checksum and runtime recovery.
The second copy is `/Users/josh/backups/openorange` on the Mac. Discover's
fresh logical snapshots and independent recovery reports are under
`discover/cutover-refresh` and `discover-preview/cutover-refresh`; their source
artifacts were unchanged from the physical snapshot. Protected runtime contexts
and the selected configuration are retained alongside them.

## Application overview release (2026-11-14)

`stats:87ff3ca79243` is deployed at Orange node version 8. The production
browser verified all three overview charts, recent requests, mobile layout and
release history. A fixed historical window retained all 1,851 events and 1,464
requests; the same six services and host associations remained registered.
Performance and memory evidence is in [frontend efficiency](frontend-efficiency.md#native-application-overview-2026-11-14).

The first image attempt inherited a protected shell's 077 umask and could not
read root-owned application files as the runtime user. The deploy script
restored the previous healthy image. Images now give the runtime user ownership
of application artifacts, and an isolated image preflight reads both descriptors,
entry modules and the dashboard asset before production selection changes.

The selected image and protected replay/verification captures are saved under
`~/backups/openorange/stats/performance-overview` on the Mac. Retain that image
supplement with the earlier full physical backup; it does not contain Engine
or Store state. Shared health after the subsequent registry-stream repair
reported 92 passes, one disk-capacity warning and no failures.

## Range refresh hardening (2026-11-14)

`stats:434ea6ed31f5` is deployed at Orange node version 15. Slow reads survive
live clock ticks. Completed ranges reuse a bounded summary cache, while manual
and periodic refresh still read fresh data. Summary responses and stored HTTP
events carry paired query and actor-call timings. Stats batches its own events
through the existing private observation binding.

The [hardening audit](runtime-hardening.md) records installed artifacts,
compatibility evidence, measured results and unresolved gaps. The
[deployment handoff](runtime-hardening-handoff.md) contains validation and
rollback commands. The Engine, persistence backend and credentials are unchanged.

### Standby mutation leases

Set `STATS_ROLLOUT` to the rollout executable and `STANDBY_SSH_CONFIG` to the
SSH configuration before running standby mutations. `standby-deploy.sh` takes
`stats-deploy` for the guest app swap, collector installation, restart, and
rollback. `collector/install.sh` takes `collector-install` for a standalone
installation. Restart `native-stats` through `rollout lease run --target-kind
native --host stats-standby --ssh-config FILE --operation native-stats-restart
--bound-s 300 -- rc-service native-stats restart`. The backup fence uses the
application API and does not mutate the host, so it does not take the host
lease. Writer handoff on Lisa is outside the standby guest lease and is owned
by Stuff. `standby-deploy.sh --check` is read-only and takes no lease.

The rollout policy can invoke `deploy/orange/functional-check.mjs` with
`--ssh-config`, `--host`, `--credential-file`, and `--statsctl`.
It requires `STATS_ROLLOUT`, `ROLLOUT_RELEASE`, and `ROLLOUT_DIGEST` and checks target identity
before and after the synthetic ingest, including process continuity. The
observer under `deploy/observer/` runs independently on another host; install
its service template with explicit executable, state, candidate, credential and
endpoint paths. Its fsynced evidence and alert outbox must reside outside the
candidate stack. Alert transitions record unconfigured delivery; no sender is
provided.
