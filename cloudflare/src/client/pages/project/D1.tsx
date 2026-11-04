import { createMemo, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TimeWindow } from "../../chart-data";
import { bytes, count, dollars, dollarsPrecise } from "../../format";
import { Widget } from "../../components/ui";
import { Waterfall, WaterfallSummary, type WaterfallRow } from "../../components/Waterfall";
import { stack } from "../../waterfall";
import { PanelLabel, PanelChart, seriesColor } from "../host/shared";
import { holdLast } from "./math";
import { provisionalFromMs, statementRows, type ProjectData } from "./series";
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

export function D1StatementsWidget(props: { readonly data: ProjectData; readonly view: TimeWindow | null }): JSX.Element {
  const statements = createMemo(() => (props.data.d1Statements === undefined ? [] : statementRows(props.data.d1Statements, props.view)));
  const totalCost = () => statements().reduce((sum, row) => sum + row.cost, 0);
  const rowsWritten = () => statements().reduce((sum, row) => sum + row.rowsWritten, 0);
  const rows = createMemo((): WaterfallRow[] => {
    const extents = stack(statements().map(row => row.cost));
    return statements().map((row, index) => ({
      id: row.statement,
      label: row.statement,
      tag: index === 0 && statements().length > 1 && totalCost() > 0 ? "TOP" : undefined,
      from: extents[index]?.from ?? 0,
      to: extents[index]?.to ?? 0,
      color: 0,
      values: [dollars(row.cost), count(row.rowsWritten), count(row.rowsRead), count(row.queries)]
    }));
  });
  return (
    <Widget id="d1-statements" class="wide" title="D1 statements" bodyClass={statements().length > 0 ? "flush wf-body" : undefined} expandable>
      <Show when={statements().length > 0} fallback={<PanelLabel>No statement data was collected in this range</PanelLabel>}>
        <WaterfallSummary stats={[
          { label: "Total list cost", value: dollars(totalCost()) },
          { label: "Rows written", value: count(rowsWritten()) },
          { label: "Costliest statement", value: statements()[0]?.statement ?? "—", note: dollars(statements()[0]?.cost) }
        ]} />
        <Waterfall
          label="D1 cost by statement"
          stepLabel="Statement"
          columns={["List cost", "Written", "Read", "Queries"]}
          axis={{ from: 0, to: totalCost() > 0 ? totalCost() : 1, format: dollarsPrecise }}
          rows={rows()}
        />
      </Show>
    </Widget>
  );
}
