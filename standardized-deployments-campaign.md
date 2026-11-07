# Campaign: Standardized deployments and first-class Stats integration

Goal: Tansu and Niceforge each ship `make deploy` / `make rollback` with a real
release lifecycle, publish accurate deployment markers, and stream privacy-safe
application telemetry to Stats through one contract Stats owns.

Repositories: `/Users/josh/d/stats`, `/Users/josh/d/tansu`, `/Users/josh/d/niceforge`.

## Status

Goal: standard deployments + Stats application telemetry.
Accepted: `S1`, `S2`, `S3`, `S4`, `S5`, `S6`, `S7`, `S8`, `S9`, `S10`, `S11`. Next: `S12`.
Released: `v0.1.0` with macOS and Linux agent binaries, `statsctl`, `install.sh`, and `SHA256SUMS`.
Red: none. Parked: producer registry publication (owner action; `make publish-producer` needs R2 S3 credentials and `make publish-producer-crate` was not attempted). `S11` uses the local `@stats/producer` file dependency until D3 is published.

## Charter

- Decide and keep going. Record a decision only when a later slice depends on it.
- Parity before optimization. Performance budgets are measured and logged, not gating, until `O1`.
- Fix anything egregiously slow or plainly broken that you meet, in its own commit, when it costs under 60 s of measured wall time or is a correctness bug on a path you already touch. Record anything else and leave it.
- One writer at a time. No parallel lanes: every slice touches `cloudflare/src/cli/` or `cloudflare/src/core/installation/` in Stats, or a single app's deploy script.
- Worktrees live in `.work/wt/<lane>`; scratch in `.work/tmp`. Never `/tmp` or `$TMPDIR`.
- Every commit is a Conventional Commit with the workstream as scope; the item ID goes in the body. Code comments never cite this doc.
- Stage only your own changes. Never rewrite history, never discard unrelated local modifications, never amend a pushed commit.
- **Pushing is forbidden.** Commit locally and stop. The owner pushes.
- No formatters.
- Git history is the log. Rewrite **Status** in place; never append checkpoints, handoffs, or dated notes.
- Do not claim a test, deployment, metric, or production result that did not happen. If a check could not run, say so and leave it red.

Hard stops — park the item, record the cause and a retry condition, continue elsewhere:

- An action needing credentials, hosts, or authority listed under **Needs environment**.
- Anything that would mutate the running `niceforge-core` instance on threadripper or its repositories.
- A release, tag, or registry publish (owner action; see **Decisions** D2).
- Any test that cannot be made green after 3 attempts.

## Decisions

**D1 · OpenRC only; delete the systemd path.** Owner, 2026-11-06.
`deploy/hosts.json` declares `lisa` and `threadripper` as `init: openrc`,
`elevate: doas`; both were verified Alpine 3.2x with `/sbin/openrc` and
passwordless `doas`. Tansu's `deploy/install.sh` writes
`/etc/systemd/system/tansu.service` and `deploy/deploy.sh` preflights
`command -v systemctl`, so it cannot deploy to either real host today. Remove
the systemd unit writer and the `systemctl` preflight rather than keeping an
untested branch. Reverses if a systemd-only host is added to `deploy/hosts.json`.

**D2 · Build `statsctl` locally; releasing is an owner action.** Owner, 2026-11-06.
`gh release list` and `git tag` are both empty and `dist/` is gitignored, so no
released artifact exists. The campaign builds the bundle with
`./scripts/build-statsctl.sh` into `dist/statsctl-<version>.mjs` and deploys that
path. No slice tags, creates a release, or uploads an artifact. The owner
publishes when they choose.

**D3 · SDKs publish to the private registries; no cross-repo path dependency.**
Owner, 2026-11-06. `~/d/stuff` is present, `deploy/publish` `mynpm`/`mycrates`
exist, and `sh deploy/publish mycrates --republish` verified live `current`.
Publish `@stats/producer` to `npm.17166969.xyz` and `stats-producer` to
`crates.17166969.xyz`, both versioned in `docs/` and consumed as pinned
dependencies. Applications must build with only `pnpm install` / `cargo build`,
never a `../stats` path. A local `file:` / `path` override is allowed only for
development and must be documented as such. Reverses if registry publishing
stops working: fall back to vendor-the-source with a drift check, never to a
production `../stats` path.

