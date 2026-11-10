# Dashboard integration report

The issue and cost investigations work with an installed dashboard package. The milestone is **not accepted**: the package adds unrelated initial JavaScript to Fleet, Projects, Services, and Service, and version 0.6.0 has not been published. The time-based performance gate is deferred because the host is busy.

## Revisions and package

- Library source: `7d62ebf648eb3f612ceb3613022d17eaedccdb9e`.
- Library hydration regression: `30bba52`, a test-only follow-up after packing.
- Package: `@laputa-systems/ui-dashboard@0.6.0`, packed as `laputa-systems-ui-dashboard-0.6.0.tgz` by `make pack`. The archive is in the library checkout at `.work/tmp/pack/`.
- Stats baseline: `5fedff5c00f004280adcd858fc00889174d5a131`, with benchmark corrections in `f893157` and fixture evidence in `5c3c751`.
- Stats integration: `d5c74d1`, serving checks in `8129740`, the prepared package lock in `c698829`, response cleanup in `632d3b6`, raw-byte review in `b29f3c9`, and menu shortcut isolation in `d584b59`.
- Toolchain: Node 26.13.0, pnpm 12.18.0, Vite 8.3.6, Chromium on macOS.

Stats installed the packed archive with pnpm and imported `@laputa-systems/ui-dashboard/feedback` and its documented stylesheet. The final archive differs from the earlier tested package only in the campaign document. The `dist` tree and manifest compare byte for byte, and the final archive was installed for the integrated checks.

The Stats lockfile points at the archive's content-addressed registry URL and integrity. A local metadata fixture generated that prospective entry from the archive and the registry's URL convention. Version 0.6.0 is not published, so a clean install from the public registry and verification of the published metadata remain open. The registry dry run did not finish. Neither repository was pushed, and nothing was published or deployed.

## Investigation journeys

- **Issues and traces.** An explicit project section survives reload and browser history. The selected issue remains available after the trace closes. Resolve and reopen report pending, acknowledged success, or failure, and focus moves to the feedback when a selected issue disappears. The [mobile trace before](dashboard-integration/trace-before-mobile.webp) clipped invocation facts and stack frames. The [mobile trace after](dashboard-integration/trace-after-mobile.webp) keeps them within the visible timeline while the timeline can scroll horizontally.
- **Cost to requests.** Mobile ledger details show the full selected route or statement, the relevant unit, and both comparison windows. The [mobile ledger capture](../cloudflare/test/ui/replay.spec.ts-snapshots/stuff-1h-ledger-mobile-darwin.webp) shows the resulting layout. Observed-project route contributors can open Requests using their complete label. If retained telemetry has no exact match, Stats says so and does not show other routes' traces as evidence. No Requests exploration is fetched until the section opens.
- **Deployment evidence.** The [service table before](dashboard-integration/service-before.webp) squeezed the operation name into one-character lines. The [service table after](../cloudflare/test/ui/services.spec.ts-snapshots/service-web-desktop-darwin.webp) keeps the name and heading on one line and wraps per-unit details within a bounded column. The focused regression also exercises a longer operation and work counter. Associated host, issue, and trace navigation is not yet improved as a complete deployment journey.

Stats uses the existing `ActionStatus` component for issue mutations. A Stats browser test mounts the packaged menu and select and verifies their keyboard input does not trigger global shortcuts; those shortcuts still work after the controls close. The library also fixes nested mixed-axis `SplitPane` ownership. The additive `WorkbenchDrawerControl` API lets a host control navigation and workspace drawers with `open` and `onOpenChange`. The canvas fixture exercises it without accessing dialog internals; Stats does not yet use that drawer API. No shared table API was generalized from Stats tables.

## Asset graphs

Each graph includes its complete initial import closure. Values are bytes. Gzip is calculated per asset by `bench-bundle.mjs`; raw sizes also match the uncompressed preview transfers in the default fixture.

| Route | JS raw before → after | JS gzip before → after | CSS raw before → after | CSS gzip before → after |
| --- | ---: | ---: | ---: | ---: |
| Fleet | 218,696 → 235,111 | 83,862 → 88,782 | 49,949 → 51,840 | 9,816 → 10,118 |
| Host | 332,028 → 342,704 | 125,566 → 128,451 | 51,593 → 53,484 | 10,506 → 10,808 |
| Projects | 270,946 → 287,367 | 101,889 → 106,804 | 55,973 → 57,864 | 11,641 → 11,943 |
| Project Overview | 381,143 → 393,680 | 142,905 → 146,356 | 78,753 → 80,987 | 16,661 → 17,022 |
| Project Errors | 412,984 → 427,084 | 154,044 → 158,049 | 78,753 → 83,011 | 16,661 → 17,598 |
| Project Requests | 410,534 → 423,523 | 153,659 → 157,189 | 78,753 → 80,987 | 16,661 → 17,022 |
| Services | 238,925 → 255,337 | 91,770 → 96,694 | 57,619 → 59,653 | 12,278 → 12,616 |
| Service | 245,065 → 261,474 | 93,674 → 98,600 | 58,777 → 60,811 | 12,579 → 12,917 |

