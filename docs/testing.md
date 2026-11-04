# Testing

Run the narrowest target while iterating and `make check` before release.

| Command | Covers |
| --- | --- |
| `make fixtures` | Fixture manifest, shapes, and cost arithmetic |
| `make agent-test` | Rust unit tests and fixture parity |
| `make cloudflare-test` | Worker typecheck, Workers-runtime tests, the observe core under `node:sqlite`, and the two-Worker tail test |
| `make dashboard-test` | Dashboard build, Playwright tests, and the tracked-PNG check |
| `make lint` | Type-aware Oxlint |
| `make preview` | Built dashboard served from captures on `http://127.0.0.1:4174/` |
| `make dashboard-bench` | Paint and transfer medians from the preview |

`make agent-test` on macOS does not compile the Linux-only readers. Run it on
Linux before changing them.

## Observability tests

`pnpm run test:observe` runs the portable core and the tail reducer under
Node. `pnpm run test:observe-e2e` needs `pnpm build` and
`pnpm run build:observe` first; it loads both bundles into Miniflare with
`stats-observe` as the tail consumer of `stats`, drives real ingest,
dashboard, admin, and scheduled traffic, and checks linked traces, grouped
issues, that polling `/api/observe/*` stores nothing, that no secret reaches
the store, and that a crashing or missing collector leaves stats responses
unchanged. `TEST_NOW_MS` pins the stats clock in the past, so
`Installation`'s retention alarm fires repeatedly there; the test waits for
the invocations it caused rather than for quiet.

`cloudflare/test/ui/observe.spec.ts` drives the route explorer, the Errors
card, and the deployment impact panel on the `stats` project page.
`observe-scenario.ts` builds a deterministic seven-day stats workload
through the real core store with injected faults: a canary that introduces
a parser bug, a v1.4.0 deploy that adds an ingest error, regresses the
resolved parser bug, and makes host history reads CPU-hot, and a poll
failure carried across every version. The spec and `make preview` answer
`/api/observe/*` from it through the real API handler;
`PREVIEW_OBSERVE=capture make preview` serves the production capture. Local workerd sets no
script version, so the two-Worker test proves that a polled deployment is
forwarded and stored, while version attribution is covered by the core
tests. `cloudflare/scripts/capture-project.sh stats` also
saves the production observe responses, which `make preview` serves from
`/api/observe/*`.

## Screenshot goldens

`cloudflare/test/ui/replay.spec.ts` serves the captures in
`cloudflare/test/ui/captures/` with the clock frozen at the capture time. It
compares the host summary and charts on each captured host page, and the same
two regions on the `stuff` project page, plus its Deployments card at the 1h and
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
