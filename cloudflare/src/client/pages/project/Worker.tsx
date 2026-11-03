import type { JSX } from "@solidjs/web";
import { count, milliseconds, percent } from "../../format";
import { LIMITS } from "../../health";

import { Widget } from "../../components/ui";
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
      <PanelLabel>5xx share (100+ invocations)</PanelLabel>
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
    <Widget id="cpu" title="CPU time" expandable>
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
      <PanelLabel>Max CPU time</PanelLabel>
      <PanelChart
        label="Worker maximum CPU time"
        series={[{ label: "maximum", color: "violet", scored: false, track: metricTrack(props.data.worker, "worker.cpuMsMax") }]}
        format={milliseconds}
        min={0}
        stepMs={props.data.worker.stepMs}
        provisionalFromMs={provisionalFromMs(props.data.worker)}
      />
    </Widget>
  );
}
