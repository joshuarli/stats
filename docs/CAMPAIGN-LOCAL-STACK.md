# Campaign: the complete local stack

## Status

- **Goal:** the whole `stats` Cloudflare topology (the `stats` Worker, `stats-observe`, their Durable Objects, tail wiring, and the dashboard assets) runs and verifies itself on this machine with no Cloudflare login and no network. The one hosted dependency with no local implementation, the `ANALYTICS_SQL` binding, is replaced at its binding boundary by an offline provider, so the real scheduled handler, collector, parsers, Durable Object, history frames, cost report, `statsctl`, and dashboard all run on a successful collection.
- **State:** L1 accepted at `8dfbc86`. `make cloudflare-test` is green in 33 s (vitest 307, node 36, local 6, observe-e2e 10, others unchanged); `make smoke-local` and `make lint` are green.
- **Accepted:** L1. **Red:** none. **Parked:** none.
- **Next:** L2. `cloudflare/local/topology.ts` takes the provider as `analytics: { service, entrypoint }` plus the provider worker in `extraWorkers`; text overrides must name an existing text binding and secrets must not shadow one.
- **Resume:** `Execute docs/CAMPAIGN-LOCAL-STACK.md from item L2. Read the item, own only its files, and finish on its acceptance command.` First command: `git log --oneline -1 && make cloudflare-test`.

## Charter

- Decide and keep going. Record a decision only when a later slice depends on it, in **Decisions**, never a log.
- The grant covers local edits, local commits, local test runs, `.work/` scratch, `git worktree` under `.work/wt/`, and a macOS `sandbox-exec` wrapper around this campaign's own commands. It never covers pushes, deploys, Cloudflare reads or writes (including `cf sql query`), SSH, `sudo` or `doas`, new dependencies, or formatters. Park anything that needs more.
- Hard stops park the item, never the campaign: a forbidden effect, a change to a wire or stored format, or a check that cannot run here. Put unrunnable proof on **Needs environment** with the owner's command.
- Parity before optimization. L1 to L6 and H1 to H3 are completeness and hardening; O1 is the only optimization-class item and goes last.
- One writer, one slice at a time, on branch `campaign/local-stack` in `.work/wt/local-stack`. Setup: `git worktree add -b campaign/local-stack .work/wt/local-stack master && cd .work/wt/local-stack && pnpm install --frozen-lockfile --offline` (0.5 s measured). Every slice shares `Makefile`, `package.json`, or `cloudflare/local/`, so no parallel pair is allowed. After each accepted slice, run the parent steering checkpoint from `orchestrate`'s campaign reference, then rewrite **Status**.
- A failing item gets `root-cause` first, then at most two fix attempts, then it is parked on its branch with the cause and a retry condition.
- The full suite (`make fixtures agent-test cloudflare-test dashboard-test lint agent-e2e node-e2e smoke-local`) runs at M1 (after L3), M2 (after L6), and close. Red work never lands. Merge each accepted slice to master with `git merge --ff-only` after rebasing; never push.
- Fix anything egregious met on the way, in its own commit. Egregious means: `make cloudflare-test` over 45 s, `pnpm --dir cloudflare run test:ui` over 35 s, `make lint` over 3 s, `make node-e2e` over 15 s, `make smoke-local` over 5 s, `make agent-e2e` over 10 s, `make integration-local` over 60 s; a test that fails in 1 of 3 runs; or a fixture that returns zero for a missing dataset. Record anything else and leave it.
- No production change unless a slice names it. No test-only seam goes into `cloudflare/src/`: the provider and topology live under `cloudflare/local/`, which nothing in `src/` imports (extend `test/node/boundary.test.ts` in L1 to prove it).
- Known traps, each of which cost time during planning:
  - `make worker-bundle`, `make smoke-local`, `make agent-e2e`, and `pnpm build` all rewrite `cloudflare/.cloudflare/output/`. Never run two of them at once, and never background one: a `make` killed mid-build left a broken bundle that answered 500 to everything.
  - Miniflare serves `ASSETS` only with `assets: { directory, binding: "ASSETS", routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true }, assetConfig: { has_user_worker: true } }`. `run_worker_first: true` answers 500 `Fetch for user worker without having a user worker binding`.
  - `ANALYTICS_SQL` is an RPC method, so the provider is a `WorkerEntrypoint` bound as `serviceBindings: { ANALYTICS_SQL: { name, entrypoint } }`. A function service binding is fetch-only and cannot answer `query`.
  - `TEST_NOW_MS` pins the Installation clock only when `ENVIRONMENT` is `test` (`cloudflare/src/cloudflare/ports.ts:3-14`). The collector's `now` is `controller.scheduledTime`, not that clock, and its window is the trailing 90 minutes in 5-minute buckets (`cloudflare/src/projects/metrics.ts:3,57-59`). Anchor generated rows to `scheduledTime`.
  - With the clock pinned in the past, `Installation`'s retention alarm fires repeatedly (`docs/testing.md`, Observability tests); wait for the invocations a test caused, never for quiet.
  - Local workerd tail events carry no script name; the observe harness wraps the collector per producer (`cloudflare/test/observe-e2e/harness.ts:20-31`). Keep that wrapper.
  - `statsctl` reads `127.0.0.1` as a Cloudflare target and `localhost` or a bare name as a Node target (`cloudflare/src/cli/auth.ts:17-20`). The launcher prints `http://127.0.0.1:PORT`. The Worker reads only the `cf-access-jwt-assertion` header (`cloudflare/src/cloudflare/access.ts:68`) and the CLI defaults to `cf-access-token`, so the CLI needs `STATSCTL_AUTH_HEADER=cf-access-jwt-assertion`.
  - A test Access JWT lives one hour (`cloudflare/test/access-token.ts`). Mint one per credential call, never once per session.
  - `playwright.config.ts` is `fullyParallel`. A spec that binds a fixed port or shares one stack sets `test.describe.configure({ mode: "serial" })`, as `services.spec.ts` does, and owns its own port. This campaign uses 4177.
  - No PNGs are tracked and `make dashboard-test` rejects them. This campaign adds no goldens; browser checks are structural.
  - Scratch goes under `.work/tmp`. `os.tmpdir()` follows `TMPDIR`, which the Makefile sets; code written here names `.work/` explicitly instead.
