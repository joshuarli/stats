# Lisa operational recovery plan

Use the [incident retrospective](#lisa-openorange-outage-retrospective) for the evidence,
the timeline, and the current temporary routes. This plan closes the
incident and makes the next recovery executable. The owning repositories
below indicate proposed responsibility. At incident handoff, name the
operator and reviewer for each work item.

## Execution record

### Current writer backup

The active Threadripper Engine was stopped cleanly at 04:00:12 UTC on
November 18, 2026, after an online pre-copy. The checksum copy completed
and the Engine restarted at 04:00:19 UTC. Each expected host subsequently
reported again. The source file digests and compressed archive digest
verified after transfer. The isolated Threadripper Alpine guest reopened
all 2,210 depot files with the pinned native musl Engine and read recent
receipts for all five hosts.

The protected off-host copy is
`~/backups/openorange/stats/threadripper-20261118T035957Z/` on the
workstation. It contains the physical depot and protected configuration,
an independently verified logical export of 853,605 rows in 223 tables
across 14 objects, and the authenticated listing of the empty
`stats-exports` bucket. After the serial export, all 14 source objects
explicitly reported `open`. A fresh namespace on the isolated Alpine
guest imported all 853,605 rows. It served recent receipts for all five
real hosts and passed a new canary ingest, history read, and duplicate
replay. Keep the archive owner-only.

To capture another point while this standby is authoritative, run
`deploy/orange/recovery/capture-standby.sh NAME` from the workstation with
`STANDBY_SSH_CONFIG`, `STATS_ROLLOUT`, `STATS_CHECK_CREDENTIAL_FILE` and
`STATSCTL` set. It runs `capture-engine.sh` on the guest under the shared
rollout lease (operation `engine-capture`, 900 s bound), so a capture cannot
overlap a rollout or another leased mutation. The guest script records which
of `native-stats`, `stats-infra-collector` and the Engine are running in
`/var/lib/live-stats/.capture-intent`, stops the app and collector before the
Engine, copies the depot only while both are stopped (300 s bound), starts the
Engine, waits for its health route, and starts only the services that were
running. The writer is down for the whole copy. Do not copy the depot while
the Engine runs: on 2026-11-22 a warm copy made the app lose its Engine
registration ([record](../bench/results/2026-11-22-engine-capture/README.md)). The sealed directory `/var/lib/live-stats-recovery/NAME` holds the
depot, `depot.sha256`, the image identity, `engine.json` and timestamps.

After any failure or interruption the driver runs `capture-engine.sh recover`
under a new lease (`engine-capture-recover`), which restores the recorded
intent; a capture refuses to start while an intent is left over. The driver
then requires the functional check (synthetic ingest with readback) within
120 s and writes `~/.local/state/openorange/captures/NAME.json`, whose
`outcome` is `captured` only when the copy completed, the services are back
and the check passed. Exit codes: 0 captured, 1 failed, 4 lease held with
nothing changed. Copy the sealed depot and protected runtime configuration
off-host, verify `depot.sha256`, and validate it by starting an isolated
Engine on it before relying on it; logical export remains separate from a
physical capture. Ingress and writer-handoff operations are outside the
guest lease.

### Incident changes

On November 18, 2026, the Stats writer moved to Threadripper. All five
expected online hosts delivered new telemetry across two reporting
intervals. The [failover record](#live-stats-failover)
identifies the protected source capture, current authority, and failback
requirements. The readback establishes the missing sample interval for
each host. Acknowledged-sample reconciliation remains open.

Lisa's existing direct Stats producer address, `172.29.80.20:8080`, now
relays signed application-event POSTs to the active writer. The Caddy
relay runs on the internal OpenOrange network. It uses a private Unix
socket to the standby tunnel, strips gateway and identity headers,
and rejects dashboard paths and other methods. A real Agentctl canary
and a Stats platform collector canary both passed signed ingestion and
persisted readback. The platform collector's existing verifier was
checked against the source configuration before it was attached to
the active writer. The relay and its tunnel are enabled in OpenRC.

For failback, include the direct producer path in the admission fence.
Stop `oo-stats-direct-proxy` and `oo-stats-direct-tunnel` before activating
a new authority or releasing `172.29.80.20` to a local app. Verify each
producer against the new authority before reopening that path. The relay
run files are in `deploy/orange/recovery/`. Its image is the pinned
binary used by Lisa's ingress. The host trust, key, and socket paths
refer to this specific standby.

The first delivery for detection is `statsctl check hosts`, which fails
for stale receipts even when the dashboard returns HTTP 200. Lisa's
OpenOrange check now uses the authenticated application readiness probe
and records structured upstream error codes. A synthetic HTTP 400
carrying `depot.request_deadline_exceeded` fails the check. Alert
delivery and the common incident view remain open. The Stats HTTP
adapter now maps the known installation storage deadline to
`503 storage_unavailable` with `Retry-After` on the data API, ingest and the
deploy marker route. The regression exercises the hosts API and the marker
route and verifies that genuine request errors still return
HTTP 400. The fix is staged in source for the next application rollout.

Run the external capability probe from a tailnet host with the same
access as the operator.

```sh
node deploy/orange/recovery/check-capabilities.mts lisa,threadripper,sentry,tim,m1-max
```

It reads Stats receipts and Agentctl hosts, verifies a Cargo download
against its sparse-index checksum, and fetches the published Discover
search index. The JSON report marks a dated Discover snapshot as
degraded even when the index loads. Exit 4 signals an unavailable
capability, and exit 7 signals degraded reads. The first live invocation
returned 7 for the HQ snapshot. Connect the report to an independent
scheduler and alert destination for the two-minute detection drill.

The first delivery for degraded recovery is the OpenOrange recovery route
configuration. A regular render and reload preserved Stats, Stuff and
Discover and left Agentctl's stateful endpoint available. The same Stats
writer entry now prevents local start and image selection. This proves
the render and authority guard on Lisa. The live Stats standby is in
Threadripper's default OpenRC runlevel. A spare disk exercised the VM
launch path. The standby reboot passed on 2026-11-20 (see the
[standby operations record](openorange.md#standby-operations-record-2026-11-20)).
Reader startup, image retention, publication and operator recovery, the shared maintenance
lock, full verified backups, disk reserves, and the Engine failure
mechanism remain open.

Stats deploy preflight now reads writer authority and checks the OpenRC
service, selected image ID and persisted node version. Simulated stale
startup, missing image, changed tag, node version drift and standby
ownership all stopped before building or changing image selection.
Release retention and the shared maintenance lock are separate items.

Logical export can resume from an interrupted archive while the source
remains fenced. The CLI keeps atomic page checkpoints, checks each
object against a fresh manifest, and reuses verified progress from a
separate output directory. The regression rejects a changed manifest
and a corrupt prefix and verifies that an interrupted append does not
enter the published archive. Parallel export failed against the isolated
copy captured at 01:24 UTC on November 18, 2026.
Serial export verified 842,207 rows in 223 tables across all 14 objects,
and explicit readback confirmed all objects reopened. The owner-only
archive is
`~/backups/openorange/stats/lisa-engine-copy-20261118T012407Z-serial-rehearsal`.
Those 14 objects also imported into a fresh loopback OpenOrange runtime.
Authenticated history was present for all five real hosts. A test host
enrolled there, sent one sample, read it back and verified replay
deduplication.
Batch reopening now attempts every object and lists any unconfirmed
state with its error code. The current-writer archive is recorded above.
Scheduled backups and the final Lisa restoration rehearsal remain open.

The HQ guest's backing chain now has durable paths outside scratch and
an enabled OpenRC boot entry. Both boot entries adopted their running
guests without interruption. Actual reboot and subsequent reader
verification remain unproven.

The sealed Lisa Engine recovery copy occupies 2,416,820 KiB. Lisa had
157,758,732 KiB free and Threadripper had 103,690,268 KiB free during the
recovery. Threadripper's active standalone VM disk occupied 13,960,400
KiB. Use these figures to size the first spare-host capacity drill.
The reserve must also account for runtime image layers, independent
bucket copies, a complete restore, and retained backup generations.

The known-good Stats release and matching Engine image are archived
off Lisa in `~/backups/openorange/stats/20261118-recovery-images/`.
`SHA256SUMS` seals the compressed archive and source inventory. All
31 content-addressed blobs and both recorded image IDs were checked
locally.
On November 18, 2026, the archive loaded into an empty Docker 29.9.3
daemon in the HQ recovery guest. The daemon ran in a private network
namespace and used a separate socket and image store. Both AMD64 image
IDs matched `images.txt`. The isolated daemon stopped and its temporary
image store was removed. The previously selected image
`stats:6cc06db247a3` remains unavailable on Lisa.
To repeat the offline drill, run `docker image load` against an empty
Docker store with networking disabled. Use the verified
`stats-engine.tar.gz` as input and compare both image IDs with
`images.txt`.

### Recheck live routes and capacity

The November 18 tailnet probe found fresh receipts for all five Stats
hosts, a checksum-matching Cargo download, and two Agentctl host records.
Discover served a 323-document index from the dated HQ snapshot.
The authenticated Stuff Cargo coordinator read and Discover operator
status request both returned HTTP 502.
Lisa's primary Stuff and Discover units were stopped. Verify those private
routes against their authoritative state before exercising a publication
or a research operation.

The live Threadripper guest had 9,754,610 KiB free on its root filesystem.
Its Engine log and object tier occupied about 2.7 GiB together.
Threadripper's backing filesystem later had 54,748,328 KiB free at 97%
reported usage. Lisa had 126,972,264 KiB free after the first physical
recheck copy. Lisa's store reported 11.1 GB of allocated bucket data,
including 9.7 GB for Stuff and 1.35 GB for Discover. Budget for guest
filesystem space and backing filesystem growth separately. Check a full
capture, the failed or partial capture it may leave, and Engine startup
before setting a reserve or scheduling more generations. The HQ guest's
relative backing chain resolves under its
durable OpenRC directory to the same four image inodes as the running
guest. Reboot and startup under a reserved allocation still need a drill.

### Verify buffering before a writer handoff

The running Stats agents on Lisa, Threadripper, Sentry, Tim, and M1 Max
use configuration files with no queue or sampling overrides. They keep
16 samples at a 15-second sampling interval in memory. Account for
samples already pending when admission pauses, upload backoff after
reopening, and agent restarts when setting the fence budget.
A local OpenOrange drill confirmed that the Rust agent persisted a
sample it collected before reopening, after an upload received HTTP 503.
That drill used one agent and a short fence.

A loopback drill used the shipped platform bridge entry point and the
Agentctl Orange sender from revision `8b2d4316c345`. The test receiver
answered HTTP 503 with `Retry-After: 60` while fenced, matching the
Stats maintenance response. Agentctl attempted three deliveries and
the bridge attempted two. Both dropped their event
after the last refusal, and their queues drained. After reopening,
the receiver accepted one new event from each producer and received
zero replays of the dropped events. The bridge's OTLP endpoint had
returned HTTP 200 for the span whose Stats delivery later failed.

To reproduce the drill, point both senders at a loopback Stats
application-event endpoint using synthetic credentials. Return the
fenced response until both senders report one drop, then return the normal
accepted-event acknowledgement. Record a new event through each sender
and compare the event identities that reach the receiver. This drill
exercised the senders without pausing live ingestion.

The production drill needs a transfer of the state acknowledged before
the fence and a retention path for events generated during the fence.
Verify both through persisted readback on the receiver. Keep Threadripper
as writer until the handoff and reverse transfer pass for host reports
and both direct producer paths.

## Restore live service

1. **Reconcile Stats and prove fresh ingest.** The Stats operator opens one
   incident record with the selected release, running release, deployment
   generation, active ingress route, and expected host roster. Keep the
   snapshot available until the live backend passes authenticated reads and
   accepts an actual host report. Record the last accepted sample before
   the outage and the first accepted sample after recovery for each host.
   Use the deployment inventory plus enrolled hosts from the installation.
   Ask the owner to classify intentionally offline hosts.
2. **Use a bounded recovery ladder.** The OpenOrange operator checks actual
   API requests and runner inventory. Restart the selected, available
   image once if the shared Engine can register it. If the same storage
   failure recurs, keep the fallback and switch to the verified standby
   recovery path. A deploy rebuilds software and updates agents. It
   cannot repair Engine storage or recover telemetry already lost to
   queue overflow.
3. **Move writer authority through a fence.** If Lisa stays unhealthy,
   verify a fresh recovery point and the matching runtime on a standby.
   Pause admission at ingress, quiesce the original writers and confirm
   the absence of a second writer before activating the replacement.
   Preserve the last acknowledged state and verify the version, schema,
   and credentials before reopening. Record the exact authoritative
   endpoint. Once it accepts writes, a return to Lisa requires fencing
   and transferring its newer data. Merely restoring Caddy would fork
   history.
4. **Verify each restored capability.** Confirm newer persisted telemetry
   for every expected online Stats host over two reporting intervals,
   with ingest acknowledgements and history read through the same
   authority. Verify an authenticated Stuff coordinator read and a
   controlled publication against an approved canary target. Verify the
   Discover operator read and authorized research operation. Verify
   Agentctl's stateful hosts API and its expected uplink status. Leave
   any missing capability open and record the loss interval.
5. **Remove fallbacks individually.** Follow the route-specific rollback
   notes. Probe adjacent apps after every reload and confirm the remaining
   fallbacks still work. Keep the depot, backups and incident receipts
   until the owner confirms recovery and data reconciliation.

## Ship the fixes in order

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
| 8. Rehearse failover, then resume native cutover | OpenOrange with all app owners. Rehearse failover and reverse transfer with real state and isolated receivers. Capture recovery time and loss by dataset. Then return to the [native deployment gates](native-lisa.md). | Complete a clean drill from an unavailable primary through protected snapshot restoration, read-only service, verified writes under a single authority, and reverse transfer. Propose a 60-minute live recovery target for the first drill. Preserve actual timings and gaps. The native drill still requires the fresh verified export, rollback proof and soak. |

## Close the incident

- Publish per-app verification with probe time, release identity, active
  authority, data freshness and any intentionally offline hosts.
- Record the outage window per Stats host and reconcile acknowledged
  samples against available history. Keep gaps visible where recovery
  cannot restore the missing samples.
- Retire the temporary routes, credentials and VM after the restored
  services pass their checks and the recovery artifacts are archived.
- Convert the proposed targets to agreed budgets and run a second drill
  with a different operator. Track any unproven checks as open work.

## Lisa OpenOrange outage retrospective

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
Discover's stateful private operations. The [operational recovery plan](#lisa-operational-recovery-plan)
defines the ownership, dependencies and evidence for closing those gaps.

The November 17 maintenance session began with Stuff already unavailable.
Cargo's sparse mirror returned HTTP 502, and Stats' backup object listing
returned HTTP 503. The shared Rivet Engine answered HTTP 200 on `/health`
while its stateful application paths failed.

### Timeline

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

### Public read recovery

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

### Stats dashboard recovery

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

### Live Stats failover

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

#### Host history reconciliation

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

### HQ public reader recovery

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

The HQ reader uses the original diagnostic guest. Its four backing
files and seed ISO are preserved under Threadripper's
`/home/josh/.local/share/stats-live-recovery/20261118/hq-reader/`.
The new paths are hard links to the open files, and the relative
backing chain resolves there. OpenRC service `hq-recovery-vm`
adopted that QEMU process and is enabled for boot. Docker and the
copied Engine are configured to start inside the guest. Lisa
supervises the separate SSH tunnels for HQ and the active Stats writer.
Both live VMs stayed up while the runlevel entries were installed.

### Why recovery took hours

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
| Release and supervisor state disagreed | Stats was selected at version 26 while version 25 ran and OpenRC said `starting`. The selected rollback image was absent locally. The first ordered restart aborted at preflight. Reconciliation required an explicit choice of available image and another service transition. The [deployment investigation](DEPLOYMENT-STALL-INVESTIGATION.md) records STA-129, now closed as superseded. |
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
