import type { JSX } from "@solidjs/web";
import { count, milliseconds } from "../../format";
import { MIN_SCORED_EVENTS } from "../../health";
import { Widget } from "../../components/ui";
import { Term } from "../../components/Info";
import { PanelLabel, PanelChart } from "../host/shared";
import { durableObjectCpuAverage, durableObjectWallAverage, provisionalFromMs, type ProjectData } from "./series";
import { metricTrack } from "../../history";

export function DurableObjectsWidget(props: { readonly data: ProjectData }): JSX.Element {
  const history = () => props.data.durableObjects;
  return (
    <Widget id="durable-objects" title="Durable Objects" expandable>
      {history() === undefined ? null : (
        <>
          <PanelChart
            label="Durable Object invocations"
            series={[
              { label: "invocations", color: "blue", scored: false, track: metricTrack(history()!, "do.invocations") },
              { label: "errors", color: "critical", scored: false, track: metricTrack(history()!, "do.errors") }
            ]}
            format={count}
            min={0}
            stepMs={history()!.stepMs}
            provisionalFromMs={provisionalFromMs(history()!)}
          />
          <PanelLabel><Term hint={`Mean CPU per invocation. Withheld for buckets with fewer than ${MIN_SCORED_EVENTS} invocations, so one slow call cannot read as an average.`}>Average CPU time</Term></PanelLabel>
          <PanelChart
            label="Durable Object average CPU time"
            area
            series={[{ label: "average", color: "blue", scored: false, track: durableObjectCpuAverage(history()!) }]}
            format={milliseconds}
            min={0}
            stepMs={history()!.stepMs}
            provisionalFromMs={provisionalFromMs(history()!)}
          />
          <PanelLabel>Max CPU time</PanelLabel>
          <PanelChart
            label="Durable Object maximum CPU time"
            series={[{ label: "maximum", color: "violet", scored: false, track: metricTrack(history()!, "do.cpuMsMax") }]}
            format={milliseconds}
            min={0}
            stepMs={history()!.stepMs}
            provisionalFromMs={provisionalFromMs(history()!)}
          />
          <PanelLabel>Average wall time</PanelLabel>
          <PanelChart
            label="Durable Object average wall time"
            series={[{ label: "average", color: "aqua", scored: false, track: durableObjectWallAverage(history()!) }]}
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
