import type { JSX } from "@solidjs/web";
import { count, milliseconds, percent } from "../../format";
import { LIMITS } from "../../health";

import { Widget } from "../../components/ui";
import { PanelLabel, PanelChart } from "../host/shared";
import { cpuAverage, metricPoints, serverErrorShare, STATUS_CLASSES, type ProjectData } from "./series";

const STATUS_COLORS = { "2xx": "blue", "3xx": "aqua", "4xx": "violet", "5xx": "critical", other: "serious" } as const;

export function RequestsWidget(props: { readonly data: ProjectData }): JSX.Element {
  return (
    <Widget id="requests" title="Requests" subtitle="Worker invocations per bucket, estimated from sampled logs" expandable>
      <PanelChart
        label="Worker invocations"
        area
        series={[{ label: "invocations", color: "blue", points: metricPoints(props.data.worker, "worker.invocations") }]}
        format={count}
        min={0}
        stepMs={props.data.worker.stepMs}
      />
    </Widget>
  );
}

export function StatusWidget(props: { readonly data: ProjectData }): JSX.Element {
  return (
    <Widget id="status" title="Response status" subtitle="Invocations by status class, and the 5xx share of all invocations" expandable>
      <PanelLabel>Invocations by status class</PanelLabel>
      <PanelChart
        label="Worker status mix"
        timeAxis={false}
        series={STATUS_CLASSES.map(statusClass => ({
          label: statusClass,
          color: STATUS_COLORS[statusClass],
          scored: false,
          points: metricPoints(props.data.worker, `worker.status.${statusClass}`)
        }))}
        format={count}
        min={0}
        stepMs={props.data.worker.stepMs}
      />
      <PanelLabel>5xx share of invocations</PanelLabel>
      <PanelChart
        label="Worker 5xx share"
        area
        series={[{ label: "5xx share", color: "critical", graded: true, points: serverErrorShare(props.data) }]}
        format={percent}
        limits={LIMITS.workerServerErrorPercent}
        min={0}
        stepMs={props.data.worker.stepMs}
      />
    </Widget>
  );
}

export function CpuTimeWidget(props: { readonly data: ProjectData }): JSX.Element {
  return (
    <Widget id="cpu" title="CPU time" subtitle="Time the Worker spent computing per invocation, not request latency" expandable>
      <PanelLabel>Average CPU time per invocation</PanelLabel>
      <PanelChart
        label="Worker average CPU time"
        area
        timeAxis={false}
        series={[{ label: "average", color: "neutral", graded: true, points: cpuAverage(props.data) }]}
        format={milliseconds}
        limits={LIMITS.workerCpuMs}
        min={0}
        stepMs={props.data.worker.stepMs}
      />
      <PanelLabel>Approximate maximum CPU time in a bucket</PanelLabel>
      <PanelChart
        label="Worker maximum CPU time"
        series={[{ label: "maximum", color: "violet", scored: false, points: metricPoints(props.data.worker, "worker.cpuMsMax") }]}
        format={milliseconds}
        min={0}
        stepMs={props.data.worker.stepMs}
      />
    </Widget>
  );
}
