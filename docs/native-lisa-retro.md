# Lisa registry outage and native migration retro

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
`Caddyfile.recovery`. The recovery Caddyfile is installed at
`/etc/openorange/ingress/Caddyfile` and survives a container restart. The
normal `oo render` and `oo reload-ingress` commands regenerate it without
the recovery routes. Keep the recovery file in service until the original
Stuff app serves package reads and an authenticated coordinator read at
`172.29.80.21:8080`. Then run `oo reload-ingress`, repeat the public and
tailnet probes, and stop `oo-stuff-read-app` followed by
`oo-stuff-read-engine`.

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

A temporary dashboard route is staged privately. Through the tunnel from
Lisa, the snapshot app serves the timestamped dashboard and both
stateful APIs, and rejects unauthenticated reads with HTTP 401.
The production route still points to Lisa. Serving the snapshot at the
production URL requires a decision to accept temporarily stale reads.
Ingest and admin writes would continue to use the production origin.

## What slowed recovery

Engine liveness and OpenRC process state answered different questions from
the caller probes. The Engine reported healthy while storage refused runner
registrations. Stuff's process repeatedly started and then failed readiness.
The cause of the storage deadline failures still needs reproduction. Clearing
disk space alone did not restore the registry.

Stats had three conflicting signals. Its selected deployment, running
container and OpenRC state disagreed. An automatic restart could therefore
pick a different image from the one observed running. The physical backup
runbook assumes it can account for writers by service status and then
independently rejects remaining Docker writers. Manual recovery needs to
reconcile those views before taking a new fence.

The migration lacked a ready Alpine rehearsal and a recent verified logical
export. Building the rehearsal during the outage added time before the first
restore attempt. That attempt also exposed an existing requirement to disable
Stats self-observation during restore so a new namespace stays empty.
The [rehearsal record](native-lisa.md#rehearsal-progress) preserves the
working configuration and the scope of the proof. The historical restore
and Engine rollback checks passed on copied state.

## Follow-up

| Action | Completion check |
| --- | --- |
| Add application readiness to Engine and registry incident checks. | A working registry serves both Cargo sparse config and a known package index entry. Faulting Engine registration alerts even when Engine `/health` returns 200. |
| Give one operator control of shared changes during recovery. | The incident record shows who owns the change, the command and deadline, selected and running versions, and the verified rollback target. A competing operator sees the lock before attempting a restart. |
| Detect and reconcile stale OpenRC state during deployment and backup preflight. | A fixture with a live container, a stale `starting` entry and a different selected image fails before taking a fence or replacing a running release. |
| Maintain a recent verified Stats export and an Alpine restore environment. | A fresh export imports into an empty native namespace and verifies every table digest. Record the backup age and restore outcome before scheduling a cutover. |
| Rehearse a shared Engine failure with realistic registry and Stats traffic. | Exercise bounded graceful restart, runner registration and real app reads. Keep the last good depot and the recovery receipt available independently of Lisa. |
| Track volume use for the Engine, app data and build workload on Lisa. | Alert while enough space remains for both Engine startup and a fenced copy. Confirm the alert and recovery path without deleting application state. |
