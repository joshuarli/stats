# Dashboard integration report

The issue and cost investigations work with an installed dashboard package. The milestone is **not accepted**: the package adds unrelated initial JavaScript to Fleet, Projects, Services, and Service, and several cold routes exceed the measured timing spread. Version 0.6.0 remains unpublished under the campaign's release boundary, so its public registry install is unverified.

## Revisions and package

- Library source: `7d62ebf648eb3f612ceb3613022d17eaedccdb9e`.
- Library hydration regression: `30bba52`, a test-only follow-up after packing.
- Package: `@laputa-systems/ui-dashboard@0.6.0`, packed as `laputa-systems-ui-dashboard-0.6.0.tgz` by `make pack`. The archive is in the library checkout at `.work/tmp/pack/`. Its SHA-512 is `c5ebf2aed4119ca672dffe1069a82afa7965e26d19a9af734ea2729997bfd3f851feed5499073361d0241151a7bb6dc95238e9f8c379920ed22f1619560fb148`.
- Stats baseline: `5fedff5c00f004280adcd858fc00889174d5a131`, with benchmark corrections in `f893157` and fixture evidence in `5c3c751`.
- Stats integration: `d5c74d1`, serving checks in `8129740`, the prepared package lock in `c698829`, response cleanup in `632d3b6`, raw-byte review in `b29f3c9`, menu shortcut isolation in `d584b59`, list restoration in `6f14432`, comparison coverage in `1f6145b`, nested evidence focus in `79235a4`, responsive route details in `13c5e1f`, range and deployment navigation in `51b53c6` and `2eebc96`, retention-workload corrections in `ed67d31` and `3ea5ef7`, and runtime chunking in `24427c9`. Subsequent benchmark reporting fixes are `4f46488`, `ce4fa56`, and `10e31c7`; they do not change the measured application assets.
- Toolchain: Node 26.13.0, pnpm 12.18.0, Vite 8.3.6, Chromium on macOS.

Stats installed the packed archive with pnpm and imported `@laputa-systems/ui-dashboard/feedback` and its documented stylesheet. The final archive differs from the earlier tested package only in the campaign document. The `dist` tree and manifest compare byte for byte, and the final archive was installed for the integrated checks.

The Stats lockfile points at the archive's content-addressed registry URL and integrity. A local metadata fixture generated that prospective entry from the archive and the registry's URL convention. `stuff publish npm --tarball <archive> --dry-run --json` completed successfully for 0.6.0. It planned 422 objects totaling 15,050,441 bytes and skipped 459 existing objects; those are planned operations, not uploads. Its result has `dry_run: true`, even though the planned status is named `published`. The public registry still lists 0.4.0 and 0.5.0. Version 0.6.0 is not published, so a clean install from the public registry and verification of the published metadata remain open. Neither repository was pushed, and nothing was published or deployed.

## Investigation journeys

- **Return to a list.** A host investigation now returns to the same search, status filters, sort, and page. A project investigation returns to the same project sort. Browser Back restores focus to the selected row when it is still present; choosing the global navigation keeps focus on that control. This state lasts for the current dashboard session.
- **Issues and traces.** An explicit project section survives reload and browser history. Explicit telemetry ranges and deployment links now survive same-page navigation; browser history also restores the default range. The selected issue remains available after the trace closes. Resolve and reopen report pending, acknowledged success, or failure, and focus moves to the feedback when a selected issue disappears. The [mobile trace before](dashboard-integration/trace-before-mobile.webp) clipped invocation facts and stack frames. The [mobile trace after](dashboard-integration/trace-after-mobile.webp) keeps them within the visible timeline while the timeline can scroll horizontally.
- **Cost to requests.** Mobile ledger details show the full selected route or statement, the relevant unit, and both comparison windows. The [mobile ledger capture](../cloudflare/test/ui/replay.spec.ts-snapshots/stuff-1h-ledger-mobile-darwin.webp) shows the resulting layout. Observed-project route contributors can open Requests using their complete label. If retained telemetry has no exact match, Stats says so and does not show other routes' traces as evidence. No Requests exploration is fetched until the section opens.
- **Deployment evidence.** The [service table before](dashboard-integration/service-before.webp) squeezed the operation name into one-character lines. The [service table after](../cloudflare/test/ui/services.spec.ts-snapshots/service-web-desktop-darwin.webp) keeps the name and heading on one line and wraps per-unit details within a bounded column. The focused regression also exercises a longer operation and work counter. Comparisons show exact before and after windows with their time zone, identify the excluded time between them, and explain service-source coverage without hover. A limited comparison no longer claims it will become ready when the after window settles. The [mobile deployment capture](../cloudflare/test/ui/observe.spec.ts-snapshots/stats-deployments-mobile-darwin.webp) keeps route identities and comparison values readable. A captured deployment test opens an associated issue and trace, returns to the issue, and restores focus to the deployment evidence.

