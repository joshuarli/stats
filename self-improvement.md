# Stats: shared cost core, `statsctl`, a telemetry foundation, then measured self-optimization

## Status

- **Goal:** build `statsctl`, an agent-facing TypeScript CLI that shares the dashboard's cost engine. Give it the telemetry it needs to answer one question: did this version use fewer resources for the same useful work, without losing data or degrading service, and is the evidence complete? Then use it on production stats for at most three deployed optimization candidates.
- **Baseline:** `00e18d2` on `master`. All loop commands are green (see **Baseline**).
- **Accepted:** G1, D1, E1, T1, C1, L1, C2, L3, T2, T3, P1x, T4, L2 (master `f441be0`, full set green).
- **O0 accepted (09:52Z):** measurement deploy `stats` `8d426e74` (version `e38f0726`) and `stats-observe` `dc041292` (version `f30bbdac`). Over 06:05–09:05Z, coverage reconciled each hour (spread 3.1%, 10.6%, 25.3%, all inside the sampling bound). `host.ingest` rows written per persisted sample read 10.64, 10.93, and 11.00, a 3.4% spread. Observe wrote 3.10 rows per accepted event. Cost run rate: stats $0.19/month, stats-observe $0.16/month. `synthetic-check` is host `h_671f99496b24b9cfa91d34f7fa5b9284`. The 24 h coverage record closes 2026-11-06 05:55Z and is checked at X1.
- **O1 pending:** merged as `3f6411d`, deployed as `stats` `e233b271` (version `bbbb4bb3`, 09:54:09Z). Smoke and `check ingest` passed (`.work/statsctl/safety/e233b271-74cb-443c-b765-4a6a95871df7.json`). Rollback target: version `e38f0726-77a2-41ad-b4df-2f9f8b87a8db`. Resume: `pnpm --dir cloudflare -s statsctl verify --project stats --deployment e233b271-74cb-443c-b765-4a6a95871df7 --policy bench/policies/o1-ingest-rollup-upsert.json --safety-check-file .work/statsctl/safety/e233b271-74cb-443c-b765-4a6a95871df7.json --wait --timeout 4h --json`.
- **M3:** the review of `00e18d2..4ca5419` found 1 P1 and 9 P2; all are fixed (`1c07472`, `1d2f2f7`, `725e393`, `de69070`).
- **P6 (Nanoshop):** N1 and N2 accepted on `campaign/nanoshop` (N2 ends at `37f7b45`; `make cloudflare-test lint dashboard-test` green). Nanoshop pins `695bdd8`. N2 found that overlapping RPCs on one Durable Object mix up diagnostics-channel messages in local workerd (STA-50), and that `ctx.id.name` resolves the store's policy (STA-51; documented as available, Durable Object ID page, updated 2026-05-27). N3 next. The branch merges after O1 is deployed, and N5 deploys in the gap after O1's verdict.
- **Red:** none. **Parked:** none.
- **Resume:** `Execute self-improvement.md from its Status block.` First command: `git log --oneline -1 && make cloudflare-test`.

## Charter

- Implement the campaign; this is not a design exercise. Decide and keep going. Record a decision in **Decisions** only when a later slice depends on it.
- Within the grant in **Execution boundary**, proceed without waiting for approval. This doc gives no permission it does not state. Park any item that needs authority outside the grant and continue with independent items.
- Hard stops, each of which parks the item: an action outside the grant, a boundary this doc forbids, or a loop that cannot check anything. Never push, never force-push, and never reset or overwrite another contributor's commits or deployments.
- Parity before telemetry, telemetry before optimization. No optimization experiment starts before O0 is accepted.
- Cause before retry: when an item fails, use `root-cause` to establish why before trying a second fix. Time-box each item at three attempts. Then park it on `campaign/<item-id>` with the cause and the condition for retrying, record it in **Status**, and move on. Known red on the baseline (STA-43) is not yours. Re-run it once; fix it only if a touched file makes it fail more often.
- Fix egregious problems you meet, each in its own commit:
  - a loop command that runs more than 2× its **Baseline** time;
  - a test in a touched file that fails twice in ten runs;
  - any path that prices missing data as zero.

  Record anything smaller in `TODO.md` (prefix STA, next number in the file) and leave it.
- Watch costs (owner, 2026-11-05). Before every deploy, and at every wakeup while a campaign deployment is live, run `statsctl cost --all --window 1h --json`. The baseline at 06:57Z on 2026-11-05 projects, at list price per month: stats $0.21, stats-observe $0.04, stuff $0.15. usr-memories is $2 on the hour after its fix; its 24 h figure still includes the failure before the fix.
  - If stats plus stats-observe projects above $2 a month for two consecutive settled hours after a campaign deploy, roll that deploy back (P4 step 8 rules) and park the item.
  - If any other project projects above $20 a month, record it in **Status** for the owner and change nothing outside this repo.
- One writer by default. Parallel lanes only for the pairs named in **Sequence**, in worktrees at `.work/wt/<lane>`, following `orchestrate`'s worktree lifecycle. Scratch and `TMPDIR` go in `.work/tmp`.
- Commits are Conventional Commits whose scope is the workstream (`cost`, `cli`, `telemetry`, `deploy`, `campaign`). The item ID goes in the body. A contract change takes `!`. Never amend a deployed commit. Measurements go in a later `docs(campaign)` commit, so deployment-to-SHA mappings stay valid. Code comments never cite this doc.
- After each accepted slice, run the parent steering checkpoint from `orchestrate`'s campaign reference. Then update **Status** in place: accepted, red, parked, next. Do not append a log; git history is the log.
- The executor may revise methods inside an item's bound. It may not change **Decisions** marked owner, the **Execution boundary**, or an acceptance check's success condition.

## Decisions

### Owner (2026-11-04)

1. **Schema:** additive `CREATE TABLE IF NOT EXISTS` is allowed in the `stats-observe` `ObservationStore`, with migration tests. No `ALTER` or drop of existing observe tables. No schema change to the stats `Installation` Durable Object. No change to host ingest or history wire formats or stored formats. Receipt timestamps live in the new tables.
2. **Synthetic host:** the executor may create exactly one production host, named `synthetic-check`, through `POST /api/v1/admin/hosts`. Write the creation response directly to `.work/credentials/synthetic-check.json` (mode 0600). It never appears in argv, stdout, logs, or commits. The executor never rotates, revokes, or purges any host. Its rows age out with normal retention. If the credential file is lost, the production end-to-end check parks under **Needs environment**; do not create a second host.
3. **No deploy freeze.** The owner and other sessions keep deploying stats; 46 deployments landed in the 3.3 days before this campaign. The executor detects overlap. An overlapped experiment is `confounded` and may be retried twice per candidate, then it parks with production verification `pending`.
4. **Observer as a project:** add `stats-observe` to `PROJECTS` in `cloudflare/cloudflare.config.ts`, with its Worker and `ObservationStore` namespace. Its dashboard project page and goldens are part of the change. Tail invocations are priced by CPU only.
5. **Unattended loop (2026-11-05):** after O1–O3, the executor may schedule the P4 loop as an unattended job that deploys stats and keeps or rolls back on `verify`'s verdict, under X2's condition.
6. **Sampled-out counts (2026-11-05):** buffered in the tail isolate and flushed in batches, as N2 describes. Counts are exact for every event that is received and flushed. An eviction loses at most one flush interval of counts, and shows as coverage below `reconciled`. Do not add a durable write per event.

### Prescribed

Each decision gives its reason, and what would reverse it.

