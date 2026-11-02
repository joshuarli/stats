import type { JSX } from "@solidjs/web";
import { milliseconds } from "../../format";
import { LIMITS } from "../../health";

import { Widget } from "../../components/ui";
import { PanelLabel, seriesColor, PanelChart } from "../host/shared";
import { endpointText, metricPoints, type ProjectData } from "./series";

export function ProbesWidget(props: { readonly data: ProjectData }): JSX.Element {
  const history = () => props.data.probes;
  return (
    <Widget id="endpoints" title="Endpoints" expandable>
      {history() === undefined ? null : (
        <>
          <PanelChart
            label="Endpoint availability"
            timeAxis={false}
            series={props.data.probeNames.map((name, index) => ({ label: name, color: seriesColor(index), points: metricPoints(history()!, `probe.${name}.up`) }))}
            format={endpointText}
            limits={LIMITS.probeUp}
            min={0}
            max={1}
            stepMs={history()!.stepMs}
          />
          <PanelLabel>Response time</PanelLabel>
          <PanelChart
            label="Endpoint response time"
            series={props.data.probeNames.map((name, index) => ({ label: name, color: seriesColor(index), scored: false, points: metricPoints(history()!, `probe.${name}.ms`) }))}
            format={milliseconds}
            min={0}
            stepMs={history()!.stepMs}
          />
        </>
      )}
    </Widget>
  );
}