- Every commit is a Conventional Commit with scope `local-stack` (or `docs`, `bench`). The slice ID goes in the body. Code comments never cite this doc. No formatters. Never push.

## Decisions

Owner (2026-11-05):

1. **`statsctl` locally: no CLI change.** The launcher exports `STATS_URL`, `STATSCTL_AUTH_COMMAND`, and `STATSCTL_AUTH_HEADER`, and a test runs the real CLI process through them. No new option, no help or contract change. Reverse only if the CLI proves unable to carry the credential (it did not in the spike).
2. **`make bench-local` is in, minimal, last (O1).** It extends the existing rows bench with machine-readable output and a provenance label per result. No CPU profiles or timing medians.
3. **Offline is enforced in two layers.** The harness fails the run on any unexpected outbound Worker request, and on macOS `make integration-local` runs the whole suite under a sandbox that denies non-loopback network. The Linux equivalent is **Needs environment**.

Prescribed (executor may not reopen without new evidence):

4. **The topology comes from the built `worker.config.json` of both Workers** (`cloudflare/.cloudflare/output/v0/workers/default/worker.config.json`, `cloudflare/observe-worker/.cloudflare/output/v0/workers/default/worker.config.json`), not from `wrangler.test.jsonc` or the `cloudflare.config.ts` text. It is the resolved topology `cf deploy --prebuilt` ships: names, compatibility, `exports` with storage kind, `env` bindings by type, `tailConsumers`, and triggers. Each binding `type` maps explicitly (`text`, `durable-object`, `assets`, `analytics`, `worker`); an unmapped type or an unread key throws, so a production topology change cannot silently diverge. Risk: `cf` is a beta (v1.0.0-beta.27) and may reshape this file; the topology test pins every key it reads and fails loudly on an upgrade. `wrangler.test.jsonc` stays for the in-runtime vitest suite; L1 adds one test that its compatibility settings and Durable Object class match the built config.
5. **The offline provider sits at the `ANALYTICS_SQL` service binding.** Production code runs unchanged: `env.ANALYTICS_SQL.query` in `cloudflare/src/cloudflare/index.ts:48`. It answers a query only when `{ query, params }` equals what the real builders in `cloudflare/src/projects/queries.ts` produce for the registry and the scenario's `scheduledTime`; anything else throws and is recorded. That ties the provider to the "fixed queries only" invariant. Its limit: fixtures cannot show that the hosted SQL dialect still accepts those queries (**Needs environment**).
6. **Expected values come from the scenario model, never from the Worker.** A scenario generates rows from a known model; tests compare stored history and `statsctl` output to sums computed from that model. A test that reads its expectation back from the system under test proves nothing.
7. **Test identity is the existing test key.** `ENVIRONMENT=test` plus `ACCESS_JWKS_JSON` from `wrangler.test.jsonc`, tokens minted by `cloudflare/local/token.ts` with `cloudflare/test/access-key.ts`. The stack binds `127.0.0.1` only. L1's test asserts the built production config keeps `ENVIRONMENT` `production` and has no `TEST_NOW_MS`. The credential command is `node --experimental-strip-types cloudflare/local/token.ts`; no token is ever in argv.
8. **Clock.** Scenarios pin `TEST_NOW_MS` at start. `dev-local` leaves it unset (real clock), and the launcher fires `scheduled` every 5 minutes itself, because local development does not run Cron Triggers. Scenarios that advance time restart the stack on the same persistence directory with a later `TEST_NOW_MS`, which also proves restart.
9. **Scope.** The Node target is already a complete local target (`make node-e2e`) and has no collector, so no Node work. The stack is the Cloudflare topology only. The recorded provider data shapes are `cloudflare/test/fixtures/analytics/{worker,r2-operations,r2-storage}.json`; generated rows use the same columns.
10. **`make integration-local` joins `make check` only if it runs in 60 s or less.** Otherwise it stays a standalone target and `docs/testing.md` says so.