1. **Name and invocation.** The CLI is `statsctl`, run as `pnpm --dir cloudflare -s statsctl …`. The entry point is `cloudflare/src/cli/statsctl.ts`, and it also runs as `node --experimental-strip-types cloudflare/src/cli/statsctl.ts`. Reason: `stats` is the Rust agent's name.
2. **No new dependencies.** Use `node:util` `parseArgs`, global `fetch`, `node:test`, `node:fs`, and `node:crypto`. No CLI framework, schema library, or SDK. Reason: the standard library covers it. Reverse only if a gate in **Acceptance** cannot be met without one, and then justify the build-time and size impact in the commit.
3. **Shared core layout.**
   - `cloudflare/src/cost/` owns: the versioned tariff table (moved from `src/client/pricing.ts`), meter identities and units, ledger construction, plan bill and projection, coverage semantics, comparison arithmetic, and `buildCostReport`.
   - `src/deployments/compare.ts` imports pricing from `src/cost/`, not `src/client/`.
   - The modules in the CLI's import graph use explicit `.ts` import extensions and erasable syntax only. This includes `src/client/history.ts`, `src/client/columns.ts`, `src/binary/*`, `src/limits.ts`, `src/observe/client/decode.ts`, and anything they import.
   - The dashboard and the CLI both call `buildCostReport`. Presentation stays in adapters: Solid and JSX in `src/client/`, terminal and JSON rendering in `src/cli/`.

   Reason: today `cost-ledger.ts` fails to load under Node with `ERR_MODULE_NOT_FOUND` on `../../history`, while `compare.ts` loads.
4. **No new server cost endpoint.** The CLI reads the existing authenticated routes: `/api/v1/projects`, `/projects/:id/history?from&to&kinds`, `/projects/:id/deployments`, `/projects/:id/deployments/:id/comparison`, and `/api/observe/stats/*`. The only additive read routes are the window-scoped observe route in T4 and the fields the comparison spec needs.
5. **Accounting fixes in the shared core.** The audit found each of these at `00e18d2`. Each fix is a deliberate change to dashboard behavior, recorded in its commit:
   - A Worker series with no covered bucket prices as zero (`cost-ledger.ts:173` falls back to factor 0, and `workerLine` has no coverage check). It becomes `uncollected/no-data`, the same as the Durable Object and D1 lines.
   - `billedBeyondPlan` (`cost-ledger.ts:450`) subtracts the full account allowance per project. Keep it, but name it `isolated` in the report, with the assumption stated. An account total exists only when every project in the account is covered and shared allowances are applied once. Otherwise account billing impact is `unknown`.
   - `monthOf` (`ledger-load.ts:108`) is a UTC calendar month. The report labels it `utc-month`, never the billing cycle.
   - Every total lists its priced meters, its excluded meters, and its residuals. The ledger total and the comparator's per-1,000-invocation cost keep different scopes, but they share arithmetic and name their meter sets.
   - Durable Object SQLite rows are priced from operation summaries (T1, T2) where available. Elsewhere they stay `uncollected/no-source`, never free. R2 Class A and B remain unpriced, because the analytics source has no action column.
   - Durable Object duration from summed wall time stays a bound of type `upper`, labelled a proxy.
6. **Tariff table.** Tariffs live in one table at `src/cost/pricing.ts`, carrying `PRICING_REVISION`, a source URL per meter, and a `verifiedOn` date. Verify every price against the Cloudflare pricing pages for Workers, Durable Objects, D1, and R2, plus the Tail Workers page, when C1 lands. Never fetch prices at runtime. Baseline and candidate always use the same revision.
7. **Exit codes for `statsctl`:**

   | Code | Meaning |
   | --- | --- |
   | 0 | Read succeeded, or verification `improved` |
   | 2 | Usage error |
   | 3 | Authentication |
   | 4 | Transport or contract failure |
   | 5 | `pending` or `insufficient-data` |
   | 6 | `unchanged` or `confounded` |
   | 7 | `regressed` |

   The JSON verdict is authoritative. `pnpm observe` (`src/observe/client/cli.ts`) keeps its own codes, because `make observe-sourcemap` depends on them. `statsctl observe …` calls the shared observe decoders and maps their failures to the codes above. Never scrape subprocess output.
8. **Authentication.**
   - The credential command defaults to `cf access token <origin>`. Override it with `STATSCTL_AUTH_COMMAND`, plus `STATSCTL_AUTH_HEADER` (default `cf-access-token`).
   - Run the command with stdin closed and a 20 s timeout. A failure exits 3 with `run: cf access login <origin>`. Never start a login.
   - Send the credential only to the configured origin, and do not follow redirects. A 3xx, an HTML 200, or a 401 or 403 is exit 3.
   - Credentials never enter argv, snapshots, logs, or report fields.
9. **HTTP limits.**
   - 15 s timeout per request.
   - Body cap 8 MiB for history and 1 MiB for JSON.
   - At most two retries, with jittered backoff, only for GETs that fail with a network error, 502, 503, or 504.
   - Bundle history kinds into one request per window.
10. **JSON envelope.** Version 1 has these fields:
    - `schema: "statsctl/1"`, `command`
    - `generatedAtMs`, `origin`, `project`, `windows: [{fromMs, toMs}]` (half-open, UTC)
    - `pricingRevision`, `measurementRevision`, `coverage`, `units`
    - `priced`, `excluded`
    - `warnings: [{code, message}]`, `identities` (deployment and version ids)
    - `payload`, or `error: {code, message}`

    Numbers stay numbers, and u64 values stay decimal strings. Ordering is deterministic. In `--json` mode stdout carries exactly one document. Diagnostics go to stderr, with no progress output, colour, or pager when stdout is not a TTY or `NO_COLOR` is set.
11. **Snapshots and state.**
    - Snapshots live in `.work/statsctl/snapshots/`, and `verify` state in `.work/statsctl/verify/<deployment-id>.json`.
    - A snapshot holds:
      - the raw history frames, base64-encoded;
      - the decoded deployment and observe JSON;
      - the resolved windows, the project config, and resource identities;
      - `pricingRevision`, `measurementRevision`, and the git SHA of the CLI;
      - a SHA-256 of each input.
    - Snapshots never hold credentials or observe stack frames.
    - Each snapshot is capped at 4 MiB, and the directory at 200 MiB, pruned oldest first.
    - `--input` refuses a snapshot whose schema, pricing revision, or hash does not match. The refusal is exit 4 with a reason code; there is no reinterpretation.
12. **Operation summaries.** These are the narrow form of the follow-up's resource and work accounting.
    - **Closed set.** `OperationId` is a closed union: `host.ingest`, `host.history`, `project.history`, `collector.record`, `cleanup.retention`, `deployments.poll`. Each operation has a fixed, typed field set:

      | Operation | Work fields | Resource fields |
      | --- | --- | --- |
      | `host.ingest` | samples received, persisted, duplicate, rejected by code | input bytes |
      | `host.history`, `project.history` | `workloadClass` (range or resolution × kind set), points, cells | output bytes, `cache: "hit-304" \| "rebuilt"` |
      | `collector.record` | runs, metric rows changed, hour rollups rebuilt | upstream queries |
      | `cleanup.retention` | rows expired, backlog remaining | — |

      Every summary also carries SQLite `rowsRead`, `rowsWritten`, and the statement count.
    - **Row accounting.** `src/sql-account.ts` provides an accountant. Each operation passes its own instance through the code it runs. The accountant runs `exec`, fully consumes the cursor, then adds the cursor's `rowsRead` and `rowsWritten`, which are final only after consumption and include index-row writes. Never subtract shared counters, never count returned arrays, and never estimate index amplification.
    - **One publish per invocation.** An instrumented entry point publishes exactly one `operation` message, carrying trace context, in a `finally`. It replaces `markInvocation()` for that invocation, which keeps the observability campaign's limit of one in-process publish per invocation. Entry points without instrumentation keep `markInvocation()`.
    - **Timing.** No `performance.now()` or `Date.now()` around synchronous code; production timers advance only on I/O. CPU comes from the tail event's `cpuTime`.
    - **Storage.** Observe stores summaries in an additive `observe_operations` table, one row per (5-minute event-time bucket, version, operation, workloadClass, synthetic flag), with receipt lag (`lag_count`, `lag_ms_max`, `lag_ms_sum`). Each row holds summed fields plus `count`, `failed`, `cpuMsSum`, and `wallMsSum`. Use µs integers if the tail `cpuTime` has fractional precision; otherwise record that it is quantized to ms. Retention is 7 days. Rows are bounded by the closed sets.
    - **Deploy order.** The tail reducer rejects any channel message kind it does not know (`tail.ts` `readChannel`). So the reducer that accepts `operation` deploys and is verified before any producer emits one. Never roll `stats-observe` back below that version while stats emits `operation`.