**D4 · No live deployment of Niceforge or Tansu.** Owner, 2026-11-06.
`niceforge-core` is running on threadripper with live repositories; deletion,
corruption, or upgrade of that instance is out of bounds. Every lifecycle proof
runs against disposable local targets. Actual activation is on **Needs
environment**.

**D5 · One contract document owned by Stats.** Prescribed.
`docs/integration.md` in Stats is the single authoritative specification for
service/host/release/attempt identity, health semantics, the telemetry protocol
version, credential scope, telemetry failure semantics, rollback semantics, and
deployment-to-observation correlation. Tansu and Niceforge each document only
their concrete implementation and link here. Any change to a numbered section
is a contract change: surface it in the commit body with `!`. Reverses if the
owner asks for a per-repository specification.

**D6 · Two credential capabilities, both new; no widening.** Prescribed.
Deployment tokens keep their current single capability (publish markers only)
and gain rotation/revocation. Application ingestion is a *separate* token row
scoped to exactly one service, which cannot publish markers. Host tokens are
untouched. A service creation response returns both once; the server stores
only SHA-256 verifiers. Never repurpose an existing token's privilege: a leaked
old token stays valid only until explicitly rotated or revoked, and both
actions are tested.

**D7 · Ingestion storage reuses the observe core; provenance is a field, not a
parallel database.** Prescribed. `cloudflare/src/observe/core/store.ts` is the
storage engine for external events; the Cloudflare binding and a new Node
`node:sqlite` adapter both call `createObserveService`. Externally ingested
observations carry an explicit provenance discriminator so no reader can
confuse an application-reported duration, a host counter, and
Cloudflare-measured CPU. Missing values stay absent or `unavailable`, never `0`.
Reverses only if the observe schema cannot represent external events without
nullable-combination explosion, which must then be shown with a failing test.

**D8 · Deployment-marker receipts are durable and outside application state.**
Prescribed. A failed marker POST is written to
`/var/lib/<app>/deploy/deploy-state.json` (owner-only, atomic rename) and
retried with the same marker id on the next deploy or an explicit sync command.
A marker is reported recorded only after a 201/200 response. Reverses if a
host's filesystem cannot hold an owner-only file outside the vault.

**D9 · OpenRC service metrics need no privileges.** Prescribed. Both hosts run
cgroup v2 unified, and
`/sys/fs/cgroup/openrc.<service>/{cpu.stat,memory.current,io.stat}` are
world-readable (`-r--r--r--`), so no elevation is needed. But
`agent/src/cgroup.rs` `unit_cgroup` parses only systemd `.service`/`.scope`/
`.slice` suffixes, and `agent/src/config.rs` `resolve_services` turns a `None`
into a hard `ConfigError` — so configuring `unit: "openrc.tansu"` today makes
the **agent refuse to start**, not merely report host-only metrics. Extend unit
resolution to the `openrc.<name>` cgroup form and prove it with a fixture built
from the real file contents. Where a stable identity genuinely does not exist
(transient Docker container ids), leave the service out of the agent config and
report service metrics `unavailable` — do not bind monitoring to an id that
changes on replacement.

**D10 · Operator CLI grows `service` verbs; existing commands keep working.**
Prescribed. Add `service create`, `service inspect`, `service token rotate`,
`service token revoke`, `service check` beside the existing `services`,
`service deployments`, and `deploy mark`. `cloudflare/test/cli/docs.test.ts`
already asserts every documented `statsctl` invocation parses, so docs changes
that add examples must keep that test green.

**D11 · Delivery is offline-first.** Prescribed. Cloudflare workerd and Node
harnesses prove ingestion; disposable Alpine-in-Docker or a smolvm guest proves
the OpenRC lifecycle. Nothing requires a real Cloudflare deploy or a production
host. `docs/testing.md` and `docs/operations.md` already describe the local
stack; reuse it.

## Baseline

Measured on the campaign start commit, `b654054`, macOS arm64.

