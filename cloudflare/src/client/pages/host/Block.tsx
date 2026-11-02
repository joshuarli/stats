import { createMemo } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { BlockSeries } from "../../api";
import { count, microseconds } from "../../format";
import { LIMITS } from "../../health";
import { TimeChart, type ChartEvent } from "../../components/TimeChart";
import { EmptyState, Widget } from "../../components/ui";

export function BlockWidget(props: { readonly series: readonly BlockSeries[]; readonly stepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  const points = createMemo(() => props.series.at(0)?.points ?? []);
  const last = createMemo(() => points().at(-1));
  return (
    <Widget
      id="block"
      title="Block latency"
      meta={last() === undefined ? undefined : <span class="widget-latest">{count(last()?.count)} completions · p50 {microseconds(last()?.p50Us)}</span>}
      expandable
    >
      {points().length === 0 ? (
        <EmptyState title="No block latency samples in this range." detail="The optional probe is not configured or reported no completions." icon="disk" />
      ) : (
        <TimeChart
          label="Block latency"
          legend
          series={[
            { label: "min", color: "ramp-1", scored: false, points: points().map(point => ({ atMs: point.atMs, value: point.minUs })), dashed: true },
            { label: "p50", color: "ramp-2", scored: false, points: points().map(point => ({ atMs: point.atMs, value: point.p50Us })) },
            { label: "p95", color: "ramp-3", scored: false, points: points().map(point => ({ atMs: point.atMs, value: point.p95Us })) },
            { label: "p99", color: "ramp-4", points: points().map(point => ({ atMs: point.atMs, value: point.p99Us })) },
            { label: "max", color: "ramp-5", scored: false, points: points().map(point => ({ atMs: point.atMs, value: point.maxUs })), dashed: true }
          ]}
          limits={LIMITS.blockP99Us}
          format={microseconds}
          min={0}
          events={props.events}
          stepMs={props.stepMs}
        />
      )}
    </Widget>
  );
}

export function BlockCompletionsWidget(props: { readonly series: readonly BlockSeries[]; readonly stepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  const points = createMemo(() => props.series.at(0)?.points ?? []);
  return (
    <Widget title="Block completions" expandable>
      {points().length === 0 ? (
        <EmptyState title="No block latency samples in this range." icon="disk" />
      ) : (
        <TimeChart label="Block completions" legend area series={[{ label: "completions", color: "blue", points: points().map(point => ({ atMs: point.atMs, value: point.count })) }]} format={count} min={0} events={props.events} stepMs={props.stepMs} />
      )}
    </Widget>
  );
}