13. **Outcome coverage.** This separates accounting coverage from diagnostic retention.
    - **Outcome counts.** Production tail batches hold one event each, so a per-batch row for every event would double observe writes. Observed events are counted from `observe_invocations`, one row each, which already exists. The tail worker counts every other event in an additive `observe_outcomes` table, per (5-minute event-time bucket, version, stage, outcome class, route label or `other`, at most 32 routes per key). The outcome classes are:
      - `excluded-status:401|403|404`;
      - `excluded-route`;
      - `rejected-invalid`;
      - `unknown-service`, stored in the `stats` store.
    - **What doesn't change.** The diagnostic filter (`EXCLUDED_STATUSES`, `tail.ts:25`) and the `observe_invocations` contents stay as they are.
    - **Receipt lag.** The lag is receipt time minus event timestamp. It is recorded on `observe_operations` rows, and on outcome rows for the rare classes. `observed_at` stays as it is.
    - **Revision.** `OBSERVE_FILTER_REVISION` is a constant stored with each bucket.
    - **Coverage state** of a window is computed, never assumed. It is:
      - `reconciled` when the observe event total at the `worker` stage (observed invocations plus all outcome classes) is within a bound of `worker.invocations` from `project_samples` for the same 5-minute buckets. The bound is the larger of 5% and three standard errors of the sampled estimate. Revised 2026-11-05: the source counts only stateless Worker events and is Workers Logs sampled at 0.1, so an analytics bucket with no sampled event counts as zero;
      - `partial` when the difference is larger, or observed buckets are missing;
      - `unknown` when either source lacks the window.

      A fresh newest event never implies `reconciled`. The executor records the measured spread in `docs/architecture.md` once O0 has a day of data. If the spread on a known-quiet day exceeds 5%, widen the bound to the observed spread plus 1 point, and record why.
14. **One comparison specification.**
    - **Shape.** `src/compare/spec.ts` defines `ComparisonSpec`, carrying:
      - the exact before and after windows from `comparisonBounds`;
      - the deployment id and version ids on each side;
      - the `OperationId` and `workloadClass` scope;
      - `measurementRevision`.
    - **Consumers.** `compareDeployment` and the new observe window query both consume it.
    - **Exploration stays exploratory.** `rolloutImpact` (`store.ts:716`), which scans the whole retention window by version, stays as it is. The acceptance path never calls it.
    - **Rollbacks.** Windows are time-bounded, so a rolled-back version inherits nothing from its earlier deployment.
15. **`verify` gate.** This replaces "reuse the existing thresholds" for operation-scoped metrics.
    - **Evidence.** At `00e18d2` the comparator returns `confounded` for both stats deployments whose 1-hour windows are free of overlap (`76b688f6…`, `2345f16c…`). The reason is that the top-route mix moved more than 20 points (`compare.ts:137`). Its 5xx share needs 1,000 invocations (`compare.ts:146`), while stats gets about 300 to 400 an hour.
    - **Global checks stay as they are.** Global, project-wide metrics keep every existing reason: the route-mix check, the 100-invocation floor, settled coverage, the stable baseline, and overlap.
    - **Operation-scoped metric.** A metric is a sum over operation buckets matching the spec's operation, `workloadClass`, and synthetic flag = false, divided by that operation's fixed work denominator:

      | Operation | Work denominator |
      | --- | --- |
      | `host.ingest` | persisted samples |
      | `host.history`, `project.history` | requests within one `workloadClass` |
      | `collector.record` | successful runs |
      | `cleanup.retention` | rows expired |

      It is blocked by settled coverage, the stable baseline, overlap, split or deferred rollouts, and coverage state other than `reconciled`. It is not blocked by the global route-mix check. It is blocked instead when work units per operation, or the share of that operation's workload classes, moves by more than 2× or 20 points.
    - **Minimums.** Each side needs at least 100 operations. The material change is at least 10% and at least the metric floor named in the policy.
    - **Guardrails:**
      - the fast safety check passes (prescribed 17);
      - no `failed` operations after the deploy, if the before window had none;
      - otherwise the failure share does not rise by more than 1 point;
      - no new observe issue group whose first version is the candidate;
      - probe failure share does not rise;
      - coverage stays `reconciled`;
      - for ingest, `persisted / (received - rejected)` does not fall.

      An insufficient guardrail is never a pass.
    - **Verdict precedence:** `regressed` (any guardrail) > `confounded` > `insufficient-data` > `pending` > `improved` / `unchanged`.
16. **Readiness is per policy.** `statsctl verify --policy P --readiness` and `statsctl health` list each signal the policy needs as `available`, or `unavailable:<code>` with a sentence. An example: `ingest write-efficiency unavailable: operation summaries absent for host.ingest`. A missing meter the policy does not use does not block it.
17. **End-to-end check.**
    - **Command.** `statsctl check ingest --credential-file F` is a mutating command, labelled as one in help. It:
      1. encodes one known sample with a fresh seq and time;
      2. POSTs STB2;
      3. decodes STA2 and expects accepted 1;
      4. reads the host history for the window and finds the sample;
      5. re-POSTs the identical bytes and expects duplicate 1, accepted 0;
      6. confirms the stored count did not change.
    - **Encoder.** The STB2 encoder is promoted from `test/support/stb2.ts` to `src/ingest/encode.ts`. It must reproduce every `fixtures/v2` golden frame byte for byte (`test/ingest/conformance.test.ts`). The real Rust agent stays covered by `make agent-e2e`. A STA2 decoder in `src/ingest/` follows the same rule against the corpus acks.
    - **Locally** it runs against both the baseline and the candidate build in workerd.
    - **In production** it runs only with the `synthetic-check` credential, and only inside the excluded deployment and warm-up interval (the deploy time up to `after.fromMs`). Synthetic operations carry the synthetic flag and are excluded from organic metrics. Their cost stays in totals.
18. **Observer and experiment overhead.**
    - **Three totals.** Reports separate application cost (`stats`), observation cost (the `stats-observe` project: Tail CPU only, plus its DO requests, duration, rows, and storage), and experiment overhead. Experiment overhead is the requests `statsctl` made, counted client-side and written into the verify state.
    - **No observer of the observer.** `stats-observe` never tails itself.
    - **Polling limits.** `verify --wait` sleeps until the window's `readyAtMs` before its first data read. After that it polls at most once every 15 minutes, with `If-None-Match`. Each poll makes at most 6 requests. A full verify makes at most 60 requests.
    - **Instrumentation budget.** T1 through T3 may add at most 1.0 observe row written per stats invocation over the baseline of 3.0. The baseline is 38,639 ingest rows over 12,885 invocations, read from production `health` on 2026-11-04. They also keep the stats Worker gzip bundle within 5 KiB of baseline.
