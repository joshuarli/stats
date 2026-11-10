# Dashboard integration report

The issue and cost investigations work with an installed dashboard package. The milestone is **not accepted**: the package adds unrelated initial JavaScript to Fleet, Projects, Services, and Service, and several cold routes exceed the measured timing spread. Version 0.6.0 remains unpublished under the campaign's release boundary, so its public registry install is unverified.

## Revisions and package

- Library source: `b7a15ae02ef3e3db696c3fb9902423b5a9e72d54`.
- Package: `@laputa-systems/ui-dashboard@0.6.0`, packed as `laputa-systems-ui-dashboard-0.6.0.tgz` by `make pack`. The archive is in the library checkout at `.work/tmp/pack/`. Its SHA-512 is `1a539be6b07426d7b850a82c8bafbe4bb93f1e0f6679f91d07d76abf6abebc83bf119a936b832b6121c1d93e3a587562de35fb3f7bcde361ae920d545caa7033`.
- Stats baseline: `5fedff5c00f004280adcd858fc00889174d5a131`, with benchmark corrections in `f893157` and fixture evidence in `5c3c751`.
- Stats integration: `d5c74d1`, serving checks in `8129740`, response cleanup in `632d3b6`, raw-byte review in `b29f3c9`, menu shortcut isolation in `d584b59`, list restoration in `6f14432`, comparison coverage in `1f6145b`, nested evidence focus in `79235a4`, responsive route details in `13c5e1f`, range and deployment navigation in `51b53c6` and `2eebc96`, retention-workload corrections in `ed67d31` and `3ea5ef7`, runtime chunking in `24427c9`, service comparison wording in `96d058a`, and table sorting in `bf7bbf0` and `1d48ed1`. Benchmark reporting fixes are `4f46488`, `ce4fa56`, and `10e31c7`.
- Toolchain: Node 26.13.0, pnpm 12.18.0, Vite 8.3.6, Chromium on macOS.

Stats installed the packed archive with pnpm and imported `@laputa-systems/ui-dashboard/feedback`, `@laputa-systems/ui-dashboard/data`, and their documented stylesheets. The installed data entry and standalone sortable-header stylesheet compare byte for byte with the archive used for the integrated checks.

The Stats lockfile points at the archive's content-addressed registry URL and integrity. A local metadata fixture generated that prospective entry from the archive and the registry's URL convention. `stuff publish npm --tarball <archive> --dry-run --json` completed for this archive. It planned 422 objects totaling 15,051,888 bytes and skipped 459 existing objects; those are planned operations, not uploads. Its result has `dry_run: true`, even though the planned status is named `published`. The public registry still lists 0.4.0 and 0.5.0. Version 0.6.0 is not published, so a clean install from the public registry and verification of the published metadata remain open. Neither repository was pushed, and nothing was published or deployed.

## Investigation journeys

- **Return to a list.** A host investigation now returns to the same search, status filters, sort, and page. A project investigation returns to the same project sort. Browser Back restores focus to the selected row when it is still present; choosing the global navigation keeps focus on that control. This state lasts for the current dashboard session.
- **Issues and traces.** An explicit project section survives reload and browser history. Explicit telemetry ranges and deployment links now survive same-page navigation; browser history also restores the default range. The selected issue remains available after the trace closes. Resolve and reopen report pending, acknowledged success, or failure, and focus moves to the feedback when a selected issue disappears. The [mobile trace before](dashboard-integration/trace-before-mobile.webp) clipped invocation facts and stack frames. The [mobile trace after](dashboard-integration/trace-after-mobile.webp) keeps them within the visible timeline while the timeline can scroll horizontally.
- **Cost to requests.** Mobile ledger details show the full selected route or statement, the relevant unit, and both comparison windows. The [mobile ledger capture](../cloudflare/test/ui/replay.spec.ts-snapshots/stuff-1h-ledger-mobile-darwin.webp) shows the resulting layout. Observed-project route contributors can open Requests using their complete label. If retained telemetry has no exact match, Stats says so and does not show other routes' traces as evidence. No Requests exploration is fetched until the section opens.
- **Deployment evidence.** The [service table before](dashboard-integration/service-before.webp) squeezed the operation name into one-character lines. The [service table after](../cloudflare/test/ui/services.spec.ts-snapshots/service-web-desktop-darwin.webp) keeps the name and heading on one line and wraps per-unit details within a bounded column. The focused regression also exercises a longer operation and work counter. Comparisons show exact before and after windows with their time zone, identify the excluded time between them, and explain service-source coverage without hover. A limited comparison and its application-work table no longer claim that an overlap will become ready when the after window settles. The [mobile deployment capture](../cloudflare/test/ui/observe.spec.ts-snapshots/stats-deployments-mobile-darwin.webp) keeps route identities and comparison values readable. A captured deployment test opens an associated issue and trace, returns to the issue, and restores focus to the deployment evidence.