Stats uses the existing `ActionStatus` component for issue mutations. A Stats browser test mounts the packaged menu and select and verifies their keyboard input does not trigger global shortcuts; those shortcuts still work after the controls close. The library also fixes nested mixed-axis `SplitPane` ownership. The additive `WorkbenchDrawerControl` API lets a host control navigation and workspace drawers with `open` and `onOpenChange`. The canvas fixture exercises it without accessing dialog internals; Stats does not yet use that drawer API. No shared table API was generalized from Stats tables.

## Asset graphs

Each graph includes its complete initial import closure. Values are bytes. Gzip is calculated per asset by `bench-bundle.mjs`; raw sizes also match the uncompressed preview transfers in the default fixture.

| Route | JS raw before → after | JS gzip before → after | CSS raw before → after | CSS gzip before → after |
| --- | ---: | ---: | ---: | ---: |
| Fleet | 218,696 → 235,296 | 83,862 → 88,545 | 49,949 → 51,840 | 9,816 → 10,118 |
| Host | 332,028 → 342,996 | 125,566 → 128,384 | 51,593 → 53,484 | 10,506 → 10,808 |
| Projects | 270,946 → 288,738 | 101,889 → 106,796 | 55,973 → 58,553 | 11,641 → 12,048 |
| Project Overview | 381,143 → 394,856 | 142,905 → 146,292 | 78,753 → 82,300 | 16,661 → 17,244 |
| Project Errors | 412,984 → 428,424 | 154,044 → 158,003 | 78,753 → 84,324 | 16,661 → 17,820 |
| Project Requests | 410,534 → 424,726 | 153,659 → 157,138 | 78,753 → 82,300 | 16,661 → 17,244 |
| Services | 238,925 → 256,442 | 91,770 → 96,621 | 57,619 → 60,342 | 12,278 → 12,721 |
| Service | 245,065 → 262,624 | 93,674 → 98,536 | 58,777 → 61,500 | 12,579 → 13,022 |

Fleet grew 7.59% raw and 5.58% gzip. Projects grew 6.57% raw and 4.82% gzip. Services grew 7.33% raw and 5.29% gzip. Service grew 7.17% raw and 5.19% gzip. All exceed the 5% review threshold in at least one form. Grouping the initial runtime dependencies removes the extra request introduced by range-history support and reduces the compressed graph on every measured route. Source-map inspection attributes much of the remaining shared growth to the richer library `Button` used by the lazy gallery: its native-attribute forwarding pulls additional Solid DOM and store support into a shared initial chunk. A disposable build that replaced the gallery Button reduced Fleet to 84,691 gzip bytes, but did not preserve the gallery's library demonstration and was rejected. Replacing Solid's property omission with a custom proxy saved only 329 gzip bytes in a separate candidate and retained the larger shared runtime, so it was rejected. Preserving package modules did not solve Fleet's growth and increased other route graphs. Inlining common chunks increased Fleet to 91,180 gzip bytes and duplicated uPlot across feature chunks, so it was rejected. A non-hydratable build was also rejected because it breaks the library contract. No optional feedback, layout, data, forms, or recipes family is needed by Fleet; feedback CSS remains deferred to Errors. The unrelated Button payload still violates the route-isolation goal and needs a contract-preserving fix.

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

## Route readiness

Five alternating baseline–candidate pairs used the default fixture, Node 26.13.0, Chromium, 150 ms emulated latency, and 1.6 Mbit/s download throughput. Each value is the median and range in milliseconds. Cold readiness runs from navigation to the route's benchmark selector; warm readiness follows navigation away and back. The preview transfers uncompressed assets. The baseline includes the same response-body cleanup as the candidate so failed requests settle on both sides. A pair whose candidate began with a hot-process warning was discarded and replaced. The accepted runs passed the load check immediately before and after each measurement.

| Route | Cold baseline | Cold candidate | Warm baseline | Warm candidate |
| --- | ---: | ---: | ---: | ---: |
| Fleet | 2,092 (2,067–2,107) | 2,163 (2,154–2,191) | 208 (205–218) | 201 (200–207) |
| Host | 2,562 (2,540–2,601) | 2,609 (2,601–2,649) | 47 (44–56) | 50 (46–57) |
| Projects | 2,368 (2,363–2,387) | 2,459 (2,449–2,471) | 173 (171–182) | 171 (167–179) |
| Project Overview | 3,265 (3,262–3,281) | 3,341 (3,335–3,371) | 370 (354–375) | 378 (370–383) |
| Project Errors | 3,459 (3,448–3,474) | 3,557 (3,533–3,597) | 348 (344–354) | 346 (342–349) |
| Project Requests | 3,655 (3,644–3,674) | 3,713 (3,694–3,753) | 712 (700–720) | 729 (707–733) |
| Services | 2,072 (2,060–2,092) | 2,147 (2,133–2,173) | 18 (9–21) | 17 (8–19) |
| Service | 2,106 (2,089–2,126) | 2,191 (2,181–2,213) | 17 (7–24) | 20 (5–23) |

