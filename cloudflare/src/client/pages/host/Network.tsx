import { createMemo, For } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { NetSeries } from "../../api";
import { pointsIn } from "../../chart-data";
import { rate } from "../../format";
import { healthOf, LIMITS } from "../../health";
import { sumSeries } from "../../metrics";
import { useTelemetry } from "../../state";
import { Sparkline } from "../../components/Sparkline";
import type { ChartEvent } from "../../components/TimeChart";
import { EmptyState, HealthMark, Widget } from "../../components/ui";
import { PanelLabel, perSecond, activeSeries, PanelChart } from "./shared";

export function NetworkWidget(props: { readonly series: readonly NetSeries[]; readonly stepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  const { view } = useTelemetry();
  const active = createMemo(() => activeSeries(props.series, props.stepMs));
  const lastIn = <T extends { readonly atMs: number }>(points: readonly T[]) => pointsIn(points, view()).at(-1);
  return (
    <Widget id="network" title="Network" expandable>
      {props.series.length === 0 ? <EmptyState title="No network series in this range." icon="network" /> : (
        <>
          <PanelChart
            label="Network throughput"
            area
            timeAxis={false}
            series={[
              { label: "receive", color: "blue", mirror: false, points: sumSeries(props.series, point => point.rxBytesPerSec) },
              { label: "transmit", color: "aqua", mirror: true, points: sumSeries(props.series, point => point.txBytesPerSec) }
            ]}
            format={rate}
            events={props.events}
            stepMs={props.stepMs}
          />
          <PanelLabel>Packets per second</PanelLabel>
          <PanelChart
            label="Network packets"
            area
            timeAxis={false}
            series={[
              { label: "receive", color: "blue", mirror: false, points: sumSeries(props.series, point => point.rxPacketsPerSec) },
              { label: "transmit", color: "aqua", mirror: true, points: sumSeries(props.series, point => point.txPacketsPerSec) }
            ]}
            format={perSecond}
            events={props.events}
            stepMs={props.stepMs}
          />
          <PanelLabel>Drops and errors per second</PanelLabel>
          <PanelChart
            label="Network drops and errors"
            series={[
              { label: "drops", color: "serious", points: sumSeries(props.series, point => point.rxDropsPerSec + point.txDropsPerSec) },
              { label: "errors", color: "critical", points: sumSeries(props.series, point => point.rxErrorsPerSec + point.txErrorsPerSec) }
            ]}
            format={perSecond}
            limits={LIMITS.netFaultsPerSec}
            min={0}
            events={props.events}
            stepMs={props.stepMs}
          />
          <div class="table-scroll flush-table">
            <table class="data-table compact" aria-label="Network activity">
              <thead><tr><th scope="col">Interface</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Drops</th><th scope="col">Errors</th><th scope="col">Trend</th></tr></thead>
              <tbody>
                <For each={active()}>
                  {(entry) => {
                    const point = () => lastIn(entry.points);
                    const drops = () => (point() === undefined ? undefined : point()!.rxDropsPerSec + point()!.txDropsPerSec);
                    const errors = () => (point() === undefined ? undefined : point()!.rxErrorsPerSec + point()!.txErrorsPerSec);
                    const health = (value: number | undefined) => (value === undefined ? undefined : healthOf(value, LIMITS.netFaultsPerSec) ?? undefined);
                    return (
                      <tr>
                        <td><span class="device-name">{entry.name ?? entry.id}</span><span class="cell-note">{entry.id}</span></td>
                        <td>{rate(point()?.rxBytesPerSec)}</td>
                        <td>{rate(point()?.txBytesPerSec)}</td>
                        <td>{drops() === undefined ? "unavailable" : perSecond(drops())}<HealthMark health={health(drops())} /></td>
                        <td>{errors() === undefined ? "unavailable" : perSecond(errors())}<HealthMark health={health(errors())} /></td>
                        <td><Sparkline points={pointsIn(entry.points, view()).map(value => ({ atMs: value.atMs, value: value.rxBytesPerSec }))} label={`${entry.id} receive rate`} /></td>
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