Stats uses the existing `ActionStatus` component for issue mutations. A Stats browser test mounts the packaged menu and select and verifies their keyboard input does not trigger global shortcuts; those shortcuts still work after the controls close. The library also fixes nested mixed-axis `SplitPane` ownership. The additive `WorkbenchDrawerControl` API lets a host control navigation and workspace drawers with `open` and `onOpenChange`. The canvas fixture exercises it without accessing dialog internals; Stats does not yet use that drawer API. The new controlled `SortableHeader` is used by the paginated fleet table and the selectable route table: only the active column exposes its sort direction, and keyboard sorting retains focus and route selection. Stats still owns ordering, selection, and pagination. The standalone `styles/sortable-header.css` avoids loading chart and summary styles into those routes.

## Asset graphs

Each graph includes its complete initial import closure. Values are bytes. Gzip is calculated per asset by `bench-bundle.mjs`. The candidate graph and raw preview transfers are from `1d48ed1`.

| Route | JS raw before → after | JS gzip before → after | CSS raw before → after | CSS gzip before → after |
| --- | ---: | ---: | ---: | ---: |
| Fleet | 218,696 → 235,744 | 83,862 → 88,693 | 49,949 → 52,078 | 9,816 → 10,145 |
| Host | 332,028 → 343,444 | 125,566 → 128,532 | 51,593 → 53,722 | 10,506 → 10,835 |
| Projects | 270,946 → 289,186 | 101,889 → 106,945 | 55,973 → 58,791 | 11,641 → 12,075 |
| Project Overview | 381,143 → 395,304 | 142,905 → 146,439 | 78,753 → 82,538 | 16,661 → 17,271 |
| Project Errors | 412,984 → 428,872 | 154,044 → 158,152 | 78,753 → 84,562 | 16,661 → 17,847 |
| Project Requests | 410,534 → 425,174 | 153,659 → 157,287 | 78,753 → 82,538 | 16,661 → 17,271 |
| Services | 238,925 → 256,890 | 91,770 → 96,769 | 57,619 → 60,580 | 12,278 → 12,748 |
| Service | 245,065 → 263,059 | 93,674 → 98,683 | 58,777 → 61,738 | 12,579 → 13,049 |

Fleet grew 7.80% raw and 5.76% gzip. Projects grew 6.73% raw and 4.96% gzip. Services grew 7.52% raw and 5.45% gzip. Service grew 7.34% raw and 5.35% gzip. All exceed the 5% review threshold in at least one form. The shared sortable header adds 448 raw and 136 gzip JavaScript bytes to Fleet versus the preceding candidate; its standalone CSS adds 238 raw and 27 gzip bytes. Loading all data styles instead added 3,100 raw CSS bytes and was rejected. Grouping the initial runtime dependencies removes the extra request introduced by range-history support. Source-map inspection attributes much of the remaining shared growth to the richer library `Button` used by the lazy gallery: its native-attribute forwarding pulls additional Solid DOM and store support into a shared initial chunk. A disposable build that replaced the gallery Button reduced Fleet to 84,691 gzip bytes, but did not preserve the gallery's library demonstration and was rejected. Replacing Solid's property omission with a custom proxy saved only 329 gzip bytes in a separate candidate and retained the larger shared runtime, so it was rejected. Preserving package modules did not solve Fleet's growth and increased other route graphs. Inlining common chunks increased Fleet to 91,180 gzip bytes and duplicated uPlot across feature chunks, so it was rejected. A non-hydratable build was also rejected because it breaks the library contract. Fleet's data import is limited to the used header; chart and summary styles and code are absent. Feedback CSS remains deferred to Errors. The unrelated Button payload still violates the route-isolation goal and needs a contract-preserving fix.

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

Five alternating baseline–candidate pairs used the default fixture, the candidate at `1d48ed1`, Node 26.13.0, Chromium, 150 ms emulated latency, and 1.6 Mbit/s download throughput. Each value is the median and range in milliseconds. Cold readiness runs from navigation to the route's benchmark selector; warm readiness follows navigation away and back. The preview transfers uncompressed assets. The baseline includes the same response-body cleanup as the candidate so failed requests settle on both sides. All ten accepted runs passed the load check immediately before and after measurement. A preceding baseline and an earlier fourth baseline overlapped other active work and were discarded; the final two pairs were measured after that work stopped.

