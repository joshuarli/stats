# Testing

Run the narrowest target while iterating and `make check` before release.

| Command | Covers |
| --- | --- |
| `make fixtures` | Ingest corpus manifest, size budgets, cross-file constants, and byte/row accounting |
| `make agent-test` | Rust unit tests, golden-frame reproduction, annotated vectors, acknowledgment decoding, seeded prefix properties |
| `make agent-e2e` | The built agent binary sampling this host and delivering through the built Worker and Durable Object |
| `make smoke-local` | `deploy/deployed-smoke.sh` against the built `stats` and `stats-observe` Workers in local workerd |
| `make integration-local` | `test:local` and the local-stack browser spec under `scripts/offline-run.sh`, which denies non-loopback network on macOS; fails on any undeclared outbound request or `cf` call |
| `make integration-producer` | `test/producer/` under `scripts/offline-run.sh`: a checkout through the recorded Nanoshop producer export with Nanoshop's Stripe simulator and mailbox, read back by a real `statsctl`; needs `NANOSHOP_DIR`, so `make check` does not run it |
| `make dev-local` | A persistent local stack on `http://127.0.0.1:8789` with state in `.work/local/state`, collecting every five minutes; `make reset-local` deletes that state |
| `make node-e2e` | `deploy/deployed-smoke.sh` and the `agent-e2e` flow against the Node server on a scratch data directory, plus its SIGTERM drain and startup checks |
| `make bench-local` | Row, statement, and byte counts for ingest and collection on the local stack (see `bench/README.md`) |
| `make ingest-bench` | Encoder, decoder, and end-to-end ingest timings (see `docs/binary-ingest.md`) |
| `pnpm --dir cloudflare test:deploy` | `deploy/*.sh` under stubbed `ssh`, `curl`, and `cf` with no network: SIGINT and SIGTERM exit 130 and 143 after one cleanup, and a deploy reports success only on a receipt that arrives after the restart |
| `make cloudflare-test` | Worker typecheck, Workers-runtime tests, the observe core under `node:sqlite`, the two-Worker tail test, and the Node server's auth and Worker-parity tests |
| `make dashboard-test` | Dashboard build, Playwright tests (including one against the Node server), and the tracked-PNG check |
| `make lint` | Type-aware Oxlint |
| `make preview` | Built dashboard served from captures on `http://127.0.0.1:4174/` |
| `make dashboard-bench` | Paint and transfer medians from the preview |

`make agent-test` on macOS does not compile the Linux-only readers. Run it on
Linux before changing them.

## Local stack

`pnpm run test:local` runs the whole Cloudflare topology in Miniflare with no
Cloudflare login and no network. It needs `pnpm build` and
`pnpm run build:observe` first.

- **Topology.** `cloudflare/local/topology.ts` builds the Miniflare workers
  from the built `worker.config.json` of both Workers, the config
  `cf deploy --prebuilt` ships. It throws on any config key or binding type it
  does not map, and on a binding the stack depends on that is missing. Every
  test that loads the `stats` bundle goes through it; `new Miniflare` appears
  only in `cloudflare/local/` and the observe producer stand-ins.
- **Analytics.** `ANALYTICS_SQL` has no local implementation, so
  `cloudflare/local/analytics.ts` binds a `WorkerEntrypoint` in its place. It
  answers a query only when the text and params equal what
  `src/projects/queries.ts` builds for the scenario's registry and scheduled
  time, and throws `unexpected analytics query` otherwise. Rows come from the
  model in `cloudflare/local/scenario.ts`, with per-dataset modes `ok`,
  `empty`, `late`, and `fail`.
- **Scenarios.** `test/local/collection.test.ts` runs S1 to S6: success, late
  and empty data, overlapping and raised windows, a failing dataset and its
  recovery, restart on one persistence directory, and retention past the
  sample horizon. Each compares stored history, `GET /api/v1/projects`, and a
  real `statsctl` process to totals computed from the model, never read back
  from the Worker.