| Check | Command | Time | State |
| --- | --- | --- | --- |
| CLI | `pnpm --dir cloudflare exec node --experimental-strip-types --test test/cli/*.test.ts` | 10.1 s | 143 pass |
| Node server | `pnpm --dir cloudflare run test:node` | 2.7 s | 37 pass |
| Observe unit | `pnpm --dir cloudflare run test:observe` | 7.0 s | 156 pass |
| Observe typecheck | `pnpm --dir cloudflare run typecheck:observe` | 0.6 s | clean |
| Toolchain | `make node-ready` | 0.3 s | clean |
| Tansu test build | `cargo test --workspace --no-run` | 24.1 s | clean |
| Niceforge typecheck | `pnpm run typecheck` | 6.5 s | clean |

Known red: none observed on these checks. Files that do not exist yet and must
be created rather than assumed: `docs/integration.md`,
`cloudflare/src/observe/ingest/`, `packages/producer/`, `packages/stats-producer/`,
`deploy/tansu-services`, `deploy/deploy-state.sh`.

Loop cost: the narrow loop is `test:node`, `test:observe`, and `test/cli`
together, about 20 s. The wide loop is `make check`; it runs `make release` and
the dashboard Playwright suite, so run it only at `S12` and at close. Report
before starting it.

## Sequence

Every item names its owned files. Do not edit files outside an item's ownership
without recording why in the commit body. Acceptance commands are run from the
repository root.

### S1 · Stats: distinct ingestion credential and rotation

Owns: `cloudflare/src/core/installation/services.ts`,
`cloudflare/src/core/installation/schema.ts`,
`cloudflare/src/core/installation/installation.ts` (service routes only),
`cloudflare/src/cli/commands/services.ts`, `cloudflare/test/` service tests.

Add an `ingest_token_hash` to `services` as migration 9, plus
`POST /api/v1/admin/services/:name/rotate`, `DELETE /api/v1/admin/services/:name`,
and `POST /api/v1/admin/services/:name/token/rotate` for the ingestion token.
`createService` returns `{deployToken, ingestToken}` — currently it returns a
single `token`, so `deploy mark` and `readServiceCredential` change with it.
Both tokens authenticate only their own capability; a deploy token on the
ingest path and an ingest token on the marker path must each 401.

Acceptance: `pnpm --dir cloudflare exec node --experimental-strip-types --test test/cli/service-*.test.ts test/deployments-api.test.ts`
— proves rotation invalidates the old token, revocation 401s, a deploy token
cannot ingest, an ingest token cannot mark, and a service-creation response
never repeats a token.

### S2 · Stats: `service` CLI verbs

Owns: `cloudflare/src/cli/commands/services.ts`, `cloudflare/src/cli/commands/index.ts`,
`cloudflare/public/llms.txt` examples, `cloudflare/test/cli/service-*.test.ts`.

Add `service create` (writes the credential file mode 0600, never prints the
token in the text renderer), `service inspect`, `service token rotate`,
`service token revoke`, `service check` (health URL + latest marker + probe
state). Reuse `credential-file.ts` for writes; reuse its symlink and mode
checks.

Acceptance: `pnpm --dir cloudflare exec node --experimental-strip-types --test test/cli/`
— includes `docs.test.ts`, which fails if a documented invocation does not parse.

### S3 · Stats: portable ingestion protocol and decoder

Owns: `cloudflare/src/observe/ingest/` (new), `cloudflare/src/observe/core/model.ts`,
`cloudflare/src/observe/http/api.ts`, `fixtures/observe-ingest/` (new),
`cloudflare/test/observe/` ingestion tests.

One typed schema and decoder in `observe/ingest/`, imported by both targets and
by the SDKs' conformance tests. Route `POST /ingest/observe/v1/:service/batches`.
Required per event: schema version, unique event id, timestamp, operation name,
outcome, duration, work counts, release identity, service, optional instance and
host, optional trace/span, bounded low-cardinality work measurements. Caps:
64 KiB and 128 events per request, enforced before parse; per-token rate limit.
Deduplicate on event id within the 7-day retention. Reject whole frames; never
partially store.

Acceptance: `pnpm --dir cloudflare exec node --experimental-strip-types --test test/observe/`
— proves a golden frame round-trips, every malformed frame is rejected with a
stable code, an oversize body is refused before parse, a replayed batch stores
nothing twice, and no field accepts an unbounded label.

### S4 · Stats: Cloudflare + Node ingestion adapters

