import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TimeWindow } from "../../chart-data";
import { count, milliseconds, percent } from "../../format";
import { Widget } from "../../components/ui";
import { PanelLabel, PanelChart } from "../host/shared";
import { durableObjectCpuAverage, durableObjectWallAverage, metricPoints, provisionalFromMs, routeRows, type ProjectData } from "./series";

export function RoutesWidget(props: { readonly data: ProjectData; readonly view: TimeWindow | null }): JSX.Element {
  const rows = () => routeRows(props.data.routes, props.view);
  return (
    <Widget id="routes" title="CPU by route" expandable>
      <Show when={rows().length > 0} fallback={<PanelLabel>No route data was collected in this range</PanelLabel>}>
        <div class="table-scroll flush-table">
          <table class="data-table compact" aria-label="CPU time by route">
            <thead>
              <tr>
                <th>Route</th>
                <th class="numeric">CPU share</th>
                <th class="numeric">Average</th>
                <th class="numeric">Invocations</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row) => (
                  <tr>
                    <td>{row.route}</td>
                    <td class="numeric">{percent(row.cpuShare)}</td>
                    <td class="numeric">{milliseconds(row.averageMs)}</td>
                    <td class="numeric">{count(row.invocations)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Widget>
  );
}

export function DurableObjectsWidget(props: { readonly data: ProjectData }): JSX.Element {
  const history = () => props.data.durableObjects;
  return (
    <Widget id="durable-objects" title="Durable Objects" expandable>
      {history() === undefined ? null : (
        <>
          <PanelChart
            label="Durable Object invocations"
            timeAxis={false}
            series={[
              { label: "invocations", color: "blue", scored: false, points: metricPoints(history()!, "do.invocations") },
              { label: "errors", color: "critical", scored: false, points: metricPoints(history()!, "do.errors") }
            ]}
            format={count}
            min={0}
            stepMs={history()!.stepMs}
            provisionalFromMs={provisionalFromMs(history()!)}
          />
          <PanelLabel>Average CPU time. Buckets under 100 invocations are not shown</PanelLabel>
          <PanelChart
            label="Durable Object average CPU time"
            area
            timeAxis={false}
            series={[{ label: "average", color: "neutral", scored: false, points: durableObjectCpuAverage(history()!) }]}
            format={milliseconds}
            min={0}
            stepMs={history()!.stepMs}
            provisionalFromMs={provisionalFromMs(history()!)}
          />
          <PanelLabel>Approximate maximum CPU time in a bucket</PanelLabel>
          <PanelChart
            label="Durable Object maximum CPU time"
            timeAxis={false}
            series={[{ label: "maximum", color: "violet", scored: false, points: metricPoints(history()!, "do.cpuMsMax") }]}
            format={milliseconds}
            min={0}
            stepMs={history()!.stepMs}
            provisionalFromMs={provisionalFromMs(history()!)}
          />
          <PanelLabel>Average wall time</PanelLabel>
          <PanelChart
            label="Durable Object average wall time"
            series={[{ label: "average", color: "aqua", scored: false, points: durableObjectWallAverage(history()!) }]}
            format={milliseconds}
            min={0}
            stepMs={history()!.stepMs}
            provisionalFromMs={provisionalFromMs(history()!)}
          />
        </>
      )}
    </Widget>
  );
}
