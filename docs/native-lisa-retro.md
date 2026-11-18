# Lisa OpenOrange outage retrospective

The first verified public registry recovery came about **56 minutes** after
the 00:19 UTC triage check. Stats snapshot reads and Agentctl were verified
by 02:30, about **2 hours 11 minutes** after that check. HQ public reads
were verified by 02:40, about **2 hours 21 minutes** after triage. These are
elapsed times between recorded checks. The exact outage start and
hands-on time are unknown. The live Stats history later showed that all
five hosts had stopped recording samples around 23:00 UTC on November 17,
roughly 79 minutes before the first documented triage check.

Recovery was partial. Package pulls and the HQ reader recovered through
temporary routes. Stats displayed a dated snapshot while live ingestion
remained unavailable. Agentctl recovered against the original Engine.
The incident stayed open for telemetry freshness, Stuff publishing and
Discover's stateful private operations. The [operational recovery plan](lisa-operational-recovery.md)
defines the ownership, dependencies and evidence for closing those gaps.

The November 17 maintenance session began with Stuff already unavailable.
Cargo's sparse mirror returned HTTP 502, and Stats' backup object listing
returned HTTP 503. The shared Rivet Engine answered HTTP 200 on `/health`
while its stateful application paths failed.

## Timeline

Times are UTC on November 18, 2026.

| Time | Event |
| --- | --- |
| 00:03 | The Engine logged a depot volume fence and a tablet maintainer fence. A new Engine container started at 00:03:38. |
| 00:19 | OpenRC showed Stuff starting. The running Stats container was `stats:c9a71b2ba127` with node version 25. The selected image was `stats:6cc06db247a3` with version 26. |
| 00:20 | The stack health command found zero connected Stuff and Stats runner nodes. Stuff returned 502. The first Stuff restart attempt met an OpenRC lock held by the ongoing start. |
| 00:21–00:24 | Once the lock cleared, the requested restart reached the start command and failed its 90-second readiness check. The Engine logged storage deadlines in the Envoy registration path. |
| 00:32 | Available root disk space had increased from about 80 GiB to about 191 GiB. Crates still returned 502. |
| 00:34–00:35 | A single graceful TERM ended the pinned Engine container. OpenRC started a new container from the same image. The authenticated Stats backup listing still returned 503. |
| 00:35 | A second Stuff start followed the Engine restart. The Alpine rehearsal finished verifying the historical Stats restore in a separate namespace. |
| 00:37 | Stuff failed readiness again. Both public Crates probes still returned 502, and the Engine continued logging registration deadlines. |
| 01:13 | The deployed Stuff Worker started in a separate Engine namespace with publishing disabled. It served the registry files from the existing versitygw store. |
| 01:15 | Caddy switched the public listener and tailnet package reads to the recovery Worker. Crates, npm, PyPI, OCI, the mirror and the Stuff landing page passed live probes. |
| 01:17–01:24 | Stats hosts and services returned Rivet's storage deadline error as HTTP 400. The first depot capture paused the Engine and triggered a lease fence. A subsequent stopped-service capture completed. |
| 01:24–01:39 | Lisa-hosted clone trials failed registration. An off-host copy reopened with the pinned Engine and served authenticated Stats data. |
| 01:39–01:53 | An ordered Lisa restart reconciled stale app identity and failed registration again. Full logical export failed on a Discover observation page. An installation-only export passed. The authenticated snapshot route was staged for approval. |
| 02:27–02:30 | After approval, Stats served the labeled snapshot at its normal URL. Agentctl restarted and passed its stateful hosts read. |
| 02:31–02:40 | Discover failed another primary start. The isolated reader passed published-content probes after its artifact binding was attached. HQ recovered through a scoped route. |
| 02:57–03:03 | An Engine-only stop sealed a fresh checksum-verified copy. A separate standby took Stats write authority. All five hosts resumed reporting. |
| 03:11 | The normal renderer reloaded the three recovery routes. Stats, registry pulls, HQ published reads and Agentctl's hosts API passed. |

## Public read recovery

The fallback uses `oo-stuff-read-app` at `172.29.80.252:8080` and
`oo-stuff-read-engine` at `172.29.80.251:6420` on the internal
`openorange` network. They use the production image pins with separate
Engine credentials and an empty `stuff-read-recovery` namespace. The
Worker has `STUFF_COORDINATOR_ENABLED=false` and receives the existing
bucket bindings. The publishing and upload credentials are absent.

