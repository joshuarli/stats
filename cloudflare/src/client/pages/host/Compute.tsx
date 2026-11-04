import { createMemo, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Cells } from "../../columns";
import { count, percent } from "../../format";
import type { SummaryTable } from "../../history";
import { LIMITS, loadLimits } from "../../health";
import { cpuUsed, lastCell } from "../../metrics";
import type { PsiWindow } from "../../psi";
import { TimeChart, type ChartEvent, type VizColor } from "../../components/TimeChart";
import { Notice, Widget } from "../../components/ui";
import { PressureChart } from "./Psi";
import { AXIS_WIDTH, PanelLabel, PanelChart } from "./shared";

interface SeriesExtra {
  readonly dashed?: boolean;
  readonly scored?: boolean;
  readonly graded?: boolean;
}

function useSeries(table: () => SummaryTable) {
  return (label: string, color: number | VizColor, cells: Cells, extra: SeriesExtra = {}) => ({ label, color, track: { times: table().times, values: cells }, ...extra });
}

export function reportsPressure(table: SummaryTable): boolean {
  return table.has("psi");
}

export function reportsGpu(table: SummaryTable): boolean {
  return table.has("gpu");
}

export function PressureNotice(props: { readonly table: SummaryTable }): JSX.Element {
  return (
    <Show when={!reportsPressure(props.table)}>
      <div id="pressure">
        <Notice>This host's kernel does not report pressure stalls (PSI), so the CPU, memory, and I/O pressure panels are hidden. PSI needs CONFIG_PSI and no psi=0 on the command line.</Notice>
      </div>
    </Show>
  );
}

export function CpuWidget(props: {
  readonly table: SummaryTable;
  readonly stepMs: number;
  readonly events: readonly ChartEvent[];
  readonly psiWindow: PsiWindow;
}): JSX.Element {
  const series = useSeries(() => props.table);
  const chartSeries = createMemo(() => [
    series("total", "blue", cpuUsed(props.table), { graded: true }),
    series("user", "aqua", props.table.cells("cpu.user"), { scored: false }),
    series("system", "violet", props.table.cells("cpu.system"), { scored: false }),
    series("iowait", "magenta", props.table.cells("cpu.iowait"), { scored: false }),
    series("steal", "ghost", props.table.cells("cpu.steal"), { scored: false })
  ]);
  return (
    <Widget id="cpu" title="CPU" expandable>
      <TimeChart
        label="CPU"
        legend
        area
        timeAxis={!reportsGpu(props.table) && !reportsPressure(props.table)}
        series={chartSeries}
        format={percent}
        min={0}
        max={100}
        limits={LIMITS.cpuPercent}
        yAxisWidth={AXIS_WIDTH}
        events={props.events}
        stepMs={props.stepMs}
      />
      <Show when={reportsGpu(props.table)}>
        <PanelLabel>GPU busy</PanelLabel>
        <PanelChart
          label="GPU busy"
          area
          timeAxis={!reportsPressure(props.table)}
          series={[{ label: "busy", color: "magenta", scored: false, track: props.table.track("gpu.busyPct") }]}
          format={percent}
          min={0}
          max={100}
          events={props.events}
          stepMs={props.stepMs}
        />
      </Show>
      <Show when={reportsPressure(props.table)}>
        <PressureChart label="CPU pressure" table={props.table} group="cpu" window={props.psiWindow} stepMs={props.stepMs} events={props.events} />
      </Show>
    </Widget>
  );
}

export function LoadWidget(props: {
  readonly table: SummaryTable;
  readonly stepMs: number;
  readonly events: readonly ChartEvent[];
}): JSX.Element {
  const loadScale = createMemo(() => loadLimits(lastCell(props.table.cells("cpuCount"))));
  const series = useSeries(() => props.table);
  const chartSeries = createMemo(() => [
    series("1 min", "ramp-5", props.table.cells("load.one"), { graded: true }),
    series("5 min", "ramp-3", props.table.cells("load.five"), { scored: false }),
    series("15 min", "ramp-1", props.table.cells("load.fifteen"), { scored: false })
  ]);
  return (
    <Widget id="load" title="Load" expandable>
      <TimeChart
        label="Load"
        legend
        area
        series={chartSeries}
        format={value => count(value)}
        limits={loadScale()}
        min={0}
        yAxisWidth={AXIS_WIDTH}
        events={props.events}
        stepMs={props.stepMs}
      />
    </Widget>
  );
}
