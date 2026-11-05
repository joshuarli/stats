# Operations

## Release build

`make agent-build` runs `agent/scripts/build-static.sh`. It requires Zig
0.17.0 and `python3` on `PATH`, builds both musl targets through the Zig
wrappers in `tools/` with `cargo build --locked`, copies
`stats-<version>-<target>` into `agent/dist/`, and rewrites `SHA256SUMS` plus
an `.elf.txt` program-header dump per binary. Older artifacts are left in
place. It fails if an ELF has `PT_INTERP` or `NEEDED`. The aarch64 wrapper
drops rustc's `--fix-cortex-a53-843419` argument, which Zig does not accept.

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
make smoke-local           # the same check against the built Worker in local workerd
make agent-e2e             # the real agent binary against the built Worker in local workerd
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
secrets in place. The `cf` session must be authenticated (`make auth-ready`).

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
   `agent-e2e`, `smoke-local`, the dashboard suite, lint), then
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
   source map), for changes that leave the observe companion untouched.
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
regressed. `--json` prints one `statsctl/1` document. Resumable verdict state
and snapshots live under `.work/statsctl/`. Authentication runs
`cf access token <origin>`; set `STATSCTL_AUTH_COMMAND` and
`STATSCTL_AUTH_HEADER` to use another credential source.

Every command reads except `check ingest`, which writes one flagged sample and
takes the `synthetic-check` host's credential from
`.work/credentials/synthetic-check.json`. Run it only inside a deployment's
excluded bucket and warm-up interval, so its sample never enters a measured
window.

Deploy order matters for measurement. `stats` publishes one `operation` message
per instrumented invocation, and `stats-observe` must already accept it:
`make observe-deploy` goes first. Never roll `stats-observe` back below the
version that accepts `operation` while `stats` still emits it. The older tail
rejects those invocations as `rejected-invalid`, and the operation tables stop
filling.

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
Worker, without project collection, deployment tracking, or observe (see
`docs/architecture.md`). It needs the Node version in `.node-version` and the
built dashboard, and runs from the repository:

```sh
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
| `STATS_LISTEN` | `IPV4:PORT` or `[IPV6]:PORT`. Default `127.0.0.1:18791`; port `0` picks a free one. |
| `STATS_ALLOWED_LOGINS` | Required. Comma-separated Tailscale logins allowed to read the API and dashboard. |

A missing or invalid value stops startup with exit code 2 and a
`stats: <variable> ...` line on stderr. Once listening, the server prints
`{"event":"listening","host":...,"port":...}`. On SIGTERM or SIGINT it
stops accepting connections, finishes requests in flight, closes the
database, and exits 0.

Every path other than `/health` and ingest needs a loopback peer and an
allowed `Tailscale-User-Login` header, which `tailscale serve` adds for
tailnet users:

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

```sh
STATS_ALLOWED_LOGINS=joshua.r.li.98@gmail.com make node-deploy
```

`deploy/node/deploy.sh` refuses a tree with uncommitted tracked changes,
because the image is tagged with the commit. It builds the dashboard here,
copies `cloudflare/src`, the built assets, and `deploy/node/Dockerfile` to
`~/stats-node-build/<commit>` on the host, and builds `stats-node:<commit>`
there from `node:26.12.1-alpine`, which is the only image on the host it
uses. It then replaces the `stats-node` container, which runs as `node` on
the host network and listens on `127.0.0.1:18791`. The container keeps the
database in `~/.local/share/stats-node` and is started with
`--restart unless-stopped`. The deploy waits for `/health` and prints the
tag, with the full output in `.work/tmp/node-deploy.log`.

The container uses the host network because Docker's bridge network would
present every request as coming from its gateway, and the auth adapter
trusts loopback peers only. The tailnet reaches the server only through
`tailscale serve`; nothing else listens beyond loopback. The deploy stops
if the host has under 50 GB free.

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
`tailscale serve` adds the identity. Only `check ingest` works there; every
other command reads Cloudflare telemetry and exits 2 with
`unsupported_on_target` before any request. Store the `synthetic-check` host
credential (`{hostId, name, token}`, mode 0600) and run:

```sh
pnpm --dir cloudflare -s statsctl check ingest --origin http://threadripper.tailcf741.ts.net:18790 --credential-file .work/credentials/synthetic-check-node.json
```

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
  [`bpf/README.md`](../bpf/README.md).

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
