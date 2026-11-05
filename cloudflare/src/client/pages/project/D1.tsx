import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TimeWindow } from "../../chart-data";
import { bytes, count } from "../../format";
import { Widget } from "../../components/ui";
import { PanelLabel, PanelChart, seriesColor } from "../host/shared";
import { holdLast } from "../../math.ts";
import { provisionalFromMs, type ProjectData } from "./series";
import { metricTrack } from "../../history";

export function D1Widget(props: { readonly data: ProjectData; readonly view: TimeWindow | null }): JSX.Element {
  const totals = () => props.data.d1;
  return (
    <Widget id="d1" title="D1" expandable>
      <Show when={totals()}>
        {(history) => (
          <>
            <PanelChart
              label="D1 database size"
              series={props.data.databases.map((id, index) => ({ label: id.slice(0, 8), color: seriesColor(index), scored: false, track: holdLast(metricTrack(history(), `d1.${id}.storageBytes`)) }))}
              format={bytes}
              min={0}
              stepMs={history().stepMs}
            />
            <PanelLabel>Rows written</PanelLabel>
            <PanelChart
              label="D1 rows written"
              area
              series={[{ label: "rows written", color: "critical", scored: false, track: metricTrack(history(), "d1.rowsWritten") }]}
              format={count}
              min={0}
              stepMs={history().stepMs}
              provisionalFromMs={provisionalFromMs(history())}
            />
            <PanelLabel>Rows read and queries</PanelLabel>
            <PanelChart
              label="D1 rows read and queries"
              series={[
                { label: "rows read", color: "blue", scored: false, track: metricTrack(history(), "d1.rowsRead") },
                { label: "queries", color: "aqua", scored: false, track: metricTrack(history(), "d1.queries") }
              ]}
              format={count}
              min={0}
              stepMs={history().stepMs}
              provisionalFromMs={provisionalFromMs(history())}
            />
          </>
        )}
      </Show>
    </Widget>
  );
}
