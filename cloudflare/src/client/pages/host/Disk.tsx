import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DiskSeries, SummaryPoint } from "../../api";
import { pointsIn } from "../../chart-data";
import { count, percent, rate } from "../../format";
import { healthOf, LIMITS } from "../../health";
import { sumSeries } from "../../metrics";
import { useTelemetry } from "../../state";
import { Sparkline } from "../../components/Sparkline";
import type { ChartEvent } from "../../components/TimeChart";
import { EmptyState, HealthMark, Meter, Widget } from "../../components/ui";
import { colorsFor, PanelLabel, perSecond, activeSeries, summarySeries, topSeries, PanelChart } from "./shared";

export function DiskWidget(props: { readonly series: readonly DiskSeries[]; readonly stepMs: number; readonly summary: readonly SummaryPoint[]; readonly summaryStepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  const { view } = useTelemetry();
  const active = createMemo(() => activeSeries(props.series, props.stepMs));
  const shown = createMemo(() => topSeries(props.series, point => point.busyPct));
  const colors = createMemo(() => colorsFor(shown()));
  const reportsPressure = createMemo(() => props.summary.some(point => point.psi?.io !== undefined));
  const reportsBusy = createMemo(() => props.series.some(entry => entry.points.some(point => point.busyPct !== undefined)));
  const lastIn = <T extends { readonly atMs: number }>(points: readonly T[]) => pointsIn(points, view()).at(-1);
  return (
    <Widget id="disk" title="Disk" expandable>
      {props.series.length === 0 ? <EmptyState title="No disk series in this range." icon="disk" /> : (
        <>
          <PanelChart
            label="Disk throughput"
            timeAxis={false}
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
          <PanelChart
            label="Disk operations"
            timeAxis={!reportsBusy() && !reportsPressure()}
            series={[
              { label: "reads", color: "blue", mirror: false, points: sumSeries(props.series, point => point.readsPerSec) },
              { label: "writes", color: "aqua", mirror: true, points: sumSeries(props.series, point => point.writesPerSec) }
            ]}
            area
            format={perSecond}
            events={props.events}
            stepMs={props.stepMs}
          />
          <Show when={reportsBusy()}>
            <PanelLabel>Busy time per device</PanelLabel>
            <PanelChart
              label="Disk busy"
              timeAxis={!reportsPressure()}
              series={shown().map(entry => ({ label: entry.name ?? entry.id, color: colors().get(entry.id) ?? "neutral", points: entry.points.map(point => ({ atMs: point.atMs, value: point.busyPct })) }))}
              format={percent}
              limits={LIMITS.diskBusyPercent}
              min={0}
              events={props.events}
              stepMs={props.stepMs}
            />
          </Show>
          <Show when={reportsPressure()}>
            <PanelLabel>I/O pressure, 10 s average</PanelLabel>
            <PanelChart
              label="I/O pressure"
              area
              series={[
                { label: "some", color: "ramp-3", points: summarySeries(props.summary, point => point.psi?.io?.some10) },
                { label: "full", color: "ramp-5", scored: false, points: summarySeries(props.summary, point => point.psi?.io?.full10) }
              ]}
              format={percent}
              limits={LIMITS.pressureSome}
              min={0}
              events={props.events}
              stepMs={props.summaryStepMs}
            />
          </Show>
          <div class="table-scroll flush-table">
            <table class="data-table compact" aria-label="Disk activity">
              <thead><tr><th scope="col">Device</th><th scope="col">Read</th><th scope="col">Write</th><th scope="col">IOPS read / write</th><Show when={reportsBusy()}><th scope="col">Busy</th><th scope="col">Trend</th></Show></tr></thead>
              <tbody>
                <For each={active()}>
                  {(entry) => {
                    const point = () => lastIn(entry.points);
                    return (
                      <tr>
                        <td><span class="device-name">{entry.name ?? entry.id}</span><span class="cell-note">{entry.id}</span></td>
                        <td>{rate(point()?.readBytesPerSec)}</td>
                        <td>{rate(point()?.writeBytesPerSec)}</td>
                        <td>{count(point()?.readsPerSec)} <span class="cell-note">/ {count(point()?.writesPerSec)}</span></td>
                        <Show when={reportsBusy()}>
                          <td>
                            <div class="cpu-cell">
                              <span class="metric-value-small">{percent(point()?.busyPct)}</span>
                              <Meter value={point()?.busyPct} warn={LIMITS.diskBusyPercent.elevated} bad={LIMITS.diskBusyPercent.critical} />
                              <HealthMark health={point()?.busyPct === undefined ? undefined : healthOf(point()!.busyPct!, LIMITS.diskBusyPercent) ?? undefined} />
                            </div>
                          </td>
                          <td><Sparkline points={pointsIn(entry.points, view()).map(value => ({ atMs: value.atMs, value: value.busyPct }))} label={`${entry.id} busy time`} /></td>
                        </Show>
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
