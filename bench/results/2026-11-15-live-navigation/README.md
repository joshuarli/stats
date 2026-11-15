# Live initial-document navigation

Verdict: P3 passes for the current production corpus and default 1h view on
`stats:9eabfbe5cce3`, Orange node version 22. All four Mac/Lisa timing gates pass.

| Navigation start to | Samples | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
| Useful health | 200 | 150.7 ms | 374.3 ms | 571.1 ms |
| Complete charts | 200 | 151.3 ms | 374.3 ms | 571.2 ms |

[accepted.json](accepted.json) records all 200 distinct document identities,
navigation timing, response bytes, resource bytes, browser build, viewport,
response bounds and journey phases. Every sample navigates from `about:blank`
to the real production project URL. The document navigation type is `navigate`.
No client summary map survives. A real uncached response must match rendered
counts and bounds; all three charts must complete. Every request settles without
an error or cancellation. None of the chart completions exceeds one second.

Timing starts at the browser's navigation origin, including response and asset
loading, bootstrap, the summary request and rendering. The first document
transfers 508,631 resource bytes and completes charts in 766.9 ms. Subsequent
documents use the normal HTTP asset cache; it is not cleared. The actor is awake.
This does not prove 200 cold-asset loads, actor-sleep or tenfold acceptance.

The [five-document smoke](smoke.json) validates the protocol without claiming
percentile acceptance. The [earlier invalid probe](invalid-reused-document.json)
detects the browser CLI reusing an already open URL. Its duplicate document
identities invalidate that trial. Moving through `about:blank` ensures that the
accepted run measures real new documents rather than rereading an old result.

```sh
node bench/project-navigation.mjs --samples 200 \
  --image stats:9eabfbe5cce3 --version 22 \
  --output .work/tmp/navigation.json
```

The driver and browser probe pass `node --check`; the accepted command exits 0.
The selected image is checked before and after collection. Output creation is
exclusive, interruption invalidates a run, and the owned browser closes on exit.