19. **Deploy targets.**
    - `make worker-deploy` always redeploys `stats-observe` first (`Makefile:96`).
    - D1 adds `make stats-deploy`: the same flow without `observe-deploy`.
    - Experiments that change no observe code use `stats-deploy`. Others use `worker-deploy` and record both version ids.
    - Never run `make deploy`, which pushes to hosts.
    - Confirm deployment ids from `cf workers deployments list --worker <name>` and from `statsctl deployments`, never from a log line alone.
    - A command that failed after upload may still have changed production. Inspect the active deployment before you retry or roll back.
20. **Campaign record.**
    - Each experiment's hypothesis and policy are committed before its deploy, at `docs/cost-campaign.md` § Experiments, together with the policy file `bench/policies/<id>.json`.
    - The result is a later `docs(campaign)` commit. It covers the code SHA, deployment and version ids, exact windows, counts, coverage state, absolute and relative deltas, denominators, exclusions, cost basis, guardrails, and the keep, revert, or pending decision.
    - Refresh the stale readings in `docs/cost-campaign.md` § State in place, rather than appending.

### Delegated

The executor decides each of these within its stated bound, using the smallest reversible assumption, and records the choice in the item's commit body.

- **Module moves.** Whether `src/client/history.ts` and `columns.ts` move to a neutral folder or stay with clean imports. Bound: no CLI import reaches `solid-js`, `@solidjs/*`, `uplot`, `*.tsx`, or `src/client/pages/**` except `src/cost/`. The test in C1 enforces this.
- **Spellings.** Command and flag spellings beyond the ones in **Acceptance**. Bound: help, tests, `llms.txt`, and the docs change together.
- **The fourth `workloadClass` dimension** for history reads: approximate series count or kind set. Bound: at most 24 classes per operation.
- **Which candidates to try** in O1–O3, ranked from `statsctl` evidence. Leads to start from: STA-31 (collector store write), the ingest commit path (STA-33), and history cache misses. Bound: no candidate may reduce retention, resolution, collection cadence, sample persistence, or Access coverage.

## Baseline

At `00e18d2` on 2026-11-04, on this Mac, each command run once:

| Command | Result | Wall |
| --- | --- | --- |
| `pnpm run test:deployments && test:observe && test:binary` (in `cloudflare/`) | green | 9 s |
| `pnpm typecheck` | green | 2 s |
| `make cloudflare-test` | green, 274 tests | 22 s |
| `make lint` | green | 1 s |
| `make worker-check` | green | 3 s |
| `make smoke-local` | green | 2 s |
| `make agent-e2e` | green | 4 s |
| `make dashboard-test` | green, 114 tests | 40 s |

- **Known flake:** STA-43 (`test/history.test.ts:266`). `make check` and `make agent-build` were not timed; no slice needs them.
- **Production, read-only:**
  - Collectors for all three projects are fresh.
  - Deployment sync is enabled, error-free, and not truncated, with 46 stats deployments since 2026-11-01. `docs/deployments.md` saying "has not been deployed" is stale; H1 fixes it.
  - Observe health: 21,794 live invocations, cleanup backlog 0, 1 conflict (STA-44).

## Sequence

Sizes are S, under half a day, and M, up to a day. Each item ends on its own acceptance command plus the narrowest affected suite, run on the integrated tree. The full set (`make cloudflare-test lint worker-check smoke-local agent-e2e dashboard-test`, about 85 s) runs at milestones M1–M3 and at the close.

### P0 — Ground

- **G1** (S, `campaign`): track this doc, confirm the baseline in **Status**, and run `make work-ready`. Acceptance: `git log -1 --format=%s` shows the commit, and the full set is green.

### P1 — Shared core and CLI parity (reference: the dashboard ledger and the comparator at `00e18d2`)

- **C1** (M, `cost`; owns `src/cost/**`, `src/client/pricing.ts` (deleted), import-extension edits in the modules the CLI imports, `src/deployments/compare.ts` (import only), `test/cost/**`, `cloudflare/vitest.config.mjs` (exclude `test/cost/**` and `test/cli/**`, which are `node --test` suites), and `cloudflare/package.json` (`test:cost` and `test:cli` scripts, both added to `test`)).
  - Work: move the tariffs and the pure ledger, plan-bill, and projection functions into `src/cost/`, with the revision and source metadata of prescribed 6. Leave behavior unchanged in this item.
  - Parity register: `test/cost/parity.test.ts` runs as a `node --test` suite. Every behavior asserted today in `test/project-ledger.test.ts`, plus `planBill` and `projectedBill` on the `test/ui/captures/stats`, `stuff`, and `usr-memories` inputs, produces identical output through the moved functions.
  - Dependency test: `test/cost/boundary.test.ts` walks the import graph from `src/cli/` and `src/cost/` and fails on any forbidden import from the first delegated bound.
  - Acceptance: `cd cloudflare && node --experimental-strip-types --test test/cost/*.test.ts && pnpm typecheck && pnpm vitest run test/project-ledger.test.ts`.
- **C2** (M, `cost`; prerequisite C1; owns `src/cost/**`, `test/cost/**`, `src/client/pages/project/{cost-ledger.ts,ledger-load.ts,CostLedger.tsx}`).
  - Work: the accounting fixes of prescribed 5, plus `buildCostReport`. `buildCostReport` takes an explicit clock, the windows, the pricing revision, the project config, and decoded inputs, and returns the typed report: priced and excluded sets, coverage, denominators, isolation assumptions, and residuals. Switch `CostLedger.tsx` to render from the report.
  - Tests. Each one fails before the fix:
    - a Worker series that is entirely missing gives `uncollected`, not $0;
    - known zero vs unavailable;
    - a partial window gives a qualified run rate, never `verified`;
    - an absent baseline;
    - storage accrual;
    - the account total is `unknown` without full coverage;
    - tariff boundaries at the allowance;
    - a top-N route that disappeared leaves a residual, not a saving;
    - truncated SQL labels are not merged.
  - Acceptance: `cd cloudflare && node --experimental-strip-types --test test/cost/*.test.ts && pnpm vitest run test/project-ledger.test.ts && cd .. && make dashboard-test`. Screenshot diffs are inspected one by one. Regenerate only goldens whose change is one of the prescribed fixes, and name each in the commit.
- **L1** (M, `cli`; prerequisite C1; owns `src/cli/**`, `test/cli/**`, and the `statsctl` script in `cloudflare/package.json`).
  - Work:
    - parser and help tree: top-level, per command, and `help workflow`;
    - envelope, exit codes, auth, and HTTP limits from prescribed 7–10;
    - commands `projects` and `health`.
  - `health` reports collector, deployment sync, and observe health independently, using the observe decoders.
  - Help must explain each command's purpose, arguments, defaults, time units (UTC, half-open windows), credential configuration, read vs mutation behavior, output modes, exit codes, and limitations. `help workflow` gives a copy-pastable recipe for each of these tasks:
    - discover projects;
    - find a bottleneck and drill into it;
    - save a snapshot;
    - compare an exact deployment;
    - write a policy;
    - wait for settlement;
    - interpret `inconclusive`, `confounded`, and `insufficient-data`;
    - resume after an interruption.

    It also explains why a lower monthly estimate is not necessarily a win. An unfamiliar agent must be able to finish the P4 loop from help alone.
  - Tests:
    - help at every level works offline, with no network, no credential command, and no UI import;
    - unknown and conflicting options exit 2;
    - an HTML login page, a 401, or a redirect exits 3;
    - malformed JSON or frames exit 4;
    - one JSON document on stdout, including for failures;
    - `NO_COLOR` and non-TTY output are respected;
    - a fake origin returns a redirect and the test asserts the credential is not forwarded;
    - `statsctl --help` exits 0 under real `node --experimental-strip-types`, measured as wall time (median of 5).
  - Acceptance: `cd cloudflare && node --experimental-strip-types --test test/cli/*.test.ts`.
