import type { JSX } from "@solidjs/web";
import { bytes, count, percent } from "../../format";
import { LIMITS } from "../../health";
import { PanelLabel, seriesColor, PanelChart } from "../host/shared";

import { Widget } from "../../components/ui";
import { holdLast } from "./math";
import { bucketOutcome, metricPoints, otherShare, r2Metric, type ProjectData } from "./series";

export function OperationsWidget(props: { readonly data: ProjectData }): JSX.Element {
  return (
    <Widget id="r2-operations" title="R2 operations" subtitle="All buckets, by outcome" expandable>
      <PanelLabel>Operations by outcome. User errors such as not-found are expected traffic and are not scored</PanelLabel>
      <PanelChart
        label="R2 operations by outcome"
        timeAxis={false}
        series={[
          { label: "success", color: "blue", scored: false, points: bucketOutcome(props.data, "success") },
          { label: "user error", color: "neutral", scored: false, points: bucketOutcome(props.data, "userError") },
          { label: "other failure", color: "critical", scored: false, points: bucketOutcome(props.data, "other") }
        ]}
        format={count}
        min={0}
        stepMs={props.data.r2.stepMs}
      />
      <PanelLabel>Share of operations that failed outside the caller's control. Buckets under 100 operations are not scored</PanelLabel>
      <PanelChart
        label="R2 failure share"
        area
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
      <PanelChart
        label="R2 stored bytes"
        timeAxis={false}
        series={props.data.buckets.map((bucket, index) => ({ label: bucket, color: seriesColor(index), scored: false, points: holdLast(metricPoints(props.data.r2, r2Metric(bucket, "storageBytes"))) }))}
        format={bytes}
        min={0}
        stepMs={props.data.r2.stepMs}
      />
      <PanelLabel>Objects</PanelLabel>
      <PanelChart
        label="R2 objects"
        series={props.data.buckets.map((bucket, index) => ({ label: bucket, color: seriesColor(index), scored: false, points: holdLast(metricPoints(props.data.r2, r2Metric(bucket, "objects"))) }))}
        format={count}
        min={0}
        stepMs={props.data.r2.stepMs}
      />
    </Widget>
  );
}
