# Operations

## Release build

`make agent-build` runs `agent/scripts/build-static.sh`. It builds both musl
targets through the Zig wrappers in `tools/` (Zig and `python3` from `PATH`),
copies `stats-<version>-<target>` into `agent/dist/`, and writes
`SHA256SUMS` plus an `.elf.txt` program-header dump per binary. It fails if an
ELF has `PT_INTERP` or `NEEDED`. The aarch64 wrapper drops rustc's
`--fix-cortex-a53-843419` argument, which Zig does not accept.

Recorded 2026-10-31: 1,943,832 bytes x86_64 and 1,733,792 bytes aarch64,
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
make smoke-deployed        # read-only live check
```

`make deploy` runs `worker-test` and `agent-test`, deploys a fresh `vite build`
with `cf deploy --prebuilt --mode production`, runs `deploy/deployed-smoke.sh`,
then updates the hosts. `STATS_DOMAIN` defaults to `stats.17166969.xyz`.
Pass `SECRETS_FILE=...` to upload Worker secrets; omitting it leaves existing
secrets in place. The `cf` session must be authenticated (`make auth-ready`).

## First deployment

1. Create an Access application for the dashboard hostname with an owner allow
   policy, and record the team domain and audience. Access fronts the whole
   hostname, so also create path-scoped Bypass/Everyone applications for
   `<host>/health` and `<host>/ingest/*`. Without them, Access challenges
   health and ingest before the Worker sees them; the Worker still requires a
   host bearer token on ingest.
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

- aarch64 on a bare host: kernel, init, and reboot persistence.
- Workers Paid limits, spend alarms, and overage behavior at fleet scale.
- The Niceforge runner deep link on a live runner host.
