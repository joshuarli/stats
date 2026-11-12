# STA-105: Preserve project coverage through aggregation

Status: conservative alternative implemented

## Summary

Carry per-meter measured duration alongside project values from five-minute
history through hourly storage, response frames and cost reports. A coarse
value must not imply that every constituent interval was measured. Prefer
keeping the known subtotal with explicit partial coverage; withhold a projection
when its denominator cannot be established.

## Motivation

At `9095d85`, project history groups rows into `sum`, `max` and `min`, then
emits an ordinary number whenever a grouped row exists. `coveredMs` credits
every non-null cell with the full response `stepMs`. Hourly storage also keeps
the aggregate value without its constituent coverage.

A local fixture stores one Worker sample in each fifteen-minute interval for
seven days, with two unknown five-minute intervals between samples. The fine
read returns `[10, null, null]`. The actual SQLite reader, history encoder,
client decoder and report builder produce a fifteen-minute history with
604,800,000 ms of claimed coverage, fraction 1 and `verified` confidence. The
known fraction is one third, and no partial-meter warning appears. Changing
resolution has changed the meaning of the evidence.

## Design

1. **Represent value and coverage separately.** A measured cell carries its
   value and known duration within the interval; missing evidence is explicit.
   Enforce `0 <= coveredMs <= intervalMs`. Define a shared typed representation
   for known zero, partial data and unknown coverage. The existing metric
   aggregation rule still decides whether values sum, take a maximum or take a
   minimum; coverage is not inferred from the resulting number.
2. **Establish coverage at the finest reliable boundary.** A stored measured
   five-minute bucket supplies its measured interval under the current collector
   contract. A missing counter bucket becomes a known zero only when the
   existing successful-run and settle-window rules establish that fact. Failed
   collection, unqueried sources and unretained evidence remain unknown.
   Define storage-gauge hold-forward coverage separately from counter coverage;
   selecting the latest storage observation is STA-106, not a reason to invent
   new measurements while carrying a gauge forward.
3. **Aggregate without increasing evidence.** Combine constituent measured
   durations without double counting retries or overlapping collection windows.
   Preserve per-meter coverage when rebuilding hourly rows after backfill.
   A fifteen-minute group with one measured five-minute cell has 300,000 ms of
   coverage, not 900,000 ms. Window clipping must not credit time outside the
   requested interval. Coverage across several meters needs their actual
   interval relationship; summing durations or taking a maximum alone cannot
   establish their union or intersection.
   Persist coverage changes even when the numeric aggregate is unchanged or a
   successful run returns no points. Establish newly known idle intervals in
   the same transaction as the run evidence; value-equality shortcuts must
   compare coverage too, before collector-run evidence can expire.
4. **Persist and transmit the distinction.** Add coverage to hourly storage
   and carry it through the project-history representation, binary frame,
   decoder and ledger input. Choose the smallest representation that preserves
   the required interval relationships. Review frame/schema compatibility and
   revisioning before shipping; old clients must not silently interpret partial
   data as complete. Deploy compatible readers before enabling new responses.
   Keep the history point limit and columnar representation, verify both
   targets, and make coverage/format changes participate in cache validation;
   an incompatible cached representation must not receive a successful `304`.
5. **Use the evidence in reports.** Normalize a meter by its measured duration,
   and propagate partial/unknown coverage to confidence, warnings and comparison
   readiness. Retain observed subtotals without presenting them as whole-window
   totals. The dashboard and `statsctl` must use the same rule. State explicitly
   which partial projections are estimates and which are unavailable.
6. **Migrate conservatively.** Recompute retained hourly rows where fine data
   and collector evidence still establish coverage. For older rows, preserve
   the value with unknown coverage or make the affected estimate unavailable;
   do not backfill full coverage from row existence. This proposal does not
   extend the documented collector-run retention window.

Acceptance should repeat the existing end-to-end proof at five-minute,
fifteen-minute, hourly and three-hour resolutions, including a retention-tier
boundary. Changing resolution must not upgrade one-third coverage to complete.
Include known idle zeros, late backfill, different coverage for different meters,
window-edge clipping, retries, a successful empty run that increases coverage
without changing the subtotal, and old hourly rows with no coverage metadata.
Verify both report consumers and incompatible frame/schema handling.

## Alternatives considered

- **Conservatively omit incomplete coarse values.** A smaller immediate change
  can return unavailable or partial when all constituent coverage cannot be
  proved. It loses usable subtotals but is preferable to a verified estimate
  built on an invented full interval. Hourly legacy data still needs a policy.
- **Always serve fine history.** It avoids one aggregation boundary only while
  fine rows exist, increases response sizes, and does not solve persisted hourly
  history or the existing point limits.
- **Change report wording only.** Insufficient while the numerical coverage
  and normalization denominator remain wrong.

## Open questions

- Should partial history support an explicitly qualified projection, or should
  the first fix withhold it? Recommend qualified estimates only with a known
  denominator and an explicit completeness warning.
- Is measured duration enough for each consumer, or is a compact constituent
  coverage mask needed to combine meters and clip windows correctly?
- Which history/schema revision and rollout sequence prevent older consumers
  from silently losing the new distinction?

## Decision

Use the conservative alternative. A coarse value is available only when every
constituent fine cell exists for that meter, or retained successful collector
runs establish every constituent counter interval, including known idle zeros.
Legacy hourly values have no constituent evidence. They remain unavailable
unless retained collector evidence establishes the complete counter interval.
Partial values remain stored, but do not enter frames or cost projections as
full intervals. A new project history ETag namespace invalidates old cached
representations. The frame format and both consumers remain unchanged.

Explicit partial subtotals and durable coverage masks remain a possible future
protocol change. They are not required to prevent false verified coverage.
