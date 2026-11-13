# Operations

## Release build

`make agent-build` runs `agent/scripts/build-static.sh`. It requires Docker
and `curl`. It downloads the pinned
[llvm-prebuilt-musl](https://github.com/laputa-systems/llvm-prebuilt-musl/releases)
release `llvm-musl-23.1.5-c4f9b08` for each architecture into
`.work/llvm-agent-build/`, verifies its sha256, and builds each musl target
with `cargo build --locked` in a container of the matching architecture
(`agent/build/Dockerfile`: Alpine 3.23 by digest, `musl-dev` headers, rustup
by checksum, the Rust channel from `rust-toolchain.toml`). The packaged `clang`
is the linker and C compiler and `llvm-ar` the archiver. The non-native
architecture runs under emulation. The script copies
`stats-<version>-<target>` into `agent/dist/` and rewrites `SHA256SUMS` plus
an `.elf.txt` program-header dump per binary. Older artifacts are left in
place. It fails if an ELF has `PT_INTERP` or `NEEDED`. Each container compiles
into `.work/llvm-agent-build/target-<arch>`, never `agent/target`.

Recorded 2026-11-01: 1,984,688 bytes x86_64 and 1,760,912 bytes aarch64,
stripped; two builds produced identical SHA-256 digests.

Recorded 2026-11-04 with the current toolchain, at `9ee3319` (JSON ingest) and
after the binary ingest change: x86_64 2,918,104 → 2,819,632 bytes, aarch64
2,563,256 → 2,471,568 bytes, macOS arm64 (`cargo build --release`) 2,631,120 →
2,553,120 bytes. The Worker bundle grew from 175,074 to 190,494 bytes (42,756
to 46,633 gzipped).

## Deployment

`deploy/hosts.json` is the host inventory: SSH target, musl target, init
(`systemd` or `openrc`), and elevation (`sudo` or `doas`) per host.
`deploy/deploy-host.sh` installs the binary and service unit from
`agent/contrib/`, restarts only when the SHA-256 or unit content changed,
preserves `/etc/stats/agent.json` and the token, and fails when the config is
missing.

```sh
make worker-check          # build + deploy validation, no upload
make deploy                # tests, Worker, live smoke, then every host
make deploy-host-<key>     # one host from deploy/hosts.json, idempotent
make deploy-hosts          # every host in the manifest
make rollback-host-<key>   # restore /usr/local/bin/stats.prev on one host
make smoke-deployed        # read-only live check
make smoke-local           # the same check against the built Workers in local workerd
make agent-e2e             # the real agent binary against the built Worker in local workerd
make integration-local     # the offline local stack: collection, statsctl, and the dashboard
make dev-local             # a persistent local stack on http://127.0.0.1:8789; make reset-local clears it
```

`cloudflare/scripts/api.mjs <path>` reads the live API as JSON. It gets an
Access token through `cf access token`, sends a GET to `/api/v1<path>`, and
decodes history frames back into the JSON-shaped history, so
`node cloudflare/scripts/api.mjs '/hosts/<id>/history?range=1h&kinds=summary' | jaq .`
works like the old JSON API. Errors print the status and body and exit 1.
`STATS_URL` overrides the origin.

`make add-host NAME=<label> SSH=<user@host>` provisions a host end to end. On
macOS it builds the native binary and installs a launchd user agent under the
login account. On Alpine it builds the static musl binary and installs the
OpenRC service as the `stats` user, using passwordless `doas` or `sudo`. In
both cases it creates the host when the label is new, rotates the token when
the server has the host but the target has no config, installs the binary,
config, token, and service unit, and waits for a fresh receipt. It needs
`cf access login https://<host>` and SSH access to the target; `SSH=local`
installs on the machine running the command. A rerun updates only the binary,
config, or service unit that changed. A Linux host also needs an entry in
`deploy/hosts.json` to receive `make deploy-hosts` updates.

`make deploy` runs `fixtures`, `worker-test`, and `agent-test` in order,
rebuilds and deploys the Worker with `make worker-deploy`, runs `deploy/deployed-smoke.sh`,
then updates the hosts. `STATS_DOMAIN` defaults to `stats.17166969.xyz`.
Pass `SECRETS_FILE=...` to upload Worker secrets; omitting it leaves existing
secrets in place. The `cf` session must be authenticated (`make auth-ready`),
and `make deploy`, `make worker-deploy`, `make stats-deploy`, and
`make observe-sourcemap` check the Access token up front (`make access-ready`)
so a missing session fails before anything is built or deployed.

`make worker-deploy` then registers the new stats version's source map with
`stats-observe` (`make observe-sourcemap VERSION=...` repeats it), which needs
an Access session from `cf access login https://$STATS_DOMAIN`.

`make worker-deploy` deploys `stats-observe` first (`make observe-deploy`),
because Cloudflare rejects a `stats` deploy whose tail consumer does not
exist (`[10203]`). For the same reason, stopping collection means removing
`tailConsumers` from `cloudflare.config.ts` and deploying `stats` before
`stats-observe` can be deleted (`[100109]`).

A host deploy installs through `stats.new` and `mv`, keeps the previous binary
as `/usr/local/bin/stats.prev`, and after restart polls `/api/v1/hosts` for a
new `lastReceivedAtMs` on that host. The poll uses `cf access token`, so run
`cf access login https://<host>` once before deploying a host directly.

## Ingest protocol v2 cutover

Ingest v2 (binary STB2 batches, `docs/protocol.md`) is a hard break with no
negotiation. **Agents built before it cannot deliver to a v2 server**: the
server answers their `POST /ingest/v1/batches` with `410 Gone`, which those
agents treat as retryable, so they back off and drop their oldest queued
samples while storing nothing. A v2 agent against a v1 server gets `405` and
also stores nothing. The server and every agent therefore move together, and
samples taken on a host between stopping its old agent and starting the new
one are not recovered. Storage does not change, so neither direction migrates
or deletes history.

`make deploy` alone is not a coordinated cutover: it deploys the Worker and
then updates only the Linux hosts listed in `deploy/hosts.json` (today only
`threadripper`), one at a time, while old agents elsewhere start failing.
macOS hosts and hosts provisioned with `make add-host` but missing from the
manifest are not updated by it. List every host first:

```sh
node cloudflare/scripts/api.mjs /hosts | jaq -r '.hosts[] | [.hostId, .name] | @tsv'
```

1. **Build and stage** from the release commit, on a quiet machine:
   `make check` (fixtures, both agent builds' tests, the Worker suites,
   `agent-e2e`, `smoke-local`, the dashboard suite, lint, `integration-local`), then
   `make agent-build` for both musl targets. Build each macOS host's binary on
   a Mac with `make agent-build-macos`. Record `stats --version` and the
   SHA-256 of every artifact, and record the currently deployed Worker
   version for rollback: `cf workers deployments list --worker stats`.
2. **Verify the binary smoke test before cutover**: `make smoke-local` runs
   `deploy/deployed-smoke.sh` against the built Worker in local workerd, and
   `make agent-e2e` delivers a real sample from the built agent through it.
   Both must pass before anything is deployed.
3. **Stop the old agents** (or accept the telemetry gap and skip this):
   `ssh <host> doas rc-service stats stop` (OpenRC),
   `ssh <host> sudo systemctl stop stats` (systemd), or
   `launchctl bootout gui/$(id -u)/xyz.17166969.stats` on a Mac.
4. **Deploy the binary-only server**: `make worker-deploy`. Note the printed
   `Current Version ID`. `make worker-deploy` deploys `stats-observe` first,
   then `stats`; `make stats-deploy` deploys only `stats` (and registers its
   source map, keyed by the version the latest `stats` deployment serves at
   100%, read from `cf workers deployments list`), for changes that leave the
   observe companion untouched.
5. **Run the binary smoke test** against production: `make smoke-deployed`.
   It checks that `GET /ingest/v2/batches` is 405, the v1 path is 410,
   JSON is 415, a version-1 STB2 header is `unknown_version`, and a valid STB2
   frame with an unknown token reaches the object and is `unauthorized`. It
   writes nothing.
6. **Replace and restart every agent**: `make push-hosts` for the manifest
   hosts (each install starts the stopped service and waits for a fresh
   receipt), and `make add-host NAME=<label> SSH=<target>` for each other host,
   which updates the binary in place and waits for a receipt.
7. **Verify** for every host: `online` and a recent `lastReceivedAtMs` in
   `/hosts`; no `upload failed` lines in the agent log
   (`/var/log/stats.log`, `journalctl -u stats`, or `log show` on macOS);
   no `ingest_rejected` lines with `invalid_frame`, `invalid_batch`,
   `unknown_version`, or `conflict` in Workers Logs; a duplicate replay
   (restart one agent within a minute) answering with duplicates, not
   conflicts; and `range=1h` history showing new points after the gap.
8. **Verify existing history**: `range=24h`, `7d`, and `30d` history for each
   host still returns the points from before the cutover
   (`node cloudflare/scripts/api.mjs '/hosts/<id>/history?range=7d&kinds=summary'`).

### Cutover record

2026-11-04: deployed `stats` version
`2f38a11c-a42e-4cb4-8101-2cfe16c4d865` and `stats-observe` version
`eff00be4-1139-4790-9dc5-54487d41285e`, replacing `stats` version
`3a4ea033-34f4-492c-99a7-7899874fd227`. Updated `threadripper` (x86_64,
`deploy/hosts.json`), `sentry` (macOS arm64, local), and `m1-max` (macOS
arm64, `make add-host`). All three reported fresh receipts, and 24-hour,
7-day, and 30-day history still returned points from before the cutover.

### Rolling back the cutover

Roll back the server and the agents together; there is no protocol
negotiation to fall back on. Stop the v2 agents (step 3), restore the
recorded Worker version with `cf workers deployments create` (below), then run
`make rollback-host-<key>` for each manifest host, which restores the v1 agent
saved as `/usr/local/bin/stats.prev` and waits for a receipt. For other hosts,
check out the previous release, rebuild, and rerun `make add-host`. Samples
written by v2 are the same canonical JSON v1 writes, so the v1 server reads
them and nothing is migrated or deleted.

## Rollback

A host deploy copies the current binary to `/usr/local/bin/stats.prev` before
installing the new one. `make rollback-host-<key>` restores that copy and
restarts the service; it fails if no previous binary exists.

The Worker keeps every deployed version. List them and point the deployment at
the version to restore:

```sh
cf workers deployments list --worker stats
cf workers deployments create --worker stats \
  --versions '[{"version_id":"<version-id>","percentage":100}]'
```

## Measuring a deployment with statsctl

`statsctl` answers whether a deployed version used fewer resources for the same
work. It reads the production origin through Access, so run it from a machine
logged in with `cf access login https://stats.17166969.xyz`:

```sh
pnpm --dir cloudflare -s statsctl help workflow
pnpm --dir cloudflare -s statsctl health --project stats --json
pnpm --dir cloudflare -s statsctl deployments --project stats --json
pnpm --dir cloudflare -s statsctl verify --project stats --deployment DEPLOYMENT_ID --window 1h --policy bench/policies/EXPERIMENT.json --safety-check-file .work/check-ingest.json --wait --timeout 2h --json
```

`statsctl help workflow` holds the full recipes and `statsctl help verify`
the policy fields; this page does not copy them. The same binary also runs as
`node --experimental-strip-types cloudflare/src/cli/statsctl.ts`. Run `health`
first and fix anything unhealthy before trusting a verdict. Exit codes: 0 read
succeeded or improved, 2 usage, 3 authentication, 4 transport or contract
failure, 5 pending or insufficient data, 6 unchanged or confounded, 7
regressed, 8 `observe rollouts` found settled rollouts to look at. `--json` prints one `statsctl/1` document. Resumable verdict state
and snapshots live under `.work/statsctl/`. Authentication runs
`cf access token <origin>`; set `STATSCTL_AUTH_COMMAND` and
`STATSCTL_AUTH_HEADER` to use another credential source.

### Checking settled rollouts

```sh
pnpm --dir cloudflare -s statsctl observe rollouts --settle 3h --within 24h --json
pnpm --dir cloudflare -s statsctl observe rollouts --project nanoshop-storied
```

`observe rollouts` is read-only and stateless. For each rollout of an observed
service (or of `--project`) that started between `--within` ago (default 24h)
and `--settle` ago (default 3h), it reads the same impact report as
`observe deployment` and lists the rollout only when it has a new issue group, a
regression, a failure-rate change, or a route CPU change larger than twice its
combined standard error; the failure-rate spread is the same rule applied to the
difference of two proportions. Changes are reported in either direction. Each
finding carries the rollout id, service, introduced versions, the numbers, and
the commands to drill in. The `statsctl/1` payload is `{settle, within,
startedFromMs, startedToMs, checked, findings}`. Exit 0 means nothing to
report, 8 means findings, and 2, 3, and 4 are the usual usage, authentication,
and transport or contract failures. The command keeps no record of what it has
reported, so a rollout with findings is listed again on every run until it ages
past `--within`; choose `--within` to bound that repetition. Scheduling it (a
host timer or an agent routine) and the alert destination are not set up and
need a production Access credential.

`check ingest` writes one real sample using the credential supplied with
`--credential-file`. Use the dedicated `synthetic-check` host credential from
`.work/credentials/synthetic-check.json`; the command does not enforce that
host role. Other writes are listed under [Mutations](#the-statsctl-contract).
It encodes one known sample with a
fresh sequence and time, POSTs it, expects the acknowledgment to accept 1, reads
the host history and finds the sample, replays the identical bytes and expects
duplicate 1 and accepted 0, and confirms the stored count did not change. Its
encoder, `src/ingest/encode.ts`, must reproduce every `fixtures/v2` golden frame
byte for byte (`test/ingest/conformance.test.ts`). Run it in production only
inside a deployment's excluded bucket and warm-up interval, so its sample never
enters a measured window; synthetic operations carry a flag and are excluded
from organic metrics, but their cost stays in totals.

Deploy order matters for measurement. `stats` publishes one `operation` message
per instrumented invocation, and `stats-observe` must already accept it:
`make observe-deploy` goes first. Never roll `stats-observe` back below the
version that accepts `operation` while `stats` still emits it. The older tail
rejects those invocations as `rejected-invalid`, and the operation tables stop
filling.

### The statsctl contract

`statsctl` is a TypeScript CLI that shares the dashboard's cost engine. It
reads project, host, service and observation APIs and also exposes explicit
provisioning and credential mutations. There is no server endpoint for cost.
It uses `node:util` `parseArgs`, global `fetch`, `node:fs`, and `node:crypto`,
with no CLI framework, schema library, or SDK. Its
name differs from `stats`, which is the Rust agent.

- **JSON envelope.** `--json` prints exactly one `statsctl/1` document on stdout.
  It carries `schema`, `command`, `generatedAtMs`, `origin`, `project`, the
  half-open UTC `windows`, `pricingRevision`, `measurementRevision`, `coverage`,
  `units`, `priced`, `excluded`, `warnings`, `identities` (deployment and
  version ids), and either `payload` or `error: {code, message}`. Numbers stay
  numbers, u64 values stay decimal strings, and ordering is deterministic.
  Diagnostics go to stderr, with no progress output, colour, or pager when
  stdout is not a TTY or `NO_COLOR` is set.
- **Schema versioning.** `statsctl/1` changes only by adding fields, to the
  envelope, its payloads, or the observe API responses it decodes. Changing an
  existing field's type, unit, or meaning, or removing a field, moves the schema
  to `statsctl/2`; when the version cannot move with the change, the commit is
  marked breaking (`!`). A `statsctl` newer than the server it reads finds an
  added field missing and fails with `server_older` (exit 4), whose message names
  the field. A field present with the wrong type is still `contract`.
- **Authentication.** The credential command defaults to
  `cf access token <origin>`, run with stdin closed and a 20 second timeout. A
  failure exits 3 with `run: cf access login <origin>`; `statsctl` never starts a
  login. The credential goes only to the configured origin, redirects are not
  followed, and a 3xx, an HTML 200, a 401, or a 403 is exit 3. A credential
  never enters argv, a snapshot, a log, or a report field.
- **Requests.** Each has a 15 second timeout and a body cap of 8 MiB for history
  and 1 MiB for JSON. Only GETs that fail with a network error, 502, 503, or 504
  retry, twice, with jittered backoff. History kinds are bundled into one request
  per window.
- **Snapshots.** `.work/statsctl/snapshots/` holds the raw history frames
  (base64), the decoded deployment and observe JSON, the resolved windows,
  project config, resource identities, the pricing and measurement revisions,
  the git SHA of the CLI, and a SHA-256 of each input. A snapshot never holds a
  credential or an observe stack frame. Each is capped at 4 MiB and the
  directory at 200 MiB, pruned oldest first. `--input` refuses a snapshot whose
  schema, pricing revision, or hash does not match, with exit 4 and a reason
  code, and never reinterprets it.
- **Readiness.** `health --policy FILE` and `verify --readiness` list each
  signal a policy needs as `available` or `unavailable:<code>` with a sentence.
  A missing signal the policy does not use never blocks it.
- **Mutations.** `check ingest` writes a sample using the supplied host credential;
  use only a dedicated `synthetic-check` host, as the CLI does not enforce that role.
  `deploy mark` writes a service marker. `service create`, `service token rotate`
  and `service token revoke` manage services and credentials. Read commands,
  including `service check`, do not persist mutations. Command definitions own
  the access classification and supported targets; use `statsctl help` for the
  current options and credential-file requirements.

### Cost reports

`cloudflare/src/cost/` owns the versioned tariff table (`pricing.ts`), ledger
construction, plan bill and projection, coverage semantics, and
`buildCostReport`. The dashboard and `statsctl cost` both call it, and each adds
its own presentation. Modules in the CLI's import graph use explicit `.ts`
imports and erasable syntax only, and none imports Solid, uPlot, or
`src/client/pages/**` (`test/cost/boundary.test.ts`).

- **Tariffs.** Every price carries a source URL and a `verifiedOn` date, and the
  table carries `PRICING_REVISION`. A meter without a source is a type error.
  Prices are never fetched at runtime, and a baseline and a candidate are priced
  with the same revision.
- **Missing data is not free.** A line with no covered bucket is
  `uncollected/no-data`, and a meter with no source (Durable Object SQLite rows
  where no summary exists, R2 Class A and B) is `uncollected/no-source`. Neither
  is priced as zero.
- **Partial Worker costs.** Missing Worker request or CPU data is `null` in
  request usage and listed as `no-data` in excluded meters. Known Worker meters
  remain priced, and the total is qualified as partial. A route missing one of
  those fields is also partial. Monthly plan usage leaves a missing Worker meter
  `null`; `missingBilledMeters` and `missingProjectionMeters` identify the
  omitted inputs. Amounts with missing inputs are lower bounds only when they
  do not include the Durable Object duration proxy.
- **Partial D1 costs.** Missing rows-read or rows-written data is `null` in
  D1 and statement usage and excluded from priced meters. Known rows remain
  priced as a partial subtotal. Monthly D1 usage is also nullable, with omitted
  meters named in `missingBilledMeters` and `missingProjectionMeters`.
- **Partial Durable Object costs.** Missing aggregate request, wall-time, or
  CPU data is `null` in object usage. Missing request or wall-time meters are
  excluded from priced meters and from monthly usage; known costs remain
  partial, including method cost shares derived from the aggregate. Monthly
  omissions are named in `missingBilledMeters` and `missingProjectionMeters`.
- **Duration proxy.** `durationProxy.billed` and `durationProxy.projected`
  identify plan amounts that include summed Durable Object request wall time.
  This is an upper-bound proxy for billed duration, so those amounts are
  estimates and may overstate duration charges. A report with both missing
  meters and this proxy is partial, rather than a guaranteed minimum.
- **Scope is stated.** The plan bill is `isolated`: it subtracts the full account
  allowance for one project, and an account total exists only when every project
  in the account is covered. Months are UTC calendar months, labelled
  `utc-month`, never the billing cycle. Durable Object duration from summed wall
  time is an upper bound. Every total lists its priced meters, excluded meters,
  and residuals.
- **Sampled object methods.** When observation samples object invocations, method
  counts and latency describe retained invocations, and allocated method costs are
  estimates rather than upper bounds. The cost report includes an
  `object-method-sampled` warning for each sampled window; its counts cover the
  overlapping observation-count buckets. A method absent from a sampled comparison
  has an unknown baseline, not zero.
- **Compare like with like.** The ledger total and the comparator's cost per
  1,000 invocations share arithmetic but have different scopes, and each names its
  meter set.

### Verifying a candidate

Pre-register each experiment before its deploy: a hypothesis and a policy file in
`bench/policies/`. `statsctl help verify` documents the policy fields, the
guardrails, and the verdict precedence, and `docs/deployments.md` explains why
the operation-scoped comparison decides acceptance. The result is the saved
`verify --json` output and a commit body with the code SHA, deployment and
version ids, exact windows, counts, coverage state, absolute and relative
deltas, denominators, exclusions, cost basis, guardrails, and the keep, revert,
or pending decision. A change that did not move its metric is reverted or
re-diagnosed, not kept.

- **Cost.** `verify` separates application cost (`stats`), observation cost (the
  `stats-observe` project: tail CPU, its Durable Object requests, duration, rows,
  and storage), and experiment overhead, which is the requests `statsctl` itself
  made, counted in the verify state. `stats-observe` never tails itself.
- **Polling.** `verify --wait` sleeps until the comparison window's ready time,
  then polls at most every 15 minutes with `If-None-Match`. A poll makes at most 7
  requests and a full verify at most 60.
- **Deploying.** `make stats-deploy` redeploys only `stats`, for a change that
  touches no observe code. `make worker-deploy` always redeploys `stats-observe`
  first. Confirm a deployment id
  from `cf workers deployments list --worker NAME` or `statsctl deployments --project stats`,
  never from a log line alone, and inspect the active deployment before you retry
  or roll back a command that failed after the upload.
- **Windows.** A production verdict needs about 2.5 hours free of other
  deployments: an hour of stable baseline, an hour after, 5 to 10 minutes of
  warm-up, and 45 minutes of settlement. A verdict whose window another
  deployment overlaps is `confounded`. Reads of history (about tens an hour)
  fall under the 100-operation minimum at 1 hour, so verify those over 6 hours.
- **Instrumentation budget.** Operation summaries add no more than 1.0 observe
  row written per `stats` invocation over a baseline of 3.0, and keep the `stats`
  Worker's gzip bundle within 5 KiB of the previous release.

### Reducing cost

Stats is the instrument: a change ships only when the project page can show
whether it helped.

1. Open the project page for the range since the last deploy. Take the top row of
   the Estimated cost widget, then the top D1 statement or CPU route under it.
2. State the hypothesis in one line and name the metric that would move.
3. Reproduce with a failing test or a measured count (rows written, CPU per
   call), fix the cause, and run the narrowest checks.
4. Deploy, wait an hour of new data, and read the same metric over the hour after
   the deploy only. Earlier data predates the change and is not a baseline.
5. Put the before and after figures in the commit body.

Estimated cost is list price before included allowances. It ranks components and
is not the bill. Durable Object CPU is not a billed dimension (requests,
duration, and rows are), so work on it buys latency and headroom, not money. Stop
working a lane when its top item is under 10% of the project's list cost, or when
the last two fixes each moved their metric by less than one sample of noise. Do
not reduce retention, resolution, collection cadence, sample persistence, or
Access coverage as an optimization.

## Observability

`cloudflare.config.ts` enables Workers Logs and Workers traces, each at 10%
head sampling. Traces carry the platform's automatic spans, including one per
Durable Object SQLite statement with its query and row counts; the Worker adds
no custom spans. The Worker
writes a fixed JSON line for ingest rejections other than duplicates, alarm
failures, and the 500 catch-all, with `event`, `hostId` when known, and `code`.
The free plan includes 200,000 log events per day with three-day retention.
From 2026-12-01, logs and traces from every Worker on the account share one
ingestion allowance (0.5 GB per day on Free, where ingestion stops at the limit
until 00:00 UTC), and traces keep seven days.
Set a spend alarm before raising either `headSamplingRate` or the fleet size, and
lower the rate or move to Workers Paid when the allowance is close.

Capture a CPU profile of the `Installation` object with
`cf workers versions profile latest-deployed --worker-id stats --profile-type cpu
--namespace-id <namespace> --actor-id <object>`, listing both IDs with
`cf durable-objects namespaces list` and
`cf durable-objects namespaces objects list --id <namespace>`. The capture
fails with "no loaded isolate" when the object is idle, and the agents'
30-second ingests alone leave the profile empty, so drive requests at the
object before and throughout the capture. Read the output with
`go tool pprof -top`.

## Project collection

The cron (`*/5 * * * *`) and the `ANALYTICS_SQL` and `PROJECTS` bindings are
declared in `cloudflare.config.ts`. The binding reads the whole account's
analytics, which is a wider permission than the host ingest path needs; only the
fixed queries in `cloudflare/src/projects/queries.ts` ever run. Change the
project list by editing `PROJECTS` there and redeploying.

Check a deployment from your machine:

- `node cloudflare/scripts/check-parity.mjs` compares every settled stored Worker bucket of the last 24 hours with `cf sql query` and fails above 5% total error; it needs `cf access login`.
- `node cloudflare/scripts/check-analytics-sql.mjs` runs the five queries
  read-only against the live account through `cf sql query` and fails on a
  non-200 response or a row the parser rejects.
- After the first cron run, `GET /api/v1/projects` shows `collector.lastSuccessAtMs`
  and `stale: false`. If there is no run, apply schedules with
  `cf workers triggers deploy`.

Budgets, measured on the test object with fixture-shaped data (the live account
has not run the collector yet):

| Measure | Result | Target |
| --- | --- | --- |
| Binding queries per project per run | 5 at most (Worker, routes, Durable Objects, R2 operations, R2 storage) | at most 6 |
| Rows written per run, steady state | 49 average, 74 at most | 60 |
| Rows written, first run or recovery after an outage | 258 to 414, once | no target |
| Rows written, identical second run | 0 | 0 |
| Projected daily writes at the average | about 14,000 | under 15,000 |
| Rows read per query, live | Worker 4.0 M, R2 operations 2.5 M, R2 storage 1.6 M | recorded |

The two expiry indexes double the cost of each new bucket; dropping them would
cut a first run to about 130 rows but would make retention scan whole tables.
The free-plan allowance is 100,000 rows written a day, shared with host ingest.
Live runs took 0.5 to 2.1 s of wall time.

## First deployment

1. Create an Access application for the dashboard hostname with an owner allow
   policy, and record the team domain and audience. Access fronts the whole
   hostname, so also create path-scoped Bypass/Everyone applications for
   `<host>/health` and `<host>/ingest/*`. Without them, Access challenges
   health and ingest before the Worker sees them; the Worker still requires a
   host bearer token on ingest. A zone rate-limit rule blocks `/ingest/*`
   above 20 requests per 10 seconds per IP per colo for 10 seconds, the
   free-plan limits and the equivalent of 120 requests per minute, so one
   source cannot flood the single object. A token-shaped header that is not a
   real host token still reaches the object, which parses the body and then
   rejects the credential; the zone rule bounds how many such requests it
   handles.
2. Deploy with `make worker-deploy SECRETS_FILE=...`, setting
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Without the team domain every
   Access-protected route returns 503; without the audience, 401.
3. Authenticate through Access (`cf access login https://<host>`), then
   provision each host with `POST /api/v1/admin/hosts` and a body of
   `{"name": "<label>"}`. The 201 response carries `hostId` and the token,
   which is shown only once; store it in an owner-only file, install the agent config and token
   (see README), then run `make deploy-hosts`.
4. Verify with `make smoke-deployed`, then check ingest, replay dedupe,
   latest and history, rotation, and revocation against a disposable host and
   revoke it. Set spend alarms before fleet use.

`cloudflare/wrangler.test.jsonc` is test-only configuration for
`@cloudflare/vitest-plugin`, not a deploy configuration.

## Run on Node

The Node server serves the same API, ingest route, and dashboard as the
Worker for supported routes. It includes service markers and application
events/issues, but no Cloudflare project collector, tail consumer or deployment
poll. Observation stores and their cleanup schedules belong to individual
services; see [Node architecture](architecture.md#node-server). It needs the
pinned Node, installed dependencies and the built dashboard, and runs from the
repository:

```sh
pnpm install --frozen-lockfile
make worker-bundle
mkdir -p "$HOME/.local/share/stats-node"
cd cloudflare && \
  STATS_DATA_DIR="$HOME/.local/share/stats-node" \
  STATS_ALLOWED_LOGINS=you@example.com \
  node --experimental-strip-types src/node/main.ts
```

| Variable | Meaning |
| --- | --- |
| `STATS_DATA_DIR` | Required. An existing directory; the database is `stats.sqlite` inside it. Only one server may use it at a time: the server holds an exclusive SQLite lock, and a second one exits 2 with `stats: STATS_DATA_DIR ... is in use by another server`. |
| `STATS_LISTEN` | `IPV4:PORT`, `[IPV6]:PORT`, or `unix:/absolute/path.sock`. Default `127.0.0.1:18791`; port `0` picks a free one. A socket's directory must exist; a stale socket file is replaced, a live one stops startup with exit 2, and the socket is `0600` and removed on shutdown. |
| `STATS_ALLOWED_LOGINS` | Required. Comma-separated Tailscale logins allowed to read the API and dashboard. |

A missing or invalid value stops startup with exit code 2 and a
`stats: <variable> ...` line on stderr. Once listening, the server prints
`{"event":"listening","host":...,"port":...}`. On SIGTERM or SIGINT it
stops accepting connections, finishes requests in flight, closes the
database, and exits 0.

Back up the whole `STATS_DATA_DIR` while the server is stopped. Include
`stats.sqlite` and the `stats.sqlite.observe` directory. The latter contains
one database per observation service. Preserve the original observation tables
in `stats.sqlite` when inspecting ambiguous legacy data. Migration copies only
rows whose service ownership is known, preserves issue resolution, and records
completion in each destination transaction. Restart resumes an interrupted copy.

Deployment starts an isolated candidate and checks health before stopping the
current container. It retains the previous container until the replacement
passes health, and restores it if
the replacement fails. Preflight uses an empty database and cannot prove a
production data migration. Take the stopped backup before an upgrade.

Every path other than `/health` and ingest needs an allowed
`Tailscale-User-Login` header, which `tailscale serve` adds for tailnet users,
and a loopback TCP peer. A connection on a Unix socket has no TCP peer and is
trusted as transport, because only the owning user and root can open it; it
still needs the header:

```sh
tailscale serve --bg --http=18790 http://127.0.0.1:18791
```

Because `tailscale serve` attaches the identity to every request from a
user's device, a page on another site could otherwise drive writes. Every
`/api/v1` request that is not `GET`, `HEAD`, or `OPTIONS` is rejected with
`403 forbidden` when its `Origin` differs from the request's own origin
(`Host`, with `X-Forwarded-Proto: https` for TLS) or its `Sec-Fetch-Site` is
`cross-site`. Clients that send neither header, such as `curl` and
`statsctl`, are unaffected. `POST /api/v1/admin/hosts` also requires
`Content-Type: application/json` and answers `415 unsupported_media_type`
otherwise. The Worker applies the same rule behind Access.

### In a container on threadripper

The Vite SSR bundle currently leaves `@jridgewell/trace-mapping` external, and
the image ships no dependency tree. The staged bundle exits on import
(STA-116 in [TODO](../TODO.md)); deployment preflight rejects this candidate
before stopping the running container. Use the source-run setup above until
the bundle includes its runtime dependency closure.

```sh
STATS_ALLOWED_LOGINS=joshua.r.li.98@gmail.com make node-deploy
```

`deploy/node/deploy.sh` refuses a tree with uncommitted tracked changes,
because the image is tagged with the commit. It builds the dashboard and Node
bundle here, copies `main.mjs`, the built assets, and `deploy/node/Dockerfile` to
`~/stats-node-build/<commit>` on the host, and builds `stats-node:<commit>`
there from the digest-pinned Node Alpine image in the Dockerfile. The Node Vite
config bundles runtime packages into `main.mjs`, leaving Node built-ins external.
An isolated candidate must pass `/health` before the running container is stopped.
The script then replaces the `stats-node` container, which runs as `node`
with `--network none` and listens on `unix:/run/stats/stats.sock`. The
container keeps the database in `~/.local/share/stats-node`, mounts the
`0700` directory `~/.local/share/stats-node-run` at `/run/stats`, and is
started with `--restart unless-stopped`. The deploy waits for `/health` over
the socket with `docker exec` and prints the tag, with the full output in
`.work/tmp/node-deploy.log`.

The container has no network at all, which also prevents outbound service-health
probes from reaching network URLs. Docker's bridge network would present
every request as coming from its gateway, and host networking would put a
listener on the host. The Node auth adapter trusts only a loopback peer or the
socket, so the socket in a `0700` directory is the one entrance, reachable by
the owning user and root and by no other process on the host. Expose it to the
tailnet with `tailscale serve` running as root:

```sh
doas tailscale serve --bg --http=18790 unix:/home/josh/.local/share/stats-node-run/stats.sock
```

This replaces the earlier `http://127.0.0.1:18791` target. The deploy stops
if the host has under 50 GB free. The Node instance is a separate installation:
it starts empty, shares no data with the Cloudflare one, and has no import or
agent cutover. `tailscale serve` attaches the caller's identity to every
tailnet request, so `deploy/deployed-smoke.sh` reports its no-credentials check
as a failure against the tailnet origin; the rejection paths are covered by
`make node-e2e`.

The container runs with `--cgroup-parent=/stats.slice/stats-node.slice`, so the
unit `stats-node.slice` names a cgroup that persists across deploys and counts
the container's CPU, memory, and I/O. A host agent reports that unit as a
service (README, `services`). The agent accepts only an `https://` endpoint or
loopback `http://`, so a remote agent reports to this instance through a
`tailscale serve --https` entry on the same socket.

To roll back, run `docker run` for an earlier `stats-node:<commit>` image
with the same flags. To remove the deployment, run `docker rm -f
stats-node` and `tailscale serve --http=18790 off`; the data directory
stays.

Provision a host through the tailnet origin as on the Worker, with
`POST /api/v1/admin/hosts` and `{"name": "<label>"}`; the token is shown once.
`make node-e2e` runs `deploy/deployed-smoke.sh` and the real agent against a
local instance.

`statsctl` picks its target from the origin. A host ending in `.ts.net`, or a
bare name with no dot, is a Node origin: statsctl sends no credential, because
`tailscale serve` adds the identity. Service administration, inspection, checks,
markers and deployments work there, as do `observe application`, `check ingest`
and `verify --service`. Project/Cloudflare-only commands exit 2 with
`unsupported_on_target` before a request. Command help lists the supported
targets. Store the `synthetic-check` host
credential (`{hostId, name, token}`, mode 0600) and run:

```sh
pnpm --dir cloudflare -s statsctl check ingest --origin http://threadripper.tailcf741.ts.net:18790 --credential-file .work/credentials/synthetic-check-node.json
```

## Services and deploy markers

A service names the hosts a deployable runs on. A deploy script records each
release with a marker, authenticated by the service's deploy token. Routes,
rules, and responses are in `docs/architecture.md`
([Services and deploy markers](architecture.md#services-and-deploy-markers)).
The statsctl commands `deploy mark`, `services`, and `service deployments`
record and read markers.

Create a service once with a human credential. The 201 response is the only
place the deploy token appears, so write it straight to an owner-only file.
On Cloudflare, log in with `cf access login https://stats.17166969.xyz` first.
The Access token reaches `curl` through a `printf` builtin and a file
descriptor, so it never appears in an argv:

```sh
umask 077
mkdir -p .work/credentials
curl -sS https://stats.17166969.xyz/api/v1/admin/services \
  -H @<(printf 'Cf-Access-Jwt-Assertion: %s\n' "$(cf access token https://stats.17166969.xyz)") \
  -H 'Content-Type: application/json' \
  -d '{"name":"web","hostIds":["h_..."],"healthUrl":"https://web.example.com/health","unit":"web.service"}' \
  > .work/credentials/web-deploy.json
```

On Node, `tailscale serve` adds the identity, so the request carries no
credential:

```sh
umask 077
mkdir -p .work/credentials
curl -sS http://threadripper.tailcf741.ts.net:18790/api/v1/admin/services \
  -H 'Content-Type: application/json' \
  -d '{"name":"stats-node","hostIds":["h_..."]}' \
  > .work/credentials/stats-node-deploy.json
```

Record a deploy after it succeeds. The token file is the creation response
saved above. `statsctl` checks it like the `check ingest` credential file
(mode 0600, read from the invocation directory, `name` must equal `--service`),
sends the token only in the `Authorization` header, and sends no Access
credential on either target. `--host` defaults to the service's `hostIds` from
the file, and `--marker-id` defaults to `v-<version>`, so repeating a deploy is
idempotent:

```sh
pnpm --dir cloudflare -s statsctl deploy mark --service stats-node --version COMMIT --message release --token-file .work/credentials/stats-node-deploy.json --origin http://threadripper.tailcf741.ts.net:18790
pnpm --dir cloudflare -s statsctl service deployments --service stats-node --origin http://threadripper.tailcf741.ts.net:18790
```

Replace `COMMIT` with the version, such as `git rev-parse --short=12 HEAD`.
`make node-deploy` runs the first command itself after the health wait when
`.work/credentials/stats-node-deploy.json` exists, against `STATS_NODE_ORIGIN`
(default `http://threadripper.tailcf741.ts.net:18790`), with the marker id
`d-<commit>-<UTC deploy time>`. Each deploy of a commit therefore gets its own
marker, and a later rollback to an already-marked commit still shows on the
timeline. With the `v-<version>` default, that repeat would be a no-op.

A new marker answers 201. Sending the same marker again answers 200 with the
stored one, so a retry is safe; `deploy mark` exits 0 for both. Pass
`--at-ms` with the recorded activation time to make a delayed retry keep it;
without it the server stamps the receive time. The same
`markerId` with a different version, message, host set, or `--at-ms` answers
409, which
`deploy mark` reports as `marker_conflict` with exit 2. A 401 or 403 exits 3,
and so does an Access challenge (`access_challenge`).

The marker `POST` goes to `/ingest/services/NAME/deployments`, so on
Cloudflare the existing `/ingest/*` Bypass application lets it reach the
Worker; no other Access application is needed. Access matches by path, not
method, so the readback stays on `/api/v1`, behind Access. The Node target
needs nothing extra: the marker route ignores Tailscale identity, so any
process that can reach the tailnet origin can mark with the token.

### Comparing a service's deployments

Once a service has two markers more than the window apart and its hosts have
reported across both, the dashboard's Services page and `statsctl verify` compare
them. The Services page is `#/services`; a service page is `#/service/NAME`, with
the deployments timeline and the before and after table. A source the service
lacks (no health URL, no host data in a window) shows as unavailable, never zero.

```sh
pnpm --dir cloudflare -s statsctl verify --service stats-node --deployment latest --policy bench/policies/service-example.json --origin http://threadripper.tailcf741.ts.net:18790 --json
```

The policy is strict JSON, schema `statsctl-policy/1`, with `id`, `hypothesis`,
`service`, `metric`, `operation`, `work`, `direction`, `minChangePercent`,
`floor`, and `window`. `metric` is one of the level metrics or application
metrics in [Service comparison](architecture.md#service-comparison). A level
metric rejects `operation` and `work`; `application.duration` and
`application.failure` require `operation`; the per-work metrics require
`operation` and `work`. There are no guardrails and no waiting. It makes one
read. Exit 0 improved, 5 pending (the after window has not settled; run it
again) or insufficient-data (a source or counter is unavailable), 6 unchanged
or confounded, 7 regressed. Every output states that resource levels and
per-work ratios are descriptive, not causal. A per-work ratio is unavailable,
with the reason, when the operation's counter is incomplete or the service
cgroup is shared by more than one operation. Service CPU and I/O per work are
per observed work, and the verdict says so: Stats does not record producer
drops, rejected batches or sequence gaps. A truncated or failed application read
makes every application metric `insufficient-data` with reason code
`application-truncated` or `application-unavailable`, and a five-minute bucket
with no events while the service was up does the same for CPU and I/O per work
with `application-gap`. Host metrics include every process
on the hosts the marker names; when the agents on those hosts report the
service's cgroup in both windows, `service.cpu`, `service.memory`, and
`service.io` supersede `host.cpu`, `host.memory`, and `host.disk`. The host rows
stay in the response after the rest, marked `supersededBy`, so a policy on a
host metric is still judged and carries a reason naming the better measure.

The Node server probes each service's `healthUrl` every five minutes. A Node
container with no network sees every probe fail, so its probe failure share is
100 percent in both windows; leave `healthUrl` off for such a service.

## Verified environments

Recorded 2026-10-31:

- **Cloud:** live ingest, exact-replay dedupe, latest and 1 h history, the
  dashboard with CSP and frame protections, rotation, and revocation at
  `https://stats.17166969.xyz`, on the account's free plan.
- **x86_64 hosts:** Ubuntu 24.04.4 LTS under systemd and Alpine edge under
  OpenRC uploaded live samples; the sequence continued across restarts, a
  stopped host became offline after 45 s, and Alpine reported PSI as
  unavailable.
- **aarch64, container-scoped:** the static binary ran `--version`, `--once`,
  `--bench`, and a full agent run against a local HTTPS ingest in
  `debian:13-slim` (under `contrib/supervise.sh`) and `alpine:edge` (under
  OpenRC, started with `rc-service -D` because container networking cannot
  satisfy `need net`) on OrbStack. This does not cover kernel behavior,
  systemd boot, reboot persistence, or block telemetry.
- **Performance and BPF:** see [`bench/README.md`](../bench/README.md) and
  [README](../README.md) (agent config, opt-in `block-latency` feature).

Not yet verified:

- Project collection on the live account, checked on 2026-11-01 after an
  Access login. The Worker (version `8390a8f6`) was deployed; the cron reached
  the Durable Object about eight minutes later and then every five minutes, and
  every recorded run was `ok`. Runs took 0.5 to 2.1 s and read about 8 M rows
  each. The binding accepts `logs.workersLogs` despite its docs, and all four
  probes reported up from the edge (`site` was down in one of the first five
  runs, 200 on every check afterwards).
- Parity with `cf sql query` did not meet the 5% gate at first. Across 14
  five-minute buckets, 11 matched and three differed: 16:05 UTC stored 12,064
  against 13,424 (-10%), 17:05 stored 8,864 against 7,344 (+21%), and 17:15
  stored 4,032 against 4,016. A temporary route that returned the raw binding
  rows for the collector's exact query (since removed) matched the CLI row for
  row at 17:48, and the store was shown to overwrite a higher value with a lower
  one. The 17:05 and 17:15 buckets then converged to the CLI values on the 17:50
  run, so the binding's view of a bucket can trail the CLI's by 10 minutes or
  more, and a bucket keeps whatever the last run inside its 90 minute window
  saw. The 16:05 bucket left that window still stale and stays 10% low. The
  cause of the lag is unknown (a deploy at about 17:46 also fell between the
  stale and the corrected runs, so a binding-side result cache is possible).
  The open choices are a longer collection window, which reads more rows per
  run, or accepting an error of about 10% on the largest buckets.
- Parity re-run on 2026-11-06 at about 04:50 UTC, with the Worker `stuff`: 279
  settled buckets compared, 275 exact. Four differed, all on 2026-11-05: 11:10 stored 44 against 8,
  15:25 stored 12 against 16, 16:25 stored 284 against 296, and 16:40 stored 200
  against 204. Total stored 14,624 against 14,608, an error of +0.1% against the
  5% gate. The 11:10 bucket stores more than the CLI returns, which the lag
  explanation above does not cover; it is a single bucket and unexplained.
- Cron delivery seen from 2026-11-04 01:00 to 2026-11-06 05:00 UTC: 620
  five-minute slots, 618 scheduled invocations reached the tail. Three slots had
  no on-time run, all in one event on 2026-11-05: 09:35 and 09:40 never started
  and 09:30 started at 10:31:36, 61 minutes late. That is 0.5% of slots; eight
  more invocations (1.3%) ended in an exception.
- Source retention seen on 2026-11-01: `logs.workersLogs` served from 04:58
  UTC that day, `events.r2CombinedOperations` served the full 7 days queried,
  and `states.r2CombinedStorage` could not be probed (state datasets allow only
  `MAX`).
- Ingestion lag seen on 2026-11-01: the newest Worker event was 6.7 minutes old
  during steady traffic and 22 minutes old in a quiet period, so the 45 minute
  settle time has margin; keep it until several days of samples exist.
- aarch64 on a bare host: kernel, init, and reboot persistence.
- Workers Paid limits, spend alarms, and overage behavior at fleet scale.
- The Niceforge runner deep link on a live runner host.
