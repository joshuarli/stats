# Browser journey measurement

The browser now measures overview navigation, range changes and refreshes
through actual chart draws. Each of the three charts must draw the current
series before completion is recorded at the next animation frame. Empty
overviews complete after their empty state renders. Interrupted and failed
reads have distinct outcomes.

Measurements are emitted as `stats:project-journey` DOM events. The frontend
does not retain an observation history or publish those events to Stats yet.
The native HTTP event retains the validated trace identity sent with its read.
The native regression verifies that identity and SQL timing in stored events.
The campaign's delivered-journey attribution goal remains open until browser
delivery and coverage checks are implemented.

## Measurement overhead

The baseline uses the exact frontend entry assets served by production
`stats:434ea6ed31f5`. The candidate adds journey measurement. Both use private
loopback asset servers and read-only HTTPS forwarding to Lisa. The harness
checks identical historical summary response hashes across variants. It bounds
the view to the captured data extent to avoid the moving retention boundary.
No captured event is omitted from that extent.

The source capture has 20,395 events and SHA-256
`4ef33788757e84e614b35dd2509a942987b7e5350d634bc327a4055d5dd3e006`.
Raw events remain in protected Mac storage. This comparison tests cached
selection rendering. It does not establish full-retention query, cold-read,
remote-asset navigation or tenfold-data acceptance.

Five interleaved rounds per variant each contain 200 interactions. Each of
the five range selections has 200 samples per variant. Every interaction
requires the expected counters, three completed charts and no summary fetch.
Both timing gates pass. There are zero failures and 1,000 completed candidate
journey measurements, in addition to five warmup journeys.

| Measurement | Baseline | Candidate |
| --- | --- | --- |
| Median cached interaction | 33.3 ms | 33.3 ms |
| p95 cached interaction | 34.0 ms | 33.9 ms |
| p99 cached interaction | 34.3 ms | 34.3 ms |
| Allocated asset-directory bytes | 888,832 | 892,928 |
| Observed browser heap range | 4,938,943–7,984,378 bytes | 7,912,497–11,971,172 bytes |

There is no measurable timing difference. Heap samples include the benchmark's
retained results and are not forced-GC retention evidence. They do not satisfy
the campaign's resource-soak goal. Asset-directory allocation is not compressed
wire size. The result rows are in `browser.json`.

## Repeat the comparison

Supply separate immutable frontend asset directories and protected metadata:

```sh
node bench/project-browser.mjs \
  --baseline "$BASELINE_ASSETS" --candidate "$CANDIDATE_ASSETS" \
  --origin https://stats.17166969.xyz --metadata "$CORPUS_METADATA" \
  --output .work/tmp/project-browser.json --per-range 200
```

`--per-range 5` exercises the harness but marks sample coverage inadequate.
The baseline entry must match production. The proxy accepts read-only routes,
publishes only loopback listeners and removes its owned browser sessions on
exit. Changed historical responses fail the comparison.
