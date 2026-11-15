# Validate or roll back the hardening release

Run these commands from the Stats checkout with its pinned Node and pnpm.
The deployed application is `stats:6cc06db247a3`, Orange node version 24.
The compatible rollback image is `stats:03d3d4f1fcb8`, node version 23.

## Verify the deployed application

1. Read the selected image and shared health:

   ```sh
   ssh josh@lisa 'doas -n /opt/openorange/bin/oo deployment stats'
   ssh josh@lisa 'doas -n /opt/openorange/bin/health --json'
   ```

2. Open `https://stats.17166969.xyz/#/project/stats` from an authorized tailnet client.
3. Load 1h, 6h and 24h, allowing each initial request to finish.
4. Switch among those completed windows. Confirm charts update without another summary request.
5. Click Refresh. Confirm a fresh summary request completes.
6. Inspect that response's `Server-Timing` fields. Compare `app-dispatch`, `app-store`, `app-query` and `app-read` from the same response. They overlap; do not add them.
7. Open Requests and inspect the corresponding `http.get.application-summary` event. Confirm integer microsecond work fields are present.
8. Inspect delivery metadata after a request burst. Allow roughly one second before expecting newly captured HTTP events. Browser transport's HTTP 202 means admission, not durable ingestion.

The latest paced verification observes all 200 browser journeys becoming
queryable within 1.52 seconds, with no browser or producer drops. A separate
burst stores 908 of 1,005 journeys and reports the other 97 as browser transport
drops; producer drops are zero. These checks do not establish lossless delivery
under an outage or sustained overload. See the
[delivery evidence](../bench/results/2026-11-15-producer-boundaries/README.md).

## Repeat targeted verification locally

Use disposable state under `.work/tmp`:

```sh
make orange-test
pnpm --dir cloudflare test:observe
node --test cloudflare/test/producer/producer.test.ts \
  cloudflare/test/observe/application-buffered.test.ts
pnpm --dir cloudflare exec playwright test test/ui/range-refresh.spec.ts \
  test/ui/platform.spec.ts
```

Run `make check` for the complete release gate. The commands above are the
targeted checks for this release. `make orange-dev` starts an isolated Orange
development session. `make dev` retains Miniflare.

## Deploy another verified application revision

Commit and push the verified application changes, then run:

```sh
sh deploy/orange/deploy.sh josh@lisa
```

The script builds an AMD64 image, verifies its descriptors and readable assets,
selects it conditionally, restarts Stats and checks production behavior.
It restores the prior image if deployment health fails. It does not upgrade
the Engine or change its persistence.

## Roll back this application release

Confirm no later operator has selected another image before running:

```sh
ssh josh@lisa 'doas -n /opt/openorange/bin/oo set-image stats stats:03d3d4f1fcb8 --if-current stats:6cc06db247a3'
ssh josh@lisa 'doas -n /sbin/rc-service oo-app.stats restart'
ssh josh@lisa 'doas -n /opt/openorange/bin/oo wait app stats 120'
ssh josh@lisa 'doas -n /opt/openorange/bin/health --json'
```

Stop if conditional selection fails. Inspect the concurrent deployment instead
of overriding it. Verify HTTPS and the dashboard after the health check.
There is no canonical-data migration to reverse. This rollback retains stored
events, both derived tables and their mutation triggers while selecting the
compact-projection query. The rollback reader excludes both derived tables
from logical snapshots. Do not drop derived tables, triggers or the old payload
index during rollback. Earlier readers do not exclude rollups from snapshots
and are unsuitable rollback targets after rollup creation.
The protected pre-projection logical backup contains 16 tables and 228,029 rows,
including 52,393 canonical events. Read and write comparisons, exact native
restore checks and the unresolved private Engine reopening failure are recorded
with the [projection evidence](../bench/results/2026-11-15-compact-projection/README.md).

## Resume deferred infrastructure work

Resume STUF-75 when S3 backups return to scope. Preserve Engine logs and object
state in the same fenced recovery artifact. Rehearse a restore before relying
on the destination. Record the independent off-host fence and elapsed restore
stages separately from backup downtime.

Before a storage or Engine migration, prepare verified backups, an isolated
successful rehearsal, consistency checks and an executable rollback path.
Current application deployment authorization does not supply those proofs.
The [audit reference](runtime-hardening.md) identifies remaining native parity
and instrumentation gaps.