The fallback reads each registry's last projected S3 `current` generation.
If an activation committed just before the outage and its projection never
completed, its generation will appear after coordinator recovery. The
private publishing hostname remains on the original upstream and returns
HTTP 502. The fallback did not move publication authority or write any
registry object.

The public Cargo sparse config and index passed over HTTPS. A download of
`serde` 1.0.228 matched its sparse-index SHA-256, and `npm view` returned
`@laputa-systems/ui-dashboard` 0.9.1. The tailnet Caddy listener served the
Cargo config. Public `/_publication`, `/_s3` and `/admin` returned HTTP
404. A public POST to the Cargo config returned HTTP 405.

The original and recovery Caddyfiles are under
`/etc/openorange/stuff-read-recovery/` as `Caddyfile.before` and
`Caddyfile.recovery`. The active route is now generated from
`recovery-routes.json`. Keep its `stuff` entry until the original app
serves package reads and an authenticated coordinator read at
`172.29.80.21:8080`. Then remove the entry, run `oo reload-ingress`,
repeat the public and tailnet probes, and stop `oo-stuff-read-app`
followed by `oo-stuff-read-engine`.

Private publishing and the native production cutover remain open. The
shared Engine needs to serve runner registration and stateful reads before
Stats can take the fresh logical backup required for cutover.

## Stats dashboard recovery

The dashboard HTML loaded while `/api/v1/hosts` and `/api/v1/services`
returned HTTP 400 with Rivet's `depot.request_deadline_exceeded` error.
The failed RPC came from the installation actor behind the Worker.

The first diagnostic copy paused the Engine. The checksum pass exceeded
the pause deadline, the worker lease expired, and OpenRC respawned the
Engine. Use an Engine-only OpenRC stop for a stable depot copy. At
01:24:07 UTC the Engine stopped, and `rsync --checksum` completed before
restart at 01:24:19. Stuff package reads stayed on the independent
recovery path. The copy is protected on Lisa at
`/var/lib/openorange/recovery/20261118T012407Z-engine/depot/`. It covers
Engine state and excludes the bucket store and production credential files.

On Lisa, the copied depot failed Stats readiness with the pinned Engine
at both resource limits tested, reduced alarm concurrency, a larger
cold-read window, and the private SQLite repair binary. Stats also failed
when the app and Engine shared loopback in an isolated network namespace.
The same pinned Engine reopened the 01:24 depot on an isolated Alpine VM
on Threadripper.
Three successive authenticated checks returned HTTP 200 for hosts and
services. This establishes recoverability of the copied state and leaves
the difference between the Lisa and VM environments unclassified.

The full logical export from the VM failed on a Discover observation
page with HTTP 500. All 14 objects reopened. An installation-only export
then verified 198,059 rows across 15 tables and reopened the object.
That protected export is at
`/Users/josh/backups/openorange/stats/lisa-engine-copy-20261118T012407Z-installation/`.
The full logical cutover backup remains open.

The ordered Lisa restart first detected that the selected image
`stats:6cc06db247a3` was absent. It conditionally aligned the selection
to the previously running `stats:c9a71b2ba127` at node version 27,
cleared the stale OpenRC state, and started the pinned Engine before
Stats. The Stats runner again failed registration. OpenRC stopped the
failed app, and the production dashboard returned HTTP 502.

The owner authorized the temporary snapshot at the Stats URL. Caddy
keeps the tailnet identity check and sends dashboard GET and HEAD
requests to `oo-stats-snapshot` on Lisa at `127.0.0.1:18483`. The
OpenRC service supervises an SSH tunnel to the isolated Stats app on
Threadripper. The page identifies the 01:24 UTC copy and says live
telemetry is unavailable. Hosts and services returned HTTP 200
through the Stats URL. Ingest and admin requests still route to the
original Stats upstream on Lisa.

The Stats recovery Caddyfiles and ingress environment backups are
under `/etc/openorange/stats-snapshot-recovery/`. The original already
includes the Stuff recovery routes. The live failover below replaced
the snapshot matcher and credential. The `oo-stats-snapshot` tunnel
was stopped and removed from the default runlevel.

Agentctl restarted against the original Engine and returned HTTP 200
for `/healthz`, `/api/session`, and the stateful `/api/hosts` read.
Discover failed the registration deadline twice with its selected image
and returned HTTP 502 at the HQ URL.

## Live Stats failover

The initial Stats snapshot is retired. The five expected online hosts
resumed reporting at 03:03 UTC on November 18, 2026, after write authority
moved to Threadripper at 03:02:50. A second check at 03:05 UTC and a check
after the ingress reload at 03:11 UTC found fresh server receipts for
`lisa`, `threadripper`, `sentry`, `tim`, and `m1-max`. The dormant
`synthetic-check` enrollment was excluded. The command and its freshness
contract are in [operations](operations.md).

