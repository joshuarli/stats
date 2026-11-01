import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { incidentsNewestFirst, worstHealth } from "../../incidents";
import { clock, dateTime } from "../../format";
import { duration, HEALTH_GLYPH, HEALTH_LABEL } from "../../health";
import { useTelemetry } from "../../state";
import { Sparkline } from "../../components/Sparkline";
import { HealthMark, Widget } from "../../components/ui";
import type { MonitorCell } from "./monitors";

const MAX_INCIDENTS = 8;
const ZOOM_PAD_MS = 5 * 60_000;

function scrollTo(anchor: string): void {
  document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function StatusStrip(props: { readonly cells: readonly MonitorCell[]; readonly label?: string; readonly threeColumns?: boolean }): JSX.Element {
  return (
    <section class={props.threeColumns === true ? "status-strip status-strip-three" : "status-strip"} aria-label={props.label ?? "Host summary"}>
      <For each={props.cells}>
        {(cell) => {
          const health = () => cell.monitored.state?.health;
          const sinceBad = () => health() !== undefined && cell.monitored.state?.text !== "OK";
          return (
            <button class="strip-cell" type="button" onClick={() => scrollTo(cell.anchor)} aria-label={`${cell.label}: ${cell.format(cell.value)}. Jump to chart.`}>
              <span class="tile-label"><span>{cell.label}</span><HealthMark health={health()} /></span>
              <span class="tile-value">{cell.format(cell.value)}</span>
              <span class="tile-detail">{sinceBad() ? cell.monitored.state?.text : cell.detail}</span>
              <span class="tile-spark"><Sparkline points={cell.spark} label={`${cell.label} trend`} color={0} health={health()} /></span>
            </button>
          );
        }}
      </For>
    </section>
  );
}

export function IncidentTimeline(props: { readonly cells: readonly MonitorCell[] }): JSX.Element {
  const telemetry = useTelemetry();
  const incidents = () => incidentsNewestFirst(props.cells.map(cell => cell.monitored), MAX_INCIDENTS);
  const worst = () => worstHealth(props.cells.map(cell => cell.monitored));
  const subtitle = () => (incidents().length === 0 ? "nothing outside its limits in this window" : `${incidents().length} in this window, newest first`);
  return (
    <Widget id="incidents" bodyClass="flush" title="Incidents" subtitle={subtitle()} meta={<HealthMark health={worst()} showOk />}>
      <Show when={incidents().length > 0} fallback={<p class="incident-empty">Every monitored metric stayed inside its limits.</p>}>
        <ul class="incidents" aria-label="Incidents">
          <For each={incidents()}>
            {(incident) => (
              <li class="incident">
                <span class={`health health-${incident.peak}`}>
                  <span class="health-icon" aria-hidden="true">{HEALTH_GLYPH[incident.peak]}</span>
                  <span class="health-word">{HEALTH_LABEL[incident.peak]}</span>
                </span>
                <span class="incident-body">
                  <span class="incident-what">{incident.label}</span>
                  <span class="incident-when">
                    {dateTime(incident.startMs)}
                    {incident.endMs === null ? " · ongoing" : ` · ${duration(incident.endMs - incident.startMs)} · ended ${clock(incident.endMs)}`}
                  </span>
                </span>
                <button
                  class="btn btn-secondary btn-small"
                  type="button"
                  onClick={() => {
                    telemetry.zoomTo({ fromMs: incident.startMs - ZOOM_PAD_MS, toMs: (incident.endMs ?? incident.startMs + 10 * 60_000) + ZOOM_PAD_MS });
                    scrollTo(incident.anchor);
                  }}
                >
                  Zoom
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Widget>
  );
}
