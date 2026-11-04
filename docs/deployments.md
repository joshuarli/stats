# Cloudflare deployment tracking

This is an opt-in, read-only addition to the Cloudflare project dashboard. It is
implemented but has **not been deployed or verified against production**.

## Enable and verify

1. Run `make cloudflare-test`, `make lint`, `make worker-check`, and
   `make dashboard-test` using the repository's pinned Node/pnpm toolchain.
   The deployment panel changes project-page screenshots: inspect and regenerate
   the affected Playwright goldens deliberately, not blindly. Replay fixtures
   do not yet contain deployment history; a missing fixture is not production
   evidence. Host chart events should remain unchanged.
2. Provide two Worker secrets through the existing `SECRETS_FILE` deployment
   flow documented in `operations.md`: `DEPLOYMENTS_ACCOUNT_ID` (the 32-character
   account id) and `DEPLOYMENTS_API_TOKEN` (an account-scoped token with Workers
   Metadata Read-Only, or another accepted **read-only** permission). Do not put
   the token in source, frontend configuration, shell arguments or logs. No
   credentials, permissions, infrastructure, or deployment were changed by this
   implementation. With neither secret configured, polling makes no API calls;
   a partially configured pair reports a configuration failure.
3. Deploy normally when ready. The existing five-minute cron polls each
   configured Worker, including `stuff`, `usr-memories`, and `stats`. Check
   `GET /api/v1/projects/:id/deployments` behind Access. Confirm successful sync,
   the deployment timestamp, immutable deployment id, version ids and traffic
   allocations against Cloudflare's deployment list. Verify version tags/messages
   when available; version enrichment is best effort and permission-dependent.
4. Make a normal deploy and a rollback. Both must produce separate timeline
   events even when the rollback reuses an old version. Confirm markers on the
   project's charts, then select an event in the Deployments panel. The before/after
   windows follow the dashboard time range: one hour, six hours or 24 hours
   each, and 24 hours for the 7 day and 30 day ranges because five-minute
   metrics are kept for seven days.
5. Allow collection to establish the baseline and post-deploy window. A one-hour
   comparison is not ready until the full hour, one complete five-minute warm-up
   bucket, any partial deployment bucket, and the existing 45-minute analytics
   settlement delay have passed. Verify the numbers with the existing fixed
   analytics queries. Test a failed token, sparse traffic and a split deployment:
   none may turn missing data into an improvement or stop ordinary metrics.

Standalone checks (no installed SDK or database package required):

```sh
cd cloudflare
node --experimental-strip-types --test test/deployments/*.test.mjs
pnpm run typecheck:deployments
```

The standalone tests use Node's built-in SQLite, fixture HTTP responses and pure
TypeScript. They are included in `pnpm test`; focused typechecking is included in
`pnpm typecheck`. Workers-runtime API tests are in `test/deployments-api.test.ts`.

## Collection and storage

The collector uses only GETs to the fixed `api.cloudflare.com` origin. It does
not deploy, roll back, create releases or change bindings. Redirects are rejected,
responses are capped at 512 KiB and each project's entire poll has a 20-second
deadline. Two projects run concurrently. A poll reads up to three pages of 100
deployments in the trailing 30 days, with an upper timestamp bound to reduce
pagination races. An exhausted budget or non-advancing pagination marks history
truncated and withholds comparisons. The API may expose less historical data;
backfill is bounded best effort, not an audit-log completeness guarantee.

Up to four previously unseen version metadata records are enriched per project
per poll. Only ids, tags and messages are retained, not version resources,
bindings, author emails, API bodies or credentials. Tags are displayed as tags;
a Git SHA is only available when the deployment process supplies it, and is not
inferred from arbitrary message text. Failed enrichment does not drop the
valid deployment timeline. Failed polls preserve the last successful history
and surface a fixed error code. Ordinary telemetry and deployment polling are
independent; a failure in one does not suppress execution of the other.

`src/deployments/installation.ts` extends the existing Installation class and is
exported under the same `Installation` name in `src/index.ts`. The binding,
Durable Object namespace and fixed `installation` object id are unchanged. The
host implementation is not replaced. Additive
`CREATE TABLE IF NOT EXISTS` initialization adds four tables to the same SQLite
database without changing existing host schema versions:

- `project_deployments`: deduplicated by project, Worker and deployment id;
  30-day retention and at most 1,000 events per project/Worker.
- `project_deployment_versions`: bounded version enrichment cache, 30 days and
  at most 2,000 entries per project/Worker.