At 02:57:23 UTC, an Engine-only stop and a checksum pass sealed the source
capture at `/var/lib/openorange/recovery/stats-live-failover-20261118/engine`
on Lisa. The original Stats app was absent from Docker before the switch
and removed from the OpenRC default runlevel. The separate guest disk
`/home/josh/.local/share/stats-live-recovery/20261118/stats.qcow2` on
Threadripper has no backing file. Its Engine uses the copied depot and the
original Engine image digest
`sha256:6e585002b700dd4d3630808eb67884aa15d1a602d83781984edac47023b6d40f`.
The app runs natively in the guest at release `c9a71b2ba127` and runner
version 27, with guest-local credentials. The old and new write histories
diverge at the switch. To fail back, pause admission, seal and transfer the
newest standby state, verify it on Lisa, then move authority. The older
Lisa capture remains evidence and a recovery point.

The standby VM is now registered in Threadripper's default OpenRC
runlevel as `stats-recovery-vm`. It adopted the current QEMU process
without restarting it. The launch path was exercised separately against
a disposable disk. The guest starts Docker, the existing Engine
container and native Stats on boot. Stats waits for Engine liveness before
running. A host-local SSH key is restricted to the guest's status and
graceful shutdown commands. The real standby's reboot and shutdown
sequence still needs an isolated rehearsal.

On Lisa, OpenRC service `oo-stats-live-tunnel` exposes the guest app on
`127.0.0.1:18489`. Caddy retains tailnet identity checking and sends all
Stats app requests to it. The `/rivet` dashboard remains separate.
`/etc/openorange/recovery-routes.json` owns the active Stats, Stuff and
Discover routes as of 03:11 UTC. Stats writer mode derives the ingress
credential from `apps/stats.recovery.env` and fences Lisa startup and
image selection. The ordinary `oo reload-ingress` generated and applied
all three routes. The authenticated Stats host probe, Agentctl hosts,
HQ dated reader and a checksum-verified Cargo download passed afterward.

The temporary deployment restores host ingest and the dashboard. Direct
producers on Lisa that address the old private Stats container IP, the
Stats export bucket binding, and complete history reconciliation remain
open. No full native Lisa cutover or standby reboot drill was performed.

### Host history reconciliation

Authenticated summary history from the active writer shows the
following gap boundaries. They are sample timestamps in UTC. The first
returning samples precede route activation because agents sent recent
queued samples. Gaps mark missing samples in the verified history. The
request logs do not identify which missing samples each host attempted
or whether every pre-outage acknowledgement survived.

| Host | Last sample before gap, Nov 17 | First sample after gap, Nov 18 |
| --- | --- | --- |
| lisa | 23:00:31 | 02:59:33 |
| threadripper | 23:00:45 | 02:59:17 |
| sentry | 23:00:20 | 02:59:42 |
| tim | 23:00:36 | 02:59:43 |
| m1-max | 23:00:32 | 02:59:51 |

To reproduce, get host IDs from the authenticated `/api/v1/hosts`
endpoint. For each, decode `kind=summary` history in UTC windows
`22:00–01:00` and `01:00–03:17`. Use the largest interval between
successive points across the two windows.

## HQ public reader recovery

The selected Discover image registered against the copy of the Engine on
Threadripper. Its public reader uses the publication pointer from that
copy and reads the corresponding published objects from the existing
versitygw bucket on Lisa. The recovery Worker runs on Lisa as
`oo-discover-read-app` on `127.0.0.1:18485`. It has no operator
credentials or scheduled triggers. Its isolated Engine endpoint uses
the `oo-discover-recovery-tunnel` OpenRC service on `127.0.0.1:18487`.

Caddy's Discover reader rule matches HQ GET and HEAD requests and excludes
admin, operator and MCP routes. Responses include
`X-Discover-Recovery-Snapshot: 2026-11-18T01:24:07Z`. Public HQ serves
the published homepage, search index and browse catalog. Requests for
research, publishing and private administration stay on the original
upstream. Public `/admin` still returns 404.

Once the authoritative Discover app serves stateful reads and the
published homepage, remove only the `discover` entry from
`recovery-routes.json`. Validate and reload, probe HQ through
public and tailnet ingress, and then stop the recovery app and its
tunnel. The original and changed Caddyfiles for this step are
`Caddyfile.before-hq` and `Caddyfile.with-hq` under
`/etc/openorange/stats-snapshot-recovery/`. Keep the Stats and Stuff
recovery routes while those services still depend on them.