Owns: `cloudflare/src/cloudflare/index.ts`, `cloudflare/src/node/server.ts`,
`cloudflare/src/node/installation.ts`, `cloudflare/src/node/sql.ts`,
`cloudflare/src/core/http.ts`, `cloudflare/test/node/`.

Wire the decoder into the Worker's authorize path and forward to
`stats-observe` through the existing binding; do not put observe work on an
ordinary request path and do not create a tail-consumer loop. On Node, replace
`observe: null` in `statsRequestListener` with a `node:sqlite`-backed
`createObserveService`, and expose the read-side `/api/observe/*` routes.
Node keeps Tailscale identity for reads; the `/ingest/observe/*` path
authenticates by token only, on both targets.

Acceptance: `make node-e2e` and `pnpm --dir cloudflare exec node --experimental-strip-types --test test/node/ test/observe-e2e/`
— the same fixture batch produces the same normalized read-back on both
backends.

### S5 · Stats: TypeScript and Rust producers

Owns: `packages/producer/` (new), `packages/stats-producer/` (new crate,
`packages/` added to `pnpm-workspace.yaml` for the TS one), root `Cargo.toml`
(create a workspace with `packages/stats-producer` as its only member),
`Makefile` publish targets, `cloudflare/test/producer/`.

The root has no `Cargo.toml` and `agent/` is a standalone package, so create a
minimal root workspace rather than adding a producer crate inside `agent/`,
which would make the agent carry SDK code it does not use. Do not change
`agent/Cargo.toml`'s dependency set.

TypeScript: native `fetch`, bounded queue, batching, timeout, exponential
backoff with jitter, graceful shutdown, dropped-count diagnostics. Rust:
`laputa-*` async primitives only — **no Tokio**; reuse the agent's
`h12tiny-client-sync` TLS approach rather than adding a second HTTP stack.
Both are no-ops with no network activity when unconfigured, never block the
caller, and never retry an unbounded body. Publish per **D3**; record the
published versions in `docs/integration.md`.

Acceptance: `pnpm --dir cloudflare exec node --experimental-strip-types --test test/producer/`
plus `cargo test -p stats-producer` — proves timeout, malformed response,
retry/backoff, shutdown flush, queue overflow dropping the documented set,
duplicate acknowledgment, and token rotation.

### S6 · Stats: contract document

Owns: `docs/integration.md` (new), `docs/architecture.md` links.

Write **D5**'s nine sections against the code as merged in `S1`–`S5`. Every
protocol field name here must match the decoder.

Acceptance: `pnpm --dir cloudflare exec node --experimental-strip-types --test test/cli/docs.test.ts`
plus a manual diff of the field list against `observe/ingest/`.

### S7 · Tansu: OpenRC deployment lifecycle

Owns: `deploy/deploy.sh`, `deploy/install.sh`, `deploy/openrc/tansu` (new),
`Makefile` deploy targets, `docs/deployment.md`.

Replace the systemd writer with an OpenRC service in
`/etc/init.d/tansu` plus `/etc/conf.d/tansu`, `rc-update add tansu default`,
`rc-service tansu`. Use `doas` (both hosts have passwordless `doas`, no `sudo`).
Add the versioned layout: `/opt/tansu/releases/<commit>/`, `/opt/tansu/current`
symlink, `/var/lib/tansu` unchanged, `/var/lib/tansu/deploy/deploy-state.json`
for the receipt. Keep the existing symlink and regular-file checks and the
`tansu:tansu` ownership. Add `make deploy-check`, `deploy-status`,
`deploy-smoke`, `rollback REV=`, `deploy`. Preflight must fail before any write.

Acceptance: `make deploy-check` on a disposable Alpine container (`docker run
--rm -v "$PWD:/src:ro" alpine:3.22` with the script pointed at a temp root) plus
`cargo test --workspace` — proves a fresh install, a no-op repeat that writes
nothing, an upgrade to a new commit, and rollback to the retained release.

### S8 · Tansu: readiness and OpenRC service metrics

Owns: `src/api.rs` (health only), `deploy/openrc/tansu`,
`agent/src/config.rs`, `agent/src/cgroup.rs`, `agent/tests/` fixtures.

Extend `/api/v2/health` with the running release identity and initialization
state — today it answers only `{ok, apiVersion}`, which cannot prove *which*
release is serving. In the agent, accept `openrc.<name>` as a unit identity
alongside systemd names, per **D9**.

