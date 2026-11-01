import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { FilesystemSeries } from "../../api";
import { bytes, percent, percentUsed } from "../../format";
import { forecastFull, forecastHealth, forecastText } from "../../forecast";
import { healthOf, LIMITS } from "../../health";
import { CapacityBar } from "../../components/CapacityBar";
import { TimeChart, type ChartEvent } from "../../components/TimeChart";
import { EmptyState, HealthMark, Widget } from "../../components/ui";
import { AXIS_WIDTH, colorsFor, reporting, retiredNote, topSeries } from "./shared";

const usedShare = (point: { readonly total: number; readonly available: number }) => percentUsed(point.total, point.available);

export function FilesystemsWidget(props: {
  readonly series: readonly FilesystemSeries[];
  readonly stepMs: number;
  readonly longSeries: readonly FilesystemSeries[] | null;
  readonly events: readonly ChartEvent[];
}): JSX.Element {
  const split = createMemo(() => reporting(props.series, props.stepMs));
  const charted = createMemo(() => topSeries(split().active, usedShare));
  const colors = createMemo(() => colorsFor(charted()));
  const rows = createMemo(() => [...split().active].sort((left, right) => (usedShare(right.points.at(-1) ?? { total: 0, available: 0 }) ?? 0) - (usedShare(left.points.at(-1) ?? { total: 0, available: 0 }) ?? 0)));
  const forecastFor = (id: string) => {
    const long = props.longSeries?.find(entry => entry.id === id);
    return long === undefined ? undefined : forecastFull(long.points);
  };
  const subtitle = () => {
    const base = split().active.length > charted().length ? `used share per mount · charted: highest ${charted().length} of ${split().active.length}` : "used share per mount";
    return retiredNote(base, split().retired);
  };
  return (
    <Widget id="filesystems" title="Filesystems" subtitle={subtitle()} expandable>
      {props.series.length === 0 ? <EmptyState title="No filesystem series in this range." icon="disk" /> : (
        <>
          <TimeChart
            label="Filesystem usage"
            yAxisWidth={AXIS_WIDTH}
            series={charted().map(entry => ({ label: entry.id, color: colors().get(entry.id) ?? "neutral", points: entry.points.map(point => ({ atMs: point.atMs, value: usedShare(point) })) }))}
            format={percent}
            limits={LIMITS.filesystemUsedPercent}
            min={0}
            max={100}
            events={props.events}
            stepMs={props.stepMs}
          />
          <div class="table-scroll flush-table">
            <table class="data-table compact" aria-label="Filesystem capacity">
              <thead><tr><th scope="col" /><th scope="col">Mount and 7 day forecast</th><th scope="col">Capacity</th></tr></thead>
              <tbody>
                <For each={rows()}>
                  {(entry) => {
                    const point = () => entry.points.at(-1);
                    const forecast = () => forecastFor(entry.id);
                    return (
                      <tr>
                        <td><span class={`legend-swatch viz-${colors().get(entry.id) ?? "neutral"}${colors().has(entry.id) ? "" : " unplotted"}`} aria-hidden="true" /></td>
                        <td>
                          <span class="device-name">{entry.id}</span>
                          <Show when={forecast()} fallback={<span class="cell-note">forecast loading</span>}>
                            {(found) => (
                              <span class="cell-note forecast">
                                <span>{forecastText(found(), bytes)}</span>
                                <HealthMark health={forecastHealth(found())} />
                              </span>
                            )}
                          </Show>
                        </td>
                        <td>
                          <Show when={point()} fallback={<span class="cell-note">unavailable</span>}>
                            {(current) => (
                              <div class="capacity-with-state">
                                <CapacityBar total={current().total} available={current().available} />
                                <HealthMark health={healthOf(usedShare(current()), LIMITS.filesystemUsedPercent) ?? undefined} />
                              </div>
                            )}
                          </Show>
                        </td>
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
