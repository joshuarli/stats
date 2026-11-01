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
```

`make deploy` runs `fixtures`, `worker-test`, and `agent-test` in order,
deploys the bundle those tests built with
`cf deploy --prebuilt --mode production`, runs `deploy/deployed-smoke.sh`,
then updates the hosts. `STATS_DOMAIN` defaults to `stats.17166969.xyz`.
Pass `SECRETS_FILE=...` to upload Worker secrets; omitting it leaves existing
secrets in place. The `cf` session must be authenticated (`make auth-ready`).

A host deploy installs through `stats.new` and `mv`, keeps the previous binary
as `/usr/local/bin/stats.prev`, and after restart polls `/api/v1/hosts` for a
new `lastReceivedAtMs` on that host. The poll uses `cf access token`, so run
`cf access login https://<host>` once before deploying a host directly.

## Rollback

A host deploy copies the current binary to `/usr/local/bin/stats.prev` before
installing the new one. `make rollback-host-<key>` restores that copy and
restarts the service; it fails if no previous binary exists.

The Worker keeps every deployed version. List them and point the deployment at
the version to restore:

```sh
cf workers deployments list --worker stats-worker
cf workers deployments create --worker stats-worker \
  --versions '[{"version_id":"<version-id>","percentage":100}]'
```

## Observability

`cloudflare.config.ts` enables Workers Logs at 10% head sampling. The Worker
writes a fixed JSON line for ingest rejections other than duplicates, alarm
failures, and the 500 catch-all, with `event`, `hostId` when known, and `code`.
The free plan includes 200,000 log events per day with three-day retention.
Set a spend alarm before raising `headSamplingRate` or the fleet size, and
lower the rate or move to Workers Paid when the allowance is close.

## Project collection

The cron (`*/5 * * * *`) and the `ANALYTICS_SQL` and `PROJECTS` bindings are
declared in `cloudflare.config.ts`. The binding reads the whole account's
analytics, which is a wider permission than the host ingest path needs; only the
fixed queries in `cloudflare/src/projects/queries.ts` ever run. Change the
project list by editing `PROJECTS` there and redeploying.

Check a deployment from your machine:

- `node cloudflare/scripts/check-parity.mjs` compares every settled stored Worker bucket of the last 24 hours with `cf sql query` and fails above 5% total error; it needs `cf access login`.
- `node cloudflare/scripts/check-analytics-sql.mjs` runs the three queries
  read-only against the live account through `cf sql query` and fails on a
  non-200 response or a row the parser rejects.
- After the first cron run, `GET /api/v1/projects` shows `collector.lastSuccessAtMs`
  and `stale: false`. If there is no run, apply schedules with
  `cf workers triggers deploy`.

Budgets, measured on the test object with fixture-shaped data (the live account
has not run the collector yet):

| Measure | Result | Target |
| --- | --- | --- |
| Binding queries per project per run | 3 | at most 6 |
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