Acceptance: `cargo test --workspace` in Tansu and `make agent-test` in Stats —
proves health reports the release it is running, a stuck initialization reports
not-ready, and `openrc.tansu` resolves to
`/sys/fs/cgroup/openrc.tansu/cpu.stat` from a fixture copied off a live host.

### S9 · Tansu: Stats integration

Owns: `deploy/tansu-services` (new), `deploy/deploy-state.sh` (new shell
helper for the D8 receipt, used by `deploy.sh`), `Makefile`, `Cargo.toml`,
`docs/deployment.md`.

Register the host and `tansu` service through the reviewed CLI, install the
agent once per host (not per release), instrument the boundaries named in
**Reference**, and publish a marker with a stable marker id per genuine
activation. Persist the receipt per **D8**. Telemetry disabled or failing must
not affect a note save.

Acceptance: `cargo test --workspace` plus `make agent-e2e` — proves a note save
and a search emit expected operation records with the right release, a marker
is recorded exactly once, a no-op deploy fabricates none, and with Stats
unreachable the save succeeds and a bounded drop count is exposed.

### S10 · Niceforge: recovery-first deployment

Owns: `scripts/forge-deploy.mjs`, `Makefile`, `docs/forge.md`.

The current script stops and removes the running container
(`forge-deploy.mjs:147-148`) *before* the candidate is healthy, then fails with
no restore. Keep the old container or enough metadata to restore it until the
candidate passes readiness; validate the rollback target instead of trusting a
string; prune only after verified activation. Add `deploy-check`, `deploy`,
`deploy-status`, `deploy-smoke`, `rollback REV=`. Keep the `--init` container
invocation unchanged and do not bind anything to the transient container id.

Acceptance: `node scripts/forge-deploy.mjs` against a disposable target with an
intentionally broken candidate — proves the previous release is restored
automatically, an explicit rollback works, an interrupted upgrade leaves state
intact, and host keys and authorized keys are unchanged.

### S11 · Niceforge: Stats integration

Owns: `package.json`, `apps/forge/src/` telemetry call sites,
`apps/controller/src/` (only when a controller is configured), `docs/forge.md`.

Add `@stats/producer` per **D3**. Instrument Core's HTTP routes, SSH/Git
subprocess failures, push receipt latency and spool backlog, SQLite errors, and
startup/shutdown. Controller telemetry only for an actually configured
controller. Never export repository contents, credentials, raw job output, or
filenames.

Acceptance: `pnpm run typecheck` and `pnpm run test:fast` plus a fixture run —
proves a local push produces health and operation observations carrying the
release identity, and no repository content or credential reaches the payload.

### S12 · Stats: work-normalized comparison and operator surface

Owns: `cloudflare/src/deployments/service-compare.ts`,
`cloudflare/src/cli/verify/`, `cloudflare/src/client/pages/`,
`cloudflare/test/cli/verify-service.test.ts`, `cloudflare/test/ui/`.

`SERVICE_LEVEL_CAVEAT` in `service-compare.ts` states the current limit
verbatim: *"a service does not report its own work counts, so this cannot show
fewer resources for the same work."* Add per-work metrics (latency and
dependency-attributable resource use per successful save/push/job) with typed
policies, keeping existing coverage, overlap, baseline, and settle guardrails.
Compute a per-work ratio only when the resource is attributable, the counter is
complete, and windows are comparable; otherwise return `unavailable` with a
reason. Surface release, marker, hosts, probes, throughput, failure rate,
issues, latency, and marker overlay in the existing Services UI. Every absent
value renders unavailable, not zero.

Acceptance: `pnpm --dir cloudflare exec node --experimental-strip-types --test test/cli/ test/observe/`
plus `make dashboard-test`.

### S13 · Cross-repository offline scenarios

Owns: `cloudflare/test/local/` (new scenario file), `docs/testing.md`,
`fixtures/observe-ingest/` (the shared conformance corpus from `S3`).

Implement scenarios A–G from **Reference** against the real workerd and Node
backends and a disposable Tansu/Niceforge target. Reuse
`scripts/offline-run.sh`. Fake or loopback Stats endpoints are allowed for
scenario E; do not require a real deployment.