- **L2** (M, `cli`; prerequisites C2 and L1).
  - Work:
    - `cost`, covering `--project`, `--all`, `--window`, `--from/--to`, and `--month-to-date`. The default is the latest settled hour. Output gives a bounded detail of the top 15 children per line. Large series are omitted unless `--series` is set.
    - `snapshot --out` and `cost --input` (prescribed 11).
  - Tests: a local Worker integration test seeds history through real ingest in workerd. It reads real binary frames through the production decoders, and asserts the CLI report equals the dashboard adapter's report on the same inputs. Snapshot replay is offline. Corrupt or mismatched snapshots exit 4.
  - Acceptance: `cd cloudflare && node --experimental-strip-types --test test/cli/*.test.ts && pnpm vitest run test/cli-worker.test.ts`.
- **L3** (S, `cli`; prerequisite L1).
  - Work: `deployments`, `compare --deployment <id> --window`, and `observe routes|traces|issues|deployment`. `observe` is read-only; `resolve`, `reopen`, and `sourcemap` are not exposed. `latest` resolves once to an immutable id.
  - Acceptance: `cd cloudflare && node --experimental-strip-types --test test/cli/*.test.ts test/deployments/*.test.ts`.
- **M1 milestone:** the full set green, and `pnpm --dir cloudflare -s statsctl cost --project stats --json` run against production succeeds. Record the request count and runtime in the L3 commit body.

Parallel lanes in P1: C2 may run alongside L1 and L3, which own disjoint files. L2 waits for both.

### P2 — Telemetry foundation and verification

- **T1** (M, `telemetry`; owns `src/sql-account.ts`, `src/observe/producer/channel.ts`, `src/observe/cloudflare/{tail.ts,worker.ts,store-object.ts}`, `src/observe/core/{store.ts,model.ts}` (additive), `test/observe/**`).
  - Work: the accountant, the `operation` channel message and its reducer support, and the `observe_operations` table with retention and capacity (prescribed 12).
  - Tests:
    - the reducer accepts an `operation` message and still rejects unknown kinds;
    - one publish per instrumented invocation;
    - row counts come from consumed cursors, asserted against a workerd SQLite cursor in a vitest Workers test;
    - an additive migration on a store populated at the `00e18d2` schema keeps every existing row;
    - bucket upserts stay bounded.
  - Acceptance: `cd cloudflare && pnpm run test:observe && pnpm vitest run test/sql-account.test.ts && pnpm run typecheck:observe`.
- **T2** (M, `telemetry`; prerequisite T1; owns `src/installation.ts`, `src/projects/{store.ts,history.ts}`, `src/index.ts`, `src/deployments/installation.ts`, and their tests).
  - Work: instrument `host.ingest`, `host.history`, `project.history`, `collector.record`, `cleanup.retention`, and `deployments.poll`.
  - Tests: a known batch in workerd yields a summary whose persisted, duplicate, and rejected counts equal its STA2 ack, and whose rows equal the cursor totals. A 304 history read records `hit-304`.
  - Acceptance: `make cloudflare-test && make agent-e2e`.
- **T3** (S, `telemetry`; prerequisite T1; owns `src/observe/cloudflare/{tail.ts,worker.ts}` and `src/observe/core/store.ts` (additive)).
  - Work: `observe_outcomes`, receipt lag, and `OBSERVE_FILTER_REVISION` (prescribed 13).
  - Tests:
    - a 404 is counted `excluded-status:404` and is still absent from `observe_invocations`;
    - an unknown route is counted `excluded-route` under `other`;
    - an unknown service is counted.
  - Acceptance: `cd cloudflare && pnpm run test:observe && pnpm run test:observe-e2e`.
- **T4** (M, `telemetry`; prerequisites C1 and T3; owns `src/compare/**`, `src/deployments/{compare.ts,installation.ts}`, `src/observe/http/api.ts`, `src/observe/client/decode.ts`, and their tests).
  - Work:
    - `ComparisonSpec` (prescribed 14);
    - `GET /api/observe/stats/window?from&to&operation&class`, which returns the operation and outcome buckets and the coverage state for exact bounds;
    - the operation-scoped comparison of prescribed 15.
  - Tests:
    - a rollback that reuses an old version does not pull in observations from that version's earlier deployment;
    - the global route-mix change still blocks global metrics but not a stable operation-scoped metric;
    - operation workload drift beyond 2× or 20 points blocks;
    - `partial` or `unknown` coverage gives `insufficient-data`.
  - Acceptance: `cd cloudflare && pnpm run test:deployments && pnpm run test:observe && pnpm vitest run test/deployments-api.test.ts`.
- **E1** (M, `cli`; owns `src/ingest/{encode.ts,ack-decode.ts}`, `src/cli/check.ts`, `test/ingest/**`, `test/cli/**`).
  - Work: promote the encoder (prescribed 17) and add `statsctl check ingest`. `test/support/stb2.ts` becomes a re-export of the production encoder, or is deleted.
  - Acceptance: `make fixtures && cd cloudflare && pnpm run test:ingest && node --experimental-strip-types --test test/cli/check.test.ts`. The CLI test runs the check against the built Worker in workerd and covers four cases: accept, readback, duplicate replay, and a wrong token exiting 3.
- **L4** (M, `cli`; prerequisites L2, L3, T4, E1; owns `src/cli/verify.ts`, `bench/policies/example.json`, and `test/cli/**`).
  - Work: `verify`, with `--policy`, `--readiness`, `--wait`, `--timeout`, and resumable state; the fast safety check; and the policy type of prescribed 15 and 16, with every field explained in help.
  - Tests, all on a fake clock and fake origin:
    - overlap and split or deferred rollouts;
    - traffic change, insufficient samples, and delayed settlement;
    - interrupted then resumed waits;
    - a timeout returns `pending` with an exact resume command and exit 5;
    - an unknown guardrail never passes;
    - a regressed guardrail overrides a cost win;
    - the poll budget holds;
    - SIGINT during `--wait` persists state and exits 5 with the resume command.
  - Acceptance: `cd cloudflare && node --experimental-strip-types --test test/cli/*.test.ts`.
- **P1x** (S, `campaign`; prerequisite T2; owns `cloudflare/cloudflare.config.ts`, `src/cost/pricing.ts` (Tail meter), dashboard goldens).
  - Work: add `stats-observe` to `PROJECTS`. Find the namespace id with a read-only `cf` listing. Price its Worker line by CPU only.
  - Acceptance: `make cloudflare-test && make dashboard-test`, with the new goldens inspected.
- **D1** (S, `deploy`; owns `Makefile` and `docs/operations.md` § deploy): add `make stats-deploy` (prescribed 19).
  - Acceptance: `make -n stats-deploy | rg -q 'cf deploy' && ! make -n stats-deploy | rg -q 'observe-worker'`, and `make worker-check`.
- **M2 milestone:** the full set is green, and every item above is accepted.

Parallel lanes in P2: T1, T3, then T4 form one lane. E1 and D1 may each run in their own lane alongside it. T2 follows T1, and P1x follows T2.

### P3 — Hardening and deploying the instrumentation

- **H1** (S, `campaign`): update `AGENTS.md` (commands and a doc-table row for this campaign), `docs/operations.md` (statsctl recipes), `docs/deployments.md` (it is deployed and syncing; refresh the verification record), `docs/architecture.md` (the operations and outcomes tables and the coverage rule), and `cloudflare/public/llms.txt`. Help text is the source of truth; documents link to `statsctl help workflow` instead of copying it. A test runs every command example in `help workflow` and `llms.txt` through the parser.
  - Acceptance: `cd cloudflare && node --experimental-strip-types --test test/cli/docs.test.ts`.
