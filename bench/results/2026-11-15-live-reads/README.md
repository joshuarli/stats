# Live awake range acceptance

Verdict: the awake portion of P2 passes on production image
`stats:1ea3e6af2dc3`, Orange node version 20. The selected deployment is verified
before and after the run. All four Mac and Lisa timing gates exit 0.

| Range | Successful selections | Click to complete p95 | p99 |
| --- | ---: | ---: | ---: |
| 1h | 200 | 146.1 ms | 226.0 ms |
| 6h | 200 | 300.4 ms | 370.8 ms |
| 24h | 200 | 364.1 ms | 432.1 ms |
| 7d | 200 | 375.2 ms | 426.9 ms |

[accepted.json](accepted.json) contains every sample and phase. There are no
failed samples, error journeys, cancellations or unsettled summary requests.
The browser, viewport and exact responses' time bounds are recorded. This is
one authorized Mac client over the normal production tailnet route, with
production self-observation enabled and the current live corpus.

Every sample unmounts the project, selects a seed range, then follows the real
Stats project link. The seed completes immediately before the target selection,
establishing an awake actor. Remounting resets the client summary map. The target
must emit an uncached journey and make a real summary read. Completion requires
three current charts, matching returned bounds and matching displayed counts.
Requested bounds are exact except for the documented seven-day retention clamp.
Response clones are parsed independently of the application's fetch return.
The observer captures completion at the real chart-ready event, then waits for
all summary requests to settle before serializing teardown evidence.

Five rounds interleave forty samples per range. No cache hits substitute for
reads. This does not prove actor-sleep, disk-cold, initial-document navigation
or tenfold acceptance. Ordinary server page-cache reuse is retained.

```sh
node bench/live-project-browser.mjs --per-range 5 \
  --output .work/tmp/live-smoke.json
node bench/live-project-browser.mjs --per-range 200 \
  --output .work/tmp/live-accepted.json
```

Both commands and both scripts' `node --check` commands exit 0. The smoke run
is explicitly inadequate for percentile acceptance. Output files are exclusive.

Earlier artifacts remain excluded: `smoke.json` fails response validation;
`full.json` stops at a cancelled seed navigation; `full-corrected.json` completes
800 selections but fails Lisa's post-run timing gate and omits one pending read's
eventual state. Their invalid flags remain intact. The accepted probe retains
intermediate outcomes, validates final renders and settles all reads. Failed
trials are not silently removed from the campaign record.
