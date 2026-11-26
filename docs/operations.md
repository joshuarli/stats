# Operations

Production runs on OpenOrange on Lisa. See [OpenOrange](openorange.md) for
deployment and recovery. Cloudflare collection, tail and cost sections below
describe the retained provider adapter and historical data. They do not imply
that the default deployment collects new Cloudflare telemetry.

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
make stats-deploy-check    # read-only selected/running image and node version
make deploy-host-<key>     # one host from deploy/hosts.json, idempotent
make deploy-hosts          # every host in the manifest
make rollback-host-<key>   # restore /usr/local/bin/stats.prev on one host
make smoke-deployed        # read-only live check
make smoke-local           # the same check against the built Workers in local workerd
make agent-e2e             # the real agent binary against the built Worker in local workerd
make integration-local     # the offline local stack: collection, statsctl, and the dashboard
make dev-local             # a persistent local stack on http://127.0.0.1:8789; make reset-local clears it
```

`cloudflare/scripts/api.mjs <path>` reads the live API as JSON. From a tailnet
device it sends a GET to `/api/v1<path>` with no credential, and
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
config, token, and service unit, and waits for a fresh receipt. It needs a
tailnet device and SSH access to the target; `SSH=local`
installs on the machine running the command. A rerun updates only the binary,
config, or service unit that changed. A Linux host also needs an entry in
`deploy/hosts.json` to receive `make deploy-hosts` updates.

`make stats-deploy` and `make worker-deploy` build and install the OpenOrange
image on `lisa` (`ORANGE_HOST` overrides the SSH destination), then run the live
smoke through the tailnet gateway. A failed health or smoke check restores the
previous image. `make observe-deploy` is retired; observation storage is bundled
in the same Orange image. See [OpenOrange deployment](openorange.md#deploy).
`make observe-sourcemap VERSION=...` uploads a source map from a tailnet device
with no credential.

A host deploy installs through `stats.new` and `mv`, keeps the previous binary
as `/usr/local/bin/stats.prev`, and after restart polls `/api/v1/hosts` for a
new `lastReceivedAtMs` on that host. The poll needs a tailnet device and no credential.

## Ingest protocol upgrades

Ingest has no negotiation or JSON fallback. Deploy a compatible receiver before
updating agents, and include every host, not only `deploy/hosts.json`. Stage and
verify both Linux architectures and each macOS binary before stopping agents.
After deployment, run `make smoke-deployed` and check fresh receipts and retained
history for every host. A pause longer than the in-memory queue loses samples.

Roll back the receiver and affected agents together across a protocol break.
Receiver rollback and state recovery are documented in [OpenOrange](openorange.md).
`make rollback-host-<key>` restores the previous host binary and restarts it.

## Measuring a deployment with statsctl

`statsctl` answers whether a deployed version used fewer resources for the same
work. It reads the production origin through the tailnet gateway, so run it from a
tailnet device; it sends no credential:

```sh
pnpm --dir cloudflare -s statsctl help workflow
pnpm --dir cloudflare -s statsctl service inspect --service stats --json
pnpm --dir cloudflare -s statsctl service update --service discover --health-url https://hq.17166969.xyz/healthz
pnpm --dir cloudflare -s statsctl service deployments --service stats --json
pnpm --dir cloudflare -s statsctl verify --service stats --deployment DEPLOYMENT_ID --window 1h --policy bench/policies/service-example.json --json
```

Native deployments use registered services and application events. See
[project telemetry](openorange.md#service-telemetry) for request and signal reads.
The retained Cloudflare adapter uses project histories instead:

```sh
pnpm --dir cloudflare -s statsctl health --project stats --json
pnpm --dir cloudflare -s statsctl deployments --project stats --json
pnpm --dir cloudflare -s statsctl verify --project stats --deployment DEPLOYMENT_ID --window 1h --policy bench/policies/example.json --safety-check-file .work/check-hosts.json --wait --timeout 2h --json
```

`statsctl help workflow` holds the full recipes and `statsctl help verify`
the policy fields; this page does not copy them. The same binary also runs as
`node --experimental-strip-types cloudflare/src/cli/statsctl.ts`. For Cloudflare
projects, run `health` first and resolve unhealthy sources before trusting a verdict.
That command judges provider collection and tail data, which are unavailable on
the default OpenOrange deployment. Exit codes: 0 read
succeeded or improved, 2 usage, 3 authentication, 4 transport or contract
failure, 5 pending or insufficient data, 6 unchanged or confounded, 7
regressed, 8 `observe rollouts` found settled rollouts to look at. `--json` prints one `statsctl/1` document. Resumable verdict state
and snapshots live under `.work/statsctl/`. `https://stats.17166969.xyz` and loopback origins are the orange target, tailnet
names are Node origins, and any other origin needs `STATSCTL_TARGET`.