Acceptance: `make integration-local` — the run prints one line per scenario and
fails if any scenario's assertion fails. That target runs `test/local/*.test.ts`
under `scripts/offline-run.sh`, which exits 2 off macOS (filed as STA-83), so
the assertions must also be reachable directly: `cd cloudflare && node
--experimental-strip-types --test test/local/<scenario>.test.ts`. Use the direct
form on Linux and note which form you ran.

### S14 · Documentation

Owns: `docs/integration.md`, `docs/operations.md`, `docs/architecture.md`,
Tansu `docs/deployment.md`, Niceforge `docs/forge.md`, each `README.md`.

Each app documents host requirements, first and subsequent deploys, credential
files, agent association, telemetry config, health, rollback, what is never
replaced, troubleshooting with Stats down, and a concrete walkthrough. Every
command shown must be one run in `S1`–`S13`.

Acceptance: `pnpm --dir cloudflare exec node --experimental-strip-types --test test/cli/docs.test.ts`
plus `make lint`.

### O1 · Optimization (last)

Owns: whatever `S1`–`S14` measured as a regression.

Only after every local deliverable passes. Act on the recorded budgets below:
no instrumentation may add more than 1 ms p50 or 5 ms p99 to a note save, a
Git push, or an API request, and no producer queue may exceed 1 MiB. Optimize
anything exceeding that; leave the rest.

Acceptance: the same measurement command rerun, with before and after recorded.

## Acceptance

Per deliverable, the command is the owning slice's acceptance command.

| Deliverable | Proof | Fails if |
| --- | --- | --- |
| Distinct ingest/deploy credentials | `S1` | an old token survives rotation, or either token works on the other path |
| Operator onboarding without raw HTTP | `S2` | a token is printed to stdout in text mode |
| One portable protocol, two backends | `S3`, `S4` | any malformed frame stores partially, or backends disagree on read-back |
| Versioned producers | `S5` | a producer blocks its caller, or retries an unbounded body |
| Contract written once | `S6` | a documented field name differs from the decoder |
| OpenRC deploy works on the real supervisor | `S7` | preflight failure leaves a production side effect |
| Readiness proves the release | `S8` | health reports ready for a different or uninitialized release |
| Marker identity exact | `S9` | a no-op deploy creates a marker, or a retry duplicates one |
| No broken release survives | `S10` | a failed candidate leaves the old service stopped |
| Privacy-safe telemetry | `S11`, `S13` scenario F | any note text, path, credential, or header reaches storage |
| Work-normalized claims gated | `S12` | a non-attributable resource is divided by a work count |
| Stats outage is survivable | `S9`, `S13` scenario E | an application operation fails because Stats is down |
| Docs match code | `S14` | a documented command does not run |

## Performance budgets (measure and log, not gating before O1)

Record each in the commit body of the slice that changes it, with the command:
SDK bundle size and dependency count; Tansu binary size before/after;
Niceforge dependency delta; baseline request latency with telemetry disabled;
latency with telemetry enabled and Stats healthy; behavior with Stats slow or
unreachable; producer queue memory bound; ingestion throughput and per-batch
write amplification; storage per event. Never claim an improvement without a
measured baseline.

## Needs environment

Owner-run. These do not hold the campaign open.

1. **Publish a Stats release.** `git tag v0.1.0 && git push --tags` then the
   `Release` workflow. Needed only to distribute `statsctl`/agent by URL.
   Command: `gh release create v0.1.0 --generate-notes dist/statsctl-*.mjs install.sh`.
2. **Deploy Tansu to `lisa`.** `cd /Users/josh/d/tansu && make deploy DEPLOY_HOST=josh@lisa`
   after `S7`–`S9` pass. Requires the owner's judgement on vault state.
3. **Deploy Niceforge Core to `threadripper`.** `cd /Users/josh/d/niceforge && make deploy`
   after `S10`–`S11`. Live repositories; `/` is 93 % full — check disk first.
4. **Confirm production Stats receives application telemetry.** Read
   `statsctl observe operations --project tansu --window 1h --json` and
   `... --project niceforge-core` against `https://stats.17166969.xyz` after (2) and (3).
5. **Cloudflare Access bypass for `/ingest/observe/*`.** Add to the existing
   `<host>/ingest/*` Bypass application. Without it, ingestion is challenged;
   with it wrongly scoped, the dashboard could become public. Owner-only.

