# Native deployment on lisa (no Docker)

The owner approved the native OpenRC migration on November 17, 2026.
Production Stats is temporarily writable on Threadripper, with the
original Docker app fenced on Lisa. The fresh backup and restore gate
governs the production cutover. See the
[live failover record](native-lisa-retro.md#live-stats-failover) for the
authority and failback requirements.

## Rehearsal progress

An x86_64 Alpine 3.24.4 VM on Threadripper runs Rivet Engine, versitygw and
both Stats Workers as unprivileged OpenRC services. The Engine and store
health routes returned HTTP 200. The Stats hosts API returned HTTP 401
directly and HTTP 200 through a private test gateway. The dashboard also
returned HTTP 200 through that gateway.

The VM used Stats release `c9a71b2ba127`, Node `26.13.1` and
`pnpm install --frozen-lockfile --prod --ignore-scripts --ignore-workspace`
with the release's lockfile. The Engine came from the published
`@rivetkit/engine-cli-linux-x64-musl@3.1.2-rc.1` tarball. Its SHA-512
integrity matched the lockfile, its binary SHA-256 was
`6240078a9f3df8c0a746bf3bb614892c76bcb5df0815e15e5f6f338ad67d6200`,
and it reported Rivet 3.1.1. The static versitygw v1.11.0 binary from the
pinned store image had SHA-256
`e7e173e1297abf444302383f8d00bb5936d648f294a7095f4c27922c466fee05`.

To reproduce the build from a committed checkout, use the pinned Node and
pnpm and generate a fresh context. `app/` holds the two Workers and the
dashboard. `orange/` holds the locked runtime installation inputs.

```sh
make work-ready node-ready
bundle=$(mktemp -d "$PWD/.work/tmp/native-stats.XXXXXX")
TMPDIR="$PWD/.work/tmp" sh deploy/orange/build-context.sh "$bundle" "$(git rev-parse --short=12 HEAD)"
```

On the isolated VM, create the Engine's log and object directories before
starting it. Create each log with its service user's ownership before
starting OpenRC. Bind the Engine guard, peer API, metrics, store and Stats
listeners to loopback. Provision the fresh namespace and its `default`
and `services` pools before starting `orange serve`. Give Stats a writable
`.open-orange` directory and a private home. Use temporary credentials
supplied through protected service configuration.

To rehearse a restore, delete `vars.APPLICATION_EVENTS_RELEASE` from the
rehearsal copy of `app/stats.jsonc` before the first boot. The first import
attempt returned HTTP 409 because Stats self-observation had populated
`observe_external_events`. Use a fresh namespace, expose it through the
existing test gateway over loopback and run `statsctl backup import` against
that gateway. Keep the production bundle unchanged.

The clean retry imported the November 14 historical export into the native
stack. The CLI verified all manifests and table hashes and reported 627,253
rows across 10 objects. The authenticated hosts API returned six restored
hosts. The native Stats endpoint then accepted both samples from the
`linux-normal` STB2 fixture and served their host history. The native
store passed all required checks in Stuff's `bin/s3-conformance`, including
multipart upload and byte-for-byte download. It returned HTTP 400 on the
optional `GET ?partNumber=2` probe.

The fresh production export is blocked at the Stats backup object listing,
which returned HTTP 503 before and after a same-image Engine restart.
Production unit changes, ingress migration and soak remain open.

The Engine rollback rehearsal stopped the native services and booted a
separate VM disk overlay with the same state. It ran the deployed Engine
image at digest
`sha256:6e585002b700dd4d3630808eb67884aa15d1a602d83781984edac47023b6d40f`
against the cloned native data paths. The authenticated Engine namespace
list reopened, and the native Stats worker read the same seven host IDs
and the fixture history from the Docker Engine. The SHA-256 of the sorted
host IDs was `4c414fdbfc4b092051900de9d23535827e40aa977a031fa0decbf3cdbf8e4534`
before and after. The production OpenRC unit switch and rollback for the
remaining services still need rehearsal.

## Why now, and what native is not

The 2026-11-17 outage was not a container failure: the Rivet engine refused to
start because the root filesystem was at 98% (emptying it is what restored
service). Running natively would not have prevented it. What native buys:
fewer layers on a constrained host, no image storage, no docker daemon, a
single OOM/CPU view per process, and one less reason for things to be opaque.
What it costs: reimplementing pinning, supervision, and health for every
component by hand, and giving up upstream's tested container boundary.

## Current state (all Docker, all on lisa)

Alpine 3.25, musl, x86_64, OpenRC. `lisa` is also a co-tenant build host
(niceforge CI) and runs Tansu, the tailnet DNS/edge, and the whole shared
OpenOrange stack. Tailnet address `100.68.104.43`.

| Component | Runs as | State |
| --- | --- | --- |
| Rivet Engine (`oo-engine`) | container, `rivetdev/engine` (glibc Debian, `3.1.2-rc.1` image, reports 3.1.1) | host bind mount `/var/lib/openorange/engine/{log,objects}` (2.2 GB + 1.2 GB) |
| versitygw S3 (`oo-store`) | container | `/var/lib/openorange/store/{data,versions,iam}`, 10.3 GB |
| Caddy ingress (`oo-ingress`) | container, custom xcaddy build with cloudflare DNS module, host network, binds 100.68.104.43:443 | `/var/lib/openorange/caddy` |
| identity sidecar (`oo-identity`) | container, python stdlib-only | unix socket `/run/openorange/identity/identity.sock` |
| CoreDNS (`oo-dns`) | container | static Corefile bind mount |
| cloudflared (`oo-tunnel`) | container | tunnel creds in `/etc/openorange/tunnel.env` |
| Platform collector (`oo-platform`) | container | protected policy and receiver credentials under `/etc/openorange` |
| Rivet dashboard (`oo-rivet`) | container | protected Engine and gateway configuration under `/etc/openorange/rivet` |
| Apps: stats, stuff, discover, discover-preview, nanoshop, agentctl | containers, `orange serve` on Node 26.13.1 Debian | assets+closure in image; durable state in Engine actors (namespace per app) |
| Tansu, `stats-perf` fixture | native OpenRC | precedent for kind = "native" |

Every OpenRC unit (`oo-engine`, `oo-store`, `oo-identity`, `oo-ingress`,
`oo-app.NAME`) is a thin supervise-daemon wrapper around `docker run --rm`.

Per-app deploy today: `make stats-deploy` builds an image on the Mac, rsyncs a
build context to `lisa`, `docker build`, then `oo set-image stats <image>` and
`rc-service oo-app.stats restart`, then health/smoke. The image is a
`node:26.13.1-bookworm-slim` with the pinned `deploy/orange` closure
(`open-orange` 1.0.2, `rivetkit` 3.1.2-rc.1, `@rivet-dev/services` 0.2.5) and
the built Vite assets under `/app`.

## What native means here

No container runtime in the serving path. OpenRC supervises host binaries
directly. Docker may remain for offline builds (`make agent-build` already
does this) and for image creation during the transition only. The plan assumes
Alpine stays (not a glibc reinstall): every component has a musl path.

Costs ~2–4 days of engineering plus rehearsal and a soak; touches every app on
the host, not just Stats. It is a platform change owned in the `stuff` repo
(`deploy/openorange/`), with `stats` gaining a native deploy path.

## Component by component

| Component | Native candidate | Notes |
| --- | --- | --- |
| Rivet Engine | `@rivetkit/engine-cli-linux-x64-musl@3.1.2-rc.1` (static-pie Rust, `libc: [glibc, musl]`, published on npm; pin sha256) | open-orange declares Linux x64/arm64 musl a supported host and resolves this package at runtime. Engine command is `rivet-engine --config /etc/rivet/config.json` with `RIVET__AUTH__ADMIN_TOKEN`. Data dirs unchanged → no state migration. Verify `--version` prints 3.1.1 and `/health` answers before trusting it; the deployed glibc image reports the same, so version string cannot distinguish them — pin by npm tarball sha256 + verify report, not `--version`. Re-check what the **image** actually ships: the musl build is a few MB, the image is Debian; the engines differ only by libc, but that is unproven until run. |
| versitygw | Go binary; no apk package; build with `apk add go` or pin a release/static build + sha256 | codelist pins it by image digest today; native replaces digest pin with binary sha256 in `images.lock.json` equivalent. posix backend paths unchanged. |
| Caddy ingress | xcaddy build (caddy 2.11.9 + caddy-dns/cloudflare v0.2.4), static musl; `apk caddy` 2.11.4 lacks the module | `cap_net_bind_service=ep` on the binary or uid 10001; binds only 100.68.104.43:443 and the public 127.0.0.1:18480 listener. The xcaddy build is reproducible today; the ingress Dockerfile does exactly this, minus the musl target. |
| identity sidecar | `apk add python3` (stdlib only) | Already a plain script; runs native with `--network none` semantics replaced by "only listens on /run/openorange/identity/identity.sock, no egress" (tailscaled LocalAPI whois probing stays). |
| CoreDNS | `apk add coredns` 1.15.0 (static Go) | Corefile unchanged. |
| cloudflared | no apk package; pin GitHub release binary + sha256, or build from tag | Same config; health is the tunnel's own metrics. |
| Platform collector and Rivet dashboard | Package their existing entry points and assets for OpenRC | Preserve Stats observation delivery and the authenticated Rivet operator route. |
| Node apps | `apk add nodejs-current` 26.13.1-r0 (edge/community) — exact match to the image's Node 26.13.1 | `orange serve --config stats.jsonc --config observe.jsonc`. The app closure installs on lisa with `pnpm install --prod --ignore-workspace` (same lockfile as the image), assets come from the Mac-side build (build-image.sh minus the docker build), synced to `/opt/openorange/app-releases/stats/<sha>`; `/opt/openorange/apps/stats` is a symlink switched atomically. |
| Tansu, stats-perf | already native | unchanged |

## Layout and networking

- Loopback only: engine `127.0.0.1:6420`, store `127.0.0.1:7070`, each app
  `127.0.0.1:808x`. No bridge, no static IPs, no per-app /24 reservation.
- Caddy binds the tailnet HTTPS address and the loopback public origin.
  Split DNS continues to bind the tailnet address on port 53. Caddy's app
  upstreams move to loopback as each app moves.
- Unix sockets for host IPC that already uses them (identity).
- `/etc/openorange`, `/var/lib/openorange`, `/var/log/openorange`,
  `/run/openorange` unchanged; engine/store state paths unchanged.
- Preserve the current network trust boundaries. Use distinct service UIDs
  and private credentials, drop capabilities and apply cgroup resource limits.
  Loopback listeners restrict incoming connections. Apply and verify separate
  egress controls for apps currently confined by the internal Docker bridge.

## OpenRC and tooling changes (stuff repo)

- `deploy/openorange/openrc/*`: drop the `docker run` command, exec the
  binary directly as the service user. Keep supervise-daemon, respawn limits,
  `output_log`, and `oo_wait` readiness gates.
- `lib/oolib.py`: `run_args` produces `env`+`exec` plans instead of docker
  argv. `bin/pin-verify` grows a `binaries.lock.json` (sha256 per binary)
  replacing image digest checks; keep `images.lock.json` until cutover is
  complete.
- Engine unit: `--user rivet` equivalent, `ulimit -n 1048576`, tmpfs /var/lib/rivet
  equivalent is unnecessary since state dirs are host paths already.
- `oo render` unchanged in behavior (same files it writes today), plus it
  rewrites app upstreams to loopback.
- Stats repo: `deploy/orange/deploy.mts` becomes build+rsync+`swap` (symlink
  switch, restart `oo-app.stats`, health/smoke) instead of image build+set-image.
  `make stats-deploy` is unchanged from the operator's point of view.
- `oo set-image`/`record-deployment` become `oo set-release`/markers; the
  deployment-marker contract (`docs/deployments.md`) is preserved — a native
  release id `<git-sha>` replaces the image tag, carried the same way.

## Rollout

1. **Backup first, on lisa:** fence stats
   (`pnpm --dir cloudflare -s statsctl backup fence --state fenced`), export,
   verify digests, unfence. This is the existing recovery contract and needs no
   new machinery.
2. **Rehearsal on a scratch Alpine VM or spare host** (x86_64): install the
   native stack with the rehearsal overlay (demo app, demo bucket/namespace),
   verify ingest→actors→dashboard end-to-end with fixtures, then rehearse
   *restore from the fenced export* into the native stack. This is the one
   step that proves the plan; don't skip it.
3. **Cutover, separate windows, on lisa:** (a) store+engine first with stats
   fenced, apps stopped, units swapped; verify engine `/health`, store
   multipart probe, then apps; (b) stats app next (`make stats-deploy` native
   path); (c) remaining apps, platform collector, Rivet dashboard, ingress,
   DNS, identity and tunnel last. To roll back a step, restore the fence,
   swap its units back to Docker and start them. Verify application reads and
   resume writes after the rollback passes.
4. **Soak 2 weeks** (docker units and images kept), then delete the image
   references, and only then retire `images.lock.json` and the docker paths.

The first cutover window must preserve reachability for applications still
on the internal Docker bridge. Rehearse restricted listeners on the existing
bridge addresses during the transition, or move the shared runtime and its
remaining clients in the same window. A loopback-only Engine and store
cannot serve the existing container network.

## Known risks / unknowns

- **The engine-musl path is unproven in production** (musl binary exists and
  open-orange supports it, but the tested/rehearsed production engine is the
  glibc image). Mitigation: step 2, plus engine cutover with instant docker
  rollback and pre-staged verification.
- **Ops tooling parity**: every `docker inspect`-based check (`deploy.mts`
  verify, bench harnesses, `docs/openorange.md`) must be reimplemented;
  incomplete parity fails loudly but expensively. Inventory:
  `rg -n "docker (inspect|run|ps|exec)"` in both repos.
- **Niceforge co-tenancy** is unchanged in shape but now invisible to docker;
  make sure ops tooling does not assume `docker ps` covers host capacity.
- **The 2026-11-17 class of failure (ENOSPC) is unaffected** by this plan.
  If this work is ordered to fix that outage, it will not. Disk budgets,
  alerting, and the niceforge cleanup are the actual fix.
- caddy-dns/cloudflare musl static build needs re-verification of ACME
  DNS-01 against the real zone before cutover.

## Decision gates

1. Do the step-2 rehearsal with the engine-musl binary and restore-from-export
   before committing to the cutover. If that fails, stop: either stay on
   docker/OpenOrange, or move lisa to a glibc distro and keep the same native
   layout (that path needs no musl trust).
2. Cutover only after a fenced full backup verifies by import into the
   rehearsal environment.
3. Native cutover on lisa only with the stats fence procedure rehearsed and
   a tested rollback to docker.

## Recommendation

Proceed, but as a scheduled project, not as an incident response. Sequence it
after lisa is stable and the disk question is settled (the 400 GB in `/home`
is the actual capacity problem; `docker images` were ~18 GB of it). If the
rehearsal in step 2 shows engine-musl trouble, the fallback is the glibc
distro reinstall with the same native layout, which keeps every other step of
this plan unchanged.