- **O0** (M, `telemetry`; prerequisites T1–T4 and P1x, which record data; L4 and H1, which are client-side and docs, may land during the wait). Deploy the measurement changes alone, with no optimization:
  1. `make observe-deploy`;
  2. verify that `stats-observe` health still accepts events;
  3. `make stats-deploy`;
  4. `make smoke-deployed`;
  5. create `synthetic-check` (owner decision 2);
  6. `statsctl check ingest` in production.

  Wait for 3 settled hours (each hour plus the 45-minute settlement). Then `statsctl health --project stats --json` must show operation summaries for `host.ingest` and `project.history`, coverage `reconciled` in each of the 3 hours, observe rows per invocation within budget, and an hour-to-hour spread of the first candidate's metric of at most a third of its `minChangePercent`. A candidate whose metric follows load (CPU or wall time per unit) waits for 24 h of baseline instead. The 24 h record keeps accumulating while candidates run: at X1, check that coverage was `reconciled` in at least 20 of the first 24 hours and record the spread (prescribed 13). A changed measurement system is not evidence that the system got cheaper, so baselines start after O0.
  - Acceptance: `statsctl verify --policy bench/policies/example.json --readiness --project stats --json` exits 0, with every signal the example needs `available`.
- **M3 milestone:** the full set is green. Then use `review` on the integrated diff `00e18d2..HEAD` and fix its P1 and P2 findings.

### P4 — Optimization

Run at most three deployed candidates (O1–O3), one at a time.

**Stop early when:**
- no candidate's estimated saving reaches 10% of its operation's cost, or of the project's list cost;
- two successive candidates show no material gain;
- a guardrail fails;
- the next step needs authority outside the grant.

**Per candidate**, the item ID is `O<n>`, and it owns only the files of its change:

1. Rank operations with `statsctl cost` and `statsctl observe routes`. Reconcile any counter you will optimize against an independent source: the analytics route CPU versus observe, rows versus `cf` cursor totals in a local reproduction, and `node cloudflare/scripts/check-parity.mjs` for stored buckets. Old TODOs are hypotheses, not measurements.
2. Commit the hypothesis and policy (prescribed 20) before looking at any result.
3. Reproduce the waste offline. Use a workerd benchmark on a representative bounded workload: row, statement, and transaction counts, and a timing distribution over 10 or more interleaved baseline and candidate runs on the same toolchain. Keep Node, workerd, and Cloudflare numbers apart. Follow `benchmark-checklist` before you report a number.
4. Implement one coherent change. Run its narrow checks plus `make cloudflare-test agent-e2e smoke-local`. Record the rollback target from `cf workers deployments list --worker stats`.
5. Make sure no deployment of stats or stats-observe falls inside the last 75 minutes. Then deploy with `make stats-deploy`, or `worker-deploy` if observe changed. Confirm the ids, and run `make smoke-deployed` and `statsctl check ingest` inside the warm-up interval.
6. Run `statsctl verify --deployment <id> --policy … --wait --timeout 4h`. If this session cannot stay active that long, persist state, set **Status** to `pending` with the resume command, and continue with any work that does not deploy.
7. Keep the change only when the verdict is `improved`. Describe it at the scope the evidence supports: resource efficiency, list-price saving, or hypothetical overage. Account billing impact stays `unknown` unless prescribed 5 allows an account total.
8. On `regressed`, check that the active deployment is still yours, then roll back with `cf workers deployments create --worker stats --versions '[{"version_id":"<rollback>","percentage":100}]'`. If someone else deployed since, do not roll back; record that and park. On `unchanged`, revert the code in a new commit, without deploying a revert unless it is harmful. On `confounded`, follow owner decision 3.
9. Re-rank. Never open a second experiment on stats while a previous comparison window is still open.

Acceptance per candidate: the committed policy, the verify JSON saved at `.work/statsctl/verify/<id>.json`, and its summary in `docs/cost-campaign.md`.

### P6 — Observing Nanoshop within budget (added 2026-11-05 at the owner's request)

Nanoshop (`~/d/nanoshop`, read-only) will run `nanoshop-storied` with `stats-observe` as its tail consumer. Its cost model (`~/d/nanoshop/docs/cost.md`, "Reference shop estimate") puts one shop at about $11 a month at 10 req/s (25.9M Worker invocations plus 3.5M Durable Object invocations, so about 29.4M tail events a month). Observing every invocation at today's store cost would take that to at least $160. P6 makes observation a small fraction of the shop it observes. It runs beside P4 and never interrupts it:

- One writer, in `.work/wt/nanoshop` on `campaign/nanoshop`.
- N1 to N4 are local.
- `campaign/nanoshop` merges to master only after O1 is deployed, so `make stats-deploy` for O1 cannot carry it.
- N5 is its only deploy. It runs after an O verdict is recorded and before the next O deploy, under P4 step 5's 75-minute rule.
- `nanoshop-storied` is not deployed on the account (checked 2026-11-05), so every Nanoshop number before Nanoshop deploys is a workerd measurement.