Delegated (executor decides inside the bound and records it in the commit body):

11. Where the provider keeps scenario and call-log state (module state or a small Durable Object). Bound: the call log must be complete across 20 collector runs, proven by test.
12. The dev seed. Bound: at most 5 s to seed and 2 MB of state, built from `fixtures/v2/sources/linux-normal.json` through `src/ingest/encode.ts`.
13. Local Explorer (`/cdn-cgi/local/explorer`, Miniflare option `unsafeLocalExplorer`). Enable it in `dev-local` if it works in one attempt; it is never gating.
14. Whether the browser spec runs under the sandbox. Bound: one fix attempt if Chromium will not launch under the profile; otherwise it runs unsandboxed and `make integration-local` prints `browser: app-level offline only`.

## Baseline

Measured 2026-11-05 on this Mac at `ea7b2c6`, warm caches:

| Command | Time | Result |
| --- | --- | --- |
| `make cloudflare-test` | 31 s | green: vitest 307 (31 files), cli 130, observe 138, node 35, observe-e2e 10, deployments 74, binary 217, cost 38, ingest 10 |
| `pnpm --dir cloudflare run test:ui` | 23 s | 120 passed (38 s before `ea7b2c6` made it parallel) |
| `make smoke-local` / `node-e2e` / `agent-e2e` | 2 s / 8 s / 4 s | green |
| `make lint`, typecheck, `make fixtures` | 1 s each | green |

Known red: none. A `todo` file is untracked in the main checkout and is not this campaign's; never stage it.

Six places hand-build Miniflare options for the `stats` bundle today, which is the drift this campaign removes: `cloudflare/scripts/local-worker.mjs:13`, `cloudflare/test/observe-e2e/harness.ts:88`, `cloudflare/test/agent-e2e/agent.test.ts:12`, `cloudflare/test/node/http-parity.test.ts:42`, `cloudflare/test/node/parity.test.ts:31`, `cloudflare/test/cli/check.test.ts:27`. None supplies `ANALYTICS_SQL`; the tail test relies on that (`cloudflare/test/observe-e2e/tail.test.ts:52`).

