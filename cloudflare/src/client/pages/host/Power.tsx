import type { JSX } from "@solidjs/web";
import type { SummaryPoint } from "../../api";
import { watts } from "../../format";
import type { ChartEvent } from "../../components/TimeChart";
import { Widget } from "../../components/ui";
import { PanelChart, summarySeries } from "./shared";

export function reportsPower(points: readonly SummaryPoint[]): boolean {
  return points.some(point => point.power !== undefined);
}

export function PowerWidget(props: { readonly points: readonly SummaryPoint[]; readonly stepMs: number; readonly events: readonly ChartEvent[] }): JSX.Element {
  return (
    <Widget id="power" title="Power" expandable>
      <PanelChart
        label="Power"
        area
        series={[
          { label: "system", color: "blue", scored: false, joinGaps: true, points: summarySeries(props.points, point => point.power?.systemWatts) },
          { label: "GPU", color: "aqua", scored: false, points: summarySeries(props.points, point => point.power?.gpuWatts) }
        ]}
        format={watts}
        min={0}
        events={props.events}
        stepMs={props.stepMs}
      />
    </Widget>
  );
}
