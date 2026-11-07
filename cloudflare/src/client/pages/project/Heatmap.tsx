import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Heatmap } from "../../../observe/core/store";
import type { ChartEvent } from "../../components/TimeChart";
import { axisTime, count } from "../../format";
import { duration, type Band } from "./Observe";

const RAMP = 5;

function edgeLabel(ms: number): string {
  return ms >= 1000 ? `${ms / 1000}s` : `${ms}`;
}

export function LatencyHeatmap(props: {
  readonly heatmap: Heatmap;
  readonly toMs: number;
  readonly band: Band | null;
  readonly events: readonly ChartEvent[];
  readonly onSelect: (band: Band | null) => void;
  readonly onMarker: (event: ChartEvent) => void;
}): JSX.Element {
  const span = createMemo(() => {
    const used = props.heatmap.cells.flatMap(cells => cells.flatMap((value, bin) => value > 0 ? [bin] : []));
    const last = props.heatmap.edges.length;
    if (used.length === 0) return { lo: 0, hi: last };
    return { lo: Math.max(0, Math.min(...used) - 1), hi: Math.min(last, Math.max(...used) + 1) };
  });
  const rows = () => span().hi - span().lo + 1;
  const rowOf = (bin: number) => span().hi - bin + 1;
  const columns = () => props.heatmap.cells.length;
  const max = createMemo(() => Math.max(1, ...props.heatmap.cells.flat()));
  const maxFailed = createMemo(() => Math.max(1, ...props.heatmap.failed));
  const spanMs = () => props.toMs - props.heatmap.fromMs;
  const bucketStart = (index: number) => props.heatmap.fromMs + index * props.heatmap.bucketMs;
  const lower = (bin: number) => bin === 0 ? 0 : props.heatmap.edges[bin - 1] ?? 0;
  const upper = (bin: number) => props.heatmap.edges[bin] ?? null;
  const yFor = (ms: number) => {
    const edges = props.heatmap.edges;
    const bin = edges.findIndex(edge => ms < edge);
    const index = bin === -1 ? edges.length : bin;
    const low = Math.max(1, lower(index));
    const high = upper(index) ?? low * 2;
    const fraction = Math.min(1, Math.max(0, Math.log(Math.max(ms, 1) / low) / Math.log(high / low)));
    return 100 - ((index - span().lo + fraction) / rows()) * 100;
  };
  const p95Path = createMemo(() => props.heatmap.p95WallMs.flatMap((value, index) => value === null ? [] : [`${((index + 0.5) / columns()) * 100},${yFor(value)}`]).join(" "));
  const shade = (value: number) => Math.min(RAMP, 1 + Math.floor((Math.log1p(value) / Math.log1p(max())) * (RAMP - 0.01)));
  const isSelected = (index: number, bin: number) => {
    const band = props.band;
    return band?.kind === "cell" && band.fromMs === bucketStart(index) && band.minWallMs === lower(bin);
  };
  const ticks = createMemo(() => Array.from({ length: 5 }, (_, index) => props.heatmap.fromMs + (spanMs() * index) / 4));
  const markers = createMemo(() => props.events.filter(event => event.atMs >= props.heatmap.fromMs && event.atMs <= props.toMs));
  const x = (ms: number) => ((ms - props.heatmap.fromMs) / spanMs()) * 100;
  return (
    <div class="heatmap" role="group" aria-label="Request duration over time">
      <span />
      <div class="heatmap-legend" aria-hidden="true">
        <span><i class="legend-p95" />p95</span>
        <span>fewer<i class="legend-ramp" />more requests</span>
        <span><i class="legend-failed" />failed</span>
      </div>
      <div class="heatmap-axis" aria-hidden="true">
        <For each={props.heatmap.edges}>{(edge, index) => <Show when={index() >= span().lo && index() < span().hi}><span style={`bottom:${((index() - span().lo + 1) / rows()) * 100}%`}>{edgeLabel(edge)}</span></Show>}</For>
        <span class="heatmap-unit">ms</span>
      </div>
      <div class="heatmap-plot">
        <div class="heatmap-grid" style={`grid-template-columns:repeat(${columns()},1fr);grid-template-rows:repeat(${rows()},1fr)`}>
          <For each={props.heatmap.cells}>{(cells, index) => (
            <For each={cells}>{(value, bin) => (
              <Show when={value > 0 && bin() >= span().lo && bin() <= span().hi}>
                <button
                  type="button"
                  class={`heatmap-cell r${shade(value)}${isSelected(index(), bin()) ? " selected" : ""}`}
                  style={`grid-column:${index() + 1};grid-row:${rowOf(bin())}`}
                  aria-label={`${count(value)} requests between ${duration(lower(bin()))} and ${upper(bin()) === null ? "more" : duration(upper(bin()) ?? 0)} at ${axisTime(bucketStart(index()), spanMs())}`}
                  aria-pressed={isSelected(index(), bin()) ? "true" : "false"}
                  onClick={() => props.onSelect(isSelected(index(), bin()) ? null : { kind: "cell", fromMs: bucketStart(index()), toMs: bucketStart(index()) + props.heatmap.bucketMs, minWallMs: lower(bin()), maxWallMs: upper(bin()) })}
                />
              </Show>
            )}</For>
          )}</For>
        </div>
        <svg class="heatmap-p95" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={p95Path()} vector-effect="non-scaling-stroke" />
        </svg>
        <For each={markers()}>{event => (
          <button type="button" class="heatmap-marker" style={`left:${x(event.atMs)}%`} title={event.label} aria-label={event.label} onClick={() => props.onMarker(event)}>
            <span>{event.label.replace(/^deploy /u, "")}</span>
          </button>
        )}</For>
      </div>
      <span />
      <div class="heatmap-failures" style={`grid-template-columns:repeat(${columns()},1fr)`} aria-hidden="true">
        <For each={props.heatmap.failed}>{value => <span style={value === 0 ? undefined : `opacity:${0.25 + 0.75 * (value / maxFailed())}`} class={value === 0 ? undefined : "failed"} />}</For>
      </div>
      <span />
      <div class="heatmap-time" aria-hidden="true">
        <For each={ticks()}>{(tick, index) => <span style={`left:${(index() / 4) * 100}%`}>{axisTime(tick, spanMs())}</span>}</For>
      </div>
    </div>
  );
}
