import { createMemo } from "solid-js";
import type { JSX } from "@solidjs/web";
import { count, microseconds } from "../../format";
import type { BlockSeries } from "../../history";
import { LIMITS } from "../../health";
import { lastCell } from "../../metrics";
import { TimeChart, type ChartEvent } from "../../components/TimeChart";
import { EmptyState, Widget } from "../../components/ui";

export function BlockWidget(props: { readonly series: readonly BlockSeries[]; readonly stepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  const table = createMemo(() => props.series.at(0)?.table);
  const rows = () => table()?.rows ?? 0;
  const lastAt = (field: "count" | "p50Us") => (rows() === 0 ? undefined : lastCell(table()!.cells(field)));
  return (
    <Widget
      id="block"
      title="Block latency"
      meta={rows() === 0 ? undefined : <span class="widget-latest">{count(lastAt("count"))} completions · p50 {microseconds(lastAt("p50Us"))}</span>}
      expandable
    >
      {rows() === 0 ? (
        <EmptyState title="No block latency samples in this range." detail="The optional probe is not configured or reported no completions." icon="disk" />
      ) : (
        <TimeChart
          label="Block latency"
          legend
          series={[
            { label: "min", color: "ramp-1", scored: false, track: table()!.track("minUs"), dashed: true },
            { label: "p50", color: "ramp-2", scored: false, track: table()!.track("p50Us") },
            { label: "p95", color: "ramp-3", scored: false, track: table()!.track("p95Us") },
            { label: "p99", color: "ramp-4", track: table()!.track("p99Us") },
            { label: "max", color: "ramp-5", scored: false, track: table()!.track("maxUs"), dashed: true }
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
  const table = createMemo(() => props.series.at(0)?.table);
  return (
    <Widget id="block-completions" title="Block completions" expandable>
      {(table()?.rows ?? 0) === 0 ? (
        <EmptyState title="No block latency samples in this range." icon="disk" />
      ) : (
        <TimeChart label="Block completions" legend area series={[{ label: "completions", color: "blue", track: table()!.track("count") }]} format={count} min={0} events={props.events} stepMs={props.stepMs} />
      )}
    </Widget>
  );
}
