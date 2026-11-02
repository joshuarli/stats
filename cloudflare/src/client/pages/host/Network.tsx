import { createMemo, For } from "solid-js";
import type { JSX } from "@solidjs/web";
import { sumTracks, windowIndexes } from "../../chart-data";
import { rate } from "../../format";
import type { NetSeries } from "../../history";
import { healthOf, LIMITS } from "../../health";
import { netDrops, netErrors } from "../../metrics";
import { useTelemetry } from "../../state";
import { Sparkline } from "../../components/Sparkline";
import type { ChartEvent } from "../../components/TimeChart";
import { EmptyState, HealthMark, Widget } from "../../components/ui";
import { PanelLabel, perSecond, activeSeries, PanelChart } from "./shared";

export function NetworkWidget(props: { readonly series: readonly NetSeries[]; readonly stepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  const { view } = useTelemetry();
  const active = createMemo(() => activeSeries(props.series, props.stepMs));
  const total = (field: "rxBytesPerSec" | "txBytesPerSec" | "rxPacketsPerSec" | "txPacketsPerSec") => sumTracks(props.series.map(entry => entry.table.track(field)));
  const derived = (cells: typeof netDrops) => sumTracks(props.series.map(entry => ({ times: entry.table.times, values: cells(entry.table) })));
  return (
    <Widget id="network" title="Network" expandable>
      {props.series.length === 0 ? <EmptyState title="No network series in this range." icon="network" /> : (
        <>
          <PanelChart
            label="Network throughput"
            area
            timeAxis={false}
            series={[
              { label: "receive", color: "blue", mirror: false, track: total("rxBytesPerSec") },
              { label: "transmit", color: "aqua", mirror: true, track: total("txBytesPerSec") }
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
              { label: "receive", color: "blue", mirror: false, track: total("rxPacketsPerSec") },
              { label: "transmit", color: "aqua", mirror: true, track: total("txPacketsPerSec") }
            ]}
            format={perSecond}
            events={props.events}
            stepMs={props.stepMs}
          />
          <PanelLabel>Drops and errors per second</PanelLabel>
          <PanelChart
            label="Network drops and errors"
            series={[
              { label: "drops", color: "serious", track: derived(netDrops) },
              { label: "errors", color: "critical", track: derived(netErrors) }
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
                    const range = () => windowIndexes(entry.table.times, view());
                    const row = () => (range()[1] >= range()[0] ? range()[1] : undefined);
                    const at = (field: "rxBytesPerSec" | "txBytesPerSec") => (row() === undefined ? undefined : entry.table.at(field, row()!));
                    const drops = () => (row() === undefined ? undefined : netDrops(entry.table)[row()!] ?? undefined);
                    const errors = () => (row() === undefined ? undefined : netErrors(entry.table)[row()!] ?? undefined);
                    const health = (value: number | undefined) => (value === undefined ? undefined : healthOf(value, LIMITS.netFaultsPerSec) ?? undefined);
                    return (
                      <tr>
                        <td><span class="device-name">{entry.name ?? entry.id}</span><span class="cell-note">{entry.id}</span></td>
                        <td>{rate(at("rxBytesPerSec"))}</td>
                        <td>{rate(at("txBytesPerSec"))}</td>
                        <td>{drops() === undefined ? "unavailable" : perSecond(drops())}<HealthMark health={health(drops())} /></td>
                        <td>{errors() === undefined ? "unavailable" : perSecond(errors())}<HealthMark health={health(errors())} /></td>
                        <td><Sparkline values={entry.table.cells("rxBytesPerSec").slice(range()[0], range()[1] + 1)} label={`${entry.id} receive rate`} /></td>
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