The foundation was proven by running real code (the evidence behind Decisions 4, 5, 7, and 8). In one Miniflare instance, the built `stats` bundle, with `ENVIRONMENT=test`, `TEST_NOW_MS` and `scheduledTime` at 2026-11-01T16:35Z, an offline `outboundService`, and a `WorkerEntrypoint` bound as `ANALYTICS_SQL` that served the three recorded fixtures:
- `scheduled()` returned `outcome: "ok"`, and `/api/v1/projects` went from `collector.lastRunAtMs: null, stale: true` to `lastSuccessAtMs: 1793550900004, stale: false`.
- A real `statsctl cost --project stuff --window 1h --json` process, with `STATS_URL=http://127.0.0.1:PORT`, `STATSCTL_AUTH_HEADER=cf-access-jwt-assertion`, and a credential command printing a test JWT, exited 0 with `coverage: "qualified; worker 75% of the window"`.
- With the router config in the traps, `GET /` answered 200 `text/html` and a hashed `/assets/*.js` 200 `text/javascript` with the assertion, and `GET /` without it answered 401.
- The same run under `sandbox-exec` with `(deny network-outbound)` plus loopback and unix-socket allowances still completed the scheduled run and the page fetch, while `curl https://example.com` inside it failed (`000`); outside it, 200.

## Sequence

All slices are serial. Paths are relative to the repo root; `cloudflare/local/` is new. Tests under `cloudflare/test/local/` run as `node --test` through a new `test:local` script that `pnpm test` runs after `test:observe-e2e`.

### L1 · Topology from the built config (M)

- **Owns:** `cloudflare/local/topology.ts`, `cloudflare/local/token.ts`, `cloudflare/test/local/topology.test.ts`, `cloudflare/test/observe-e2e/harness.ts`, `cloudflare/scripts/local-worker.mjs`, `cloudflare/package.json` (`test:local`), `cloudflare/test/node/boundary.test.ts`.
- **Prereq:** none.
- **Work:** build Miniflare options for `stats` and `stats-observe` from the two built configs per Decision 4, with named overrides (`ENVIRONMENT`, `TEST_NOW_MS`, `PROJECTS`, `ANALYTICS_SQL` provider, outbound handler, persistence path, collector mode). Assets use the trap's router config. Migrate `harness.ts` (collector modes `attached`, `crashing`, `absent`, and the `usr-memories` stand-in stay in the harness) and `local-worker.mjs` onto it. Default outbound rejects and records (full behavior in L6).
- **Acceptance:** `pnpm --dir cloudflare run test:local` (topology cases below) and `pnpm --dir cloudflare run test:observe-e2e` still 10 of 10 with its test files unchanged, and `make smoke-local`.
  - The topology names both Workers, their SQLite Durable Object classes, the `OBSERVE` service binding, the tail link, and `ASSETS`.
  - It throws on a planted unknown binding `type` and on a binding removed from a temporary copy of the config.
  - `/` answers 200 with the test assertion and 401 without.
  - `wrangler.test.jsonc` compatibility and class match the built config.
  - The built production config has `ENVIRONMENT: production` and no `TEST_NOW_MS`.
  - `boundary.test.ts` fails when a planted `src/` file imports `cloudflare/local/`.

### L2 · The offline Analytics provider (M)

