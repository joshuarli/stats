import type { JSX } from "@solidjs/web";
import { bytes, count, percent } from "../../format";
import { LIMITS } from "../../health";
import { SERIES_COLORS, AXIS_WIDTH, PanelLabel } from "../host/shared";
import { TimeChart } from "../../components/TimeChart";
import { Widget } from "../../components/ui";
import { bucketOutcome, metricPoints, otherShare, r2Metric, type ProjectData } from "./series";

export function OperationsWidget(props: { readonly data: ProjectData }): JSX.Element {
  return (
    <Widget id="r2-operations" title="R2 operations" subtitle="All buckets by outcome. Not-found and similar user errors are expected traffic and are not scored" expandable>
      <PanelLabel>Operations by outcome</PanelLabel>
      <TimeChart
        label="R2 operations by outcome"
        compact
        legend="inline"
        timeAxis={false}
        yAxisWidth={AXIS_WIDTH}
        series={[
          { label: "success", color: "blue", scored: false, points: bucketOutcome(props.data, "success") },
          { label: "user error", color: "neutral", scored: false, points: bucketOutcome(props.data, "userError") },
          { label: "other failure", color: "critical", scored: false, points: bucketOutcome(props.data, "other") }
        ]}
        format={count}
        min={0}
        stepMs={props.data.r2.stepMs}
      />
      <PanelLabel>Share of operations that failed outside the caller's control</PanelLabel>
      <TimeChart
        label="R2 failure share"
        compact
        area
        legend="inline"
        yAxisWidth={AXIS_WIDTH}
        series={[{ label: "failure share", color: "critical", graded: true, points: otherShare(props.data) }]}
        format={percent}
        limits={LIMITS.r2OtherPercent}
        min={0}
        stepMs={props.data.r2.stepMs}
      />
    </Widget>
  );
}

export function StorageWidget(props: { readonly data: ProjectData }): JSX.Element {
  return (
    <Widget id="r2-storage" title="R2 storage" subtitle="Stored bytes and objects per bucket, as each bucket last reported them" expandable>
      <PanelLabel>Stored bytes</PanelLabel>
      <TimeChart
        label="R2 stored bytes"
        compact
        legend="inline"
        timeAxis={false}
        yAxisWidth={AXIS_WIDTH}
        series={props.data.buckets.map((bucket, index) => ({ label: bucket, color: SERIES_COLORS[index % SERIES_COLORS.length] ?? "neutral", scored: false, points: metricPoints(props.data.r2, r2Metric(bucket, "storageBytes")) }))}
        format={bytes}
        min={0}
        stepMs={props.data.r2.stepMs}
      />
      <PanelLabel>Objects</PanelLabel>
      <TimeChart
        label="R2 objects"
        compact
        legend="inline"
        yAxisWidth={AXIS_WIDTH}
        series={props.data.buckets.map((bucket, index) => ({ label: bucket, color: SERIES_COLORS[index % SERIES_COLORS.length] ?? "neutral", scored: false, points: metricPoints(props.data.r2, r2Metric(bucket, "objects")) }))}
        format={count}
        min={0}
        stepMs={props.data.r2.stepMs}
      />
    </Widget>
  );
}
