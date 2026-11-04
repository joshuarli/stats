# Testing

Run the narrowest target while iterating and `make check` before release.

| Command | Covers |
| --- | --- |
| `make fixtures` | Ingest corpus manifest, size budgets, cross-file constants, and byte/row accounting |
| `make agent-test` | Rust unit tests, golden-frame reproduction, annotated vectors, acknowledgment decoding, seeded prefix properties |
| `make agent-e2e` | The built agent binary sampling this host and delivering through the built Worker and Durable Object |
| `make smoke-local` | `deploy/deployed-smoke.sh` against the built Worker in local workerd |
| `make ingest-bench` | Encoder, decoder, and end-to-end ingest timings (see `docs/binary-ingest.md`) |
| `make cloudflare-test` | Worker typecheck, Workers-runtime tests, the observe core under `node:sqlite`, and the two-Worker tail test |
| `make dashboard-test` | Dashboard build, Playwright tests, and the tracked-PNG check |
| `make lint` | Type-aware Oxlint |
| `make preview` | Built dashboard served from captures on `http://127.0.0.1:4174/` |
| `make dashboard-bench` | Paint and transfer medians from the preview |

`make agent-test` on macOS does not compile the Linux-only readers. Run it on
Linux before changing them.

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
checks that the test-only frame builder (`test/support/stb2.ts`, used by the
workerd tests for ad hoc batches) reproduces the agent's golden bytes. The
workerd suite posts every golden and malformed frame through the public route.
After a deliberate format or corpus change, `make fixtures-write` regenerates
everything; review the binary diff against `annotated.json`.

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

`cloudflare/test/ui/observe.spec.ts` drives the route explorer, the Errors
card, and the deployment impact panel on the `stats` project page.
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
compares the host summary and charts on each captured host page, and the same
two regions on the `stuff` project page, plus its Deployment card at the 1h and
6h ranges. Baselines live beside the spec as WebP files, and `make
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
