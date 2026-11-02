import { createMemo, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { SummaryPoint } from "../../api";
import { bytes, percent, rate } from "../../format";
import { LIMITS, memoryUsedLimits } from "../../health";
import type { ChartEvent } from "../../components/TimeChart";
import { Widget } from "../../components/ui";
import { PanelLabel, summarySeries, PanelChart } from "./shared";

export function MemoryWidget(props: { readonly points: readonly SummaryPoint[]; readonly stepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  const total = createMemo(() => props.points.at(-1)?.mem?.total);
  const limits = createMemo(() => memoryUsedLimits(total()));
  const reportsPressure = createMemo(() => props.points.some(point => point.psi?.memory !== undefined));
  const reportsPressureLevel = createMemo(() => props.points.some(point => point.mem?.pressure !== undefined));
  const used = (point: SummaryPoint) => (point.mem === undefined ? undefined : point.mem.total - point.mem.available);
  return (
    <Widget id="memory" title="Memory" expandable>
      <PanelChart
        label="Memory in use"
        area
        timeAxis={false}
        series={[
          { label: "RAM used", color: "neutral", graded: true, points: summarySeries(props.points, used) },
          { label: "swap used", color: "violet", scored: false, points: summarySeries(props.points, point => point.mem?.swapUsed) }
        ]}
        format={bytes}
        limits={limits()}
        min={0}
        events={props.events}
        stepMs={props.stepMs}
      />
      <PanelLabel>Paging to and from swap</PanelLabel>
      <PanelChart
        label="Swap activity"
        area
        timeAxis={!reportsPressure() && !reportsPressureLevel()}
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
      <Show when={reportsPressureLevel()}>
        <PanelLabel>Share of time under memory pressure</PanelLabel>
        <PanelChart
          label="Memory pressure level"
          area
          timeAxis={!reportsPressure()}
          series={[
            { label: "warn or worse", color: "ramp-3", points: summarySeries(props.points, point => point.mem?.pressure?.warnPct) },
            { label: "critical", color: "ramp-5", scored: false, points: summarySeries(props.points, point => point.mem?.pressure?.criticalPct) }
          ]}
          format={percent}
          limits={LIMITS.memoryPressureWarnPercent}
          min={0}
          events={props.events}
          stepMs={props.stepMs}
        />
      </Show>
      <Show when={reportsPressure()}>
        <PanelLabel>Memory pressure, 10 s average</PanelLabel>
        <PanelChart
          label="Memory pressure"
          area
          series={[
            { label: "some", color: "ramp-3", points: summarySeries(props.points, point => point.psi?.memory?.some10) },
            { label: "full", color: "ramp-5", scored: false, points: summarySeries(props.points, point => point.psi?.memory?.full10) }
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