- **Upgrade.** `test/local/upgrade.test.ts` opens state written by the build of
  `a5918ea~1` with the current build. It reads that build from
  `BASELINE_WORKTREE` (default `.work/wt/baseline`) and skips with the build
  command when it is absent.
- **Offline.** The stack answers every outbound request with 503, and
  `dispose()` throws naming any URL the scenario did not declare. A scenario
  declares the probe URLs in its registry. `scripts/offline-run.sh` adds the
  OS layer: it removes `CLOUDFLARE_*` and `CF_*` and runs its command under
  `sandbox-exec` with only loopback network, so DNS lookups fail too.
- **Launcher.** `cloudflare/scripts/local-stack.mjs run -- CMD` runs `CMD`
  against an ephemeral seeded stack with `STATS_URL`, `STATSCTL_AUTH_COMMAND`,
  and `STATSCTL_AUTH_HEADER` set, so `statsctl` reads it without `cf`. `dev`
  serves a persistent stack and prints the same environment.
- **Producer exports.** `run` and `dev` take `--producer DIR`, repeatable,
  and `startStack` takes the same directories as `producers`. `DIR` is a
  Nanoshop producer export (`producer-export.json` version 1, written by
  `nanoshop local export-producer`). The launcher hosts each producer's
  Worker in the same Miniflare as `stats` and `stats-observe`:
  - **Refusals.** The launcher recomputes the export's digest (`sha256:` over
    the sorted `path NUL sha256(file)` lines of every file except the manifest)
    and refuses an export whose files no longer match, before anything starts.
    It also refuses an export with more than one tenant, a service
    `stats-observe` does not observe, a tail consumer other than
    `stats-observe`, a binding type other than `text`, `durable-object`,
    `assets`, and `r2`, and a Stripe, mailbox, or identity origin that is not
    an `http` loopback origin with a port. Two exports in one stack are
    refused when they would share a service (its Worker, collector copy, and
    Durable Object state), a shop port (or the stack's own port), or an R2
    bucket; exports that share none of these run side by side.
  - **Worker.** The Worker is rebuilt from the manifest's
    `tenants[0].worker` with the module contents and assets directory read
    from the export. It listens on `127.0.0.1` at the port of its
    `shopOrigin`, because the shop accepts only its exact `Host`. Send requests
    to that port with the `Host` of `shopOrigin`: inside
    `scripts/offline-run.sh`, `*.localhost` names do not resolve.
  - **Tail labels.** Local workerd sends tail events with no script name or
    version, so each producer tails into its own copy of the collector bundle
    (`<service>-observe`, writing to the `stats-observe` store). That copy
    labels the events with the export's service name and version id.
  - **Persistence.** The first start copies `persist-seed/` into the stack's
    persistence directory and skips `cache/`. When the directory already holds
    a Miniflare namespace index (`metadata.sqlite`), the copy keeps the
    existing one. Any other existing file stops the start. Later starts
    find the producer's Durable Object directory and keep its state, so
    `make reset-local` (or a new `--state`) is the only way to take a newer
    export's data.
  - **Network and cron.** A producer's outbound request to one of the
    origins its manifest declares (`tenants[0].stripeOrigin`,
    `origins.mailboxApi`, `origins.identity`) is forwarded to `127.0.0.1` at
    that origin's port with the origin's `Host`, because `*.localhost` does
    not resolve inside the sandbox. The launcher starts none of them; a
    request to one that is not listening fails in the producer. Every other
    request gets the same offline 503 as `stats`'s and fails the run as
    undeclared. The launcher fires `scheduled` for `stats` only and never the
    producer's cron, which Nanoshop's own local stack fires.

  `fixtures/producers/nanoshop-storied/` is a recorded export: Nanoshop's
  `storied` tenant seeded with its synthetic `alpha` catalog, with tax and
  shipping set through its admin so it can check out, and local test secrets
  only. `test/local/launcher.test.ts` serves it with `dev`, sends
  storefront requests, waits for the sampled counts to flush (about 20 s
  idle), and checks the producer's invocation count and version through the
  window API and a real `statsctl observe routes` process. The checks also
  cover a cart that survives a restart and a tampered copy that is refused.
  To regenerate the fixture, run these commands from a Nanoshop checkout,
  with `S` a scratch directory and `config.json` a one-tenant config for
  `storied` on `http://storied.localhost:8080` with theme `themes/default`,
  settings `tenants/storied/settings.json`, and image host
  `images.alpha.test`:

  ```sh
  node src/main.ts local init --env s3 --root "$S" --config config.json --catalog storied=tests/fixtures/catalogs/alpha.json
  node src/main.ts local start --env s3 --root "$S"
  ```

  While it runs, sign in to the shop's `/admin` as `owner` through the test
  identity it prints, and save the tax settings (rate table: WA 10% on
  lines, OR 0% on lines and shipping) and the shipping settings (origin WA,
  free over 100, local pickup on, zone `West` at 7 for WA, OR, and CA), the
  values Nanoshop's own `tests/local/stack.test.ts` uses. Stop it with
  Ctrl-C, then:

  ```sh
  node src/main.ts local export-producer --env s3 --root "$S" --out "$S/export"
  ```

  Then replace the fixture directory with `$S/export`. The export includes
  the release's `.cloudflare/output`, which its digest covers, so
  `.gitignore` re-includes `.cloudflare/` under `fixtures/producers/`;
  without it a fresh checkout fails the digest check. The ports are chosen at
  `init` and recorded in the export, so they change on every regeneration,
  and the tests fail if one is already in use.

- **Producer checkout.** `make integration-producer` runs
  `test/producer/checkout.test.ts` under `scripts/offline-run.sh`. It runs
  Nanoshop's Stripe simulator and mailbox as separate processes from
  `NANOSHOP_DIR` (`src/simulator/stripe/main.ts`,
  `src/simulator/mailbox/main.ts`; no install or build there) on the ports
  the export declares, and fails with the preparation command when
  `NANOSHOP_DIR` is unset. A fake provider would not do: the point is that
  the producer's real Stripe calls, signed webhooks, and email pass through
  the stack. The simulator posts webhooks to a relay in the test, which
  forwards them to the shop with its `Host`. The test adds to cart, reviews,
  accepts, and pays with the success card, then runs `statsctl observe
  operations --project nanoshop-storied --json` until it reports exactly
  what the test caused: one `request.cart-add`, `request.checkout-review`,
  and `request.checkout-accept`; one `request.webhook` per webhook the shop
  stored; one `store.rpc.commerceCommand` for the review, two for the accept
  (accept and session record) and one per stored webhook; and as many
  `store.alarm` as a second tail consumer recorded from workerd directly.
  It also requires the confirmation email in the mailbox and no undeclared
  outbound request. It takes about 40 s, mostly waiting: local workerd
  delivered one Durable Object RPC's tail event about 20 s late when it
  overlapped the alarm, and the collector flushes sampled counts about 20 s
  after its last event.

The stack loads the `stats` bundle behind an entry module that adds a
`runAlarm()` RPC to each Durable Object, because Miniflare has no alarm
trigger and RPC reserves `alarm()`. An identical collection rewrites only
live-measured points: probe latencies and the store's own size.

Limits: fixtures cannot show that Cloudflare still accepts the fixed queries or
returns the recorded columns; run `node cloudflare/scripts/check-analytics-sql.mjs`
after changing `src/projects/queries.ts`. `scripts/offline-run.sh` exits 2 off
macOS until a Linux sandbox is verified, so `make check` runs
`make integration-local` only on macOS; elsewhere `make cloudflare-test` still
runs `test:local` with the app-level outbound check. Nothing here measures billable CPU.

## Ingest conformance

`fixtures/v2/` holds the cross-language corpus for the binary ingest format.
`scripts/fixture-sources.mjs` deterministically writes the semantic sources
(`sources/*.json`, the stored sample shape) and `manifest.json` with each
sample's expected outcome and the size budgets. `agent/tests/conformance.rs`
encodes every source with the agent's encoder and requires the bytes to equal
`frames/<name>.stb2` and `.absolute.stb2`, the hand-audited segments in
`annotated.json` to equal their golden frame, and every golden
acknowledgment in `acks.json` (written by the Worker's encoder) to decode to
its stated values, with the malformed acknowledgments rejected. The Node suite
`test/ingest/` decodes every golden frame and compares the normalized samples
with the sources, checks that delta and absolute encodings store the same
content, rejects every frame in `malformed.json` with its code and every
strict prefix of every golden frame, runs 20,000 seeded byte mutations, and
checks that the frame encoder (`src/ingest/encode.ts`, used by the
workerd tests for ad hoc batches) reproduces the agent's golden bytes. The
workerd suite posts every golden and malformed frame through the public route.
After a deliberate format or corpus change, `make fixtures-write` regenerates
everything; review the binary diff against `annotated.json`.

## Node target tests

`pnpm run test:node` runs the `Installation` core under Node on `node:sqlite`:
the corpus ingest and history paths, retention, the scheduler, and the SQL
adapter. Its parity test needs `pnpm build`. It sends every `fixtures/v2` frame
to the built Worker in Miniflare and to the core on `node:sqlite`, and requires
identical acknowledgment bytes, history frame bytes, ETags, and host rows. Row
counts are not compared: `node:sqlite` reports table rows changed, not the rows
Cloudflare bills.

## Observability tests

`pnpm run test:observe` runs the portable core, symbolication, the tail
reducer, and the `pnpm observe` CLI (against the scenario over local HTTP)
under Node. `test/observe-e2e/sourcemap.test.ts` maps a throw site in the
built stats bundle back to the source line that throws. `pnpm run test:observe-e2e` needs `pnpm build` and
`pnpm run build:observe` first; it loads both bundles into Miniflare with
`stats-observe` as the tail consumer of `stats` and of a small `usr-memories`
stand-in that publishes marks and one caught error, drives real ingest,
dashboard, admin, and scheduled traffic, and checks linked traces, grouped
issues, that each service lands in its own store, that polling
`/api/observe/*` stores nothing, that no secret reaches the store, that
billed rows written per invocation stay within budget, and that a crashing
or missing collector leaves stats responses unchanged. Local workerd sends
tail events with no script name, so the harness wraps the collector bundle
once per producer to supply the name production sends. `TEST_NOW_MS` pins the stats clock in the past, so
`Installation`'s retention alarm fires repeatedly there; the test waits for
the invocations it caused rather than for quiet.

`test/observe/sampling-parity.test.ts` pins the rows written per batch and the
absence of sampling fields for `stats` and `usr-memories`; it passes unchanged on
the commit before sampling. `test/observe/counts.test.ts` sums 10,000 seeded
events against the counts table, and `count-buffer.test.ts` does the same with
buffering on and a final flush. `test/observe-e2e/trace-determinism.test.ts` shows
that a Durable Object invocation reports its caller's trace id, and
`sampling.test.ts` drives a Nanoshop-shaped producer through the real tail
handler and store, moving the collector's clock forward to force the final flush.

`cloudflare/test/ui/observe.spec.ts` drives the route explorer, the Errors
card, the deployment impact panel, and the ledger's Durable Object split on
the `stats` project page, and checks that with every section open nothing on
the page scrolls on its own.
`observe-scenario.ts` builds a deterministic seven-day stats workload
through the real core store with injected faults: a canary that introduces
a parser bug, a v1.4.0 deploy that adds an ingest error, regresses the
resolved parser bug, and makes host history reads CPU-hot, and a poll
failure carried across every version. The spec and `make preview` answer
`/api/observe/stats/*` from it through the real API handler;
`PREVIEW_OBSERVE=capture make preview` serves the production capture. Its WebP goldens
(`observe.spec.ts-snapshots/`) cover the route explorer, the Deployment card
with v1.4.0's impact, the Errors card, and the trace modal on desktop and
mobile; they come from the scenario, so they change only when the scenario
or the design does. Local workerd sets no
script version, so the two-Worker test proves that a polled deployment is
forwarded and stored, while version attribution is covered by the core
tests. `cloudflare/scripts/capture-project.sh stats` also
saves the production observe responses, which `make preview` serves from
`/api/observe/stats/*`.

## Screenshot goldens

`cloudflare/test/ui/replay.spec.ts` serves the captures in
`cloudflare/test/ui/captures/` with the clock frozen at the capture time. It
compares the host summary and charts on each captured host page, the cost
ledger and charts on the `stuff` project page, and its Deployment card at the
1h and 6h ranges. The ledger reads `from`/`to` windows, which the replay and
`make preview` answer by slicing the shortest captured range that covers the
window. Baselines live beside the spec as WebP files, and `make
dashboard-test` rejects tracked PNGs. The replay hides the section bar and
zeroes the card scroll offset, because Playwright's scroll-into-view would
otherwise leave a card shorter than the viewport partly off-screen and
unpainted.

Recapture fixture data with `cloudflare/scripts/capture-host.sh` or
`cloudflare/scripts/capture-project.sh` against the deployed service. The
`stuff` deployment files (`deployments.json` and `comparison-1h|6h|24h.json`)
are hand-built, not captured, and both the replay and `make preview` serve them.

A one-device-pixel raster shift can fail a golden even when the content and
layout are unchanged. Playwright pads a size mismatch before counting pixels
but still reports the mismatch. Inspect the difference with odiff before
refreshing a baseline:

```sh
pnpm dlx odiff-bin@latest expected.webp actual.webp --antialiasing --parsable-stdout
```

odiff prints the diff percentage. Add `--fail-on-layout` to make differing
dimensions a separate failure. The 2026-11-02 replay failures were this case:
a one-pixel shift gave 0.57% on the host summary and 1.14% on the charts with
antialiasing ignored. The goldens were refreshed only after that check.

After a deliberate UI change, update the affected goldens:

```sh
cd cloudflare
pnpm exec playwright test test/ui/replay.spec.ts --update-snapshots
```

Inspect the new images before committing. Do not refresh a golden just to make
the suite pass.

## Playwright compared with odiff

odiff is faster on large images, slower on small ones, and neither comparator
is the suite's bottleneck.

Measured on 2026-11-02 on an Apple M5 Max with macOS 27.0.1, Node 26.12.1, and
Playwright 1.64.1. Each side ran 11 times, alternating, with the first run
discarded. Values are medians with the observed range.

| Comparison | Playwright | odiff |
| --- | ---: | ---: |
| Desktop chart, identical, 1240×2360 | 62 ms (58 to 66) | 24 ms (23 to 25) |
| Mobile chart, identical, 350×3203 | 22 ms (20 to 25) | 14 ms (11 to 18) |
| Desktop host summary, identical, 1240×174 | 5.5 ms (4.9 to 6.7) | 9.1 ms (8.0 to 10.3) |
| Desktop chart, one-pixel mismatch | 225 ms (193 to 347) | 27 ms (26 to 29) |

Playwright decodes WebP in WASM and then runs `pixelmatch` in JavaScript.
`pixelmatch` has a fast path for identical images that scans 32-bit pixels and
returns before the full per-pixel diff, so a passing suite avoids the slow
mismatch path. odiff is native and wins on large charts. Process startup alone
costs about 4.3 ms, which dominates a 5 ms host-summary comparison. Server
mode would remove that startup, but not the end-to-end conclusion.

The replay suite runs 20 host-summary and 20 chart comparisons. At these
medians, replacing the comparator saves roughly 0.4 s of CPU across the suite.
With four Playwright workers that is about 0.1 s of a 10 s run, near 1%.
Playwright has no pluggable comparator, so an odiff replacement would also
mean reimplementing snapshot storage, update, and attachment handling.

Decision: keep Playwright's comparator and use odiff to inspect failures. Add
odiff to the suite only if the goal becomes tolerating one-pixel layout drift
on every run, not for speed.

Measurement caveat: an unrelated benchmark was running on the host, with a
load average between 3.7 and 10.5 on 18 cores. The sides were interleaved, so
read the absolute times as inflated and the ratios as indicative.