| Route | Cold baseline | Cold candidate | Warm baseline | Warm candidate |
| --- | ---: | ---: | ---: | ---: |
| Fleet | 2,075 (2,074–2,078) | 2,177 (2,162–2,183) | 203 (200–213) | 200 (193–218) |
| Host | 2,542 (2,522–2,586) | 2,600 (2,598–2,651) | 45 (44–56) | 45 (44–54) |
| Projects | 2,379 (2,365–2,396) | 2,452 (2,447–2,494) | 174 (172–189) | 181 (166–189) |
| Project Overview | 3,278 (3,262–3,295) | 3,339 (3,330–3,349) | 366 (353–387) | 371 (367–390) |
| Project Errors | 3,450 (3,449–3,489) | 3,551 (3,550–3,595) | 340 (332–348) | 342 (331–350) |
| Project Requests | 3,646 (3,609–3,660) | 3,720 (3,691–3,745) | 712 (704–727) | 712 (703–717) |
| Services | 2,071 (2,047–2,099) | 2,140 (2,135–2,164) | 15 (5–21) | 11 (6–20) |
| Service | 2,102 (2,082–2,127) | 2,185 (2,181–2,218) | 12 (6–20) | 11 (8–13) |

The cold median increase exceeds the larger observed range on seven routes; Host and every warm difference are within their observed ranges. The extra raw assets are consistent with the cold increases under the emulated download limit, but the measurements do not isolate network transfer as the sole cause. Every run reported the same per-route API byte and request counts on both sides. The corrected harness records failures for each run, including interrupted or unreadable responses, and rejects a network-idle timeout; focused regression tests cover those cases. All ten timed runs recorded only the same expected fixture 404s: the `usr-memories` deployment history and `web` issue collection. An earlier five-pair comparison at `24427c9` found cold increases beyond the observed spread on six routes; Host and Project Requests were within spread.

## Lifecycle

On the current candidate, ten Fleet-to-Host chart cycles in the default fixture left zero additional DOM nodes and listeners and zero uPlot roots after leaving the host. Forced-GC heap rose 606.7 KiB and backing storage fell 0.3 KiB. The repaired-baseline observation was +676.7 KiB heap and −0.3 KiB backing. Both are single observations, not a retained-memory trend. Host and project history revalidations returned 304 with no response body for 1h, 24h, and 7d ranges.

The large fixture contains 24 hosts and 12 projects. Request-only runs found identical cold API counts on every route. Errors adds one CSS request, as in the default fixture. Projects made 50 total requests, including 38 API requests; Fleet made 27, including 21 API requests. Sorting Fleet by CPU loaded all 24 distinct histories and produced ascending values across all three pages. The baseline did the same.

The current candidate's 100-navigation retention run exercised all three Fleet pages. After forced collection, it grew from 5,576.7 to 29,357.9 KiB of JavaScript heap and from 1,225.1 to 16,588.8 KiB of backing storage. Its checkpoints after step 25 contained 4,798–6,058 DOM nodes and 218–242 listeners. The final Fleet view retained no uPlot roots. The baseline grew from 5,534.1 to 29,117.2 KiB of heap and from 1,208.5 to 16,621.2 KiB of backing storage, with 4,566–5,823 nodes and 217–241 listeners after step 25. These are single observations, not a leak-rate or timing comparison. The benchmark now navigates to the intended page even when the fleet retains its previous page and preserves the selected range between routes.

The original large run repeatedly waited five seconds for failed responses whose bodies the frontend had not canceled. Stats now cancels unread error bodies while preserving their reported status and message. The default and large request comparisons remeasure the baseline with the same cleanup so those responses are counted on both sides.

## Checks and remaining work

- Library `make check`: 67 unit and packed tests, 272 Chromium tests. The library build's peak RSS was 173,424,640 bytes. Data browser JavaScript, server JavaScript, and standalone sortable-header CSS were 4,867, 5,933, and 197 gzip bytes. The archive was 194,750 bytes.
- Stats `make dashboard-test`: 206 tests with Node 26.13.0 and the current archive installed. Earlier Chromium 157 checks used actual 200% page zoom in a 1280-pixel viewport: the resulting layout viewport was 640 CSS pixels, device pixel ratio was 2, and page width did not overflow. The [deployment](dashboard-integration/deployment-zoom.webp), [ledger](dashboard-integration/ledger-zoom.webp), and [trace stack](dashboard-integration/trace-zoom.webp) captures were reviewed. The main Stats typecheck and targeted lint passed after the sortable-header change; all four typecheck configurations passed earlier. Focused tests also checked the Worker and Node serving the generated Errors assets. The Worker test loaded the view and stylesheet; the Node test compared response bytes with the built assets.
- Earlier candidate measurements made with Node 26.12.0 were discarded. The baseline and comparisons in this report use Node 26.13.0. The readiness results apply to the recorded fixture and emulated network; they do not establish a throughput change.
- The current cold readiness comparison fails the performance acceptance on seven routes. The memory-only and request-only checks above carry no timing claim.
- Rank the next work by consumer benefit: remove the unrelated Button payload while preserving its full native and hydration contracts, then repeat the paired timings on a quiet host. Extend the shared table only when another Stats need warrants it. Publish the exact prepared archive only through the established release process when publication is authorized, then verify the public lockfile and clean install.
