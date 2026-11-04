import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { sumTracks, windowIndexes } from "../../chart-data";
import { count, percent, rate } from "../../format";
import type { DiskSeries, SummaryTable } from "../../history";
import { healthOf, LIMITS } from "../../health";
import { useTelemetry } from "../../state";
import { Sparkline } from "../../components/Sparkline";
import type { ChartEvent } from "../../components/TimeChart";
import { EmptyState, HealthMark, Meter, Widget } from "../../components/ui";
import { colorsFor, PanelLabel, perSecond, activeSeries, topSeries, PanelChart } from "./shared";

export function DiskWidget(props: { readonly series: readonly DiskSeries[]; readonly stepMs: number; readonly summary: SummaryTable; readonly summaryStepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  const { view } = useTelemetry();
  const active = createMemo(() => activeSeries(props.series, props.stepMs));
  const shown = createMemo(() => topSeries(props.series, table => table.cells("busyPct")));
  const colors = createMemo(() => colorsFor(shown()));
  const reportsPressure = createMemo(() => props.summary.has("psi.io"));
  const reportsBusy = createMemo(() => props.series.some(entry => entry.table.has("busyPct")));
  const total = (field: "readBytesPerSec" | "writeBytesPerSec" | "readsPerSec" | "writesPerSec") => sumTracks(props.series.map(entry => entry.table.track(field)));
  return (
    <Widget id="disk" title="Disk" expandable>
      {props.series.length === 0 ? <EmptyState title="No disk series in this range." icon="disk" /> : (
        <>
          <PanelChart
            label="Disk throughput"
            timeAxis={false}
            series={[
              { label: "read", color: "blue", mirror: false, track: total("readBytesPerSec") },
              { label: "write", color: "aqua", mirror: true, track: total("writeBytesPerSec") }
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
              { label: "reads", color: "blue", mirror: false, track: total("readsPerSec") },
              { label: "writes", color: "aqua", mirror: true, track: total("writesPerSec") }
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
              series={shown().map(entry => ({ label: entry.name ?? entry.id, color: colors().get(entry.id) ?? "neutral", track: entry.table.track("busyPct") }))}
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
                { label: "some", color: "ramp-3", track: props.summary.track("psi.io.some10") },
                { label: "full", color: "ramp-5", scored: false, track: props.summary.track("psi.io.full10") }
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
                    const range = () => windowIndexes(entry.table.times, view());
                    const row = () => (range()[1] >= range()[0] ? range()[1] : undefined);
                    const at = (field: "readBytesPerSec" | "writeBytesPerSec" | "readsPerSec" | "writesPerSec" | "busyPct") => (row() === undefined ? undefined : entry.table.at(field, row()!));
                    const busy = () => at("busyPct");
                    return (
                      <tr>
                        <td><span class="device-name">{entry.name ?? entry.id}</span><span class="cell-note">{entry.id}</span></td>
                        <td>{rate(at("readBytesPerSec"))}</td>
                        <td>{rate(at("writeBytesPerSec"))}</td>
                        <td>{count(at("readsPerSec"))} <span class="cell-note">/ {count(at("writesPerSec"))}</span></td>
                        <Show when={reportsBusy()}>
                          <td>
                            <div class="cpu-cell">
                              <span class="metric-value-small">{percent(busy())}</span>
                              <Meter value={busy()} warn={LIMITS.diskBusyPercent.elevated} bad={LIMITS.diskBusyPercent.critical} />
                              <HealthMark health={busy() === undefined ? undefined : healthOf(busy()!, LIMITS.diskBusyPercent) ?? undefined} />
                            </div>
                          </td>
                          <td><Sparkline series={[{ values: entry.table.cells("busyPct").slice(range()[0], range()[1] + 1) }]} times={entry.table.times.slice(range()[0], range()[1] + 1)} label={`${entry.id} busy time`} limits={LIMITS.diskBusyPercent} /></td>
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
