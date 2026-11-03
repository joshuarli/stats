import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { sumTracks, windowIndexes } from "../../chart-data";
import { rate } from "../../format";
import type { NetSeries } from "../../history";
import { healthOf, LIMITS } from "../../health";
import { netDrops, netErrors, netFaults } from "../../metrics";
import { useTelemetry } from "../../state";
import { Sparkline } from "../../components/Sparkline";
import type { ChartEvent } from "../../components/TimeChart";
import { EmptyState, HealthMark, Widget } from "../../components/ui";
import { PanelLabel, perSecond, activeSeries, PanelChart } from "./shared";

const TABLE_LIMIT = 8;

function trafficPeak(entry: NetSeries): number {
  let peak = 0;
  const rx = entry.table.cells("rxBytesPerSec");
  const tx = entry.table.cells("txBytesPerSec");
  for (let row = 0; row < rx.length; row += 1) peak = Math.max(peak, (rx[row] ?? 0) + (tx[row] ?? 0));
  return peak;
}

export function NetworkWidget(props: { readonly series: readonly NetSeries[]; readonly stepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  const { view } = useTelemetry();
  const [showAll, setShowAll] = createSignal(false);
  const active = createMemo(() => activeSeries(props.series, props.stepMs));
  const rows = createMemo(() => {
    const ordered = [...active()].sort((left, right) => left.id.localeCompare(right.id));
    if (showAll() || ordered.length <= TABLE_LIMIT) return ordered;
    const scores = new Map(ordered.map(entry => [entry.id, {
      faults: netFaults(entry.table).some(value => value !== null && value > 0),
      traffic: trafficPeak(entry)
    }]));
    const ranked = [...ordered].sort((left, right) => {
      const leftScore = scores.get(left.id)!;
      const rightScore = scores.get(right.id)!;
      return Number(rightScore.faults) - Number(leftScore.faults) || rightScore.traffic - leftScore.traffic;
    });
    const kept = new Set(ranked.slice(0, TABLE_LIMIT).map(entry => entry.id));
    return ordered.filter(entry => kept.has(entry.id));
  });
  const overflow = createMemo(() => Math.max(0, active().length - TABLE_LIMIT));
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
          <div class="flush-table">
            <div class="table-scroll">
              <table class="data-table compact" aria-label="Network activity">
                <thead><tr><th scope="col">Interface</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Drops</th><th scope="col">Errors</th><th scope="col">Trend</th></tr></thead>
                <tbody>
                  <For each={rows()}>
                    {(entry) => {
                      const range = () => windowIndexes(entry.table.times, view());
                      const row = () => (range()[1] >= range()[0] ? range()[1] : undefined);
                      const at = (field: "rxBytesPerSec" | "txBytesPerSec") => (row() === undefined ? undefined : entry.table.at(field, row()!));
                      const drops = () => (row() === undefined ? undefined : netDrops(entry.table)[row()!] ?? undefined);
                      const errors = () => (row() === undefined ? undefined : netErrors(entry.table)[row()!] ?? undefined);
                      const health = (value: number | undefined) => (value === undefined ? undefined : healthOf(value, LIMITS.netFaultsPerSec) ?? undefined);
                      return (
                        <tr>
                          <td>
                            <span class="device-name">{entry.name ?? entry.id}</span>
                            <Show when={entry.name !== undefined && entry.name !== entry.id}><span class="cell-note">{entry.id}</span></Show>
                          </td>
                          <td>{rate(at("rxBytesPerSec"))}</td>
                          <td>{rate(at("txBytesPerSec"))}</td>
                          <td>{drops() === undefined ? "unavailable" : perSecond(drops())}<HealthMark health={health(drops())} /></td>
                          <td>{errors() === undefined ? "unavailable" : perSecond(errors())}<HealthMark health={health(errors())} /></td>
                          <td><Sparkline series={[{ values: entry.table.cells("rxBytesPerSec").slice(range()[0], range()[1] + 1) }]} times={entry.table.times.slice(range()[0], range()[1] + 1)} label={`${entry.id} receive rate`} /></td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
            <Show when={overflow() > 0}>
              <div class="table-more">
                <button class="btn btn-small" type="button" aria-expanded={showAll() ? "true" : "false"} onClick={() => setShowAll(value => !value)}>
                  {showAll() ? "Show fewer interfaces" : `Show all ${active().length} interfaces`}
                </button>
              </div>
            </Show>
          </div>
        </>
      )}
    </Widget>
  );
}
