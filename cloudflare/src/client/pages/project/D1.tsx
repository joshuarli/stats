import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TimeWindow } from "../../chart-data";
import { count, dollars } from "../../format";
import { Widget } from "../../components/ui";
import { PanelLabel, PanelChart } from "../host/shared";
import { metricPoints, provisionalFromMs, statementRows, type ProjectData } from "./series";

export function D1Widget(props: { readonly data: ProjectData; readonly view: TimeWindow | null }): JSX.Element {
  const totals = () => props.data.d1;
  const statements = () => (props.data.d1Statements === undefined ? [] : statementRows(props.data.d1Statements, props.view));
  return (
    <Widget id="d1" title="D1" subtitle="Rows written and read across the project's databases, estimated from sampled queries" expandable>
      <Show when={totals()}>
        {(history) => (
          <>
            <PanelLabel>Rows written per bucket. Each costs about 1000 times a row read</PanelLabel>
            <PanelChart
              label="D1 rows written"
              area
              timeAxis={false}
              series={[{ label: "rows written", color: "critical", scored: false, points: metricPoints(history(), "d1.rowsWritten") }]}
              format={count}
              min={0}
              stepMs={history().stepMs}
              provisionalFromMs={provisionalFromMs(history())}
            />
            <PanelLabel>Rows read and queries per bucket</PanelLabel>
            <PanelChart
              label="D1 rows read and queries"
              series={[
                { label: "rows read", color: "blue", scored: false, points: metricPoints(history(), "d1.rowsRead") },
                { label: "queries", color: "aqua", scored: false, points: metricPoints(history(), "d1.queries") }
              ]}
              format={count}
              min={0}
              stepMs={history().stepMs}
              provisionalFromMs={provisionalFromMs(history())}
            />
          </>
        )}
      </Show>
      <Show when={statements().length > 0} fallback={<PanelLabel>No statement data was collected in this range</PanelLabel>}>
        <PanelLabel>The costliest statements at list price. Text is cut to 60 characters</PanelLabel>
        <div class="table-scroll flush-table">
          <table class="data-table compact" aria-label="D1 cost by statement">
            <thead>
              <tr>
                <th>Statement</th>
                <th class="numeric">List cost</th>
                <th class="numeric">Rows written</th>
                <th class="numeric">Rows read</th>
                <th class="numeric">Queries</th>
              </tr>
            </thead>
            <tbody>
              <For each={statements()}>
                {(row) => (
                  <tr>
                    <td>{row.statement}</td>
                    <td class="numeric">{dollars(row.cost)}</td>
                    <td class="numeric">{count(row.rowsWritten)}</td>
                    <td class="numeric">{count(row.rowsRead)}</td>
                    <td class="numeric">{count(row.queries)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Widget>
  );
}
