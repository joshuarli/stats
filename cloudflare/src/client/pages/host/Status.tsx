import { For } from "solid-js";
import type { JSX } from "@solidjs/web";
import { HEALTH_LABEL } from "../../health";
import { LimitGauge } from "../../components/LimitGauge";
import { Sparkline } from "../../components/Sparkline";
import { HealthMark, MetricValue, revealWidget } from "../../components/ui";
import type { MonitorCell } from "./monitors";

function scrollTo(anchor: string): void {
  revealWidget(anchor);
  requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

export function StatusStrip(props: { readonly cells: readonly MonitorCell[]; readonly label?: string }): JSX.Element {
  return (
    <section class="status-strip" style={`--cells:${props.cells.length}`} aria-label={props.label ?? "Host summary"}>
      <For each={props.cells}>
        {(cell) => {
          const health = () => cell.state;
          const stateNote = () => {
            const current = health();
            return current === undefined ? "" : ` ${HEALTH_LABEL[current]}.`;
          };
          const limits = () => (cell.limits !== undefined && cell.limits.direction === "above" ? cell.limits : undefined);
          return (
            <button
              class={`strip-cell${health() === "elevated" || health() === "critical" ? ` is-${health()}` : ""}`}
              type="button"
              onClick={() => scrollTo(cell.anchor)}
              aria-label={`${cell.label}: ${cell.format(cell.value)}.${stateNote()} Jump to chart.`}
            >
              <span class="tile-label"><span>{cell.label}</span><HealthMark health={health()} showOk labelled /></span>
              <span class="tile-value"><MetricValue text={cell.format(cell.value)} /></span>
              {limits() === undefined ? null : <LimitGauge value={cell.value} limits={limits()!} health={health()} format={cell.format} />}
              <span class="tile-detail">{cell.detail}</span>
              <span class="tile-spark"><Sparkline values={cell.spark} label={`${cell.label} trend`} zeroBased health={health()} /></span>
            </button>
          );
        }}
      </For>
    </section>
  );
}