- **N1** (M, `telemetry`): register `nanoshop-storied` on master. Port the intent of `campaign/cloudflare` (`56c9ab5`, `c35a40b`, `6cb4f1f`, built on `d3ad048`) onto master's observe design; do not merge that branch.
  - The `OBSERVED_SERVICES` entry; the service comes only from the tail item's `scriptName`.
  - A policy whose Worker route templates are generated from a data list in Nanoshop's own notation (`/products/{handle}`) copied from `~/d/nanoshop/src/routes/routes.ts`. `/static/*`, `/assets/*`, and unmatched paths become `excluded-route` outcomes, which master already counts. The storefront object has no public route.
  - The operation set, typed `as const`: `request.<route>` for the ten routes, `request.unmatched`, `catalog.load`, `catalog.rejected`, `store.rpc.<method>` for `syncCatalog`, `readCart`, `addToCart`, `setCartQuantity`, `removeCartItem` (Nanoshop's `ErrorOperation` in `src/cloudflare/observe/operations.ts`).
  - The operation charset `^[a-z][A-Za-z0-9_.-]{0,63}$`. A test proves that every operation of every policy passes validation.
  - Generic producer types: `ErrorReport<O>`, `reportError<O>`, and a generic `operation` message for services other than stats, `{ kind: "operation", traceId, spanId, operation: O, synthetic, rows: RowAccount | null }`. One publish per invocation carries the trace, so no separate invocation mark is needed. Stats keeps its typed summaries. Nanoshop's richer counters stay in Nanoshop; adding them later is additive.
  - Nanoshop snapshots `producer/channel.ts`, `producer/report.ts`, and `cloudflare/mark.ts` byte for byte, so those three files import only each other, `node:diagnostics_channel`, and `cloudflare:workers`. Move `SampleRejection`'s codes into `channel.ts` and import them from `ingest/ack.ts`. A test fails on any other import.
  - The tail reads each service's `operation` message with that service's decoder: the stats decoder stays, and other services accept any operation in their policy's set.
  - STA-48: test first. An unrouted event that carries an uncaught exception, a channel error report, or a status of at least 500 is observed with the label `<METHOD> unmatched`. Only the rest are excluded.
  - STA-49 (Stats half): the route data list and operation list are exported data, and the matcher is derived from them. Then rewrite STA-49 to the remaining Nanoshop-side equality check, which is Nanoshop's to add.
  - The `PROJECTS` entry: `nanoshop-storied` with `buckets: []`, `durableObjectNamespaces: []`, `d1Databases: []`, `probes: []`, `workerBilling: "requests-and-cpu"`. Regenerate the affected goldens deliberately.
  - Acceptance: `cd cloudflare && pnpm exec vitest run test/observe && pnpm run typecheck`, then `make lint dashboard-test`. Record the commit that Nanoshop should pin in **Status**.
- **N2** (L, `telemetry`): observation sampling with exact totals.
  - **Policy.** `ServicePolicy` gains `sampling: { kind: "all" } | { kind: "sampled"; keepPerMillion; slowWallMs; slowCpuMs }`. `stats` and `usr-memories` stay `all` unless a measurement gives a reason to change; a test pins that.
  - **What is always kept:**
    - uncaught exceptions and caught error reports;
    - a status of at least 500;
    - any `outcome` other than `ok`;
    - wall or CPU time at or above the slow thresholds;
    - any invocation with no trace, counted as `untraced` in health, because the decision cannot be made consistently without one.
  - **Everything else** is kept when `fnv1a32(traceId) % 1_000_000 < keepPerMillion`. A Worker invocation and its Durable Object invocation are therefore kept or dropped together. First check in workerd that a Durable Object invocation's active span has its caller's trace id; if it does not, park N2 with that evidence.
  - **Counting.** Every event of a sampled service, kept or not, is counted in a new additive table `observe_counts`, in 5-minute event-time buckets keyed by version, stage, route, operation, and class (`ok`, `failed`, `excluded`). Each row holds kept and sampled-out counts plus CPU and wall sums. For sampled services, totals, coverage, and outcome counts come from this table. Services set to `all` keep master's current tables and costs.
  - **Buffering.** So that a sampled-out event costs no store request, the tail Worker counts in a per-isolate buffer.
    - The buffer rides along on the next kept event's store call once it is older than the flush interval, or is flushed alone when an event finds it older than that interval.
    - It flushes at least once per 5-minute bucket.
    - Counts are exact for every event that reaches the collector and is flushed. A buffer lost to isolate eviction loses at most one flush interval of counts, and shows as coverage below `reconciled` against analytics `worker.invocations`.
    - Exactness across eviction would need one durable write per event, which is the cost this item removes. State this limit in `docs/architecture.md`.
  - **Visible sampling.** Health reports kept, sampled-out, untraced, and flushed-batch counts per window. Every route, explore, and trace response for a sampled service carries `sampling: { keepPerMillion, kept, observed }`. `statsctl observe` marks any percentile computed from kept invocations as sampled, so it is never presented as unsampled.
  - Acceptance: workerd tests show that the decision is deterministic per trace, that every always-keep case holds, that counts summed over 10,000 events equal the input exactly, and that the stats and usr-memories store rows and responses are unchanged. Then `make cloudflare-test lint`.
- **N3** (M, `telemetry`): measure cost per observed invocation, then set and gate the budget.
  - **Workload.** A deterministic workerd test drives the real tail handler and store with a seeded Nanoshop workload: 70% page views, 20% search, 10% cart, with a cart Worker invocation followed by its Durable Object RPC. It reports separately for a kept event and a sampled-out event:
    - billed rows written, from cursor totals, including index rows and the retention delete, measured by running cleanup after retention elapses;
    - store requests, counted at the binding;
    - flushes.
  - **Collector CPU per event.** Measure it as a Node microbenchmark of reduce, decide, and count (10 or more interleaved runs; a Node number), and separately read `stats-observe` CPU per invocation from `statsctl cost --project stats-observe` (a Cloudflare number, in whole milliseconds). Keep the two apart.
  - **Production store costs for stats.** Read rows per invocation from `stats-observe` health, and cleanup rows per expired invocation from `observe_write_cost`.
  - **Budget.** At 29.4M tail events a month, assuming no allowance remains, Nanoshop's observation must cost at most $1.10 a month at list price (10% of the shop's $11). That sums:
    - rows written at $1.00 per million, which must also stay at or below 1.0M a month, 2% of the shared 50M allowance;
    - store requests at $0.15 per million;
    - tail CPU at $0.02 per million ms;
    - store duration at $12.50 per million GB-s.
  - **Setting the rate.** Choose `keepPerMillion` and the flush interval as the largest rate and shortest interval that fit the budget. A pure projection function computes the bill from the measured per-event figures, and the workerd test fails when the projection exceeds the budget.
  - Acceptance: `cd cloudflare && pnpm exec vitest run test/observe/budget.test.ts`.
- **N4** (S, `campaign`): write `docs/observe-billing.md` for Nanoshop to cite. For each fact, give the official source URL and the date it was read:
  - Tail Worker billing;
  - store requests per tail batch;
  - rows per kept and per sampled-out invocation, retention deletes included;
  - collector CPU per event;
  - Durable Object request, duration, and row prices;
  - index and delete accounting.

  Measured numbers name their command. A final section lists what is unverified: production batch size for Nanoshop until it deploys, whether tail CPU is billed at sub-millisecond precision, and tail isolate lifetime. Add the doc to `AGENTS.md`'s docs table.
  - Acceptance: every fact has a URL with a date or a command, and `test/cli/docs.test.ts` still passes.
- **N5** (S, `deploy`): after O1's verdict is recorded, with 75 minutes clear, run `make worker-deploy` from master, which now includes N1 to N4. Run `make smoke-deployed` and `statsctl check ingest`. The item is accepted when, over the next 3 settled hours:
  - stats coverage is still `reconciled`;
  - stats observe rows per invocation are within ±0.1 of the O0 reading;
  - usr-memories health shows no new rejection reason;
  - `statsctl observe` lists `nanoshop-storied` with zero events.

  Record the deployment ids in **Status**. Nanoshop's own deploy, and the production confirmation of its batch size and rows, are Nanoshop's work.
- **N6** (S, owner request 2026-11-05, after N4 is accepted): follow up in `~/d/nanoshop`. This is the only write to another repository this campaign makes, and it is limited to three changes:
  - **Tail pricing:** price tail invocations by CPU only, citing `docs/observe-billing.md`'s source.
  - **Store rows:** replace the assumed Stats store rows per invocation (6) and the store-calls gap with N3's measured figures for kept and sampled-out events, and with the sampling rate N3 set.
  - **Producer pin:** set `STATS_PRODUCER_PIN` to the pinned commit recorded in **Status** and run its sync script.

  Follow Nanoshop's `AGENTS.md`, and update the "Reference shop estimate" section and the totals pinned by `tests/cost/reference.test.ts` together. Run Nanoshop's narrowest checks: the cost tests, its typecheck, and the Stats integration suite with `STATS_DIR` set to this repo, once the pinned commit is reachable. Commit on a branch in Nanoshop, never on its main branch. No push and no deploy.
  - Acceptance: Nanoshop's cost and reference tests pass with the new totals, and its snapshot files are byte-identical to the pinned commit.

### P5 — Close

- **X1** (S): delete the dead code and prove it dead with `dead-code-archaeology`. This covers `src/client/pricing.ts`, the old `cost-ledger.ts` exports with no callers, `test/support/stb2.ts` if it was replaced, and `scripts/api.mjs`'s dependency on `test/support/history.ts` (now production decoders, or the script is deleted in favour of `statsctl`). Run the full set. Use `review` on the integrated diff and fix P1 and P2 findings. Write the final report: what was implemented, locally tested, deployed, production-verified, reverted, and pending; the commands to run next; the commits and deployment ids; the measured CLI and observer overhead; and the before/after table.
- **X2** (S, owner decision 5, 2026-11-05): schedule the loop as an unattended job only if O1–O3 produced trustworthy verdicts: every verdict matches the offline prediction's direction or is explained by a named confound, and at least one candidate ended `unchanged`, `regressed`, or reverted. The job runs one candidate per run through the P4 loop (rank with `statsctl cost`, offline proof, `make stats-deploy`, safety check, `verify`, keep or `cf` rollback, a `docs(campaign)` record), under every hard stop in this doc, and commits locally without pushing. If the condition fails, write why in the final report and do not schedule.
  - Acceptance: the job is listed by the scheduler, and its prompt names this doc and the stop rules.

## Acceptance

Distinct success and failure conditions for each deliverable:

