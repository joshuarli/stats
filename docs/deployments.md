# Deployment tracking

Service markers work on OpenOrange and Node. Project deployment polling below
belongs to the retained Cloudflare adapter; it is not enabled by the default
OpenOrange deployment. Imported project deployments remain historical data.
Use [service operations](operations.md#services-and-deploy-markers) for current
application deployment markers.

The default native Projects dashboard uses registered services, application
events and these service markers. Successful OpenOrange activations are
recorded by the shared host helper after health checks, including healthy
rollbacks. Marker identity includes the selected node version, so returning to
an earlier release records a separate deployment. Request status and elapsed
work are available independently of Cloudflare analytics and billing.

Project and service list responses carry optional `latestDeployment` summaries.
They distinguish an available latest item, no retained deployment and unavailable
data. Overview rows use those summaries; detail and comparison views use full
histories. The readers select only the latest item's referenced metadata and
keep the list usable when an individual summary fails.

Cloudflare project tracking is opt-in and read-only. Its historical production
validation is in the [verification record](#verification-record).

## Enable and verify Cloudflare polling

These steps apply to a Cloudflare installation. The default Make deployment
targets install OpenOrange. See the
[provider deployment reference](operations.md#cloudflare-adapter-deployment-reference)
before configuring a separate Cloudflare installation.

1. Run `make cloudflare-test`, `make lint`, `make worker-check`, and
   `make dashboard-test` using the repository's pinned Node/pnpm toolchain.
   Inspect affected Playwright goldens before accepting screenshot changes.
2. Configure two Worker secrets: `DEPLOYMENTS_ACCOUNT_ID` (the 32-character
   account id) and `DEPLOYMENTS_API_TOKEN` (an account-scoped token with Workers
   Metadata Read-Only, or another accepted **read-only** permission). Do not put
   the token in source, frontend configuration, shell arguments or logs.
   The scheduled handler enables polling only with a valid account id and a
   nonempty token without line breaks. Otherwise it skips provider polling.
3. Deploy the Cloudflare adapter. Its five-minute cron polls each
   configured Worker, including `stuff`, `usr-memories`, and `stats`. Check
   `GET /api/v1/projects/:id/deployments` behind the tailnet gateway. Confirm successful sync,
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
node --experimental-strip-types --test test/deployments/*.test.ts
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
and surface a fixed error code. A project whose Worker the account does not
have (the deployments list answers 404) records `not_deployed` without
reporting a caught error, so a configured but undeployed project shows in
health as `sync_error: not_deployed` and does not mark scheduled runs failed. Ordinary telemetry and deployment polling are
independent; a failure in one does not suppress execution of the other.

The deployment routes, polls, and retention live in `src/core/installation/`
with the host logic. `src/cloudflare/installation.ts` is the Durable Object that builds its
ports and is exported under the `Installation` name in `src/cloudflare/index.ts`. The binding,
Durable Object namespace and fixed `installation` object id are unchanged. Additive
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

Both routes use the target's identity boundary and no-store responses:

```text
GET /api/v1/projects/:id/deployments
GET /api/v1/projects/:id/deployments/:deploymentId/comparison?window=1h|6h|24h
```

The history response includes `enabled`, `sync`, `deployments` and `versions`.
Comparison responses include exact half-open before/after bounds, readiness time,
invocation counts (null when unavailable), blocking reasons, warnings and metric
values/deltas, plus four fields that make a response self-describing:

- `spec`: the exact comparison inputs, namely both sides' deployment id, version
  ids and bounds, an optional operation scope, and the measurement identity
  (measurement revision, observe filter revision, pricing revision). A verdict
  is only comparable with another produced from the same `spec`.
- `reasonCodes`: a closed set of codes, one for each entry in `reasons`.
- `deferredObjects`: true when either deployment deferred Durable Object code
  updates, which suppresses Durable Object and cost attribution.
- `analyticsInvocations`: the per-bucket analytics `worker.invocations` that the
  Worker-level metrics used, for each side. `statsctl verify` reconciles them
  against the invocations the `stats-observe` tail counted (the coverage rule in
  [Architecture](architecture.md#operations-and-coverage)).

Read-only routes reject writes and invalid/duplicate parameters.

The comparison route stays descriptive: it ranks Worker-level metrics and says
why they are or are not trustworthy, but it never decides acceptance. The
operation-scoped comparison in `src/compare/` divides CPU, wall time and SQLite
rows and statements by one operation's own work unit (for example, per persisted
sample for `host.ingest`) from the `stats-observe` operation tables, and applies
guardrails for failed share, ingest persistence and coverage. `statsctl verify`
runs it against a committed policy and is the acceptance gate. Its exit code and
verdict, not this route's metrics, decide whether a candidate is accepted
(`statsctl help verify`).
The project-wide gates cannot decide a `stats` deployment. Its top-route mix
moves more than 20 points between hours, which suppresses the verdict, and its
5xx share needs 1,000 invocations while `stats` serves a few hundred an hour. So
`statsctl verify` judges an operation-scoped metric instead:

- **Metric.** The sum of CPU, wall time, SQLite rows read or written, or
  statements over the operation buckets that match the policy's operation and
  workload class, divided by that operation's work
  unit. The work unit is persisted samples for `host.ingest`, requests within one
  workload class for `host.history` and `project.history`, and successful runs for
  `collector.record`.
- **Not blocked** by the route-mix check or the 100-invocation floor. **Blocked**
  by an unsettled window, an unstable baseline, an overlapping deployment, a split
  or deferred rollout, a coverage state other than `reconciled`, and a move of
  more than 2x in work units per operation or of more than 20 points in the
  share of the operation's workload classes.
- **Minimums.** Each side needs at least 100 operations. A material change is at
  least 10% and at least the metric's floor.
- **Guardrails.** The fast safety check passes. Failed operations do not appear
  if the before window had none, and otherwise the failed share rises by no more
  than 1 point. No observe issue group has the candidate as its first version.
  The probe failure share does not rise. Coverage stays `reconciled`. For ingest,
  persisted plus duplicate over received does not fall by more than 1 point. A
  guardrail without evidence never passes.
- **Precedence.** `regressed`, then `confounded`, `insufficient-data`, `pending`,
  and `improved` or `unchanged`.

Windows are time-bounded, so a rolled-back version inherits nothing from its
earlier deployment. The observe store's `rolloutImpact`, which scans the whole
retention window by version, stays exploratory and never feeds the gate.

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
the same rule the history API uses. Probe buckets are never zero-filled, because
probes are not re-collected: a probe's response time and failure share are means
over the samples present, and a window with fewer than three quarters of its
probe samples has none. A missing sample means the collector run failed, not the
probe, since a probe that cannot be reached is recorded as down. Coverage starts with this implementation: **backfilled deployment
events do not retroactively certify old metrics**. Some historical comparisons
will remain unavailable even though charts contain numeric samples.

A known stable single-version baseline is required. Split traffic, overlapping
releases, a stale/truncated deployment history, material observed top-route mix
changes, too few probe samples and fewer than 100 Worker invocations suppress
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

Production, as of 2026-11-05: tracking is enabled, `sync` is healthy and not
truncated, and `stats` has recorded 46 deployments since 2026-11-01. Comparisons
for those deployments were read from production through `statsctl` on
2026-11-04 and 2026-11-05 using read-only requests; no Cloudflare writes were
made to produce them.

Local: the repository's pinned Node 26 and pnpm run the standalone fixture and
SQLite tests, the Workers runtime suite, lint, the built UI and the Playwright
goldens through `make cloudflare-test`, `make lint` and `make dashboard-test`.

Not established by this record: how a rollback appears on the timeline, the
behavior of a failed token, and the permissions of any token other than the one
in use. Check those before relying on them.

Primary API references:

- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
- https://developers.cloudflare.com/workers/versions-and-deployments/

## Offline release qualification

`smoke` exercises the gate and recovery with a short workload. Its verdict does
not establish promotion readiness. `promotion` uses a 60-second warm-up and a
600-second measurement window at ten requests per second. It requires at least
5,400 measured requests. Both definitions are frozen in
`deploy/orange/qualification/profiles/`; the policy records the SHA-256 of the
exact definition bytes.

The promotion definition proposes a maximum error share of 0.001, p95 of 500 ms, p99 of one second, 100 CPU seconds per 1,000 requests, and a
1.5 GiB sampled memory peak. It permits no lost writes, history mismatches, or observed
restarts. Paired latency regressions require both a 25% increase and a 10 ms
increase. CPU per 1,000 requests and peak memory may rise by at most 25%.

These limits are provisional and need owner review before a promotion run. One
short `smoke` rehearsal made 30 measured requests per cohort without failures
and verified all six host points before and after recovery. The candidate's
histogram upper bounds were 22.006 ms at p95 and 23.014 ms at p99. Its measured
CPU delta was 0.662 seconds, or about 22.1 seconds per 1,000 requests, and the
sampled process RSS peak was about 1.07 GB. The limits leave headroom over that
one small run. Its mix, duration, load and collector-family coverage do not
establish promotion capacity or a tail-latency distribution. The 25% regression
limit and 10 ms latency floor are initial guardrails, not statistically derived
thresholds. Compare a full promotion run with production conditions before
relying on them.

On native Linux with Docker, build both Worker bundles and supply two runtime
artifact directories, each containing `runtime.tar` and `manifest.json`. The
receipt's artifact digest identifies the exact copied archive bytes. The
components also identify the canonical runtime manifest, Workers, Engine image,
and collector. If the input manifest declares `tar_sha256`, the runner checks
it against the copied archive. Otherwise it records the archive and manifest
hashes independently; the rollout must establish that they correspond.

Each side also takes an app release directory built by
`node --experimental-strip-types deploy/orange/app-release.mts --out DIR` (both
Workers, their descriptors and the collector; the same directory `make
standby-deploy` stages). Pass the same directory to both sides for the layer an
experiment holds constant. The changed layer names the result: a runtime change
keeps runtime release IDs and digests, an app change uses app release IDs and
`stats-app-manifest/1` digests, and a change to both is attributed to the
`RUNTIME+APP` pair, which no single rollout promotes. Identical artifacts on both
sides are refused. Each side runs its own app release's collector.

```sh
TMPDIR="$PWD/.work/tmp" node deploy/orange/qualification/promotion.mts \
  --baseline BASELINE_DIR --candidate CANDIDATE_DIR \
  --baseline-app BASELINE_APP_DIR --candidate-app CANDIDATE_APP_DIR --out EVIDENCE_DIR
make build-statsctl
node dist/statsctl.mjs verify release --evidence EVIDENCE_DIR --receipt-out RECEIPT.json --json
node dist/statsctl.mjs verify release --evidence EVIDENCE_DIR --replay --json
```

The runner accepts `--profile FILE` for a shortened definition named `smoke`.
A definition named `promotion` must match the frozen promotion file. The runner
starts both Workers and a separate Engine, builds the INF-7 collector, and reads
its source evidence. Collector delivery evidence is derived from its live process
and the reconciled checkpoints for all three targets. A missing source or
family is inconclusive. The source
reader's family status is integrated after the INF-7 source-read change lands.

The release policy is `stats-release-policy/2`; no `/1` policy is accepted.
Candidate absolute limits reject independently of baseline quality. Paired
regression limits apply only when both cohorts have sufficient evidence. A
window that is too short, too few measured requests, unavailable resources,
missing sources, unusable required families, or incomplete history cannot pass.
Open windows are pending. Candidate history mismatches reject. CPU is a window
delta, memory is the highest sample in that window, and restart evidence uses
process identity and Worker incarnation samples.

`ledger.json` includes every acknowledged host sample and the before and after
history comparisons. The oracle compares the expected undownsampled history
points using the sample wall time and the protocol's same-boot delta rules.
`observations.json` records source delivery checkpoints and family status.
`recovery.json` records the state-copy recovery. The remaining bundle files are
`policy.json`, the two release manifests, `workload.json`, and `decision.json`.
Unexpected files are rejected.

The built evaluator writes `stats-qualification-receipt/1` with the profile,
release, policy, workload, evaluator, observation, input and decision identities.
The receipt path must be outside the evidence directory and must not already
exist. The source CLI refuses receipt output. Replay evaluates at the recorded
instant and compares verdict and reason codes. Exit codes are pass 0, reject 7,
inconclusive 6, pending 5, replay mismatch 4, and invalid input 2. A rollout
controller must compare the evidence file set and hashes with the receipt, then
run replay before accepting the receipt.
