import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { CollectorState } from "../../api";
import { age, count, dateTime, minutes } from "../../format";
import { LIMITS } from "../../health";

import { Widget } from "../../components/ui";
import { PanelChart } from "../host/shared";
import type { ProjectData } from "./series";

export function CollectorWidget(props: { readonly data: ProjectData; readonly collector: CollectorState; readonly now: number; readonly rowsRead: number | undefined }): JSX.Element {
  return (
    <Widget id="collector" title="Collector" expandable>
      <PanelChart
        label="Collector silence"
        area
        series={[{ label: "since last success", color: "blue", graded: true, track: props.data.silence }]}
        format={minutes}
        limits={LIMITS.collectorStaleMinutes}
        min={0}
      />
      <p class="collector-line">
        <span title={dateTime(props.collector.lastSuccessAtMs ?? undefined)}>Last success {props.collector.lastSuccessAtMs === null ? "never" : age(props.collector.lastSuccessAtMs, props.now)}</span>
        <Show when={props.rowsRead !== undefined}><span>{count(props.rowsRead)} rows read</span></Show>
        <Show when={props.collector.lastError !== null}><span class="collector-error">Last run failed: {props.collector.lastError}</span></Show>
      </p>
    </Widget>
  );
}
