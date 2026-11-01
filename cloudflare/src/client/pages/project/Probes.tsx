import type { JSX } from "@solidjs/web";
import { LIMITS } from "../../health";
import { TimeChart } from "../../components/TimeChart";
import { Widget } from "../../components/ui";
import { AXIS_WIDTH, PanelLabel, SERIES_COLORS } from "../host/shared";
import { endpointText, metricPoints, milliseconds, type ProjectData } from "./series";

export function ProbesWidget(props: { readonly data: ProjectData }): JSX.Element {
  const history = () => props.data.probes;
  const colorAt = (index: number) => SERIES_COLORS[index % SERIES_COLORS.length] ?? "neutral";
  return (
    <Widget id="endpoints" title="Endpoints" subtitle="Probed from Cloudflare's edge once per collection, not measured from users" expandable>
      {history() === undefined ? null : (
        <>
          <PanelLabel>Availability: 1 is up, 0 is down</PanelLabel>
          <TimeChart
            label="Endpoint availability"
            compact
            legend="inline"
            timeAxis={false}
            yAxisWidth={AXIS_WIDTH}
            series={props.data.probeNames.map((name, index) => ({ label: name, color: colorAt(index), points: metricPoints(history()!, `probe.${name}.up`) }))}
            format={endpointText}
            limits={LIMITS.probeUp}
            min={0}
            max={1}
            stepMs={history()!.stepMs}
          />
          <PanelLabel>Response time of the probe request</PanelLabel>
          <TimeChart
            label="Endpoint response time"
            compact
            legend="inline"
            yAxisWidth={AXIS_WIDTH}
            series={props.data.probeNames.map((name, index) => ({ label: name, color: colorAt(index), scored: false, points: metricPoints(history()!, `probe.${name}.ms`) }))}
            format={milliseconds}
            min={0}
            stepMs={history()!.stepMs}
          />
        </>
      )}
    </Widget>
  );
}
