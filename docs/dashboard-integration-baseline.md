# Stats dashboard integration baseline

The frontend source is Stats `5fedff5c00f004280adcd858fc00889174d5a131` with the measurement-target fix in `f893157`. The installed registry package is `@laputa-systems/ui-dashboard@0.5.0`; its source revision has not been established. The local library candidate began at `6d093c74ff9d6354f88238d05e4576a7ba71ff94` and is a different artifact despite its `0.5.0` manifest. No candidate tarball was installed for this baseline.

The build uses Node 26.13.0, pnpm 12.18.0, Vite 8.3.6 and the captured preview fixture. The default fixture has four hosts, three projects and one service. The large fixture synthesizes 24 hosts and 12 projects from captures. The browser measurements below use one run; they establish request and lifecycle observations, not timing claims. The preview transfers assets uncompressed. Gzip sizes below come from `bench-bundle.mjs`, not preview transfers.

## Initial import graphs and compressed assets

JavaScript and CSS are bytes. Each graph lists every transitive initial chunk stem. Expanded rows include the indicated deferred view; `projectOpen` is the union of project dynamic imports rather than a simultaneously rendered page.

| Route | JS raw | JS gzip | CSS raw | CSS gzip | JS chunk stems | CSS chunk stems |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| fleet | 218696 | 83862 | 49949 | 9816 | index, dist, sort, api | index |
| host | 332028 | 125566 | 51593 | 10506 | index, dist, sort, api, HostPage, shared, Info, DeploymentEvents | index, shared |
| projects | 270946 | 101889 | 55973 | 11641 | index, dist, sort, api, ProjectsPage, Deployments, ledger-load, Info | index, Deployments, projects |
| projectsExpanded | 349356 | 133983 | 57617 | 12331 | index, dist, sort, api, ProjectsPage, Deployments, ledger-load, Trends, shared, DeploymentEvents, series, Info | index, Deployments, projects, shared |
| project | 381143 | 142905 | 78753 | 16661 | index, dist, sort, api, ProjectPage, Info, shared, ledger-load, series, Deployments, DeploymentEvents | index, shared, Deployments, ProjectPage, project |
| projectErrors | 412984 | 154044 | 78753 | 16661 | index, dist, sort, api, ProjectPage, ObserveSection, Info, shared, ledger-load, series, Deployments, DeploymentEvents, TraceTimeline | index, shared, Deployments, ProjectPage, project |
| projectRequests | 410534 | 153659 | 78753 | 16661 | index, dist, sort, api, ProjectPage, Requests, Info, shared, ledger-load, series, Deployments, DeploymentEvents, TraceTimeline | index, shared, Deployments, ProjectPage, project |
| projectOpen | 428486 | 159464 | 78753 | 16661 | index, dist, sort, api, ProjectPage, Info, shared, ledger-load, series, Deployments, DeploymentEvents, ObserveSection, TraceTimeline, Requests | index, shared, Deployments, ProjectPage, project |
| services | 238925 | 91770 | 57619 | 12278 | index, dist, sort, api, ServicesPage, Deployments, Info | index, Deployments, projects, services |
| service | 245065 | 93674 | 58777 | 12579 | index, dist, sort, api, ServicePage, Deployments, DeploymentEvents, Info | index, Deployments, project, services |

## Default preview requests

The route run used `bench-ui.mjs --runs 1`. Raw bytes are actual preview JS and CSS transfers. Request counts include the document and assets; API counts are the subset. Warm counts follow a navigation away and back.

| Route | JS raw | CSS raw | Cold requests | Cold API | Warm requests | Warm API |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fleet | 218696 | 49949 | 15 | 9 | 8 | 8 |
| host | 332028 | 51593 | 14 | 3 | 2 | 2 |
| projects | 270946 | 55973 | 22 | 10 | 9 | 9 |
| project overview | 381143 | 78753 | 28 | 11 | 10 | 10 |
| services | 238925 | 57619 | 15 | 3 | 2 | 2 |
| service | 245065 | 58777 | 16 | 3 | 2 | 2 |
| project Errors | 412984 | 78753 | 31 | 12 | 11 | 11 |
| project Requests | 410534 | 78753 | 33 | 14 | 13 | 13 |

The fleet requests the host list, four host histories and four system records. The projects overview requests the host and project lists, six settled-window histories and two deployment lists. The project overview requests project history, current and comparison ledger histories, month history, health, open issues, two object windows and deployments. Errors adds the selected issue's occurrences and the `ObserveSection` and `TraceTimeline` chunks. Requests adds exploration, trace list and selected trace requests, and the `Requests` and `TraceTimeline` chunks. The other sections remain deferred.

## Large preview and global sorting

The large fixture contains 24 hosts, 12 projects and one service. Its single-run cold request counts were 27 for Fleet, 14 for Host, 46 for Projects, 28 for project Overview, 15 for Services, 16 for Service, 31 for Errors and 33 for Requests. Their API subsets were 21, 3, 34, 11, 3, 3, 12 and 14 respectively. The route asset graphs are the same as the default fixture.

Sorting Fleet by CPU loaded histories for all 24 hosts and visited all three pages. The displayed CPU values were globally ascending, including the 14 hosts beyond the initially visible page. The complete load and sort issued 24 history requests and 25 JSON requests, including the host list and system records.

The forced-GC 100-navigation trace exercised all three Fleet pages. Heap used was 5,534.1 KiB at step 0 and 29,117.2 KiB at step 100. Backing storage was 1,208.5 KiB and 16,621.2 KiB respectively. After step 25, checkpoints contained 4,566–5,823 DOM nodes and 217–241 listeners. The final Fleet view had zero uPlot roots. Focused browser checks overlapped the retention pass, so its timing data is discarded.

## Chart lifecycle

In the default fixture, one forced-GC ten-cycle Fleet-to-Host run retained 663 KiB of JavaScript heap and reduced backing storage by 0.3 KiB. DOM nodes and listeners had zero net change, and zero uPlot roots remained after leaving the host. The host showed 11 uPlot roots while active. The host and project 1h, 24h and 7d history revalidations returned 304 with zero response body bytes. These are single-run observations.

## Screenshots

The first milestone follows an issue to an occurrence and trace. These captured-scenario screenshots are the pre-change view:

- [Errors at 1440 × 900](dashboard-integration/errors-before-desktop.webp)
- [Errors at 768 × 1024](dashboard-integration/errors-before-tablet.webp)
- [Errors at 390 × 844](dashboard-integration/errors-before-mobile.webp)
- [Selected trace at 390 × 844](dashboard-integration/trace-before-mobile.webp)

The mobile trace places the selected invocation inside the horizontally scrolling timeline table. Its facts and stack extend beyond the visible panel. The desktop issue view retains a useful side-by-side list and details.
