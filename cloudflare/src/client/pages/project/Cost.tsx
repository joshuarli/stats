import { For } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TimeWindow } from "../../chart-data";
import { count, dollars, dollarsPrecise } from "../../format";
import { Widget } from "../../components/ui";
import { PanelLabel, PanelChart, seriesColor } from "../host/shared";
import { costParts, totalIn, type ProjectData } from "./series";

export function CostWidget(props: { readonly data: ProjectData; readonly view: TimeWindow | null }): JSX.Element {
  const parts = () => costParts(props.data);
  const rows = () => parts().map(part => ({ label: part.label, unit: part.unit, usage: totalIn(part.usage, props.view), cost: totalIn(part.points, props.view) }));
  const total = () => rows().reduce((sum, row) => sum + row.cost, 0);
  return (
    <Widget id="cost" title="Estimated cost" expandable>
      <div class="table-scroll flush-table">
        <table class="data-table compact" aria-label="Estimated cost by component">
          <thead>
            <tr>
              <th>Component</th>
              <th class="numeric">Usage</th>
              <th class="numeric">List cost</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(row) => (
                <tr>
                  <td>{row.label}</td>
                  <td class="numeric">{count(row.usage)} {row.unit}</td>
                  <td class="numeric">{dollars(row.cost)}</td>
                </tr>
              )}
            </For>
            <tr>
              <td><strong>Total</strong></td>
              <td />
              <td class="numeric"><strong>{dollars(total())}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      <PanelLabel>Cost per bucket</PanelLabel>
      <PanelChart
        label="Estimated cost per bucket"
        series={parts().map((part, index) => ({ label: part.label, color: seriesColor(index), scored: false, track: part.points }))}
        format={dollarsPrecise}
        min={0}
        stepMs={props.data.worker.stepMs}
      />
    </Widget>
  );
}
