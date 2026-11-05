# Portable core: stats on Node, with Cloudflare as an adapter

## Status

- **Goal:** the same stats core runs as a Cloudflare Worker (today's production, unchanged) and as a Node.js server in a container on `josh@threadripper`, reachable only on the tailnet. Cloudflare-only features become an adapter layer on top, as in Nanoshop.
- **Baseline:** master `b9f8fb0`. Full set at `425fb3e` (code unchanged since): fixtures, agent-test, release, agent-e2e, smoke-local, dashboard-test (114), and lint pass; `cloudflare-test` 297 of 297 in 5 reruns, with one load-only failure (STA-54). `pnpm --dir cloudflare run bench:workerd ingest-rows` reads `writtenPerSample 7.762`, which P1 must reproduce exactly.
- **Accepted:** P0; P1 (`d1ecf35`..`8936b5d` on master): `Installation` runs on SQL, clock, scheduler, and operation-sink ports in `src/core/installation/`, with Cloudflare adapters in `src/cloudflare/` and `node:sqlite` ones in `src/node/`. Every SQL statement is unchanged (the full statement set over `src` compared), `bench:workerd ingest-rows` reads 7.762, and `test/node/parity.test.ts` finds the acks, history bodies, and ETags of all 37 fixture batches byte-identical between workerd and node:sqlite. `make cloudflare-test lint agent-e2e smoke-local fixtures` green after the rebase onto STA-52. P2 (`f490bbe`..`bb91782`): Cloudflare-only code lives in `src/cloudflare/` (Worker entry, Durable Object wrapper, Access, the Analytics and deployment collectors, SQL and port adapters) and `src/observe/cloudflare/` (kept in place so the observe Worker config is unchanged); `test/node/boundary.test.ts` fails when any other file imports those, `cloudflare:*`, or `@cloudflare/*` (proven with three planted imports). Observe uses `SqlStatements` from `core/sql.ts` through the shared `CloudflareSql`. Both Workers export the same names as before and `worker.config.json` is byte-identical. `make cloudflare-test lint dashboard-test agent-e2e smoke-local` green, bench 7.762. `deploymentsEnabled` stays in the adapter, because it reads Cloudflare environment variables and only the wrapper calls it. **Red:** none. **Parked:** none.
- **P3 accepted** (merged, ending `9fc5858`): `src/core/http.ts` routes for both targets through `handleStatsRequest(request, target)`; `src/node/server.ts` serves it over `node:http` with Tailscale identity from loopback (`src/node/tailscale.ts`, 7 tests, mutation-checked); projects are empty and observe answers 503 `unavailable` on Node; `test/node/http-parity.test.ts` finds status, headers, and bodies identical between workerd and Node for health, ingest rejections and acks, latest, system, history, 304, projects, and deployments; `make node-e2e` (smoke, real agent, SIGTERM drain, restart) is in `make check`. `make cloudflare-test lint dashboard-test node-e2e agent-e2e smoke-local` green; bench 7.762; Worker exports and config unchanged.
- **P4 deployed, exposure parked (15:20Z):** `make node-deploy` (`619c238`) runs `stats-node:619c23856d11` on threadripper (host network, `127.0.0.1:18791`, data in `~/.local/share/stats-node`). Through an SSH tunnel to its loopback: `deploy/deployed-smoke.sh` passes; no `Tailscale-User-Login` or an unlisted login gets 401, `joshua.r.li.98@gmail.com` gets 200, and observe answers 503 `unavailable`; a `synthetic-check` host (`h_a11481203f5aabc848d66285601bc6a6`, token only at `.work/credentials/synthetic-check-node.json`, 0600) survives `docker restart` with a graceful stop. **Exposed (15:31Z):** the owner granted passwordless `doas` on threadripper, because operator rights cannot change a serve config that already holds the 8080 path entry. `doas tailscale serve --bg --http=18790 http://127.0.0.1:18791` added the entry and left 8080 unchanged. From this Mac over the tailnet, `http://threadripper.tailcf741.ts.net:18790` serves the dashboard and `/api/v1/hosts` (200, listing `synthetic-check`), and observe answers 503. `deployed-smoke.sh` reports its no-credentials check as a failure there, because `tailscale serve` attaches the caller's identity to every tailnet request; the rejection paths are covered by the tunnel run. P4 accepted. `niceforge-core` was recreated at 15:01:15Z by something other than this campaign, which touched only `stats-node`.
- **P5 accepted** (`e4797c0`): `targetOf` in `src/cli/auth.ts` treats a `.ts.net` host or a bare name as the Node target, which gets no credential, and everything else as Cloudflare, which gets Access. `cost`, `verify`, `observe`, `projects`, `health`, `snapshot`, `deployments`, and `compare` read Cloudflare-only data and exit 2 with `unsupported_on_target` before any request, so `health` does not work on Node, contrary to the original P5 text. Over the tailnet, `statsctl check ingest --origin http://threadripper.tailcf741.ts.net:18790 --credential-file .work/credentials/synthetic-check-node.json` passes all seven steps, and the Cloudflare origin still passes. `test:cli` 112, `test:node` 23, `node-e2e` 3, lint clean. `make cloudflare-test` stopped twice on STA-54's sampling e2e test, which fails the same way on master.
- **Next:** X.
- **P4 notes:** Decided for P4 (executor, 2026-11-05, follows Decision 1): the container runs with `--network host` and `STATS_LISTEN=127.0.0.1:18791`, because on Docker's bridge network every request arrives from the gateway, not loopback, and Decision 1 trusts loopback only. Carry-overs: the server runs as `node --experimental-strip-types src/node/main.ts` from `cloudflare/` with Node 26.12.1 and the built assets at `cloudflare/.cloudflare/output/v0/workers/default/assets`; the agent accepts only `https://` or loopback `http://`, so pointing a remote agent at it needs `tailscale serve --https` (out of scope, Decision 2); the Node projects page still says projects are declared in `cloudflare.config.ts`.
- **Resume:** `Execute docs/portable-core-campaign.md from its Status block.` First command: `git log --oneline -1 && make cloudflare-test`.

## Charter

- Implement; decide inside the bounds below and keep going. Record a decision in **Decisions** only when a later slice depends on it.
- Parity before features. The Node target serves the same routes with the same bytes as the Worker for everything it supports. What it does not support is absent or `unavailable`, never zero (an `AGENTS.md` invariant).
- One writer, one slice at a time, in `.work/wt/portable` on branch `campaign/portable`. P1 and P2 touch the same files, so nothing runs in parallel. After each accepted slice, run the parent steering checkpoint from the `orchestrate` campaign reference, then update **Status**.
- A failing check is root-caused before any retry (`root-cause`). The same failure twice after a fix parks the slice with its evidence.
- Hard stops, each of which parks the item: an action outside **Execution boundary**, a change to a wire or stored format, or a check that cannot run.

## Decisions

1. **Auth on Node (owner, 2026-11-05): tailnet only, Tailscale identity.**
   - The server binds `127.0.0.1` only. `tailscale serve` on threadripper proxies tailnet traffic to it.
   - Non-ingest paths accept a request only when it arrives from loopback and carries a `Tailscale-User-Login` header that is in a configured allowlist (`STATS_ALLOWED_LOGINS`, comma-separated). Anything else gets 401 before any data is read.
   - Ingest keeps today's per-host bearer tokens, hashed at rest.
   - The `AGENTS.md` Access invariant becomes per target: an Access JWT on Cloudflare, Tailscale identity from loopback on Node. Update that invariant in P3, together with the code.
2. **Data (owner, 2026-11-05): a fresh parallel instance.** threadripper starts empty, and Cloudflare stays production. No export, import, or agent cutover in this campaign; pointing an agent at threadripper is a later decision.
3. **Ports, reused from Nanoshop's shape.** Core code takes a `SqlDatabase` port (the interface `observe/core/store.ts` already uses), a clock, and a scheduler (`at(ms)` for retention). Cloudflare implements them with `ctx.storage.sql` and alarms; Node implements them with `node:sqlite` `DatabaseSync` and timers. One owning process per database file gives the single-writer guarantee the Durable Object gives today.
4. **Cloudflare-only features stay off on Node:** the project collector and deployment tracking (both read Cloudflare's API), `stats-observe` and the tail consumer, and Access. On Node, the dashboard and `statsctl` report them as `unavailable`. Making the project collector run from Node with an API token is out of scope, because this campaign changes no tokens.
5. **Container:** `node:26-alpine`, non-root user, one container named `stats-node`, on the host network, with the server listening on `127.0.0.1:18791` only. Data lives in a bind mount at `/home/josh/.local/share/stats-node`, and the container runs with `--restart unless-stopped`. The image is built on threadripper (x86_64) from a `git archive` of the campaign branch, so threadripper needs no git checkout.
6. **Dependencies:** none new. `node:http` and `node:sqlite` are built in. A new dependency needs a written reason, and its build time and image size go in the commit body.

## Execution boundary

Allowed without asking:
- Local code, tests, and commits on `campaign/portable`. Merge to master after P4 is accepted.
- On `josh@threadripper` over SSH, as `josh` with no `sudo`:
  - copying a tarball into `~/stats-node-build/`;
  - `docker build -t stats-node:<commit>`, and `docker run`, `stop`, `rm` and `logs` for the container `stats-node` only;
  - creating `/home/josh/.local/share/stats-node`;
  - `tailscale serve --bg --http=18790 http://127.0.0.1:18791`, and `tailscale serve --http=18790 off` to undo it, run with `doas` (owner grant, 2026-11-05) because the existing 8080 path entry makes any serve change need root. `doas` is for these two commands only.

Forbidden:
- Touching any other container (`niceforge-core` runs there), any other port, the existing `tailscale serve` entry on 8080, system packages, OpenRC services, the firewall, or `sudo`.
- Deploying either Cloudflare Worker, and changing Cloudflare tokens, Access, or retention.
- Pushing, force-pushing, and changing the host ingest wire format or the stored sample format.
- Writing outside `.work/` locally, and outside the paths above on threadripper.

Park and report:
- If `tailscale serve` refuses as `josh`, park P4's exposure step with the exact error. The fix is the owner running `sudo tailscale set --operator=josh`.
- If threadripper has less than 50 GB free at any check, stop deploying (it had 225 GB free on 2026-11-05).

## Sequence

### P0 — Baseline (S)

Run `make check` on master. Record in **Status** the commit, the pass counts, and the wall time of `make cloudflare-test`. Then run the offline ingest measurement and record its numbers; P1 must reproduce them exactly. That measurement is O1's workerd bench of rows written per persisted sample, with history frame and ETag bytes (see `bench/README.md`).
- Acceptance: the baseline is recorded and `make check` is green, or STA-54's known failure is noted.

### P1 — `Installation` on ports (M)

Move the logic in `cloudflare/src/installation.ts` and `cloudflare/src/deployments/installation.ts` into `cloudflare/src/core/installation/`, written against the `SqlDatabase`, clock, and scheduler ports (Decision 3). The Durable Object class keeps its name and exported RPC methods, and becomes a thin wrapper that builds the ports from `ctx`.
- Move `SqlDatabase` out of `observe/core/store.ts` to `cloudflare/src/core/sql.ts`, so both stores import the one interface.
- No schema, query text, row, frame, ack, or ETag changes. The `fixtures/v2/` corpus, the history goldens, and P0's ingest measurement must come out byte-identical and count-identical.
- Add a `node:sqlite` implementation of the ports under `cloudflare/src/node/` now, plus a test that runs the core ingest and history paths against it. Run the same fixture frames through it and through workerd: the acks and history frames must be byte-identical.
- Acceptance: `make cloudflare-test lint agent-e2e smoke-local fixtures`, P0's measurement identical, and the cross-target parity test green.

### P2 — The Cloudflare adapter boundary (M)

Everything Cloudflare-specific moves under `cloudflare/src/cloudflare/`:
- the Worker entry (`index.ts`);
- the Durable Object wrappers and the alarm and cron handlers;
- `access.ts`;
- `projects/collector.ts` and `deployments/collector.ts`, plus the parts of `projects/parse.ts` that read Cloudflare responses;
- `observe/cloudflare/`.

Core keeps everything else.
- Add a test, in the style of Nanoshop's Node-release test (`~/d/nanoshop/tests/stats/stats.test.ts`, "never reaches the Stats producer"). It walks the import graph from the core entry points and the Node entry, and fails if any of them reaches `cloudflare:*` or `src/cloudflare/`.
- `cloudflare.config.ts`, the bundle names, and the deployed Worker behavior stay unchanged.
- Acceptance: `make cloudflare-test lint dashboard-test agent-e2e smoke-local` and the import test. `cf deploy --dry-run`, or the repo's bundle build, produces the same Worker entry exports as master.

### P3 — Node target (M)

`cloudflare/src/node/server.ts` serves the same request handler over `node:http`:
- ingest at `INGEST_PATH`;
- the history, host, and dashboard API routes;
- the built dashboard assets;
- health.

Configuration comes from the environment:
- `STATS_DATA_DIR`;
- `STATS_LISTEN` (default `127.0.0.1:18791`);
- `STATS_ALLOWED_LOGINS`.

Retention runs on the scheduler port. Graceful shutdown closes the database.
- **Auth adapter (Decision 1):** a test proves each of these: a non-loopback peer is rejected; a missing header is rejected; a login outside the allowlist is rejected; an allowed login reads data. It also proves that ingest ignores Tailscale headers and requires its bearer token.
- **Unavailable features (Decision 4):**
  - project, deployment, and observe routes answer with the same shape the Worker uses when the source lacks the window;
  - the dashboard renders them as unavailable;
  - a Playwright case covers the project page on the Node target.
- **Test targets:** `make node-e2e` runs `deploy/deployed-smoke.sh` and the real agent binary (the `agent-e2e` flow) against a locally started Node server. Add the target to `make check`.
- **Docs:** rewrite the `AGENTS.md` auth invariant per target, add the Node target to `docs/architecture.md`, and add a run section to `docs/operations.md`.
- Acceptance: `make cloudflare-test lint dashboard-test node-e2e agent-e2e smoke-local`.

### P4 — Container on threadripper (S)

- Add a `Dockerfile` at `deploy/node/Dockerfile`: multi-stage, `node:26-alpine`, non-root, with only the built server and the dashboard assets in the final stage.
- Add `make node-deploy HOST=josh@threadripper`. It archives `HEAD`, copies it to the host, builds the image tagged with the commit, and replaces the `stats-node` container per Decision 5, keeping the data directory. Its output goes to `.work/tmp/node-deploy.log`.
- Expose it with `tailscale serve --bg --http=18790 http://127.0.0.1:18791`.
- Provision a `synthetic-check` host on the Node instance through its provisioning route. Store the token only at `.work/credentials/synthetic-check-node.json`, mode 0600, and never in argv or logs (the `AGENTS.md` token invariant).
- Acceptance, from this Mac on the tailnet:
  - `STATS_URL=http://threadripper.tailcf741.ts.net:18790 deploy/deployed-smoke.sh`;
  - `statsctl check ingest` against that origin (P5 adds the origin support it needs; until then, run the smoke only);
  - the container restarts after `docker restart stats-node` with its data intact;
  - `docker ps` shows `niceforge-core` untouched.

### P5 — `statsctl` against the Node origin (S)

`statsctl` gains an auth mode chosen by origin:
- Access, as today, for the Cloudflare origin;
- none for an origin on the tailnet, where `tailscale serve` supplies identity.

Commands whose data source is Cloudflare-only (`cost`, `verify`, and `observe`) fail fast with exit 2 and the code `unsupported_on_target` against a Node origin; they do not fall back. `health` and `check ingest` work.
- Acceptance: `test/cli` covers the mode selection and the refusal, `test/cli/docs.test.ts` passes, and `statsctl check ingest --origin http://threadripper.tailcf741.ts.net:18790 --credential-file .work/credentials/synthetic-check-node.json` exits 0.

### X — Close (S)

- Prove the moved code dead or alive (`dead-code-archaeology`).
- Run `review` on the integrated diff and fix P1 and P2 findings.
- Merge `campaign/portable` to master. Record the image tag and container id in **Status**.
- Report: what runs where, which commands deploy and verify each target, and what stays Cloudflare-only.

## Reference

Coupling found on 2026-11-05, before P1:
- `installation.ts` has about 52 direct `ctx.storage.sql` calls and uses Durable Object alarms.
- `index.ts` is the Worker fetch and scheduled entry.
- `access.ts` verifies Access JWTs.
- The project and deployment collectors read Cloudflare's GraphQL and REST APIs.
- The observe tail consumer exists only on Cloudflare.
- Already portable: `binary/`, `ingest/`, `cost/`, `compare/`, most of `deployments/`, `cli/`, `client/`, and `observe/core/`, which already writes through `SqlDatabase` and runs under plain Node in `test/observe`.

threadripper, checked 2026-11-05:
- Alpine Linux edge, x86_64, 32 cores, 60 GB RAM, 225 GB free.
- Docker 29.9, which `josh` can use.
- No Node, no reverse proxy, no `cloudflared`.
- Tailscale: the tailnet name is `threadripper.tailcf741.ts.net`, and an existing `tailscale serve` entry on port 8080 must stay.
- Ports 18790 and 18791 are free.
