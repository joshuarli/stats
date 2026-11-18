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

## Project telemetry

The default Projects view lists registered services and reads their native
deployment markers and application events. Overview shows operation counts;
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
table definitions, resumes from recorded progress, and re-verifies every table
before the object reopens. Backups contain token verifiers: keep them
owner-only and off shared storage. `make orange-test` proves the round trip
into a fresh namespace.

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
