import { createMemo, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Psi, SummaryPoint } from "../../api";
import type { ChartPoint } from "../../chart-data";
import { count, percent } from "../../format";
import { LIMITS, loadLimits } from "../../health";
import { cpuUsed } from "../../metrics";
import { TimeChart, type ChartEvent, type VizColor } from "../../components/TimeChart";
import { EmptyState, Notice, Widget } from "../../components/ui";
import { summarySeries } from "./shared";

function psiSeries(points: readonly SummaryPoint[], pick: (pressure: Psi) => number | undefined): ChartPoint[] {
  return points.map(point => ({ atMs: point.atMs, value: point.psi === undefined ? undefined : pick(point.psi) }));
}

export function ComputeWidgets(props: {
  readonly points: readonly SummaryPoint[];
  readonly yesterday: readonly SummaryPoint[] | null;
  readonly stepMs: number;
  readonly events: readonly ChartEvent[];
}): JSX.Element {
  const loadScale = createMemo(() => loadLimits(props.points.at(-1)?.cpuCount));
  const reportsPressure = createMemo(() => props.points.some(point => point.psi !== undefined));
  const series = (label: string, color: number | VizColor, pick: (point: SummaryPoint) => number | undefined, extra: { readonly dashed?: boolean; readonly scored?: boolean; readonly graded?: boolean } = {}) => ({ label, color, points: summarySeries(props.points, pick), ...extra });
  const ghost = (pick: (point: SummaryPoint) => number | undefined) => (props.yesterday === null || props.yesterday.length === 0 ? [] : [{ label: "yesterday", color: "ghost" as const, dashed: true, scored: false, points: summarySeries(props.yesterday, pick) }]);
  return (
    <Show
      when={props.points.length > 0}
      fallback={
        <Widget title="Samples" subtitle="No accepted observations for this range">
          <EmptyState title="No samples were accepted in this range." detail="Gaps are not interpolated and missing values never become zero." icon="activity" />
        </Widget>
      }
    >
      <Show when={props.points.some(point => point.partial)}>
        <Notice tone="warn">Some buckets are partial; gaps are not interpolated.</Notice>
      </Show>
      <section class="chart-grid" aria-label="Host charts">
        <Widget id="cpu" title="CPU" subtitle="% of total counter time" expandable>
          <TimeChart
            label="CPU"
            legend
            area
            series={[
              series("total", "neutral", cpuUsed, { graded: true }),
              series("user", "blue", point => point.cpu?.user, { scored: false }),
              series("system", "aqua", point => point.cpu?.system, { scored: false }),
              series("iowait", "violet", point => point.cpu?.iowait, { scored: false }),
              series("steal", "magenta", point => point.cpu?.steal, { scored: false }),
              ...ghost(cpuUsed)
            ]}
            format={percent}
            min={0}
            max={100}
            limits={LIMITS.cpuPercent}
            events={props.events}
            stepMs={props.stepMs}
          />
        </Widget>
        <Widget id="load" title="Load" subtitle="run-queue length" expandable>
          <TimeChart
            label="Load"
            legend
            area
            series={[
              series("1 min", "ramp-5", point => point.load?.one, { graded: true }),
              series("5 min", "ramp-3", point => point.load?.five, { scored: false }),
              series("15 min", "ramp-1", point => point.load?.fifteen, { scored: false }),
              ...ghost(point => point.load?.one)
            ]}
            format={value => count(value)}
            limits={loadScale()}
            min={0}
            events={props.events}
            stepMs={props.stepMs}
          />
        </Widget>
        <Show
          when={reportsPressure()}
          fallback={
            <Widget id="pressure" title="Pressure" subtitle="PSI">
              <EmptyState title="This host does not report pressure stalls." detail="The kernel needs PSI enabled (CONFIG_PSI, and no psi=0 on the command line) for /proc/pressure to exist." icon="activity" />
            </Widget>
          }
        >
          <Widget id="pressure" title="Pressure" subtitle="PSI some, 10s average: share of time tasks stalled" expandable>
            <TimeChart
              label="Pressure"
              legend
              area
              series={[
                { label: "cpu", color: "blue", points: psiSeries(props.points, value => value.cpu?.some10) },
                { label: "memory", color: "aqua", points: psiSeries(props.points, value => value.memory?.some10) },
                { label: "i/o", color: "violet", points: psiSeries(props.points, value => value.io?.some10) }
              ]}
              format={percent}
              limits={LIMITS.pressureSome}
              min={0}
              events={props.events}
              stepMs={props.stepMs}
            />
          </Widget>
          <Show when={props.points.some(point => [point.psi?.cpu, point.psi?.memory, point.psi?.io].some(group => group?.full10 !== undefined))}>
            <Widget title="Full stalls" subtitle="PSI full, 10s average: all non-idle tasks stalled" expandable>
              <TimeChart
                label="Full stalls"
                legend
                area
                series={[
                  { label: "cpu", color: "blue", points: psiSeries(props.points, value => value.cpu?.full10) },
                  { label: "memory", color: "aqua", points: psiSeries(props.points, value => value.memory?.full10) },
                  { label: "i/o", color: "violet", points: psiSeries(props.points, value => value.io?.full10) }
                ]}
                format={percent}
                limits={LIMITS.pressureFull}
                min={0}
                events={props.events}
                stepMs={props.stepMs}
              />
            </Widget>
          </Show>
        </Show>
      </section>
    </Show>
  );
}
