# Slow journey attribution

Verdict: all 17 delivered journeys over one second in the captured release
cohort have complete, paired timing evidence. This establishes 100% observed
coverage for that cohort, above P4's 99% threshold. It does not establish a
population guarantee or lossless telemetry delivery.

The read-only capture contains 13,828 events over a two-hour window, ending
five minutes before capture to allow delivery to settle. Event count equals
the summary count. Raw events stay in protected storage. [capture.json](capture.json)
identifies the window, count and checksum. The analysis selects release
`stats-1ea3e6af2dc3` and completed browser journeys lasting more than one second.
Cancelled and failed outcomes remain eligible; absent phases reduce coverage.
There are no eligible cached journeys in this cohort.

Each read journey must match a stored `http.get.application-summary` event by
trace and span IDs. All six shared server phase values must equal those in that
HTTP event. The analysis requires complete browser phases, coherent nested
server boundaries and accounted elapsed time within 2 ms of producer rounding
and measurement overhead. The negative controls reject missing pairs, altered
server timings, absent cancelled-request phases and contradictory durations.
An empty cohort cannot pass.

[coverage.json](coverage.json) reports seven journeys dominated by aggregate SQL,
five by the actor-call interval outside the handler, three by the fetch interval
outside server timing, and two by dispatch outside the actor call. These are
timing boundaries. They do not identify a network, scheduler or storage cause.
Nested intervals are decomposed rather than added together.

```sh
node bench/capture-application-corpus.mjs \
  --origin https://stats.17166969.xyz --hours 2 \
  --output PRIVATE_DIRECTORY/journeys.json
node bench/journey-coverage.mjs --input PRIVATE_DIRECTORY/journeys.json \
  --release stats-1ea3e6af2dc3 --output .work/tmp/coverage.json
node --test bench/journey-coverage.test.mjs
```

All commands exit 0; four regression tests pass. This is an attribution check,
not a latency comparison or evidence of telemetry that was never delivered.
