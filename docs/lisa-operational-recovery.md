# Lisa operational recovery plan

Use the [incident retrospective](native-lisa-retro.md) for the evidence,
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
`deploy/orange/recovery/capture-engine.sh live-stats-engine
/var/lib/live-stats /var/lib/live-stats-recovery/<new-directory>`
inside the active guest. It takes a per-depot capture lock, bounds the
stopped copy to 55 seconds, and restarts the same Engine after a copy
failure or interruption. Verify fresh host receipts before joining a
second operation. Copy the sealed depot and protected runtime
configuration off-host, verify hashes, and export logically from an
isolated restore. The per-depot lock covers this capture command.
Engine, deploy, and ingress operations still need a shared lock.

### Incident changes

On November 18, 2026, the Stats writer moved to Threadripper. All five
expected online hosts delivered new telemetry across two reporting
intervals. The [failover record](native-lisa-retro.md#live-stats-failover)
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
delivery, the common incident view, and the HTTP status exposed to the
dashboard remain open.

The first delivery for degraded recovery is the OpenOrange recovery route
configuration. A regular render and reload preserved Stats, Stuff and
Discover and left Agentctl's stateful endpoint available. The same Stats
writer entry now prevents local start and image selection. This proves
the render and authority guard on Lisa. The live Stats standby is in
Threadripper's default OpenRC runlevel. A spare disk exercised the VM
launch path. An end-to-end standby reboot, reader startup, image
retention, publication and operator recovery, the shared maintenance
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
locally. For the offline supply-chain drill, load that archive on a
spare Docker host and compare its image IDs with `images.txt`.
The previously selected image `stats:6cc06db247a3` remains unavailable
on Lisa.

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
