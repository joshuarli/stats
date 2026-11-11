import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { sumTracks, windowIndexes } from "../../chart-data";
import { count, milliseconds, percent, perSecond, rate } from "../../format";
import type { DiskSeries, SummaryTable } from "../../history";
import { healthOf, LIMITS } from "../../health";
import { useTelemetry } from "../../state";
import type { PsiWindow } from "../../psi";
import { Sparkline } from "../../components/Sparkline";
import type { ChartEvent } from "../../components/TimeChart";
import { EmptyState, Meter } from "@laputa-systems/ui-dashboard";
import { HealthMark, Notice, Widget } from "../../components/ui";
import { compareSortValues, createSort, SortHeader } from "../../components/sort";
import { PressureChart } from "./Psi";
import { colorsFor, PanelLabel, activeSeries, topSeries, PanelChart } from "./shared";

export function DiskWidget(props: {
  readonly series: readonly DiskSeries[];
  readonly stepMs: number;
  readonly summary: SummaryTable;
  readonly summaryStepMs: number;
  readonly events: readonly ChartEvent[];
  readonly psiWindow: PsiWindow;
}): JSX.Element {
  const { view } = useTelemetry();
  const { sort, sortBy } = createSort<"none" | "device" | "read" | "write" | "iops" | "latency" | "queue" | "busy">({ key: "none", direction: 1 });
  const active = createMemo(() => activeSeries(props.series, props.stepMs));
  const rows = createMemo(() => {
    const key = sort().key;
    if (key === "none") return active();
    const direction = sort().direction;
    const value = (entry: DiskSeries): number | string | null => {
      if (key === "device") return entry.name ?? entry.id;
      const range = windowIndexes(entry.table.times, view());
      const row = range[1] >= range[0] ? range[1] : undefined;
      if (row === undefined) return null;
      if (key === "read") return entry.table.at("readBytesPerSec", row) ?? null;
      if (key === "write") return entry.table.at("writeBytesPerSec", row) ?? null;
      if (key === "iops") return entry.table.at("readsPerSec", row) ?? null;
      if (key === "latency") return entry.table.at("readLatencyMs", row) ?? null;
      if (key === "queue") return entry.table.at("queueDepth", row) ?? null;
      return entry.table.at("busyPct", row) ?? null;
    };
    return [...active()].sort((left, right) => {
      const leftValue = value(left);
      const rightValue = value(right);
      if (leftValue === null || rightValue === null) {
        if (leftValue === null && rightValue === null) return left.id.localeCompare(right.id);
        return leftValue === null ? 1 : -1;
      }
      return compareSortValues(leftValue, rightValue) * direction || left.id.localeCompare(right.id);
    });
  });
  const shown = createMemo(() => topSeries(props.series, table => table.cells("busyPct")));
  const colors = createMemo(() => colorsFor(shown()));
  const reportsPressure = createMemo(() => props.summary.has("psi.io"));
  const reportsBusy = createMemo(() => props.series.some(entry => entry.table.has("busyPct")));
  const latencyShown = createMemo(() => topSeries(props.series, table => table.cells("writeLatencyMs")));
  const latencyColors = createMemo(() => colorsFor(latencyShown()));
  const reportsReadLatency = createMemo(() => props.series.some(entry => entry.table.has("readLatencyMs")));
  const reportsWriteLatency = createMemo(() => props.series.some(entry => entry.table.has("writeLatencyMs")));
  const reportsQueue = createMemo(() => props.series.some(entry => entry.table.has("queueDepth")));
  const reportsLatencyTable = createMemo(() => reportsReadLatency() || reportsWriteLatency());
  const deviceTracks = (field: "readLatencyMs" | "writeLatencyMs" | "queueDepth") => latencyShown().map(entry => ({ label: entry.name ?? entry.id, color: latencyColors().get(entry.id) ?? "neutral", track: entry.table.track(field) }));
  const total = (field: "readBytesPerSec" | "writeBytesPerSec" | "readsPerSec" | "writesPerSec") => sumTracks(props.series.map(entry => entry.table.track(field)));
  return (
    <Widget id="disk" title="Disk" expandable>
      {props.series.length === 0 ? <EmptyState title="No disk series in this range." icon="disk" /> : (
        <>
          <Show when={!reportsBusy()}>
            <Notice>This host does not report disk busy time, so the busy panel is hidden.</Notice>
          </Show>
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
            timeAxis={!reportsReadLatency() && !reportsWriteLatency() && !reportsQueue() && !reportsBusy() && !reportsPressure()}
            series={[
              { label: "reads", color: "blue", mirror: false, track: total("readsPerSec") },
              { label: "writes", color: "aqua", mirror: true, track: total("writesPerSec") }
            ]}
            area
            format={perSecond}
            events={props.events}
            stepMs={props.stepMs}
          />
          <Show when={reportsReadLatency()}>
            <PanelLabel>Mean read latency per device</PanelLabel>
            <PanelChart
              label="Disk read latency"
              timeAxis={!reportsWriteLatency() && !reportsQueue() && !reportsBusy() && !reportsPressure()}
              series={deviceTracks("readLatencyMs")}
              format={milliseconds}
              min={0}
              events={props.events}
              stepMs={props.stepMs}
            />
          </Show>
          <Show when={reportsWriteLatency()}>
            <PanelLabel>Mean write latency per device</PanelLabel>
            <PanelChart
              label="Disk write latency"
              timeAxis={!reportsQueue() && !reportsBusy() && !reportsPressure()}
              series={deviceTracks("writeLatencyMs")}
              format={milliseconds}
              min={0}
              events={props.events}
              stepMs={props.stepMs}
            />
          </Show>
          <Show when={reportsQueue()}>
            <PanelLabel>Average queue depth per device</PanelLabel>
            <PanelChart
              label="Disk queue depth"
              timeAxis={!reportsBusy() && !reportsPressure()}
              series={deviceTracks("queueDepth")}
              format={count}
              min={0}
              events={props.events}
              stepMs={props.stepMs}
            />
          </Show>
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
            <PressureChart label="I/O pressure" table={props.summary} group="io" window={props.psiWindow} stepMs={props.summaryStepMs} events={props.events} />
          </Show>
          <div class="table-scroll flush-table">
            <table class="data-table compact" aria-label="Disk activity">
              <thead><tr>
                <SortHeader label="Device" sortKey="device" sort={sort()} onSort={sortBy} />
                <SortHeader label="Read" sortKey="read" sort={sort()} onSort={sortBy} />
                <SortHeader label="Write" sortKey="write" sort={sort()} onSort={sortBy} />
                <SortHeader label="IOPS read / write" sortKey="iops" sort={sort()} onSort={sortBy} />
                <Show when={reportsLatencyTable()}><SortHeader label="Latency read / write" sortKey="latency" sort={sort()} onSort={sortBy} /></Show>
                <Show when={reportsQueue()}><SortHeader label="Queue" sortKey="queue" sort={sort()} onSort={sortBy} /></Show>
                <Show when={reportsBusy()}><SortHeader label="Busy" sortKey="busy" sort={sort()} onSort={sortBy} /><th scope="col">Trend</th></Show>
              </tr></thead>
              <tbody>
                <For each={rows()}>
                  {(entry) => {
                    const range = () => windowIndexes(entry.table.times, view());
                    const row = () => (range()[1] >= range()[0] ? range()[1] : undefined);
                    const at = (field: "readBytesPerSec" | "writeBytesPerSec" | "readsPerSec" | "writesPerSec" | "busyPct" | "readLatencyMs" | "writeLatencyMs" | "queueDepth") => (row() === undefined ? undefined : entry.table.at(field, row()!));
                    const busy = () => at("busyPct");
                    return (
                      <tr>
                        <td><span class="device-name">{entry.name ?? entry.id}</span><span class="cell-note">{entry.id}</span></td>
                        <td>{rate(at("readBytesPerSec"))}</td>
                        <td>{rate(at("writeBytesPerSec"))}</td>
                        <td>{count(at("readsPerSec"))} <span class="cell-note">/ {count(at("writesPerSec"))}</span></td>
                        <Show when={reportsLatencyTable()}>
                          <td>{milliseconds(at("readLatencyMs"))} <span class="cell-note">/ {milliseconds(at("writeLatencyMs"))}</span></td>
                        </Show>
                        <Show when={reportsQueue()}>
                          <td>{count(at("queueDepth"))}</td>
                        </Show>
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
