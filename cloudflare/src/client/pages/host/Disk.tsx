import { createMemo, For } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DiskSeries } from "../../api";
import { pointsIn } from "../../chart-data";
import { count, percent, rate } from "../../format";
import { healthOf, LIMITS } from "../../health";
import { sumSeries } from "../../metrics";
import { useTelemetry } from "../../state";
import { Sparkline } from "../../components/Sparkline";
import { TimeChart, type ChartEvent } from "../../components/TimeChart";
import { EmptyState, HealthMark, Meter, Widget } from "../../components/ui";
import { AXIS_WIDTH, colorsFor, PanelLabel, perSecond, reporting, retiredNote, topSeries } from "./shared";

export function DiskWidget(props: { readonly series: readonly DiskSeries[]; readonly stepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  const { view } = useTelemetry();
  const split = createMemo(() => reporting(props.series, props.stepMs));
  const shown = createMemo(() => topSeries(props.series, point => point.busyPct));
  const colors = createMemo(() => colorsFor(shown()));
  const lastIn = <T extends { readonly atMs: number }>(points: readonly T[]) => pointsIn(points, view()).at(-1);
  return (
    <Widget id="disk" title="Disk" subtitle={retiredNote("reads above the line, writes below; all block devices", split().retired)} expandable>
      {props.series.length === 0 ? <EmptyState title="No disk series in this range." icon="disk" /> : (
        <>
          <PanelLabel>Throughput</PanelLabel>
          <TimeChart
            label="Disk throughput"
            compact
            legend="inline"
            timeAxis={false}
            yAxisWidth={AXIS_WIDTH}
            series={[
              { label: "read", color: "blue", mirror: false, points: sumSeries(props.series, point => point.readBytesPerSec) },
              { label: "write", color: "aqua", mirror: true, points: sumSeries(props.series, point => point.writeBytesPerSec) }
            ]}
            area
            format={rate}
            events={props.events}
            stepMs={props.stepMs}
          />
          <PanelLabel>Operations per second</PanelLabel>
          <TimeChart
            label="Disk operations"
            compact
            legend="inline"
            timeAxis={false}
            yAxisWidth={AXIS_WIDTH}
            series={[
              { label: "reads", color: "blue", mirror: false, points: sumSeries(props.series, point => point.readsPerSec) },
              { label: "writes", color: "aqua", mirror: true, points: sumSeries(props.series, point => point.writesPerSec) }
            ]}
            area
            format={perSecond}
            events={props.events}
            stepMs={props.stepMs}
          />
          <PanelLabel>Busy time per device</PanelLabel>
          <TimeChart
            label="Disk busy"
            compact
            legend="inline"
            yAxisWidth={AXIS_WIDTH}
            series={shown().map(entry => ({ label: entry.name ?? entry.id, color: colors().get(entry.id) ?? "neutral", points: entry.points.map(point => ({ atMs: point.atMs, value: point.busyPct })) }))}
            format={percent}
            limits={LIMITS.diskBusyPercent}
            min={0}
            events={props.events}
            stepMs={props.stepMs}
          />
          <div class="table-scroll flush-table">
            <table class="data-table compact" aria-label="Disk activity">
              <thead><tr><th scope="col">Device</th><th scope="col">Read</th><th scope="col">Write</th><th scope="col">IOPS read / write</th><th scope="col">Busy</th><th scope="col">Trend</th></tr></thead>
              <tbody>
                <For each={split().active}>
                  {(entry) => {
                    const point = () => lastIn(entry.points);
                    return (
                      <tr>
                        <td><span class="device-name">{entry.name ?? entry.id}</span><span class="cell-note">{entry.id}</span></td>
                        <td>{rate(point()?.readBytesPerSec)}</td>
                        <td>{rate(point()?.writeBytesPerSec)}</td>
                        <td>{count(point()?.readsPerSec)} <span class="cell-note">/ {count(point()?.writesPerSec)}</span></td>
                        <td>
                          <div class="cpu-cell">
                            <span class="metric-value-small">{percent(point()?.busyPct)}</span>
                            <Meter value={point()?.busyPct} warn={LIMITS.diskBusyPercent.elevated} bad={LIMITS.diskBusyPercent.critical} />
                            <HealthMark health={point() === undefined ? undefined : healthOf(point()!.busyPct, LIMITS.diskBusyPercent) ?? undefined} />
                          </div>
                        </td>
                        <td><Sparkline points={pointsIn(entry.points, view()).map(value => ({ atMs: value.atMs, value: value.busyPct }))} label={`${entry.id} busy time`} /></td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </>
      )}
    </Widget>
  );
}
