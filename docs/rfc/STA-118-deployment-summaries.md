# STA-118: Bound deployment summaries for overview pages

Status: accepted (2026-11-13, owner decision)

## Summary

Give project and service overview rows a bounded latest-deployment summary.
Keep full deployment histories for detail and comparison views. Prefer adding
the summary to the existing list responses, so an overview needs no request per
row solely to display its latest deployment.

## Motivation

`ProjectsPage.tsx` and `ServicesPage.tsx` load histories but use their first
deployment for the row's marker and title. Project history can include 1,000
deployments and 2,000 version payloads; service history can include 1,000
markers. Visible, live overview pages repeat these requests every five minutes.

At `4f111c4`, the real project API and decoder returned 344,983 bytes for a
synthetic retained history at those caps, versus 1,113 bytes for three deployments
and six versions. Both selected the same newest ID, time and title. This proves
response growth, not production latency or a predicted saving. The workload is
recorded in [Benchmarks](../../bench/README.md#review-work-counts-2026-11-12).

## Design

- Select the newest retained deployment using the same ordering as the history
  reader, including its behavior for equal timestamps. Read only the version
  metadata referenced by that deployment. A summary must not construct and then
  discard the full history.
- Return the deployment ID, timestamp and the data needed for the existing
  marker title. Preserve split-version labels, percentages and fallback labels
  when version metadata is missing. Service summaries need no host list or
  historical markers solely for the overview.
- Prefer optional summary fields in the existing project/service list
  responses. Define an explicit result for no deployment and for unavailable
  deployment data; neither is an invented timestamp or a healthy state.
- Derive project summaries from retained local data, with no upstream
  Cloudflare request. Keep authentication, target capabilities and service
  ownership unchanged. The Node target continues to have an empty project list.
- Decode the summary at the response boundary and reuse the existing display
  formatter. Keep full-history routes and their detail consumers unchanged.
- Make list refreshes update summaries. If lists gain conditional responses,
  deployment changes must participate in their cache validators. Preserve the
  current visibility, zoom and retained-data rules.

Acceptance compares summary and history output for empty history, one deployment,
equal timestamps, split versions, missing tags and expired markers on both
targets. At the retention caps, prove that overview query rows, decoded payloads
and bytes are bounded by the newest deployment's referenced metadata, and that
the per-row history requests disappear. Detail and comparison pages must still
read the complete history they need.

## Alternatives considered

- **Dedicated summary endpoints.** They avoid changing list response contracts
  and permit independent refresh, but retain one extra request per row unless
  the endpoint batches subjects.
- **A `limit=1` history query.** A small route change, but it must also restrict
  version payloads and still leaves the per-row request fan-out.
- **Client caching alone.** It reduces repeated transfer for unchanged data but
  leaves the initial overfetch and server-side history decoding.

## Open questions

- Extend the existing list contracts or use separate summary routes? Recommend
  list fields because both overview pages already load those lists; choose
  separate routes only if independent refresh or compatibility requires them.
- When summary loading fails, should the whole list fail or carry a per-row
  unavailable result? Recommend a per-row result so host/project inventory
  remains usable and the failure is visible.

## Decision

Accepted 2026-11-13 on the owner's adoption of the two recommendations:

- Extend the existing project/service list responses with optional latest-deployment
  summary fields rather than adding separate summary routes. Overview pages already
  load those lists; the per-row fan-out disappears.
- A summary failure does not fail the list: the list succeeds and carries a per-row
  unavailable result, so host/project inventory remains usable and the failure is
  visible.

Implementation proceeds under STA-118.
