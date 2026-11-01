import { createMemo, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { SummaryPoint } from "../../api";
import { bytes, percent, rate } from "../../format";
import { LIMITS, memoryUsedLimits } from "../../health";
import { TimeChart, type ChartEvent } from "../../components/TimeChart";
import { Widget } from "../../components/ui";
import { AXIS_WIDTH, PanelLabel, summarySeries } from "./shared";

export function MemoryWidget(props: { readonly points: readonly SummaryPoint[]; readonly stepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  const total = createMemo(() => props.points.at(-1)?.mem?.total);
  const limits = createMemo(() => memoryUsedLimits(total()));
  const reportsPressure = createMemo(() => props.points.some(point => point.psi?.memory !== undefined));
  const used = (point: SummaryPoint) => (point.mem === undefined ? undefined : point.mem.total - point.mem.available);
  return (
    <Widget id="memory" title="Memory" subtitle="RAM in use against total, swap, paging, and stalls" expandable>
      <PanelLabel>RAM and swap in use</PanelLabel>
      <TimeChart
        label="Memory in use"
        compact
        area
        legend="inline"
        timeAxis={false}
        yAxisWidth={AXIS_WIDTH}
        series={[
          { label: "RAM used", color: "neutral", graded: true, points: summarySeries(props.points, used) },
          { label: "swap used", color: "violet", scored: false, points: summarySeries(props.points, point => point.mem?.swapUsed) }
        ]}
        format={bytes}
        limits={limits()}
        min={0}
        max={total()}
        events={props.events}
        stepMs={props.stepMs}
      />
      <PanelLabel>Paging to and from swap</PanelLabel>
      <TimeChart
        label="Swap activity"
        compact
        area
        legend="inline"
        timeAxis={!reportsPressure()}
        yAxisWidth={AXIS_WIDTH}
        series={[
          { label: "swap in", color: "blue", points: summarySeries(props.points, point => point.mem?.swapInBytesPerSec) },
          { label: "swap out", color: "aqua", points: summarySeries(props.points, point => point.mem?.swapOutBytesPerSec) }
        ]}
        format={rate}
        limits={LIMITS.swapBytesPerSec}
        min={0}
        events={props.events}
        stepMs={props.stepMs}
      />
      <Show when={reportsPressure()}>
        <PanelLabel>Memory pressure (PSI some)</PanelLabel>
        <TimeChart
          label="Memory pressure"
          compact
          area
          legend="inline"
          yAxisWidth={AXIS_WIDTH}
          series={[
            { label: "10s", color: "ramp-5", points: summarySeries(props.points, point => point.psi?.memory?.some10) },
            { label: "5m", color: "ramp-1", scored: false, points: summarySeries(props.points, point => point.psi?.memory?.some300) }
          ]}
          format={percent}
          limits={LIMITS.pressureSome}
          min={0}
          events={props.events}
          stepMs={props.stepMs}
        />
      </Show>
    </Widget>
  );
}
