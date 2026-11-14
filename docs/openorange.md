# Stats on OpenOrange

Stats runs on OpenOrange on `lisa`, reachable only from the tailnet at
`https://stats.17166969.xyz` (a DNS-only A record to `lisa`'s Tailscale
address). The shared host stack (Rivet Engine, S3 store, Caddy ingress with
ACME DNS-01, whois identity sidecar, OpenRC units, backups) is defined in
`stuff/deploy/openorange/` and documented in `stuff/docs/openorange-runtime.md`.
This page covers what Stats owns.

## What runs

| Piece | Where |
| --- | --- |
| Image | `deploy/orange/Dockerfile`: Node 26.13.1 Debian (digest-pinned), the pinned `deploy/orange` closure (open-orange 1.0.2, rivetkit 3.1.2-rc.1), both Workers |
| Descriptors | `deploy/orange/generate.mts` derives `stats.jsonc` and `observe.jsonc` from the typed `cf/config` build output; Analytics SQL and the tail consumer are dropped with reasons |
| Durable state | `Installation` and one `ObservationStore` per service, as Rivet actors in namespace `stats-prod` |
| Access | The ingress asserts `Stats-Tailnet-Identity` with the per-app `GATEWAY_SECRET`; ingest and deploy markers keep their bearer tokens |

## Deploy

```sh
deploy/orange/build-image.sh lisa                # builds a committed tree on lisa, prints stats:<commit>
ssh lisa doas /opt/openorange/bin/install-app stats stats:<commit>
sh deploy/deployed-smoke.sh                      # from a tailnet device
```

`install-app` keeps the previous image for `oo set-image stats <ref>` rollback.
The actor schema migrates forward on start; rolling back an image across a
schema migration needs a restore.

## Back up and restore

The application export is the recovery contract; it does not depend on the
Engine's directories.

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
Orange writes. A fresh full Orange export was aborted after three minutes and
writes were reopened; a fresh logical full backup is not complete.

## Not carried over

- Cloudflare project collection (Analytics SQL) is skipped: project cost and
  traffic charts for `stuff`, `usr-memories`, `nanoshop-storied`, `discover`
  and `discover-preview` stop at the cutover. Their project probes ran inside
  the same collector and stopped too.
- The old Cloudflare tail consumer references were removed before the Workers
  were deleted. Cloudflare tail events are not collected on OpenOrange.
- OpenOrange tails report zero CPU and no diagnostics, so Stats' own operations
  arrive as application events with wall-clock durations, not platform CPU.

The authenticated `/api/v1/capabilities` endpoint reports provider collection and tail events unavailable on OpenOrange. Imported project history remains readable; the collector status does not describe that retained data as live.
