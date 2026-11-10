import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { percent } from "../../format";
import type { FilesystemSeries } from "../../history";
import { healthOf, LIMITS } from "../../health";
import { lastCell, usedShare } from "../../metrics";
import { CapacityBar } from "../../components/CapacityBar";
import type { ChartEvent } from "../../components/TimeChart";
import { EmptyState } from "@laputa-systems/ui-dashboard";
import { HealthMark, Widget } from "../../components/ui";
import { createSort, SortHeader } from "../../components/sort";
import { colorsFor, activeSeries, topSeries, PanelChart } from "./shared";

export function FilesystemsWidget(props: {
  readonly series: readonly FilesystemSeries[];
  readonly stepMs: number;
  readonly events: readonly ChartEvent[];
}): JSX.Element {
  const active = createMemo(() => activeSeries(props.series, props.stepMs));
  const charted = createMemo(() => topSeries(active(), usedShare));
  const colors = createMemo(() => colorsFor(charted()));
  const { sort, sortBy } = createSort<"mount" | "capacity">({ key: "capacity", direction: -1 });
  const rows = createMemo(() => {
    const direction = sort().direction;
    return [...active()].sort((left, right) => {
      if (sort().key === "mount") return left.id.localeCompare(right.id) * direction;
      const leftValue = lastCell(usedShare(left.table)) ?? null;
      const rightValue = lastCell(usedShare(right.table)) ?? null;
      if (leftValue === null || rightValue === null) {
        if (leftValue === null && rightValue === null) return left.id.localeCompare(right.id);
        return leftValue === null ? 1 : -1;
      }
      return (leftValue - rightValue) * direction || left.id.localeCompare(right.id);
    });
  });
  return (
    <Widget id="filesystems" title="Filesystems" expandable>
      {props.series.length === 0 ? <EmptyState title="No filesystem series in this range." icon="disk" /> : (
        <>
          <PanelChart
            label="Filesystem usage"
            series={charted().map(entry => ({ label: entry.id, color: colors().get(entry.id) ?? "neutral", track: { times: entry.table.times, values: usedShare(entry.table) } }))}
            format={percent}
            limits={LIMITS.filesystemUsedPercent}
            min={0}
            max={100}
            events={props.events}
            stepMs={props.stepMs}
          />
          <div class="table-scroll flush-table">
            <table class="data-table compact" aria-label="Filesystem capacity">
              <thead><tr><th scope="col" /><SortHeader label="Mount" sortKey="mount" sort={sort()} onSort={sortBy} /><SortHeader label="Capacity" sortKey="capacity" sort={sort()} onSort={sortBy} /></tr></thead>
              <tbody>
                <For each={rows()}>
                  {(entry) => {
                    const last = () => entry.table.rows - 1;
                    const total = () => entry.table.at("total", last());
                    const available = () => entry.table.at("available", last());
                    return (
                      <tr>
                        <td><span class={`legend-swatch viz-${colors().get(entry.id) ?? "neutral"}${colors().has(entry.id) ? "" : " unplotted"}`} aria-hidden="true" /></td>
                        <td>
                          <span class="device-name">{entry.id}</span>
                        </td>
                        <td>
                          <Show when={total() !== undefined && available() !== undefined} fallback={<span class="cell-note">unavailable</span>}>
                            <div class="capacity-with-state">
                              <CapacityBar total={total()!} available={available()!} />
                              <HealthMark health={healthOf(lastCell(usedShare(entry.table)), LIMITS.filesystemUsedPercent) ?? undefined} labelled />
                            </div>
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
