import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { FilesystemSeries } from "../../api";
import { percent, percentUsed } from "../../format";
import { healthOf, LIMITS } from "../../health";
import { CapacityBar } from "../../components/CapacityBar";
import type { ChartEvent } from "../../components/TimeChart";
import { EmptyState, HealthMark, Widget } from "../../components/ui";
import { colorsFor, activeSeries, topSeries, PanelChart } from "./shared";

const usedShare = (point: { readonly total: number; readonly available: number }) => percentUsed(point.total, point.available);

export function FilesystemsWidget(props: {
  readonly series: readonly FilesystemSeries[];
  readonly stepMs: number;
  readonly events: readonly ChartEvent[];
}): JSX.Element {
  const active = createMemo(() => activeSeries(props.series, props.stepMs));
  const charted = createMemo(() => topSeries(active(), usedShare));
  const colors = createMemo(() => colorsFor(charted()));
  const rows = createMemo(() => [...active()].sort((left, right) => (usedShare(right.points.at(-1) ?? { total: 0, available: 0 }) ?? 0) - (usedShare(left.points.at(-1) ?? { total: 0, available: 0 }) ?? 0)));
  return (
    <Widget id="filesystems" title="Filesystems" expandable>
      {props.series.length === 0 ? <EmptyState title="No filesystem series in this range." icon="disk" /> : (
        <>
          <PanelChart
            label="Filesystem usage"
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
              <thead><tr><th scope="col" /><th scope="col">Mount</th><th scope="col">Capacity</th></tr></thead>
              <tbody>
                <For each={rows()}>
                  {(entry) => {
                    const point = () => entry.points.at(-1);
                    return (
                      <tr>
                        <td><span class={`legend-swatch viz-${colors().get(entry.id) ?? "neutral"}${colors().has(entry.id) ? "" : " unplotted"}`} aria-hidden="true" /></td>
                        <td>
                          <span class="device-name">{entry.id}</span>
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
