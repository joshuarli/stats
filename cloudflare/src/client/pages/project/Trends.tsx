import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Project } from "../../api";
import { bytes, count, milliseconds } from "../../format";
import { metricTrack, type ProjectHistories } from "../../history";
import { ratio } from "../../math.ts";
import { PanelChart, PanelLabel } from "../host/shared";
import { provisionalFromMs } from "./series";

export function Trends(props: { readonly project: Project; readonly histories: ProjectHistories }): JSX.Element {
  const worker = () => props.histories.worker;
  const common = () => ({
    min: 0,
    compact: true,
    stepMs: worker().stepMs,
    ...(worker().range === undefined ? {} : { provisionalFromMs: provisionalFromMs(worker()) })
  });
  const calls = () => metricTrack(worker(), "worker.invocations");
  const probe = () => props.project.probes[0];
  const bucket = () => props.project.buckets[0];
  return (
    <div class="projects-trends">
      <div><PanelLabel>Requests</PanelLabel><PanelChart label={`${props.project.name} requests`} area series={[{ label: "requests", color: "blue", track: calls() }]} format={count} {...common()} /></div>
      <div><PanelLabel>CPU per request</PanelLabel><PanelChart label={`${props.project.name} CPU per request`} series={[{ label: "CPU/request", color: "violet", track: ratio(metricTrack(worker(), "worker.cpuMsSum"), calls(), 1, 1) }]} format={milliseconds} {...common()} /></div>
      <div><PanelLabel>5xx responses</PanelLabel><PanelChart label={`${props.project.name} 5xx`} area series={[{ label: "5xx", color: "critical", track: metricTrack(worker(), "worker.status.5xx") }]} format={count} {...common()} /></div>
      <Show when={probe()} fallback={
        <Show when={bucket()}>{name => (
          <div><PanelLabel>{name()} stored</PanelLabel><PanelChart label={`${name()} stored`} area series={[{ label: "stored", color: "aqua", track: metricTrack(props.histories.r2, `r2.${name()}.storageBytes`) }]} format={bytes} min={0} compact stepMs={props.histories.r2.stepMs} /></div>
        )}</Show>
      }>{target => {
        const probes = props.histories.probes;
        return probes === undefined ? null : <div><PanelLabel>{target().name} response time</PanelLabel><PanelChart label={`${target().name} response time`} series={[{ label: target().name, color: "aqua", track: metricTrack(probes, `probe.${target().name}.ms`) }]} format={milliseconds} min={0} compact stepMs={probes.stepMs} /></div>;
      }}</Show>
    </div>
  );
}
