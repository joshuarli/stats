import { createMemo, createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TimeWindow } from "../../chart-data";
import { count, dollars, dollarsPrecise } from "../../format";
import { Segmented, Widget } from "../../components/ui";
import { Waterfall, WaterfallSummary, type WaterfallRow } from "../../components/Waterfall";
import { stack } from "../../waterfall";
import { PanelLabel, PanelChart, seriesColor, SERIES_COLORS } from "../host/shared";
import { costParts, totalIn, type ProjectData } from "./series";

type CostView = "breakdown" | "over-time";

export function CostWidget(props: { readonly data: ProjectData; readonly view: TimeWindow | null }): JSX.Element {
  const [mode, setMode] = createSignal<CostView>("breakdown");
  const parts = () => costParts(props.data);
  const rows = createMemo(() => parts().map(part => ({ label: part.label, unit: part.unit, usage: totalIn(part.usage, props.view), cost: totalIn(part.points, props.view) })));
  const total = () => rows().reduce((sum, row) => sum + row.cost, 0);
  const top = createMemo(() => rows().reduce<ReturnType<typeof rows>[number] | undefined>((best, row) => best === undefined || row.cost > best.cost ? row : best, undefined));
  const waterfallRows = createMemo((): WaterfallRow[] => {
    const extents = stack(rows().map(row => row.cost));
    return rows().map((row, index) => ({
      id: row.label,
      label: row.label,
      tag: rows().length > 1 && total() > 0 && row === top() ? "TOP" : undefined,
      from: extents[index]?.from ?? 0,
      to: extents[index]?.to ?? 0,
      color: index % SERIES_COLORS.length,
      values: [`${count(row.usage)} ${row.unit}`, dollars(row.cost)]
    }));
  });
  return (
    <Widget
      id="cost"
      class="wide"
      title="Estimated cost"
      bodyClass="flush wf-body"
      expandable
      meta={<Segmented label="Cost view" value={mode()} options={[["breakdown", "Breakdown"], ["over-time", "Over time"]]} onChange={setMode} />}
    >
      <Show
        when={mode() === "breakdown"}
        fallback={
          <div class="wf-chart">
            <PanelLabel>Cost per bucket</PanelLabel>
            <PanelChart
              label="Estimated cost per bucket"
              series={parts().map((part, index) => ({ label: part.label, color: seriesColor(index), scored: false, track: part.points }))}
              format={dollarsPrecise}
              min={0}
              stepMs={props.data.worker.stepMs}
            />
          </div>
        }
      >
        <WaterfallSummary stats={[
          { label: "Total cost", value: dollars(total()), note: "list price" },
          { label: "Worker requests", value: count(rows()[0]?.usage) },
          { label: "Most expensive", value: top()?.label ?? "—", note: top() === undefined ? undefined : dollars(top()!.cost) }
        ]} />
        <Waterfall
          label="Estimated cost by component"
          stepLabel="Component"
          columns={["Usage", "Cost"]}
          valueWidth={128}
          axis={{ from: 0, to: total() > 0 ? total() : 1, format: dollarsPrecise }}
          rows={waterfallRows()}
        />
      </Show>
    </Widget>
  );
}
