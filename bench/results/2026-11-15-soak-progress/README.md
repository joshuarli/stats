# Soak analysis preparation

At 2026-11-15 19:10–19:13 UTC, the original sampler PID 3384 remained live
on Lisa. Read-only inspection found 152 collected samples of 1,441 planned.
The protected series remains at
`/home/josh/.work/stats-perf-campaign/maintained-rollup-soak-v2.jsonl`.
It was not copied out, stopped or duplicated.

The series already contains unavailable measurements: actor-list requests
returned HTTP 503 at indices 1, 3, 10, 14, 23, 25, 37, 39, 48, 59, 66, 71,
80, 87, 102, 109, 117, 118, 123, 131, 138, 140 and 150. The application
health group timed out at index 30. These invalidate a passing W6 result
under the campaign's requirement of no unavailable groups. Initial successful
probe samples were not evidence that the complete series stayed available.
No plateau result is claimed.

Stuff STUF-88 (P2, assumed) tracks inventory availability and the preserved
sample failures. Stats STA-128 (P2, assumed) retains the separate P7 overhead
study blocked by the incomplete fixture. Both tickets are committed and
pushed in their owning repositories.

The current sampler must still finish untouched. After the deadline, verify
its terminal record and absence of its process before considering W6's one
allowed invalidation restart with a fresh output path. Preserve this series.
Do not silently drop unavailable samples or change the acceptance rule.

`bench/analyze-native-soak.py` reads the series without runtime dependencies.
It checks completion, sequence, duration, restarts, unavailable groups,
truncated actor lists and delayed samples. It discards the first six hours,
compares RSS medians for hours 6–12 against hours 12–24, and reports hourly
queue and actor-count medians over the final twelve hours. A positive linear
slope of hourly medians conservatively leaves a trend unresolved; it does
not establish a plateau. This introduces no tolerance that could hide growth.
Traffic counter regressions remain explicit. Retained database size and
traffic deltas are reported alongside resource figures. Existing queue and
lifecycle coverage gaps prevent an overall pass even if measured metrics
meet their bounds.

The output binds its input bytes with SHA-256 and is created exclusively.
Run it on Lisa with read access to the protected file, using a fresh output:

```sh
doas python3 /home/josh/.work/stats-perf-campaign/analyze-native-soak.py \
  /home/josh/.work/stats-perf-campaign/maintained-rollup-soak-v2.jsonl \
  --output /home/josh/.work/stats-perf-campaign/soak-final-analysis.json
```

Six regression tests pass via
`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bench -p test_analyze_native_soak.py`.
They cover incomplete collection, unavailable groups, missing samples,
restarts, warmup exclusion, the RSS bound, growing queues and actor counts,
counter regressions and explicit coverage gaps. A partial-series invocation
on Lisa correctly reports blocked, with no timing or plateau acceptance.
