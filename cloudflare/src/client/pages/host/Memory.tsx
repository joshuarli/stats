import { createMemo, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { bytes, percent, rate } from "../../format";
import type { SummaryTable } from "../../history";
import { LIMITS, memoryUsedLimits } from "../../health";
import { lastCell, memoryUsedBytes } from "../../metrics";
import type { PsiWindow } from "../../psi";
import type { ChartEvent } from "../../components/TimeChart";
import { Widget } from "../../components/ui";
import { PressureChart } from "./Psi";
import { PanelLabel, PanelChart, peakOf } from "./shared";

export function MemoryWidget(props: {
  readonly table: SummaryTable;
  readonly stepMs: number;
  readonly events: readonly ChartEvent[];
  readonly psiWindow: PsiWindow;
}): JSX.Element {
  const total = createMemo(() => lastCell(props.table.cells("mem.total")));
  const limits = createMemo(() => memoryUsedLimits(total()));
  const scale = createMemo(() => {
    const maximum = total();
    if (maximum === undefined || maximum <= 0) return undefined;
    return Math.max(maximum, peakOf(props.table.cells("mem.swapUsed")));
  });
  const reportsPressure = createMemo(() => props.table.has("psi.memory"));
  const reportsPressureLevel = createMemo(() => props.table.has("mem.pressure"));
  return (
    <Widget id="memory" title="Memory" expandable>
      <PanelChart
        label="Memory in use"
        area
        timeAxis={false}
        series={[
          { label: "RAM used", color: "blue", graded: true, track: { times: props.table.times, values: memoryUsedBytes(props.table) } },
          { label: "swap used", color: "violet", scored: false, track: props.table.track("mem.swapUsed") }
        ]}
        format={bytes}
        limits={limits()}
        min={0}
        max={scale()}
        events={props.events}
        stepMs={props.stepMs}
      />
      <PanelLabel>Paging to and from swap</PanelLabel>
      <PanelChart
        label="Swap activity"
        area
        timeAxis={!reportsPressure() && !reportsPressureLevel()}
        series={[
          { label: "swap in", color: "blue", track: props.table.track("mem.swapInBytesPerSec") },
          { label: "swap out", color: "aqua", track: props.table.track("mem.swapOutBytesPerSec") }
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
            { label: "warn or worse", color: "ramp-3", track: props.table.track("mem.pressure.warnPct") },
            { label: "critical", color: "ramp-5", scored: false, track: props.table.track("mem.pressure.criticalPct") }
          ]}
          format={percent}
          limits={LIMITS.memoryPressureWarnPercent}
          min={0}
          events={props.events}
          stepMs={props.stepMs}
        />
      </Show>
      <Show when={reportsPressure()}>
        <PressureChart label="Memory pressure" table={props.table} group="memory" window={props.psiWindow} stepMs={props.stepMs} events={props.events} />
      </Show>
    </Widget>
  );
}