Fleet grew 7.51% raw and 5.87% gzip. Projects grew 6.06% raw and 4.82% gzip. Services grew 6.87% raw and 5.37% gzip. Service grew 6.70% raw and 5.26% gzip. All exceed the 5% review threshold in at least one form. Source-map inspection attributes much of the shared growth to the richer library `Button` used by the lazy gallery: its native-attribute forwarding pulls additional Solid DOM and store support into a shared initial chunk. A disposable build that replaced the gallery Button reduced Fleet to 84,691 gzip bytes, but did not preserve the gallery's library demonstration and was rejected. Preserving package modules did not solve Fleet's growth and increased other route graphs. A non-hydratable build was also rejected because it breaks the library contract. No optional feedback, layout, data, forms, or recipes family is needed by Fleet; feedback CSS remains deferred to Errors. The unrelated Button payload still violates the route-isolation goal and needs a contract-preserving fix.

## Requests and lifecycle

The default fixture contains four hosts, three projects, and one service. Each observation below is one run and is not a timing claim. Cold request counts include the document and assets. API counts are a subset. The baseline request run includes the later response-body cleanup, so both sides count 404 responses that the original run missed.

| Route | Cold requests before → after | Cold API before → after | Warm requests before → after |
| --- | ---: | ---: | ---: |
| Fleet | 15 → 15 | 9 → 9 | 8 → 8 |
| Host | 14 → 14 | 3 → 3 | 2 → 2 |
| Projects | 23 → 23 | 11 → 11 | 10 → 10 |
| Project Overview | 28 → 28 | 11 → 11 | 10 → 10 |
| Project Errors | 31 → 32 | 12 → 12 | 11 → 11 |
| Project Requests | 33 → 33 | 14 → 14 | 13 → 13 |
| Services | 15 → 15 | 3 → 3 | 2 → 2 |
| Service | 17 → 17 | 4 → 4 | 3 → 3 |

Errors adds one request for the feedback stylesheet. The route gates still exclude uPlot and observability code from Fleet and exclude uPlot from the initial Projects graph. Deep-linked sections load their views; inactive sections do not fetch their gated data.

Before the keyboard guard was added, ten Fleet-to-Host chart cycles in the default fixture left zero additional DOM nodes and listeners and zero uPlot roots after leaving the host. Forced-GC heap rose 674.1 KiB and backing storage fell 0.3 KiB. The repaired-baseline observation was +676.7 KiB heap and −0.3 KiB backing. Both are single observations, not a retained-memory trend. Host and project history revalidations returned 304 with no response body for 1h, 24h, and 7d ranges.

The large fixture contains 24 hosts and 12 projects. Request-only runs found identical cold API counts on every route. Errors adds one CSS request, as in the default fixture. Projects made 50 total requests, including 38 API requests; Fleet made 27, including 21 API requests. Sorting Fleet by CPU loaded all 24 distinct histories and produced ascending values across all three pages. The baseline did the same.

The 100-navigation retention run, also before the keyboard guard, exercised all three Fleet pages. After forced collection, the candidate grew from 5,565.4 to 29,286.6 KiB of JavaScript heap and from 1,224.4 to 16,634.1 KiB of backing storage. Its checkpoints after step 25 contained 4,696–5,953 DOM nodes and 217–241 listeners. The final Fleet view retained no uPlot roots. The baseline grew from 5,534.1 to 29,117.2 KiB of heap and from 1,208.5 to 16,621.2 KiB of backing storage, with 4,566–5,823 nodes and 217–241 listeners after step 25. These are single observations, not a leak-rate or timing comparison.

The original large run repeatedly waited five seconds for failed responses whose bodies the frontend had not canceled. Stats now cancels unread error bodies while preserving their reported status and message. The default and large request comparisons remeasure the baseline with the same cleanup so those responses are counted on both sides.

## Checks and remaining work

- Library `make check`: 67 unit and packed tests, 270 Chromium tests. The final archive's runtime and manifest match the checked archive. The library build's peak RSS was 174,735,360 bytes. Layout browser JavaScript, server JavaScript, and CSS were 14,563, 12,290, and 2,704 gzip bytes. The archive was 193,459 bytes.
- Stats `make dashboard-test`: 193 tests with Node 26.13.0 and the final archive installed. All four Stats typecheck configurations and focused lint checks passed. Focused tests also checked the Worker and Node serving the generated Errors assets. The Worker test loaded the view and stylesheet; the Node test compared response bytes with the built assets.
- Earlier candidate measurements made with Node 26.12.0 were discarded. The baseline and comparisons in this report use Node 26.13.0. The measurements do not establish a latency or throughput change.
- perf gate deferred: host busy. The memory-only and request-only checks above ran without a timing claim.
- Rank the next work by consumer benefit: remove the unrelated Button payload while preserving its full native and hydration contracts; preserve filtered and sorted host and project lists across detail navigation; then connect deployment comparisons to their associated host, issue, or trace with explicit coverage. Validate table primitives against two materially different Stats tables before generalizing their API. Publish the exact prepared archive only through the established release process when publication is authorized, then verify the public lockfile and clean install.
