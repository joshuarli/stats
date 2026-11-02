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
        series={[{ label: "since last success", color: "neutral", graded: true, points: props.data.silence }]}
        format={minutes}
        limits={LIMITS.collectorStaleMinutes}
        min={0}
      />
      <div class="sysinfo" role="group" aria-label="Collector details">
        <div class="sysinfo-fact">
          <span class="sysinfo-label">Last success</span>
          <span class="sysinfo-value">{props.collector.lastSuccessAtMs === null ? "never" : age(props.collector.lastSuccessAtMs, props.now)}</span>
          <Show when={props.collector.lastSuccessAtMs !== null}>
            <span class="sysinfo-detail">{dateTime(props.collector.lastSuccessAtMs ?? undefined)}</span>
          </Show>
        </div>
        <Show when={props.collector.lastError !== null}>
          <div class="sysinfo-fact">
            <span class="sysinfo-label">Last run failed</span>
            <span class="sysinfo-value">{props.collector.lastError}</span>
          </div>
        </Show>
        <Show when={props.rowsRead !== undefined}>
          <div class="sysinfo-fact">
            <span class="sysinfo-label">Rows read by the last run</span>
            <span class="sysinfo-value">{count(props.rowsRead)}</span>
          </div>
        </Show>
      </div>
    </Widget>
  );
}
