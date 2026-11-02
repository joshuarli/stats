import type { JSX } from "@solidjs/web";
import { watts } from "../../format";
import type { SummaryTable } from "../../history";
import type { ChartEvent } from "../../components/TimeChart";
import { Widget } from "../../components/ui";
import { PanelChart } from "./shared";

export function reportsPower(table: SummaryTable): boolean {
  return table.has("power");
}

export function PowerWidget(props: { readonly table: SummaryTable; readonly stepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  return (
    <Widget id="power" title="Power" expandable>
      <PanelChart
        label="Power"
        area
        series={[
          { label: "system", color: "blue", scored: false, joinGaps: true, track: props.table.track("power.systemWatts") },
          { label: "GPU", color: "aqua", scored: false, track: props.table.track("power.gpuWatts") }
        ]}
        format={watts}
        min={0}
        events={props.events}
        stepMs={props.stepMs}
      />
    </Widget>
  );
}