- **Owns:** `cloudflare/local/analytics.ts`, `cloudflare/local/scenario.ts`, `cloudflare/test/local/analytics.test.ts`.
- **Prereq:** L1.
- **Work:** a `WorkerEntrypoint` source for the provider, and a scenario model (registry, `nowMs`, per-dataset row generators in the recorded fixtures' columns). It answers per Decision 5 and records every call (query text, params, outcome). Modes per dataset: `ok`, `empty`, `late` (omit the newest N slots), `fail`. `statistics.rows_read` is the honest count of rows returned.
- **Acceptance:** `pnpm --dir cloudflare run test:local`:
  - The production registry from the built config (which includes a D1 database and a Durable Object namespace) makes the real collector issue queries against all six datasets (`logs.workersLogs`, `events.durableObjectsInvocations`, `events.r2CombinedOperations`, `states.r2CombinedStorage`, `events.d1Queries`, `states.d1Storage`, plus the D1 statements query), each answered and each parsed by the real parsers.
  - A query whose params differ by one byte throws `unexpected analytics query` and appears in the call log.
  - Generated rows have exactly the recorded fixtures' column sets.
  - The call log is complete across 20 runs.

### L3 · Collection to report, end to end (L)

- **Owns:** `cloudflare/local/stack.ts` (start, stop, restart on one persistence directory, `scheduled(at)`, an Access-authenticated fetch, and `cliEnv(origin)` for the CLI), `cloudflare/test/local/collection.test.ts`.
- **Prereq:** L1, L2.
- **Work:** the six scenarios in **Acceptance**, driven through the real Worker, HTTP API, and a real `statsctl` process. Each scenario is mutation-checked: plant one defect in production code (a dropped dataset, a zero-filled gap, a summed replay, a swallowed collector error, a wrong persist path, a retention constant), see the scenario fail, revert, and record the six defects in the commit body.
- **Acceptance:** `pnpm --dir cloudflare run test:local` in 15 s or less, then **M1**: the full suite.

### L4 · Launcher and development environment (M)

- **Owns:** `cloudflare/scripts/local-stack.mjs` (replaces `local-worker.mjs`), `cloudflare/test/local/launcher.test.ts`, `Makefile` (`dev-local`, `reset-local`, `smoke-local`).
- **Prereq:** L3.
- **Work:** `local-stack.mjs run -- CMD…` starts an ephemeral stack and runs `CMD` with the Decision 1 environment, as `local-worker.mjs` does today (`smoke-local` and `agent-e2e` flows keep working). `local-stack.mjs dev` keeps state in `.work/local/state`, seeds per Decision 12, fires `scheduled` every 5 minutes (Decision 8), prints the origin and the exact `statsctl` environment, and exits cleanly on SIGINT and SIGTERM. `make reset-local` deletes `.work/local/state` only.
- **Acceptance:** `pnpm --dir cloudflare run test:local` and `make smoke-local agent-e2e`. The launcher test covers:
  - `run -- statsctl projects --json` exits 0 with `schema: "statsctl/1"`;
  - `cost --project stuff --window 1h --json` exits 0 against seeded data;
  - a broken credential command exits 3;
  - a `cf` shim first on `PATH` that exits 99 and logs is never called;
  - `dev` serves `/health`, `/`, and `/api/v1/projects`, survives a restart with its state, and leaves no child process after SIGTERM.

### L5 · The browser on the integrated stack (M)

- **Owns:** `cloudflare/test/ui/local-stack.spec.ts`, `Makefile` (`dashboard-test` also runs `pnpm run build:observe`, which the stack's second Worker needs).
- **Prereq:** L3, L4.
- **Work:** the spec starts its own stack in `beforeAll` on port 4177, serial, with the test assertion as an extra HTTP header. It ingests a host, runs a collection, and loads the `stuff` project page and the `stats` observe cards. Checks are structural, with no goldens.
- **Acceptance:** `make dashboard-test` stays green with the new spec's runtime at most 15 s. The spec proves:
  - the project page's estimated-cost figure equals `statsctl cost`'s figure from the same stack;
  - a failing collection shows the collector's stale or failed state and a later good run clears it;
  - the observe cards for `stats` render with data from the attached collector.

### L6 · Offline enforced (S)

- **Owns:** `cloudflare/local/outbound.ts`, `scripts/offline-run.sh`, `Makefile` (`integration-local`).
- **Prereq:** L3 (L5 for the browser leg).
- **Work:** the outbound handler rejects with 503, records `{ url, scenario }`, and the stack's `dispose()` throws if any request was unexpected; a scenario that needs an outbound call (the deployments API in `tail.test.ts`) declares its host. `scripts/offline-run.sh CMD…` runs `CMD` with `CLOUDFLARE_*` and `CF_*` removed from the environment, under `sandbox-exec` on Darwin with `(deny network-outbound)` plus loopback and unix sockets allowed, and exits 2 with a message on any other OS until the Linux mechanism is verified. `make integration-local` builds both bundles (`pnpm build`, `pnpm run build:observe`), runs `test:local`, the L5 spec (Decision 14), and the launcher test through it, and prints which layers were active.
- **Acceptance:** `make integration-local` exits 0, and:
  - `scripts/offline-run.sh curl -m 5 https://example.com` exits non-zero while `scripts/offline-run.sh node -e "fetch('http://127.0.0.1:1').catch(()=>{})"` exits 0;
  - a planted `fetch("https://example.com")` in a Worker under test fails the run and names the URL;
  - the run needs no `cf` login (the shim from L4 stays uncalled).
  - **M2**: the full suite. Apply Decision 10 and record the measured time.

### H1 · Remaining hand-built setups onto the topology (M)

- **Owns:** `cloudflare/test/agent-e2e/agent.test.ts`, `cloudflare/test/node/http-parity.test.ts`, `cloudflare/test/node/parity.test.ts`, `cloudflare/test/cli/check.test.ts`.
- **Prereq:** L6.
- **Acceptance:** `make agent-e2e node-e2e` and `pnpm --dir cloudflare run test:cli` with unchanged pass counts (agent-e2e 1, node 35, cli 130), and `rg -n "new Miniflare" cloudflare` finds only `cloudflare/local/`, `scripts/local-stack.mjs`, and the observe producer stand-ins (`sampling`, `overlap.measure`, `trace-determinism`, `observe/workload.ts`), which never load the `stats` bundle.

### H2 · Opening an older build's state (M, time-boxed)

- **Owns:** `cloudflare/test/local/upgrade.test.ts`.
- **Prereq:** L6.
- **Work:** build the bundle of `a5918ea~1` (the last commit before schema version 8) in `.work/wt/baseline` (`pnpm install --frozen-lockfile --offline`, `pnpm build`), run scenario S1 on it with a persistence directory, stop, start the candidate on the same directory, and compare. Time-box: 20 minutes of setup and two attempts; then park with the cause and move the proof to **Needs environment**.
- **Acceptance:** `pnpm --dir cloudflare run test:local`: pre-upgrade hosts, samples, and project history are present with identical history-frame bytes and ETags, and the candidate serves a route that needs schema version 8.

### H3 · Docs and contract (S)

- **Owns:** `docs/testing.md`, `docs/architecture.md`, `docs/operations.md`, `AGENTS.md`, `README.md` if it names `smoke-local`.
- **Prereq:** H2 resolved or parked.
- **Work:** document the stack (topology source, provider, scenarios, offline layers, honest limits), add the new commands to the `AGENTS.md` command list, add this campaign to its docs table, and add the guard to the `docs/testing.md` command table.
- **Acceptance:** `mdtool check --untracked` on each edited doc when installed (otherwise `rg -n '\[[^]]+\]\(' DOC` and inspect each target); `pnpm --dir cloudflare run test:cli` (its `docs.test.ts` stays green).

### O1 · `make bench-local`, minimal (M)

- **Owns:** `cloudflare/bench/local.workerd.ts`, `Makefile` (`bench-local`), `bench/README.md`, `cloudflare/test/local/bench.test.ts`.
- **Prereq:** H3.
- **Work:** run a fixed workload (the `linux-normal` batches through ingest, then L3's S1 collection) against the stack and print one JSON object per workload with: `workload`, `revision` and a `dirty` flag, Miniflare and workerd versions, `provenance` (`local-measured`, `fixture-replay`, or `modeled`), Durable Object rows read and written from cursor totals (as `cloudflare/bench/ingest-rows.workerd.ts` does), SQL statement count, request and response bytes, stored database growth, and observation rows written per invocation. Counts only; no timing, so the host-load rules do not apply and nothing gates.
- **Acceptance:** `make bench-local` prints valid JSON, two runs give identical counts, `writtenPerSample` still reads 7.762 (the reference: `bench/README.md`, Durable Object rows per ingest), and `bench/README.md` states which provenance applies to each field. `cloudflare/test/local/bench.test.ts` fails when a planted extra SQL statement per ingest changes the counts.

### X · Close (S)

- Prove the moved and replaced code dead or alive (`dead-code-archaeology`): `local-worker.mjs` is deleted once nothing references it.
- Run `review` on the integrated diff and fix P1 and P2 findings.
- Run the full suite and `make integration-local`; record both times in the closing report, and remove `.work/wt/local-stack`.
- Report: what runs offline and what does not, the commands, and the scenarios.

## Acceptance

Every deliverable has one command. The success condition and the failure the test must catch are separate.

| Deliverable | Command | Passes when | Must fail when |
| --- | --- | --- | --- |
| D1 One topology source | `test:local` topology cases, `test:observe-e2e` | 10 of 10 observe-e2e unchanged; topology matches the built configs | an unknown binding type, a removed binding, or an `src/` import of `local/` |
| D2 Offline provider | `test:local` analytics cases | all six datasets answered and parsed; call log complete over 20 runs | a query differing by one byte, a column set that differs from the fixtures |
| D3 Collection to report | `test:local` collection cases (below) | each scenario matches its model | each planted defect in L3 |
| D4 `statsctl` offline | `test:local` launcher cases | exits 0 with `statsctl/1` JSON; broken credential exits 3; no `cf` call | a credential command printing a multi-line value, a `cf` call |
| D5 Browser | `make dashboard-test` | page figure equals CLI figure; failure then recovery shown; observe cards render | a collector that never recovers, a missing observe card |
| D6 Offline enforced | `make integration-local` | exits 0 with both layers named | a planted outbound `fetch`, a denied-network `curl` that succeeds |
| D7 Commands and docs | `make dev-local` (launcher test), docs checks | state survives restart; no stray process after SIGTERM | a dead link, a missing command in `AGENTS.md` |
| D8 Hardening | `make agent-e2e node-e2e`, `test:cli`, `test:local` upgrade case | counts unchanged; upgrade preserves state | state or history-frame bytes that change across the upgrade |
| D9 Minimal bench | `make bench-local` and `bench.test.ts` | identical counts on two runs; 7.762 | a planted extra statement per ingest |

Scenarios for D3 (all anchored at `scheduledTime` 2026-11-01T16:35Z, the time of the recorded fixtures):

| ID | Setup | Passes when | Existing lower-level cover |
| --- | --- | --- | --- |
| S1 success | production registry, all datasets `ok`, collection runs | stored history, `GET /api/v1/projects`, and `statsctl cost --json` equal sums computed from the scenario model; coverage `qualified`; exit 0 | `test/projects-collector.test.ts:75` stores one run; `test/cli-worker.test.ts` seeds one |
| S2 late or incomplete | the newest 3 slots of Worker rows omitted and R2 operations `empty` | the missing data reads `unavailable` or partial coverage in the API and CLI; no zero cost, no improvement claimed | `test/migration.test.ts:75` (purged history unknown, not zero) |
| S3 repeated windows | three runs at +0, +5, +10 minutes over overlapping 90-minute windows; then one run with one slot's value raised | totals equal S1; the second run writes no metric rows; the raised slot is replaced, not summed | `test/projects-collector.test.ts:75,88` |
| S4 failure and recovery | one dataset `fail` for a run, then `ok` | `scheduled()` rejects; the project shows the fixed `collector_failed` detail and stale; host ingest and `/api/v1/hosts` still answer 200; earlier metrics survive; the next run clears it; stats-observe records the failed scheduled trace | `test/projects-collector.test.ts:187,200`; `test/observe-e2e/tail.test.ts:52` |
| S5 restart | stop and start on the same persistence directory | project collector state, host rows, history-frame bytes and ETag, and the observe store's trace count are unchanged | `make node-e2e` restart check (Node target only) |
| S6 retention | restart with `TEST_NOW_MS` beyond the raw and project retention horizons | rows older than the horizon are gone and newer rows remain, in the API and in history-frame windows | `test/operations.test.ts:225-229` (retention sweeps, one object, no restart) |

Observation overhead is already proven through the two-Worker stack by `tail.test.ts` (polling `/api/observe/*` stores nothing; the 100-poll loop at `tail.test.ts:68-71`) and keeps passing on the shared topology in L1. Observation-store retention and count-buffer flushing keep their existing cover in `test/observe` and `observe-e2e/sampling.test.ts`: the production collector has no clock seam, and this campaign adds none (**Non-goals**).

## Needs environment

- **Hosted SQL contract.** Fixtures cannot show Cloudflare still accepts the fixed queries or still returns the recorded column shapes. After any change to `cloudflare/src/projects/queries.ts`, or periodically, the owner runs `node cloudflare/scripts/check-analytics-sql.mjs`, which runs each built query through `cf sql query` and parses the rows with the real parsers (`docs/operations.md:252`), and `pnpm --dir cloudflare -s statsctl health --project stats --json`.
- **Linux offline run.** `scripts/offline-run.sh` exits 2 off Darwin until verified. On a Linux host the owner runs `make integration-local` after the executor's `unshare -rn` variant is added; this campaign cannot run it.
- **Schema upgrade, if H2 parks.** `BASELINE_WORKTREE=.work/wt/baseline` with `a5918ea~1` built, then `pnpm --dir cloudflare run test:local`.
- **Production parity of local timing.** Nothing here measures billable CPU; `statsctl cost` and `verify` against production remain the evidence for that (`self-improvement.md`).

## Execution boundary and non-goals

Authorized: everything in the **Charter** grant, including a macOS `sandbox-exec` wrapper around this campaign's own test commands (it restricts the campaign; it does not bypass a boundary).

Forbidden: pushes; any Cloudflare call, deploy, or credential; SSH; touching the threadripper deployment; new dependencies (Miniflare, Playwright, and Vitest are already pinned); changing the wire or stored format, any HTTP route, `statsctl` options or output, or `cloudflare/src/`, except a fix to a defect a mutation check exposes, in its own commit and surfaced in **Status**; editing `todo`, `TODO.md`, or other campaigns' docs.

Contract changes for the owner: none to an API, type, schema, permission, or invariant. New commands (`dev-local`, `integration-local`, `reset-local`, `bench-local`) join the `AGENTS.md` command list in H3. The build output `worker.config.json` becomes a read dependency (Decision 4).

Non-goals, each with its reason:
- **`cf dev`, `createTestHarness()`, or the Cloudflare Vite plugin as the harness.** Their support for the `cf` config and `.cloudflare/output/v0` format is unverified here, and the Miniflare harness already works (Baseline). Revisit when the format is documented.
- **An instrumented D1 and R2 workload Worker.** The collector side is covered by L2's six datasets. A producer test needs a repo with a D1 or R2 binding to observe; none exists in this repo. Add it with the first such producer.
- **Node target collector or probes.** Cloudflare-only by design (`docs/portable-core-campaign.md`, Decision 4).
- **Observation-store clock and buffering in the integrated stack.** No production clock seam exists and none is added; core tests own it.
- **CPU profiling and timing medians.** Owner decision 2.
- **Running Cron Triggers in tests.** Tests call `scheduled()` explicitly; only `dev-local` emulates the cron.

## Reference

Wiring proven in the Baseline spike, as the topology builder emits it (names and `compat` come from the built config):

```js
{ name: "stats", modules: true, scriptPath: ".cloudflare/output/v0/workers/default/bundle/index.js", ...compat,
  bindings: { ...text, ENVIRONMENT: "test", ACCESS_JWKS_JSON, TEST_NOW_MS, PROJECTS },
  assets: { directory: ".cloudflare/output/v0/workers/default/assets", binding: "ASSETS",
    routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true }, assetConfig: { has_user_worker: true } },
  durableObjects: { INSTALLATION: { className: "Installation", useSQLite: true } },
  serviceBindings: { ANALYTICS_SQL: { name: "analytics-fixture", entrypoint: "Analytics" }, OBSERVE: "stats-observe" },
  tails: ["stats-observe"], outboundService: rejectAndRecord }
```

Code map (verified at `ea7b2c6`):
- Scheduled entry: `cloudflare/src/cloudflare/index.ts:44-65`; collector: `cloudflare/src/cloudflare/projects/collector.ts` (`AnalyticsQuery` at `:18`); fixed queries: `cloudflare/src/projects/queries.ts`.
- Existing harness: `cloudflare/test/observe-e2e/harness.ts` (`collectorModules` at `:26`, `start` at `:69`, `scheduled()` at `:106`); tail test: `cloudflare/test/observe-e2e/tail.test.ts`; CLI worker test: `cloudflare/test/cli-worker.test.ts`.
- CLI target and credential rules: `cloudflare/src/cli/auth.ts:17-20,40-43`; exit codes: `cloudflare/src/cli/exit.ts:13-21`.
- Recorded provider rows: `cloudflare/test/fixtures/analytics/`. Rows bench: `cloudflare/bench/ingest-rows.workerd.ts`; run with `pnpm --dir cloudflare run bench:workerd ingest-rows`.
- Prior campaigns whose conventions this follows: `docs/portable-core-campaign.md`, `docs/service-deployments-campaign.md`.
