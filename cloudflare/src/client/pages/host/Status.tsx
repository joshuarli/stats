import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { HEALTH_LABEL } from "../../health";
import { LimitGauge } from "../../components/LimitGauge";
import { Sparkline } from "../../components/Sparkline";
import { HealthMark, jumpTo, MetricValue } from "../../components/ui";
import { useTelemetry } from "../../state";
import type { MonitorCell } from "./monitors";

export function StatusStrip(props: { readonly cells: readonly MonitorCell[]; readonly label?: string; readonly class?: string }): JSX.Element {
  const { range, setRange } = useTelemetry();
  const present = () => props.cells.filter(cell => cell.value !== undefined);
  const absent = () => props.cells.filter(cell => cell.value === undefined);
  const columns = () => present().length + (absent().length > 0 ? 1 : 0);
  return (
    <section class={props.class === undefined ? "status-strip" : `status-strip ${props.class}`} style={`--cells:${columns()}`} aria-label={props.label ?? "Host summary"}>
      <For each={present()}>
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
              onClick={() => jumpTo(cell.anchor)}
              aria-label={`${cell.label}: ${cell.format(cell.value)}.${stateNote()} Jump to chart.`}
            >
              <span class="tile-label"><span>{cell.label}</span><HealthMark health={health()} showOk labelled /></span>
              <span class="tile-value"><MetricValue text={cell.format(cell.value)} /></span>
              {limits() === undefined ? null : <LimitGauge value={cell.value} limits={limits()!} health={health()} format={cell.format} />}
              <span class="tile-detail">{cell.detail}</span>
              <span class="tile-spark"><Sparkline series={[{ values: cell.spark }]} label={`${cell.label} trend`} zeroBased health={health()} /></span>
            </button>
          );
        }}
      </For>
      <Show when={absent().length > 0}>
        <div class="strip-cell strip-absent">
          <span class="tile-label">No data in this range</span>
          <span class="strip-absent-links">
            <For each={absent()}>{(cell) => <button class="link" type="button" onClick={() => jumpTo(cell.anchor)}>{cell.label}</button>}</For>
          </span>
          <Show when={range() === "1h" || range() === "6h"}>
            <button class="btn btn-small strip-absent-action" type="button" onClick={() => setRange("24h")}>Show 24h</button>
          </Show>
        </div>
      </Show>
    </section>
  );
}
