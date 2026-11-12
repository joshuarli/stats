# Handoff: improve the stats development loop

Prepared November 12, 2026. Repository: [joshuarli/stats](https://github.com/joshuarli/stats).

## Mission

Implement a fast, reliable, credential-free local development loop for stats on its existing Cloudflare stack. Provide one canonical **make dev** command with frontend hot updates, automatic backend rebuild/reload, persistent development data, useful readiness output, and reliable shutdown. Make focused tests schedule only the resources they need, and make the full gate account for every intended test.

Stay on the existing cf + Cloudflare Vite v2 + Miniflare/workerd direction. This work should remain useful as Cloudflare moves service implementations into workerd. A celld migration, external S3 service, deployment-provider migration, or broad application-performance rewrite is outside this task.

This is an implementation handoff, not a report of completed changes. The preparation was read-only: no repository files were changed, and no builds, test suites, or latency benchmarks were run. Treat the timing improvements below as hypotheses to measure.

## Starting point and evidence

The audit used master at **e5bd65f489392a52644f40656fbde8beace93f38**, committed November 12, 2026. The local snapshot was checked against GitHub HEAD and the complete remote tree. Refresh the current branch and reconcile intervening changes before acting; do not restore old files or overwrite unrelated work to reproduce this snapshot.

Read AGENTS.md, TODO.md, docs/testing.md, docs/dependencies.md, the Makefile, cloudflare/package.json, and pnpm-lock.yaml first. Follow the repository's current instructions. The important implementation entrypoints are listed in the source appendix.

### Verified findings

| Finding at the audited commit | Consequence |
| --- | --- |
| The lockfile contains three Miniflare versions and two workerd versions. The direct harness and Vite plugin use the October 23 runtime, while cf and the Vitest plugin use November 10. | Local development and integration tests do not currently use the same runtime generation. Update the family together and verify actual resolution. |
| Both aggregate runners contain the same 73 explicit Node test filenames; 24 paths no longer exist and 36 ordinary current test files are unlisted. Vitest excludes their directories. | Repair selection before relying on a full-gate result or comparing test timings. The absent paths may also make a runner fail; this audit did not execute it. |
| dev-local builds both Workers, launches the built topology, seeds/collects, and waits. No source watcher or HMR path is wired into that command. | It is a persistent local environment, but it does not yet provide the desired automatic edit-to-feedback loop. |
| Nested build:all calls and phony Make bundle targets overlap. A serial full gate reaches three builds of each Worker; parallel Make invocations can write the same outputs concurrently. | Centralize freshness and writer ownership. Removing duplicate compilation should be measured separately from changing runtime versions. |
| Playwright uses fixed ports 4173 and 4175 with unconditional server reuse; the local-stack browser spec uses 4177 and starts its own stack. | Concurrent checkouts can collide or use another checkout's server. A focused local-stack spec also incurs unrelated global servers. |
| Test runners duplicate process management, buffer child output without a bound, and do not track the initial build consistently for cancellation. | Improve cleanup, diagnostics, and concurrency control as part of making agent runs reliable. |

The test-file counts are source-inventory findings, not counts of individual test cases and not a claim that CI currently passes. Make the repaired inventory visible in command output and CI.

## 1. Repair test ownership and selection first

Replace the duplicated filename arrays in cloudflare/scripts/test-runner.mjs and cloudflare/scripts/worker-test.mjs with one small shared suite definition/discovery mechanism. Reuse it from individual and aggregate entrypoints where practical. Prefer discovery by established directory/pattern with explicit exceptional cases over another long list of individual files.

Every discovered test must have an execution owner and declared prerequisites. Keep these execution routes distinct:

| Route | Prerequisites |
| --- | --- |
| Pure binary, ingest, and core logic | Pinned Node and committed/generated fixtures as required; no Worker build or workerd startup |
| Worker source integration | Cloudflare Vitest plugin and its required configuration/setup |
| Built-artifact parity and local topology | Fresh matching stats/observe outputs, then isolated Miniflare instances |
| Browser | Only the selected project's required artifacts and owned servers |
| Agent and Node end to end | The specific Worker, Node, or Rust artifacts used by the scenario |
| Explicit external/opt-in suites | Their documented external prerequisites; never silently treated as default coverage |

Do not equate a Node test with a pure test: test/node/parity.test.ts opens built Workers. Include test/profile/*.node.ts in the inventory; make test currently includes that route while make check does not. Make the intended gate choice explicit instead of accidentally changing it during refactoring.

Provide file selection and the underlying runner's name filter, plus a list/JSON mode showing suite ownership, prerequisites, and selected files. Fail clearly on an unmatched explicit selector, nonexistent declared path, or unowned test. Report selected/discovered file counts and executed test results so omitted coverage cannot masquerade as a speed improvement.

The 36 ordinary omitted files are enumerated in Appendix A. Three other excluded-directory tests have intentional separate paths: agent-e2e/agent.test.ts, node-e2e/server.test.ts, and optional producer/checkout.test.ts. Preserve those distinctions.

**Acceptance:** all ordinary files belong to the appropriate default route; a new test in an established suite is discovered without editing two runners; a selected ingest conformance test runs without .cloudflare/output and launches neither Vite nor workerd; a selected Worker/Node parity test obtains its actual prerequisites.

## 2. Capture a trustworthy baseline

First record the original inventory/gate failure, if reproducible. Then use the repaired selection with the original dependency pins as the comparison baseline. Comparing the old incomplete suite against a larger corrected suite is not a valid speed comparison.

Record these scenarios before changing runtime versions or orchestration:

- Cold readiness with dependencies already installed and generated build output absent. Separately identify any fixture-generation cost.
- Warm readiness with valid output and existing development state.
- A representative frontend edit becoming visible in the browser.
- A representative Worker edit becoming visible in a successful request.
- One pure focused test and one built-artifact/local-stack focused test, including prerequisite work.
- A repeated unchanged gate/build request, with compilation counts as well as elapsed time.
- Idle/warm process count and process-tree RSS if memory is part of the decision.

Use host-side monotonic timings. Record the commit and dirty state, lockfile hash, fixture version, OS/CPU, Node/pnpm versions, actual resolved Cloudflare runtime versions, and test counts. Use repeated trials and report median/range and failures. Keep baseline/candidate conditions comparable and avoid concurrent heavy jobs. For an edit workflow that does not currently exist, report that limitation and the measured manual rebuild/restart cycle instead of inventing an automated baseline.

Reuse the version-attribution approach in cloudflare/bench/local.ts, which resolves workerd through the Miniflare installation actually used. The existing local benchmark measures application/storage work; it is not an edit-latency benchmark or evidence about billable CPU.

## 3. Update a compatible Cloudflare dependency group

Recheck published package/release metadata when executing this handoff. The latest candidate group verified on November 12 was:

| Package | Audited pin | Verified candidate |
| --- | --- | --- |
| cf | 1.0.0-beta.29 | **1.0.0-beta.31** |
| @cloudflare/vite-plugin | 2.0.0-beta.v.8 | **2.0.0-beta.v.16** |
| @cloudflare/vitest-plugin | 1.8.0 | **1.8.1** |
| Direct miniflare | 5.20261023.3-beta | **5.20261110.2-beta** |
| @cloudflare/workers-types | 5.20261110.1 | Retain unless the chosen release group requires otherwise |
| Vite | 8.3.8 | Retain; it satisfies the v2 plugin's supported peer range |
| Transitive workerd | 1.20261023.1 and 1.20261110.1 | **1.20261110.1**, selected by this Miniflare release |

The independent newest workerd release at the audit was **1.20261112.1**. It is ahead of the runtime selected by the compatible SDK package group. Do not force it with a global override simply to make every version look current. Track that lag explicitly and adopt newer runtimes through the supported package group, or evaluate them in an isolated experiment with clear attribution.

Track the **Vite v2 beta** channel explicitly: the stable Vite-plugin v1 tag is a different line. Retain exact pins and the committed lockfile. Preserve package-manager release-age/build-script policies; a same-day publication is not a reason to weaken them globally. Keep the current Node, pnpm, and Vitest versions unless a concrete incompatibility requires a change.

Verify the resolved graph from each consumer: Vite development/build, the direct offline harness, Vitest integration, and cf tooling. The expected candidate permits one Miniflare release and one workerd release across these paths; demonstrate the actual result rather than assuming a top-level package edit achieved it. Add a small version/doctor command that reports each resolved path and the app's configured compatibility dates. Compare dates with the runtime's supported behavior/diagnostics; do not infer compatibility solely from an arbitrary package string.

### Migration details to check

- Vite beta.9 changed the config customization callback to consume and return the full Cloudflare configuration, including worker. Preserve existing top-level/worker fields when adding local overrides; arrays replace rather than deep-merge. The audited Vite config calls cloudflare() without customization, but a new offline development integration may use this API.
- Vite beta.15 stopped emitting Worker Vite manifests by default and avoids certain duplicate environment builds. Check any manifest assumptions and use supported Build Output metadata. These release notes are not a measured stats speedup.
- Vitest plugin 1.8.1 fixes a run hanging after a socket read rejects following a completed Worker handler.
- Review Miniflare's recent export and tail-configuration changes against actual imports. Stats uses ordinary tail consumers; do not move them into streaming-tail configuration indiscriminately.
- Both production Worker configs currently set compatibilityDate to **2026-10-30**. Treat changes to that date or compatibility flags as a separate behavioral migration.

Run config validation, type generation/typecheck, the focused compatibility smoke set, and the repaired aggregate routes. Keep the upgrade separable from orchestration edits so regressions and performance changes can be attributed.

## 4. Share build preparation and enforce one writer per output

Introduce a small shared build-preparation path used by Make targets, both test runners, local stack commands, and browser setup. Reuse supported build-system facilities where they suffice; avoid growing a general-purpose build framework.

It must:

- Reuse a successful output when the relevant inputs and toolchain are unchanged.
- Invalidate on actual source edits, including dirty/untracked relevant files, config changes, generated inputs, dependency lock changes, and missing/invalid outputs. A git SHA alone is insufficient.
- Include build mode, relevant command-line options, and an explicit allowlist of build-affecting environment values in freshness identity. For example, STATS_DOMAIN changes the generated Worker configuration. Do not fingerprint or log the entire environment or secrets.
- Serialize writers to the same output and publish only a complete successful generation. Failed or interrupted builds cannot become the advertised current generation.
- Permit independent outputs to build concurrently where safe. build-all.mjs already builds stats and observe in parallel; adding Promise.all alone is not new work.
- Retain an explicit clean/release build path and offer enough diagnostics to explain a rebuild or cache hit.

Do not add an unconditional skip-build switch that lets tests run stale artifacts. Freshness checks should be cheap compared with the compilation they avoid. For any persistent lock, use clear owner identity, bounded waits, and recovery from a dead owner without deleting another live run's resources.

**Acceptance:** unchanged inputs cause no compilation; a relevant edit or lock/config change rebuilds the necessary outputs; two concurrent consumers cannot corrupt an output; tests and dev receive a complete matching artifact generation.

## 5. Deliver one warm make dev

Make **make dev** the documented entrypoint; retain dev-local as an alias if compatibility is useful. After a documented dependency/fixture bootstrap, it must start without Cloudflare credentials, remote analytics, external object storage, or package-update discovery.

Choose the smallest supported architecture that preserves the existing topology. First establish whether the current Vite v2 development APIs can represent stats, stats-observe, producer fixtures, actual tail/service bindings, deterministic analytics, and outbound restrictions. Use that path if it preserves the contracts. If it cannot, keep the direct Miniflare topology, use Vite for frontend hot updates, and add a small shared Worker build/reload supervisor. Explain any upstream limitation and the removable adapter it necessitates.

Avoid accidentally starting both a Vite-owned Worker topology and a second complete custom topology for the same application. One command may own several necessary processes, but should provide one coherent local application and one authoritative backend state.

Required behavior:

- Frontend-only edits use HMR without rebuilding or reseeding the backend.
- Worker and observe changes rebuild automatically, then reload the affected topology using supported APIs. Coalesce rapid edits; a superseded build must not replace a newer generation.
- Refresh configuration metadata and client/DO handles when replacing a runtime. Existing stack.restart() reuses cached BuiltWorker metadata while topology launch rereads bundle bytes; a correct new reload path must account for both.
- A failed compilation must leave the running generation untouched and surface the error. After a successful build, use a supported reload or serialized stop/start with exclusive ownership of persistent state; a brief, clearly reported backend transition is acceptable. Mark the new runtime active after readiness succeeds. Report activation failure separately, and do not promise rollback after startup changes persistent data unless storage compatibility is established. Never have two runtimes concurrently write the same SQLite state.
- Preserve explicit per-worktree development state, stable resource identities, and the existing seed-only-if-empty behavior. A normal edit or restart must not reset history. Provide an explicit, scoped reset operation for intentional resets.
- Advertise usable URLs and a small machine-readable readiness/status record with run identity, artifact identity, ports, state location, and resolved runtime versions. Keep credentials out of status/logs.
- SIGINT, SIGTERM, startup failure, and watcher failure shut down all owned children/listeners and release build ownership. A failed build remains diagnosable without orphaning workerd.

Preserve production-derived configuration and fail-closed handling of unsupported bindings. Do not maintain a parallel hand-written production binding map just to make development start.

## 6. Make focused tests, browser runs, and parallel worktrees reliable

Use the shared suite/prerequisite logic from section 1. Selected pure tests should start immediately. Built-artifact tests should reuse valid outputs, with isolated mutable test state. A warm developer instance is not a universal test fixture.

Use one small child-process helper for existing runners: handle spawn errors, track initial builds and later children, stream or tee useful output to run-scoped logs, bound the failure tail kept in memory, propagate cancellation, and wait for owned descendants to exit. Bound total concurrency across outer suite groups and inner test workers; measure oversubscription before increasing parallelism.

Give browser/test invocations their own state and output directories under the repository's scratch convention. Have servers bind port zero where possible and publish the chosen origin; where a fixed/preselected port is necessary, detect conflicts and verify server identity. Automated tests must own their server or positively verify checkout/build/run identity before reusing one. A responding health endpoint alone is insufficient.

Scope Playwright setup to the selected test/project. The local-stack browser scenario should not start unrelated static and Node servers. Preserve deterministic screenshot behavior and existing WebP goldens.

Miniflare v5 enables a shared development registry by default, but convertV4MiniflareOptions preserves v4's opt-in behavior. Stats currently uses that conversion. Preserve isolation when changing APIs: either disable discovery where unused or set CLOUDFLARE_DEV_REGISTRY_PATH per worktree/run. If shared storage needs the registry, isolate the path rather than disabling a required feature.

**Acceptance:** two worktrees can run development and browser/local tests concurrently without crossed requests, state, registry discovery, or cleanup. Interrupting a build or runtime test leaves no owned processes/listeners behind and does not stop the other invocation.

## 7. Preserve the application's existing contracts

Retain STB2/STA2 fixtures, exact u64/bigint behavior, Worker/Node wire and storage parity, current authentication boundaries, deterministic collection, real tail attribution, and the rule against adding test seams to production source. Exercise meaningful behavior rather than tests that mirror private orchestration functions.

The existing analytics substitute is essential: **Analytics SQL has no local implementation and always connects to the remote service in ordinary Cloudflare development.** Setting remote to false does not create an offline service. Keep the local query substitute faithful to actual query text/parameters and fail on unexpected queries. Preserve outbound checks for collectors, probes, and producers.

Distinguish network-free execution after bootstrap from downloading dependencies during bootstrap. The existing OS-level offline sandbox is macOS-only; Linux coverage is tracked as **STA-83**. Verify the app-level outbound guard on supported environments and run the existing OS-enforced route where available. Report the actual enforcement layer; do not claim that removed credentials prove OS-level isolation.

Keep the existing **STA-116** Node artifact issue visible: source-map resolution imports a package that the staged bundle/image does not include. Source-only Node tests do not prove a packaged server starts. Coordinate with that issue if it blocks validating build changes; do not hide the failure or expand this task into unrelated application work.

## 8. Add a small, actionable upstream compatibility check

The user wants close tracking of workerd/Miniflare convergence. A ChatGPT watch has already been created to check official sources at 03:00, 09:00, 15:00, and 21:00 America/Los_Angeles and notify only about material new developments. Do not create a duplicate notification task.

Inside the repository, add a lightweight daily plus manually dispatched candidate-validation workflow once the corrected smoke path is usable. Keep the ordinary developer command deterministic and lockfile-based.

The candidate workflow should resolve the explicit supported channels, prepare the compatible Cloudflare dependency group in isolated state, run the same useful compatibility smoke checks as normal development, and retain the proposed version/lock diff and results for review. Reuse existing package-manager/CI mechanisms; no new dependency-update service is needed. Promotion remains a deliberate versioned change, not an automatic mutation of the normal local environment.

The report should separate:

1. New source/PR work.
2. Merged workerd implementation.
3. A tagged/published workerd release containing it.
4. A published Miniflare/Vite/Vitest/cf combination adopting it.
5. Successful execution of stats's actual contracts.

At the audit, workers-sdk **#16684** (Miniflare's workerd KV adoption) and workerd **#8176** (rolling deployment adoption) were drafts. The KV proposal also describes a local persistence-layout change without migration of existing local KV data. Watch those details if/when adoption ships; do not describe them as current behavior of the recommended Miniflare release.

Other useful signals are first-class local configuration/build-output APIs, removal of service shims, state/persistence changes, dev registry behavior, tails, Durable Objects, and measured reload/startup changes. A newly merged standalone service is not by itself a reason to rewrite stats's working harness.

## Definition of done

| Scenario | Required result |
| --- | --- |
| Fresh installed checkout | Documented bootstrap followed by make dev reaches a working, seeded, authenticated local UI/API without production credentials or external services |
| Frontend edit | Browser updates automatically; no backend build, restart, or reseed |
| Worker/observe edit | New behavior appears automatically, including working real tail delivery |
| Build error then fix | Error is visible; last working generation remains usable; recovery is automatic |
| Restart | Stored history and fixture identity persist as intended |
| Unchanged build/test prerequisites | No repeated compilation; selected test coverage is unchanged |
| Pure focused test | Runs without Worker output and without starting Vite/workerd |
| Built-artifact parity test | Uses verified fresh artifacts and isolated state |
| Test inventory | No stale paths or accidentally unowned ordinary tests; intentional opt-ins are listed |
| Two worktrees/runs | Independent ports, servers, mutable state, registry namespace, logs, and cleanup |
| Cancellation | No owned child/listener left behind; unrelated runs remain alive |
| Offline contract | Deterministic analytics and outbound guard remain exercised; OS sandbox result is attributed accurately |
| Dependency candidate | Actual resolved versions and migration checks are recorded, with all required smoke checks accounted for |
| Full gate | Existing contract checks remain; any pre-existing or environmental failures are explicit |

Report measured before/after results with test counts, compilation counts, and memory tradeoffs. Choose latency targets after observing the baseline rather than making an unsupported speed promise. If an upstream API limitation prevents a desired reload property, report the precise blocker and the implemented behavior; do not label a restart-only preview as HMR.

Deliver reviewable changes following the repository's normal commit workflow, updated dev/testing/dependency documentation, an agent-friendly command map, repeatable benchmark output, and a concise account of remaining upstream limitations. No deployment is required for this task.

## Suggested command surface

These names describe desired capabilities; reuse existing commands where that keeps the interface smaller. Except for the canonical make dev entrypoint, avoid adding aliases solely to match this sketch.

| Capability | Example interface |
| --- | --- |
| Warm offline development | make dev |
| Actual toolchain and runtime report | make dev-doctor |
| Test discovery/prerequisites | shared runner --list --json |
| Focused execution | shared runner --file PATH --name PATTERN |
| Freshness-aware build preparation | one shared ensure-build entrypoint |
| Dev-loop measurement | make bench-dev |
| Complete existing gate | make check |
| Upstream compatibility candidate | manual/daily CI workflow |

## Appendix A: ordinary test files omitted from the audited aggregate lists

All entries are relative to cloudflare/test and end in .test.ts.

| Directory | Basenames |
| --- | --- |
| ingest | acks, conformance, malformed |
| deployments | operation-compare |
| cost | boundary, parity, report |
| cli | deployments, docs, http, observe-rollouts, service-check, verify-cli, verify-policy |
| scripts | bench-bundle, bench-network, bench-preview-fallbacks |
| node | boundary, installation, parity, ports, service-comparison |
| observe | always-kept-cap, cli, cloudflare-rollouts, counts, fan-out, grouping, operations, outcomes, producer-files, sampling-decision, sampling-parity, sampling, symbolicate, window |

Recompute this inventory at the execution commit. Do not simply paste this snapshot into a new hardcoded array.

## Appendix B: primary evidence and implementation entrypoints

### Stats sources at the audited commit

- [Package pins and scripts](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/cloudflare/package.json) and [resolved lockfile](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/pnpm-lock.yaml).
- [Makefile](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/Makefile), [test-runner.mjs](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/cloudflare/scripts/test-runner.mjs), [worker-test.mjs](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/cloudflare/scripts/worker-test.mjs), and [Vitest configuration](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/cloudflare/vitest.config.mjs).
- [Build orchestration](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/cloudflare/scripts/build-all.mjs), [local launcher](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/cloudflare/scripts/local-stack.mjs), [stack lifecycle](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/cloudflare/local/stack.ts), and [production-derived topology](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/cloudflare/local/topology.ts).
- [Playwright configuration](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/cloudflare/playwright.config.ts) and [local-stack browser scenario](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/cloudflare/test/ui/local-stack.spec.ts).
- [Dependencies documentation](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/docs/dependencies.md), [testing documentation](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/docs/testing.md), [TODO](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/TODO.md), and [local benchmark attribution](https://github.com/joshuarli/stats/blob/e5bd65f489392a52644f40656fbde8beace93f38/cloudflare/bench/local.ts).

### Upstream sources checked November 12, 2026

- [Cloudflare Vite v2 beta documentation](https://developers.cloudflare.com/workers/vite-plugin/v2-beta/) and [Vite plugin changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/vite-plugin-cloudflare/CHANGELOG.md).
- [Vite v2 beta.16 release](https://github.com/cloudflare/workers-sdk/releases/tag/%40cloudflare/vite-plugin%402.0.0-beta.v.16), [Vitest plugin 1.8.1 release](https://github.com/cloudflare/workers-sdk/releases/tag/%40cloudflare/vitest-plugin%401.8.1), and [cf releases](https://github.com/cloudflare/cf/releases).
- [Miniflare 5.20261110.2-beta release](https://github.com/cloudflare/workers-sdk/releases/tag/miniflare%405.20261110.2-beta), [release-tag dependency catalog](https://github.com/cloudflare/workers-sdk/blob/miniflare@5.20261110.2-beta/pnpm-workspace.yaml), and [workerd releases](https://github.com/cloudflare/workerd/releases).
- [Miniflare registry and persistence options](https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/README.md) and [Analytics SQL configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#analytics-sql).
- [Miniflare adoption of workerd KV, draft #16684](https://github.com/cloudflare/workers-sdk/pull/16684), [workerd rolling deployment adoption, draft #8176](https://github.com/cloudflare/workerd/pull/8176), and [Cloudflare's celld/workerd integration announcement](https://blog.cloudflare.com/deno-joins-cloudflare/).

Release metadata and repository state will change. Reverify execution-time versions and PR status; retain this dated snapshot as the basis of the handoff, not a permanent claim about latest releases.