The cold median increase exceeds the larger sample range for Fleet, Projects, Project Overview, Project Errors, Services, and Service. Host and Project Requests increases are within their observed spreads; every warm difference is within its observed spread. The extra raw assets are consistent with the cold increases under the emulated download limit, but the measurements do not isolate network transfer as the sole cause. Every run reported the same per-route API byte and request counts on both sides. A separate request audit found the same two fixture 404s on each side: the `usr-memories` deployment history and `web` issue collection. The timed harness did not retain individual response statuses, so that audit does not prove every timed response succeeded. The corrected harness now records failures for each run, including interrupted or unreadable responses, and rejects a network-idle timeout; focused regression tests cover those cases.

## Lifecycle

On the current candidate, ten Fleet-to-Host chart cycles in the default fixture left zero additional DOM nodes and listeners and zero uPlot roots after leaving the host. Forced-GC heap rose 654.8 KiB and backing storage fell 0.3 KiB. The repaired-baseline observation was +676.7 KiB heap and −0.3 KiB backing. Both are single observations, not a retained-memory trend. Host and project history revalidations returned 304 with no response body for 1h, 24h, and 7d ranges.

The large fixture contains 24 hosts and 12 projects. Request-only runs found identical cold API counts on every route. Errors adds one CSS request, as in the default fixture. Projects made 50 total requests, including 38 API requests; Fleet made 27, including 21 API requests. Sorting Fleet by CPU loaded all 24 distinct histories and produced ascending values across all three pages. The baseline did the same.

The current candidate's 100-navigation retention run exercised all three Fleet pages. After forced collection, it grew from 5,568.0 to 29,305.4 KiB of JavaScript heap and from 1,224.7 to 16,588.4 KiB of backing storage. Its checkpoints after step 25 contained 4,696–5,956 DOM nodes and 218–242 listeners. The final Fleet view retained no uPlot roots. The baseline grew from 5,534.1 to 29,117.2 KiB of heap and from 1,208.5 to 16,621.2 KiB of backing storage, with 4,566–5,823 nodes and 217–241 listeners after step 25. These are single observations, not a leak-rate or timing comparison. The benchmark now navigates to the intended page even when the fleet retains its previous page and preserves the selected range between routes.

The original large run repeatedly waited five seconds for failed responses whose bodies the frontend had not canceled. Stats now cancels unread error bodies while preserving their reported status and message. The default and large request comparisons remeasure the baseline with the same cleanup so those responses are counted on both sides.

## Checks and remaining work

- Library `make check`: 67 unit and packed tests, 270 Chromium tests. The final archive's runtime and manifest match the checked archive. The library build's peak RSS was 174,735,360 bytes. Layout browser JavaScript, server JavaScript, and CSS were 14,563, 12,290, and 2,704 gzip bytes. The archive was 193,459 bytes.
- Stats `make dashboard-test`: 204 tests with Node 26.13.0 and the final archive installed. Chromium 157 was also checked at actual 200% page zoom in a 1280-pixel viewport: the resulting layout viewport was 640 CSS pixels, device pixel ratio was 2, and page width did not overflow. The [deployment](dashboard-integration/deployment-zoom.webp), [ledger](dashboard-integration/ledger-zoom.webp), and [trace stack](dashboard-integration/trace-zoom.webp) captures were reviewed. All four Stats typecheck configurations and focused lint checks passed. Focused tests also checked the Worker and Node serving the generated Errors assets. The Worker test loaded the view and stylesheet; the Node test compared response bytes with the built assets.
- Earlier candidate measurements made with Node 26.12.0 were discarded. The baseline and comparisons in this report use Node 26.13.0. The readiness results apply to the recorded fixture and emulated network; they do not establish a throughput change.
- The cold readiness comparison above fails the performance acceptance on six routes. The memory-only and request-only checks above carry no timing claim.
- Rank the next work by consumer benefit: remove the unrelated Button payload while preserving its full native and hydration contracts, and recheck performance and lifecycle after the latest journeys. Validate table primitives against two materially different Stats tables before generalizing their API. Publish the exact prepared archive only through the established release process when publication is authorized, then verify the public lockfile and clean install.