The HQ reader still needs the original diagnostic guest. It is separate
from the VM that now accepts Stats writes. Lisa supervises both active
SSH tunnels.

## Why recovery took hours

The main delay was the absence of a rehearsed recovery path for a shared
Engine that could answer health checks while its applications failed.
Package bytes, published HQ artifacts, application containers and the
authenticated ingress were recoverable independently. The default
deployment still tied all of their startup or publication state to the
Engine. During the incident we had to identify which dependencies could
be removed, assemble replacements, and prove the resulting trust and
data boundaries before routing users to them.

| Friction | Evidence and impact |
| --- | --- |
| Liveness passed while capabilities failed | Engine `/health`, a running container, and HTML all gave green signals during different parts of the outage. Registry pulls, runner registration, Stats actor reads, and ingestion need their own probes. The dashboard's HTTP 400 made a storage deadline look like a client request error. |
| Shared failure domain and dependency loop | Rivet registration took down Stats, Stuff, Discover, and Agentctl. Stuff's registry failures also blocked hosted package consumers. Stored package bytes survived, but the serving path depended on the publication coordinator. |
| Recovery and migration competed | I kept building the native rehearsal while production dependencies were already failing. I made the degraded-reader path the priority only after the first restart sequence failed. The rehearsal established portability, but it was on the critical path for too much of the investigation. |
| Restart ownership and deadlines were unclear | A preexisting OpenRC start held the lock. Subsequent start attempts spent their readiness deadline retrying the same registration error. A same-image Engine restart did not clear it. We needed a single operator and a defined point to switch methods. |
| Release and supervisor state disagreed | Stats was selected at version 26 while version 25 ran and OpenRC said `starting`. The selected rollback image was absent locally. The first ordered restart aborted at preflight. Reconciliation required an explicit choice of available image and another service transition. [STA-129](../TODO.md#sta-129--p1--investigate-deployment-stall-and-interrupted-rollback) tracks the existing deployment investigation. |
| The first capture method was wrong | I paused the live Engine for the checksum pass. The pause exceeded its lease and triggered a fence and restart without a completed copy. The later Engine-only stop and checksum completed. Lease budgets and the capture method belong in a tested incident command. |
| There was no current tested recovery point | The earlier verified logical export was historical. The fresh production listing returned 503. On a recovered copy, the full 14-object export failed on one page and never published an index. The single-installation export succeeded, which helped the dashboard and left the remaining objects unverified. |
| Rehearsal setup had hidden requirements | The VM needed working SSH access, pinned artifacts, writable directories and service logs. Stats self-observation populated a restore object before import and caused 409. Copy ownership had to match the Engine UID. Each failure consumed time before a stateful check could run. |
| The failure did not follow the data alone | Local clone trials, the private repair binary and changed resource limits failed to register Stats. The same pinned Engine reopened copied state off-host. The environments also differed in kernel, workload, networking and app packaging. The exact environmental cause remains open. |
| Data transfer used the wrong path first | I sent the depot through the workstation before checking host-to-host connectivity. That copy stalled and was stopped. A direct tailnet path with a scoped key completed. A standby needs prevalidated data and management paths. |
| Recovery routes were assembled by hand | The registry fallback needed a second Engine and a read-only ingress policy. Stats and HQ needed a VM, credential handling, SSH tunnels and Caddy validation. Initial tunnel supervision failed because the service user could not traverse the key and log directories. |
| HTTP 200 hid incomplete recovery | The first Discover probe served its bundled marker page because the artifact binding was absent. Probing the real homepage, search index and browse catalog caught the missing dependency. Stats snapshot reads likewise did not prove fresh telemetry or successful ingest. |
| Recovery configuration and retention were fragile | Normal ingress rendering deletes temporary routes. Lisa supervises the tunnels, but the remote VM currently needs manual restart. Earlier rollback artifacts and build headroom had disappeared or shrunk. Reclaiming disk was necessary during the earlier capacity failure and did not clear the registration outage. |
| Telemetry loss was unmeasured | The documented agent queue holds about four minutes at default settings. The outage lasted longer. The observed snapshot, host list and later HTTP status alone cannot establish how much telemetry was dropped or which agents recovered. |

The confirmed failure was the Engine's stateful request and registration
path missing deadlines. The earlier disk incident, later observations of
alarm pressure, and success on Threadripper inform the next experiments.
They do not establish one root cause for the entire outage.