- `project_deployment_sync`: attempt/success timestamps, error and truncation.
- `project_deployment_coverage`: merged intervals proving that the metrics
  collector successfully re-read buckets after their settlement deadline. The
  intervals retain gaps across outages and expire with seven-day fine history.

Unchanged deployment/version records are not rewritten; sync advances once per
poll. Coverage merges adjacent intervals instead of writing a row per metric or
bucket. It adds a small amount of storage work to successful metric runs, even
when API polling is disabled, so enabling tracking later can use those baselines.
Failures to record coverage are logged without failing the metrics run. The
existing alarm handles expiry, including when deployment polling is disabled.
Worker names are part of the storage key so a project rename cannot merge old and
new deployment identities.

## API and interpretation

Both routes use the existing Access boundary and no-store responses:

```text
GET /api/v1/projects/:id/deployments
GET /api/v1/projects/:id/deployments/:deploymentId/comparison?window=1h|6h|24h
```

The history response includes `enabled`, `sync`, `deployments` and `versions`.
Comparison responses include exact half-open before/after bounds, readiness time,
invocation counts (null when unavailable), blocking reasons, warnings and metric
values/deltas. Read-only routes reject writes and invalid/duplicate parameters.
Chart annotations use the existing event mechanism. Lines closer than three
pixels merge into one counted marker, and a label is drawn only where it fits
before the next line, so a wide range shows bare lines (hover lists the
deployments under them) instead of overprinted text.

The deployments list is a rail beside the project page. Choosing a deployment
there, or its marker on a chart, selects it and zooms every chart to its
rollout: from the deployment until the next one replaced it (until now for the
newest), padded on both sides by a quarter of that span, between ten minutes
and six hours. The project's history is then fetched for exactly that window, so
a rollout gets the finest buckets the retention still holds (five-minute buckets
for a rollout within the last seven days, hourly rows before that). If the
rollout starts before the selected range, the range widens to the smallest
standard one that reaches it, so panning stays inside it; it never narrows.
A `deployment` link zooms on load; a plain page
load does not. Requests are cancelled on project/selection changes, and panel
loading/errors do not block the other project charts.

Comparisons use five-minute additive data, never downsampled chart values, average
of averages, approximate maxima or manufactured percentiles. The deployment's
mixed bucket and one whole warm-up bucket are excluded. Windows must fit within
seven-day fine retention and have recorded settled coverage. Within covered
windows an absent analytics counter bucket is an idle bucket and counts as zero,
the same rule the history API uses; probe buckets are never zero-filled because
probes are not re-collected. Coverage starts with this implementation: **backfilled deployment
events do not retroactively certify old metrics**. Some historical comparisons
will remain unavailable even though charts contain numeric samples.

A known stable single-version baseline is required. Split traffic, overlapping
releases, a stale/truncated deployment history, material observed top-route mix
changes, missing probe buckets and fewer than 100 Worker invocations suppress
verdicts.
Worker error-rate signals require 1,000 invocations on each side. Deferred Durable
Object updates in either deployment suppress DO/cost attribution. Major traffic
volume changes are warned about; stable top-route observations cannot prove the
complete workload stayed stable because upstream route collection is truncated.

Metrics: Worker CPU/invocation and 5xx share; DO CPU/wall time per invocation;
D1 rows read/written per Worker invocation; per-bucket R2 operations per Worker
invocation; configured edge probe response times and failure shares; estimated
list-price cost per 1,000 invocations using the dashboard's existing price table.
D1 and R2 ratios include background work and other resource clients. Probe times
are not user-request latency. Cost is not a bill: allowances, R2, storage and DO
duration remain excluded just as in the existing cost widget.

Signals are deliberately **heuristic, not statistically significant or causal**:
a 10% relative change plus a metric-specific absolute floor is required; absolute
floors handle a zero baseline without infinity. Error/probe shares show
percentage-point deltas. There is no per-version telemetry attribution, p95/p99,
alert routing, automatic rollback, or storage/config-change audit trail. Those
are separate work, not implied by the new release timeline.

## Verification record

Local: standalone fixture/SQLite tests and strict standalone TypeScript checking.
The editing sandbox has Node 22, not the project's pinned Node 26, and cannot
install the pinned Workers/Solid tooling. Full Workers runtime, lint, built UI,
Playwright goldens, live permissions, API pagination/enrichment and production
comparisons are **unverified**. No production deploy or Cloudflare writes were run.

Primary API references:

- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
- https://developers.cloudflare.com/workers/versions-and-deployments/