### Checking Cloudflare tail rollouts

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
need a tailnet device.

Run `statsctl check hosts --hosts lisa,threadripper --max-age 2m --json` after deployment begins. Save the output as `.work/check-hosts.json` for the verification safety check. Every expected host must report a receipt after deployment begins.

Deploy order matters for measurement. `stats` publishes one `operation` message
per instrumented invocation, and `stats-observe` must already accept it:
`make observe-deploy` goes first. Never roll `stats-observe` back below the
version that accepts `operation` while `stats` still emits it. The older tail
rejects those invocations as `rejected-invalid`, and the operation tables stop
filling.

### The statsctl contract

Command definitions in `cloudflare/src/cli/commands/` own supported targets,
mutation access, flags and examples. Run `statsctl help workflow` and the
command's help before use. `--json` returns one `statsctl/1` envelope; diagnostics
go to stderr. Decoders reject incompatible schemas rather than guessing.

Read requests use gateway identity. Mutations that need host or service tokens
read protected credential files. Never put tokens in argv, snapshots or reports.
`cloudflare/src/cli/http.ts` owns request limits and read retries, and
`cloudflare/src/cli/snapshot-store.ts` owns snapshot integrity and retention.

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

- **Scheduling.** The deploy-verify-keep or roll-back loop stays run by hand.
  Automation is only worth deciding after a candidate is measured on a
  representative workload, and that evidence does not exist yet. If the loop is
  ever scheduled, it uses a committed verification policy, restores the
  previously validated version on exit 7, and stops at an explicit spend
  ceiling.

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
access-control coverage as an optimization.

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

- `node cloudflare/scripts/check-parity.mjs` compares every settled stored Worker bucket of the last 24 hours with `cf sql query` and fails above 5% total error; it needs a tailnet device and a `cf` session for the account query.
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

## Cloudflare adapter deployment reference

The default Make deployment targets install OpenOrange. The retained Cloudflare
build uses `cloudflare/cloudflare.config.ts` and the generated Build Output.
`make worker-check` validates that output without uploading it.

