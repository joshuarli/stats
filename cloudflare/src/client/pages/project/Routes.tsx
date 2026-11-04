import { createMemo, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TimeWindow } from "../../chart-data";
import { count, milliseconds, percent } from "../../format";
import { Widget } from "../../components/ui";
import { Waterfall, WaterfallSummary, type WaterfallRow } from "../../components/Waterfall";
import { stack } from "../../waterfall";
import { PanelLabel, PanelChart } from "../host/shared";
import { durableObjectCpuAverage, durableObjectWallAverage, provisionalFromMs, routeRows, type ProjectData } from "./series";
import { metricTrack } from "../../history";

export function RoutesWidget(props: { readonly data: ProjectData; readonly view: TimeWindow | null }): JSX.Element {
  const rows = createMemo(() => routeRows(props.data.routes, props.view));
  const totalCpu = () => rows().reduce((sum, row) => sum + row.cpuMs, 0);
  const invocations = () => rows().reduce((sum, row) => sum + row.invocations, 0);
  const waterfallRows = createMemo((): WaterfallRow[] => {
    const extents = stack(rows().map(row => row.cpuMs));
    return rows().map((row, index) => ({
      id: row.route,
      label: row.route,
      tag: index === 0 && rows().length > 1 && totalCpu() > 0 ? "TOP" : undefined,
      from: extents[index]?.from ?? 0,
      to: extents[index]?.to ?? 0,
      color: 0,
      values: [percent(row.cpuShare), milliseconds(row.averageMs), count(row.invocations)]
    }));
  });
  return (
    <Widget id="routes" class="wide" title="CPU by route" bodyClass={rows().length > 0 ? "flush wf-body" : undefined} expandable>
      <Show when={rows().length > 0} fallback={<PanelLabel>No route data was collected in this range</PanelLabel>}>
        <WaterfallSummary stats={[
          { label: "Total CPU", value: milliseconds(totalCpu()) },
          { label: "Invocations", value: count(invocations()) },
          { label: "Hottest route", value: rows()[0]?.route ?? "—", note: percent(rows()[0]?.cpuShare) }
        ]} />
        <Waterfall
          label="CPU time by route"
          stepLabel="Route"
          columns={["Share", "Average", "Invocations"]}
          axis={{ from: 0, to: totalCpu() > 0 ? totalCpu() : 1, format: milliseconds }}
          rows={waterfallRows()}
        />
      </Show>
    </Widget>
  );
}

export function DurableObjectsWidget(props: { readonly data: ProjectData }): JSX.Element {
  const history = () => props.data.durableObjects;
  return (
    <Widget id="durable-objects" title="Durable Objects" expandable>
      {history() === undefined ? null : (
        <>
          <PanelChart
            label="Durable Object invocations"
            series={[
              { label: "invocations", color: "blue", scored: false, track: metricTrack(history()!, "do.invocations") },
              { label: "errors", color: "critical", scored: false, track: metricTrack(history()!, "do.errors") }
            ]}
            format={count}
            min={0}
            stepMs={history()!.stepMs}
            provisionalFromMs={provisionalFromMs(history()!)}
          />
          <PanelLabel>Average CPU time (100+ invocations)</PanelLabel>
          <PanelChart
            label="Durable Object average CPU time"
            area
            series={[{ label: "average", color: "blue", scored: false, track: durableObjectCpuAverage(history()!) }]}
            format={milliseconds}
            min={0}
            stepMs={history()!.stepMs}
            provisionalFromMs={provisionalFromMs(history()!)}
          />
          <PanelLabel>Max CPU time</PanelLabel>
          <PanelChart
            label="Durable Object maximum CPU time"
            series={[{ label: "maximum", color: "violet", scored: false, track: metricTrack(history()!, "do.cpuMsMax") }]}
            format={milliseconds}
            min={0}
            stepMs={history()!.stepMs}
            provisionalFromMs={provisionalFromMs(history()!)}
          />
          <PanelLabel>Average wall time</PanelLabel>
          <PanelChart
            label="Durable Object average wall time"
            series={[{ label: "average", color: "aqua", scored: false, track: durableObjectWallAverage(history()!) }]}
            format={milliseconds}
            min={0}
            stepMs={history()!.stepMs}
            provisionalFromMs={provisionalFromMs(history()!)}
          />
        </>
      )}
    </Widget>
  );
}
