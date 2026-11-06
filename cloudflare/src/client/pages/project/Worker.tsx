import type { JSX } from "@solidjs/web";
import { count, milliseconds, percent } from "../../format";
import { LIMITS, MIN_SCORED_EVENTS } from "../../health";

import { Widget } from "../../components/ui";
import { Term } from "../../components/Info";
import { PanelLabel, PanelChart } from "../host/shared";
import { cpuAverage, provisionalFromMs, serverErrorShare, STATUS_CLASSES, type ProjectData } from "./series";
import { metricTrack } from "../../history";

const STATUS_COLORS = { "2xx": "blue", "3xx": "aqua", "4xx": "violet", "5xx": "critical", other: "serious" } as const;

export function RequestsWidget(props: { readonly data: ProjectData }): JSX.Element {
  return (
    <Widget id="requests" title="Requests" expandable>
      <PanelChart
        label="Worker invocations"
        area
        series={[{ label: "invocations", color: "blue", track: metricTrack(props.data.worker, "worker.invocations") }]}
        format={count}
        min={0}
        stepMs={props.data.worker.stepMs}
        provisionalFromMs={provisionalFromMs(props.data.worker)}
      />
    </Widget>
  );
}

export function StatusWidget(props: { readonly data: ProjectData }): JSX.Element {
  return (
    <Widget id="status" title="Response status" expandable>
      <PanelChart
        label="Worker status mix"
        series={STATUS_CLASSES.map(statusClass => ({
          label: statusClass,
          color: STATUS_COLORS[statusClass],
          scored: false,
          track: metricTrack(props.data.worker, `worker.status.${statusClass}`)
        }))}
        format={count}
        min={0}
        stepMs={props.data.worker.stepMs}
        provisionalFromMs={provisionalFromMs(props.data.worker)}
      />
      <PanelLabel><Term hint={`5xx responses as a share of invocations. Withheld for buckets with fewer than ${MIN_SCORED_EVENTS} invocations, so a few errors cannot read as a rate.`}>5xx share</Term></PanelLabel>
      <PanelChart
        label="Worker 5xx share"
        area
        series={[{ label: "5xx share", color: "critical", graded: true, track: serverErrorShare(props.data) }]}
        format={percent}
        limits={LIMITS.workerServerErrorPercent}
        min={0}
        stepMs={props.data.worker.stepMs}
        provisionalFromMs={provisionalFromMs(props.data.worker)}
      />
    </Widget>
  );
}

export function CpuTimeWidget(props: { readonly data: ProjectData }): JSX.Element {
  return (
    <Widget id="worker-cpu" title="CPU time" expandable>
      <PanelChart
        label="Worker average CPU time"
        area
        series={[{ label: "average", color: "blue", graded: true, track: cpuAverage(props.data) }]}
        format={milliseconds}
        limits={LIMITS.workerCpuMs}
        min={0}
        stepMs={props.data.worker.stepMs}
        provisionalFromMs={provisionalFromMs(props.data.worker)}
      />
      <PanelLabel><Term hint="Analytics Engine computes this maximum from a sketch, so it can read several times higher than the largest real invocation in the bucket. Use it to spot a trend, not to read a peak.">Max CPU time (estimate)</Term></PanelLabel>
      <PanelChart
        label="Worker maximum CPU time estimate"
        series={[{ label: "estimated maximum", color: "violet", scored: false, track: metricTrack(props.data.worker, "worker.cpuMsMax") }]}
        format={milliseconds}
        min={0}
        stepMs={props.data.worker.stepMs}
        provisionalFromMs={provisionalFromMs(props.data.worker)}
      />
    </Widget>
  );
}