A provider deployment needs its Analytics SQL and service bindings plus a private
gateway that supplies the secret and asserted tailnet identity required by
`cloudflare/src/cloudflare/gateway.ts`. The former Access JWT setup is not the
current authorization contract. Keep data recovery and host protocol compatibility
separate from provider activation; see [architecture](architecture.md#worker).

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
  node --experimental-strip-types src/node/main.ts
```

| Variable | Meaning |
| --- | --- |
| `STATS_DATA_DIR` | Required. An existing directory; the database is `stats.sqlite` inside it. Only one server may use it at a time: the server holds an exclusive SQLite lock, and a second one exits 2 with `stats: STATS_DATA_DIR ... is in use by another server`. |
| `STATS_SOURCE_COMMIT` | Optional lowercase hexadecimal source commit identifier, exposed in startup identity and the authenticated runtime snapshot. |
| `APPLICATION_EVENTS_RELEASE` | Enables Node application observations when set to a valid release identifier. Events are buffered in process and written to the `stats` observation store. |
| `STATS_AUTH` | Required: `tailscale` or `gateway`; there is no default, so a unit that loses the setting fails to start instead of trusting identity headers. Gateway mode requires the trusted proxy to strip identity headers and assert its secret and tailnet identity. |
| `STATS_GATEWAY_SECRET_FILE` | In gateway mode, path to a readable file containing the shared single-line secret. |
| `STATS_LISTEN` | `IPV4:PORT`, `[IPV6]:PORT`, or `unix:/absolute/path.sock`. Default `127.0.0.1:18791`; port `0` picks a free one. A socket's directory must exist; a stale socket file is replaced, a live one stops startup with exit 2, and the socket is `0600` and removed on shutdown. |

A missing or invalid value stops startup with exit code 2 and a
`stats: <variable> ...` line on stderr. Once listening, the server prints
`{"event":"listening","host":...,"port":...}` and logs the loaded release, source commit, Node version and known schema versions. The authenticated runtime snapshot exposes the same identity; observation database schema version is unavailable because that store has no version marker. On SIGTERM or SIGINT it
stops accepting connections, drains requests, stops sampling, cancels and joins active probes, flushes observations, and closes the databases. It closes remaining connections after eight seconds and enforces a ten-second shutdown deadline.

All file-backed Node databases use WAL with exclusive locking, `synchronous=FULL`, a 1-second busy timeout, and a truncating checkpoint every 60 seconds. Checkpoint results appear in the runtime snapshot.

Back up the whole `STATS_DATA_DIR` while the server is stopped. Include
`stats.sqlite`, the `stats.sqlite.observe` directory, and the `stats.sqlite.metrics` directory. The observation directory contains one database per observation service. Preserve the original observation tables
in `stats.sqlite` when inspecting ambiguous legacy data. Migration copies only
rows whose service ownership is known, preserves issue resolution, and records
completion in each destination transaction. Restart resumes an interrupted copy.

Deployment starts an isolated candidate and checks health before stopping the
current container. It retains the previous container until the replacement
passes health, and restores it if
the replacement fails. Preflight uses an empty database and cannot prove a
production data migration. Take the stopped backup before an upgrade.

In the default `tailscale` mode, every path other than `/health` and ingest needs a
`Tailscale-User-Login` header, which `tailscale serve` adds for tailnet users,
and a loopback TCP peer. A connection on a Unix socket has no TCP peer and is
trusted as transport, because only the owning user and root can open it; it
still needs the header:

```sh
tailscale serve --bg --http=18790 http://127.0.0.1:18791
```

In `gateway` mode, the trusted proxy instead supplies `Stats-Gateway-Secret` and
`Stats-Tailnet-Identity`. Protect the secret file and restrict access to the
Node listener; the proxy must remove client-supplied identity headers before
adding its own.

Because `tailscale serve` attaches the identity to every request from a
user's device, a page on another site could otherwise drive writes. Every
`/api/v1` request that is not `GET`, `HEAD`, or `OPTIONS` is rejected with
`403 forbidden` when its `Origin` differs from the request's own origin
(`Host`, with `X-Forwarded-Proto: https` for TLS) or its `Sec-Fetch-Site` is
`cross-site`. Clients that send neither header, such as `curl` and
`statsctl`, are unaffected. `POST /api/v1/admin/hosts` also requires
`Content-Type: application/json` and answers `415 unsupported_media_type`
otherwise. The Worker applies the same rule behind the gateway.

### Production in the Threadripper guest

Since 2026-11-26 production Stats is the Node server in the
`stats-recovery-vm` guest, behind the unchanged route: Lisa's Caddy
(`stats.17166969.xyz`, identity sidecar, `Stats-Gateway-Secret`) →
`127.0.0.1:18489` → `oo-stats-live-tunnel` → guest `127.0.0.1:8080`.
OpenOrange, Rivet and the Engine container are stopped and out of the
runlevel; their data stays on the guest disk untouched.

The guest has 2 GiB and a virtio balloon with free page reporting
([unit](../deploy/orange/recovery/stats-recovery-vm.openrc)); its cgroup
reserves `memory.min 1G`. Until 2026-11-26 it had 4 GiB and a 5 GiB
reservation, and QEMU kept every page the guest had touched, so the host
showed about 4.1 GiB resident while Stats used under 300 MiB (mostly page
cache). After the change the host shows about 640 MiB and the guest 180 MiB
used.

| Piece | Location |
| --- | --- |
| Unit | `/etc/init.d/stats-node` ([source](../deploy/node/stats-node.openrc)), instance `stats-node.main`, user `stats-node` |
| Release | `/opt/stats-node/releases/<commit12>/cloudflare/src/node/main.mjs` and the built assets beside it; `MANIFEST.sha256` lists every file |
| Configuration | `/etc/conf.d/stats-node.main` (`stats_release`, `stats_source_commit`, `stats_data`, `stats_listen`) |
| Secrets | `/etc/stats-node/gateway-secret`, `/etc/stats-node/verifiers.env` (infra and platform token verifiers), root:stats-node 0640 |
| Data | `/var/lib/stats-node/main/`: `stats.sqlite`, `stats.sqlite.observe/`, `stats.sqlite.metrics/`, `RESET.json` |

The server runs with `STATS_AUTH=gateway` and the guest's ordinary network, so
service probes reach their health URLs. Build a release with
`pnpm --dir cloudflare build && (cd cloudflare && node scripts/bundle-node.mjs)`,
copy `main.mjs` to `cloudflare/src/node/` and the assets directory to
`cloudflare/.cloudflare/output/v0/workers/default/` of a new release
directory, point `stats_release` at it and run
`rc-service stats-node.main restart`. A restart takes about one second to
readiness (ten cycles measured 0.66–1.03 s).

The cutover started a fresh installation: the OpenOrange installation answered
503 on its admin and host routes, so no logical export was possible. Host IDs,
names and token verifiers and service registrations were rebuilt from each
producer's own configuration with
[`restore-registrations.mjs`](../deploy/node/restore-registrations.mjs). Its
input holds only SHA-256 verifiers (`tokenSha256`, `deployTokenSha256`,
`ingestTokenSha256`) computed on each producer, so no plaintext token is
copied to the guest. It
writes `RESET.json` with the restored names and any service left without a
usable token (`agentctl-node`, `oo-platform`, `oo-tunnel`, the ingest token
of `stats` and the deploy token of `tansu`). Telemetry before 2026-11-26
04:57 UTC is not in this installation.

The rebuild missed `m1-max`, whose agent was not among the configurations
read; it was registered at 09:30 UTC from its own `hostId` and token
verifier, so the agent kept its credential. At 09:35 UTC each token named in
`RESET.json` was rotated with `statsctl service token rotate` into
`~/.config/stats/services/NAME.json` on sentry. Each new ingest token was
confirmed with a non-JSON batch (415 rather than 401) and each deploy token
with an empty marker (400 rather than 401), so nothing was written. No
producer reads the `agentctl-node`, `oo-tunnel` or `stats` tokens.
`oo-platform` (`/etc/openorange/platform.env`) and `agentctl` on Lisa still
send to the retired Lisa container at `172.29.80.20:8080`; repointing them
means changing and restarting the parked apps' shared infrastructure, which
is left to their owner. Tansu reads its deploy token through
`STATS_DEPLOY_TOKEN_FILE`; point it at `~/.config/stats/services/tansu.json`.

### In a container on threadripper

The Vite SSR build bundles its runtime dependencies. The packaging regression
stages only that bundle and its assets, then denies workspace reads.

```sh
make node-deploy
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
markers and deployments work there, as do `observe application`, `check hosts`
and `verify --service`. Project/Cloudflare-only commands exit 2 with
`unsupported_on_target` before a request. Command help lists the supported
targets.

Verify the expected online roster with an authenticated read from the
service that accepts production ingest.

```sh
pnpm --dir cloudflare -s statsctl check hosts --hosts lisa,threadripper,sentry,tim,m1-max --max-age 2m --json
```

Exit 7 means at least one expected host is missing, ambiguous, revoked,
or stale. The check uses the server receipt timestamp, so a dashboard
snapshot can return HTTP 200 while this check fails. Repeat across two
reporting intervals during recovery and verify history for the affected
range separately.

## Services and deploy markers

A service names the hosts a deployable runs on. A deploy script records each
release with a marker, authenticated by the service's deploy token. Routes,
rules, and responses are in `docs/architecture.md`
([Services and deploy markers](architecture.md#services-and-deploy-markers)).
The statsctl commands `deploy mark`, `services`, and `service deployments`
record and read markers.

Create a service once with a human credential. The 201 response is the only
place the deploy token appears, so write it straight to an owner-only file.
From a tailnet device the gateway asserts identity, so the request carries no
credential:

```sh
umask 077
mkdir -p .work/credentials
curl -sS https://stats.17166969.xyz/api/v1/admin/services \
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
  -d '{"name":"stats-node","hostIds":["h_..."],"healthUrl":"https://stats-node.example.com/health"}' \
  > .work/credentials/stats-node-deploy.json
```

Record a deploy after it succeeds. The token file is the creation response
saved above. `statsctl` checks its mode is 0600 and its `name` equals `--service`,
sends the token only in the `Authorization` header, and sends no other
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
and so does a redirect or login page (`access_challenge`).

The marker `POST` goes to `/ingest/services/NAME/deployments` and ignores
gateway and Tailscale identity, so any process that can reach the origin can
mark with the token; the readback stays on `/api/v1` and needs identity.

### Comparing a service's deployments

Once a service has two markers more than the window apart and its hosts have
reported across both, the dashboard's Services page and `statsctl verify` compare
them. The Services page is `#/services`. It groups services by host, with the
busiest host first and one CPU scale across hosts, so a service on two hosts
appears under each. A service page is `#/service/NAME`, with
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

The Node server probes each service's `healthUrl` every 60 seconds. Configure a
reachable endpoint for every service. A container without access to an
endpoint records the probe as down.

## Verified environments

Historical validation, superseded as production status by the 2026-11-14
[OpenOrange cutover](openorange.md#cutover-record-2026-11-14).

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

## Historical ingest cutover

2026-11-04: deployed `stats` version
`2f38a11c-a42e-4cb4-8101-2cfe16c4d865` and `stats-observe` version
`eff00be4-1139-4790-9dc5-54487d41285e`, replacing `stats` version
`3a4ea033-34f4-492c-99a7-7899874fd227`. Updated `threadripper` (x86_64,
`deploy/hosts.json`), `sentry` (macOS arm64, local), and `m1-max` (macOS
arm64, `make add-host`). All three reported fresh receipts, and 24-hour,
7-day, and 30-day history still returned points from before the cutover.
