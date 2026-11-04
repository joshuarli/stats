import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { duration, windowIndexes, windowMean } from "../../chart-data";
import { percent } from "../../format";
import type { SummaryTable } from "../../history";
import { LIMITS } from "../../health";
import { useTelemetry } from "../../state";
import { PSI_WINDOWS, psiField, psiWindowLabel, type PsiGroup, type PsiWindow } from "../../psi";
import type { ChartEvent } from "../../components/TimeChart";
import { PanelChart, PanelLabel } from "./shared";

export function PsiWindowBar(props: { readonly value: PsiWindow; readonly onChange: (value: PsiWindow) => void }): JSX.Element {
  return (
    <div class="pressure-bar">
      <span class="pressure-bar-label">Pressure window</span>
      <div class="segmented" role="group" aria-label="Pressure average window">
        <For each={PSI_WINDOWS}>
          {(option) => (
            <button class="segment" type="button" aria-pressed={props.value === option.value ? "true" : "false"} onClick={() => props.onChange(option.value)}>
              {option.label}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

export function PressureChart(props: {
  readonly label: string;
  readonly table: SummaryTable;
  readonly group: PsiGroup;
  readonly window: PsiWindow;
  readonly stepMs: number;
  readonly events: readonly ChartEvent[];
  readonly timeAxis?: boolean | undefined;
}): JSX.Element {
  const { view, range } = useTelemetry();
  const statistics = createMemo(() => {
    const [first, last] = windowIndexes(props.table.times, view());
    return windowMean(props.table.cells(psiField(props.group, "some", props.window)), props.table.cells("coverageMs"), first, last);
  });
  const spanLabel = createMemo(() => {
    const current = view();
    return current === null ? range() : duration(current.toMs - current.fromMs);
  });
  return (
    <>
      <PanelLabel>{props.label}, {psiWindowLabel(props.window)} average</PanelLabel>
      <PanelChart
        label={props.label}
        area
        timeAxis={props.timeAxis}
        series={[
          { label: "some", color: "ramp-3", track: props.table.track(psiField(props.group, "some", props.window)) },
          { label: "full", color: "ramp-5", scored: false, track: props.table.track(psiField(props.group, "full", props.window)) }
        ]}
        format={percent}
        limits={LIMITS.pressureSome}
        min={0}
        events={props.events}
        stepMs={props.stepMs}
      />
      <p class="pressure-summary">
        <Show when={statistics()} fallback="No pressure data in this window.">
          {(stats) => <>{spanLabel()} mean {percent(stats().mean)} · peak {percent(stats().peak)}</>}
        </Show>
      </p>
    </>
  );
}
