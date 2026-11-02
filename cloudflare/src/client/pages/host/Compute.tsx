import { createMemo, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Psi, SummaryPoint } from "../../api";
import type { ChartPoint } from "../../chart-data";
import { count, percent } from "../../format";
import { LIMITS, loadLimits } from "../../health";
import { cpuUsed } from "../../metrics";
import { TimeChart, type ChartEvent, type VizColor } from "../../components/TimeChart";
import { Notice, Widget } from "../../components/ui";
import { AXIS_WIDTH, PanelLabel, summarySeries, PanelChart } from "./shared";

function psiSeries(points: readonly SummaryPoint[], pick: (pressure: Psi) => number | undefined): ChartPoint[] {
  return points.map(point => ({ atMs: point.atMs, value: point.psi === undefined ? undefined : pick(point.psi) }));
}

function useSeries(points: () => readonly SummaryPoint[]) {
  return (label: string, color: number | VizColor, pick: (point: SummaryPoint) => number | undefined, extra: { readonly dashed?: boolean; readonly scored?: boolean; readonly graded?: boolean } = {}) => ({ label, color, points: summarySeries(points(), pick), ...extra });
}

function ghostOf(yesterday: readonly SummaryPoint[] | null, pick: (point: SummaryPoint) => number | undefined) {
  return yesterday === null || yesterday.length === 0 ? [] : [{ label: "yesterday", color: "ghost" as const, dashed: true, scored: false, points: summarySeries(yesterday, pick) }];
}

export function reportsPressure(points: readonly SummaryPoint[]): boolean {
  return points.some(point => point.psi !== undefined);
}

export function reportsGpu(points: readonly SummaryPoint[]): boolean {
  return points.some(point => point.gpu !== undefined);
}

export function PressureNotice(props: { readonly points: readonly SummaryPoint[] }): JSX.Element {
  return (
    <Show when={!reportsPressure(props.points)}>
      <div id="pressure">
        <Notice>This host's kernel does not report pressure stalls (PSI), so the CPU, memory, and I/O pressure panels are hidden. PSI needs CONFIG_PSI and no psi=0 on the command line.</Notice>
      </div>
    </Show>
  );
}

export function CpuWidget(props: {
  readonly points: readonly SummaryPoint[];
  readonly yesterday: readonly SummaryPoint[] | null;
  readonly stepMs: number;
  readonly events: readonly ChartEvent[];
}): JSX.Element {
  const series = useSeries(() => props.points);
  return (
    <Widget id="cpu" title="CPU" expandable>
      <TimeChart
        label="CPU"
        legend
        area
        timeAxis={!reportsGpu(props.points) && !reportsPressure(props.points)}
        series={[
          series("total", "neutral", cpuUsed, { graded: true }),
          series("user", "blue", point => point.cpu?.user, { scored: false }),
          series("system", "aqua", point => point.cpu?.system, { scored: false }),
          series("iowait", "violet", point => point.cpu?.iowait, { scored: false }),
          series("steal", "magenta", point => point.cpu?.steal, { scored: false }),
          ...ghostOf(props.yesterday, cpuUsed)
        ]}
        format={percent}
        min={0}
        max={100}
        limits={LIMITS.cpuPercent}
        yAxisWidth={AXIS_WIDTH}
        events={props.events}
        stepMs={props.stepMs}
      />
      <Show when={reportsGpu(props.points)}>
        <PanelLabel>GPU busy</PanelLabel>
        <PanelChart
          label="GPU busy"
          area
          timeAxis={!reportsPressure(props.points)}
          series={[{ label: "busy", color: "magenta", scored: false, points: summarySeries(props.points, point => point.gpu?.busyPct) }]}
          format={percent}
          min={0}
          max={100}
          events={props.events}
          stepMs={props.stepMs}
        />
      </Show>
      <Show when={reportsPressure(props.points)}>
        <PanelLabel>CPU pressure, 10 s average</PanelLabel>
        <PanelChart
          label="CPU pressure"
          area
          series={[
            { label: "some", color: "ramp-3", points: psiSeries(props.points, value => value.cpu?.some10) },
            { label: "full", color: "ramp-5", scored: false, points: psiSeries(props.points, value => value.cpu?.full10) }
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

export function LoadWidget(props: {
  readonly points: readonly SummaryPoint[];
  readonly yesterday: readonly SummaryPoint[] | null;
  readonly stepMs: number;
  readonly events: readonly ChartEvent[];
}): JSX.Element {
  const loadScale = createMemo(() => loadLimits(props.points.at(-1)?.cpuCount));
  const series = useSeries(() => props.points);
  return (
    <Widget id="load" title="Load" expandable>
      <TimeChart
        label="Load"
        legend
        area
        series={[
          series("1 min", "ramp-5", point => point.load?.one, { graded: true }),
          series("5 min", "ramp-3", point => point.load?.five, { scored: false }),
          series("15 min", "ramp-1", point => point.load?.fifteen, { scored: false }),
          ...ghostOf(props.yesterday, point => point.load?.one)
        ]}
        format={value => count(value)}
        limits={loadScale()}
        min={0}
        events={props.events}
        stepMs={props.stepMs}
      />
    </Widget>
  );
}