| Deliverable | Command | Passes when | Fails when |
| --- | --- | --- | --- |
| Shared core | `node --experimental-strip-types --test test/cost/*.test.ts` | the dashboard and CLI adapters produce identical reports on the captures, and every C2 case holds | any total prices missing data as zero, or the CLI graph imports UI code |
| Offline help | `test/cli` help tests | every help path exits 0 with no network, credential command, or UI import; `--help` median ≤ 300 ms | any help path spawns a process or opens a socket |
| Machine contract | `test/cli` contract tests | one JSON document on stdout for success and failure; exit codes as in prescribed 7 | a formatted dollar string replaces a number, or progress output reaches stdout |
| Auth | `test/cli` auth tests | a credential never appears in argv, logs, snapshots, or reports, and never crosses origins | a redirect forwards the header, or login starts |
| Snapshot replay | `test/cli` snapshot tests | `cost --input` equals the live report on the same data, offline | a mismatched revision or hash is accepted |
| Operation accounting | T2 workerd test | summary counts equal the ack and the cursor totals | rows are estimated or taken from array lengths |
| Outcome coverage | T3 tests | 401, 403, and 404 are counted but not retained; coverage is computed | a 404 regression disappears from the counted population |
| Comparison spec | T4 tests | observe and project comparisons share exact windows; a rollback inherits nothing | `rolloutImpact` feeds the gate |
| End to end | E1 test, plus production `statsctl check ingest` | accept, readback, and duplicate replay all hold | an acknowledged sample is not readable |
| Verify | L4 tests | each verdict precedence case holds; a timeout gives `pending` with a resume command | an insufficient signal passes |
| Overhead | O0 health, plus `vite build` sizes before and after | ≤ 1.0 extra observe row per stats invocation; Worker bundle grows ≤ 5 KiB gzip; the dashboard entry chunk grows ≤ 2% gzip and all dashboard JS ≤ 3% (revised 2026-11-05 under the owner's grant of decision power: the required cost report adds 2.1% to the lazily loaded ledger chunk); one publish per invocation; `statsctl cost` makes ≤ 4 requests per project | any bound is exceeded |
| Nanoshop registration | N1 tests | every Nanoshop operation and route template is accepted, and the producer files import nothing outside themselves | a Nanoshop error report is rejected, or a 500 on an unrouted path disappears |
| Sampling | N2 tests | counts over all events are exact, the decision is per trace, and stats and usr-memories are unchanged | a sampled percentile is shown unmarked, or a sampled-out event costs a store request on its own |
| Observation budget | `test/observe/budget.test.ts` | the projected Nanoshop observation is ≤ $1.10 a month and ≤ 1.0M rows | the projection exceeds either bound |
| Dogfood | P4 records | each candidate has a pre-registered policy, saved verify JSON, and an honest scope | a claim is upgraded beyond its evidence |

## Needs environment

- **Production verdicts** need about 2.5 h free of deployments (1 h stable baseline, 1 h after, 5 to 10 min warm-up, 45 min settlement), and there is no freeze. The owner would run `pnpm --dir cloudflare -s statsctl verify --deployment <id> --policy bench/policies/<id>.json --wait --timeout 4h --json` from the resume command in **Status**.
- **History-read experiments** see tens of reads an hour, under the 100-operation minimum at 1 h, so they need 6 h windows. They are verified offline, and production stays `pending` until a quiet 6 h exists.
- **If `.work/credentials/synthetic-check.json` is lost**, the owner decides whether to rotate that host's token.

## Execution boundary and non-goals

**Authorized:**
- local code, tests, and commits;
- read-only production API and `cf` reads;
- deploying `stats` and `stats-observe` through `make observe-deploy`, `make stats-deploy`, and `make worker-deploy`;
- rolling back to a previously validated version through `cf workers deployments create`;
- the additive observe tables (owner decision 1);
- one synthetic host (owner decision 2);
- the `stats-observe` project entry (owner decision 4).

**Forbidden:**
- pushing;
- `make deploy`, or any host deploy or rollback;
- deploying other projects, including `nanoshop-storied`, which stays undeployed (owner, 2026-11-05), or modifying other repositories except N6's three Nanoshop changes;
- changing account plans, Access policies, tokens, or permissions;
- deleting resources or data, including host purge, revoke, or rotate;
- `ALTER` or `DROP` on any existing table, and any Installation schema change;
- changing host ingest or history wire or stored formats;
- disabling telemetry, dropping samples, or reducing retention, resolution, or cadence as an "optimization".

**Non-goals:**
- an LLM loop, MCP server, daemon, scheduler, or new Cloudflare service;
- a generic `--exec`, hooks, or a plugin system;
- universal custom spans, cross-service tracing, a metric-label API, or trace warehousing;
- production A/B infrastructure or automatic profiling triggers;
- a statistics framework; the comparator stays labelled heuristic;
- STA-45 (alert delivery remains an owner decision).

**Contract changes for the owner:**
1. `statsctl` JSON envelope `statsctl/1`, and its exit codes.
2. The `operation` observe channel message, which the tail must accept before stats emits it.
3. The `observe_operations` and `observe_outcomes` tables, and `GET /api/observe/stats/window`.
4. `ComparisonSpec`, and the operation-scoped verdict rule (prescribed 15).
5. Ledger semantics: a missing Worker series becomes `uncollected` instead of $0, and allowance isolation is named.
6. Pricing moves to `src/cost/pricing.ts` with a revision.
7. A new `stats-observe` project in `/api/v1/projects`.
8. `make stats-deploy`.
9. A third observed service, `nanoshop-storied`, its `PROJECTS` entry, and the wider operation charset.
10. Generic producer types (`ErrorReport<O>` and the generic `operation` message), and producer files that import nothing outside themselves.
11. `ServicePolicy.sampling`, the `observe_counts` table, the sampled-out and untraced counts in health, and the `sampling` field on observe responses.
12. STA-48: unrouted events with errors are observed instead of excluded.

## Reference

Verified at `00e18d2`:

- **Ledger:** `cloudflare/src/client/pages/project/cost-ledger.ts:195` (`workerLine`), `:173` (missing-coverage factor 0), `:450` (`billedBeyondPlan`), and `ledger-load.ts:108` (`monthOf`, UTC). The tests are in `cloudflare/test/project-ledger.test.ts`.
- **Comparator:** `cloudflare/src/deployments/compare.ts:1` (pricing imported from `client/`), `:72` (100-invocation floor), `:137` (route-mix 20 points), `:146` (5xx needs 1,000). Its SQL lives in `src/deployments/installation.ts:109`; route CPU is not selected today.
- **Observe:**
  - `src/observe/cloudflare/tail.ts:25,74,78` drops 401, 403, 404, and unknown routes; `worker.ts:21` skips them; `readChannel` rejects unknown message kinds.
  - `src/observe/core/store.ts:427` (`observed_at = min(eventAt, now)`), `:422,448` (rows written only), `:716` (`rolloutImpact` over retention), `:869` (route CPU adds child DO CPU).
  - `src/observe/client/cli.ts` holds the existing observe CLI and its exit codes; `src/observe/cloudflare/mark.ts` publishes the one in-process message.
- **Installation:** about 88 direct `sql.exec` call sites across `installation.ts`, `projects/`, and `deployments/`. Cleanup already reads `.rowsWritten` (`installation.ts:528`).
- **Deploy:** `Makefile:96` (`worker-deploy` depends on `observe-deploy`). Rollback is in `docs/operations.md` § Rollback. `deploy/deployed-smoke.sh` checks only rejections and the auth boundary.
- **Cloudflare facts (fetched 2026-11-04):**
  - Tail Workers are billed by CPU time, not requests.
  - A SQLite cursor's `rowsRead` and `rowsWritten` grow during iteration, and the final value is billed.
  - Each index-row update counts as a written row.
  - Production `performance.now()` advances only on I/O.