## Execution boundary and non-goals

Authorized: edit and commit in all three repositories; run local tests,
containers, and disposable guests; publish SDKs to the private registries;
create services, rotate tokens, and mark deployments against a *local* Stats.

Forbidden: pushing; tagging or releasing; deploying to `lisa` or `threadripper`;
touching the running `niceforge-core` instance or its repositories; deleting
persistent data; exposing a service publicly; Tailscale Funnel; modifying
unrelated Cloudflare resources; adding a systemd dependency; adding Tokio,
OpenTelemetry, or a heavyweight logging stack to Tansu; a second event database;
a new cross-repository orchestration framework; Ansible/Terraform/Kubernetes
abstractions.

Non-goals with reasons: browser-side telemetry (needs a public ingestion secret
or a proxy — out of scope for server-first coverage); per-runner direct
reporting (controller-side aggregation closes the gap); zero-downtime stateful
replacement (a singleton vault cannot be replaced without a pause, and claiming
otherwise would be false); a general deployment engine (standardize behavior,
not mechanism).

Contract changes to surface to the owner: `createService`'s response shape
(`token` → `{deployToken, ingestToken}`), a new `services` column, new admin
routes, the new `/ingest/observe/v1/:service/batches` route, and the extended
`/api/v2/health` body.

## Reference

**Existing Stats surfaces to extend, verified at `b654054`:**

| Surface | Location |
| --- | --- |
| Service create/list/read, marker record, history | `cloudflare/src/core/installation/services.ts` |
| Marker route, cross-site and body caps | `cloudflare/src/core/http.ts:96` |
| Admin routes, comparison, probes | `cloudflare/src/core/installation/installation.ts:694` |
| Schema migrations (8 so far) | `cloudflare/src/core/installation/schema.ts` |
| Observe store and service | `cloudflare/src/observe/core/store.ts`, `core/service.ts` |
| Observe HTTP API (read-only today) | `cloudflare/src/observe/http/api.ts` |
| Observe limits and retention | `cloudflare/src/observe/core/limits.ts` |
| Producer channel and report | `cloudflare/src/observe/producer/` |
| Service comparison caveat | `cloudflare/src/deployments/service-compare.ts:10` |
| CLI registry and command shape | `cloudflare/src/cli/registry.ts`, `run.ts` |
| Agent cgroup resolution | `agent/src/cgroup.rs` (`unit_cgroup`) |
| Agent config | `agent/src/config.rs` |
| Host inventory (openrc/doas) | `deploy/hosts.json` |
| Docs-parse test | `cloudflare/test/cli/docs.test.ts` |

**Tansu boundaries to instrument** (from the draft, kept as requirements):
HTTP request outcomes and latency by route template; note open/read; note
save/write; reconciliation and conflict detection; search latency and result
counts; catalog/index startup and rebuild; durable SQLite failures;
authentication infrastructure failures; background task failures and graceful
shutdown; work counts for saves, revisions, indexed documents, and searches.
Never record note titles, bodies, user text, pasted content, imported page
text, Markdown paths, image payloads, cookies, or passkey data.

**Niceforge Core boundaries:** HTTP route latency and error rate; SSH/Git
subprocess failures; clone/fetch/push outcomes; push receipt ingestion latency;
spool backlog and processing duration; repository provisioning and recovery
failures; SQLite persistence errors; startup, shutdown, and dependency failures.

**Scenarios required at `S13`:**
A — create a service, save credentials, send an event, read it back, rotate,
prove the old token is rejected.
B — disposable Tansu: health, save, search; expected records arrive.
C — local forge fixture: create a repository, push; health and operation
records arrive.
D — per app: stage, activate, prove readiness, record a marker, redeploy
unchanged, roll back; genuine activations counted once, no-ops add none.
E — inject: Stats unavailable; invalid token; transport timeout; marker POST
interrupted after server commit; candidate fails startup; host restart during
deploy; incompatible rollback candidate; missing artifact or checksum mismatch.
F — errors carrying note text, local paths, repository URLs, credentials,
headers, env values; prove none reach storage.
G — the same golden fixtures on Cloudflare and Node; compare normalized
responses, not timestamps or ids.
