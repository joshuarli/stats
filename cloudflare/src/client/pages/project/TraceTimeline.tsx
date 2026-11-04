import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { InvocationSummary, Occurrence, TraceDetail } from "../../../observe/core/store";
import { isInApp } from "../../../observe/core/stack";

const TRACK_HEIGHT = 26;
const SLICE_INSET = 3;
const PALETTE = 8;
const MIN_VIEW_MS = 0.5;

interface Slice {
  readonly invocation: InvocationSummary;
  readonly startMs: number;
  readonly endMs: number;
  readonly lane: number;
  readonly color: number;
  readonly errors: readonly Occurrence[];
}

interface Group {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly lanes: number;
  readonly slices: readonly Slice[];
}

interface Layout {
  readonly groups: readonly Group[];
  readonly spanMs: number;
  readonly originMs: number;
}

function hashColor(name: string): number {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index++) hash = Math.imul(hash ^ name.charCodeAt(index), 16777619);
  return (hash >>> 0) % PALETTE;
}

function sliceName(invocation: InvocationSummary): string {
  return invocation.stage === "object" ? invocation.label.replace(/^[A-Za-z]+[ .]/u, "") : invocation.label;
}

function pack(invocations: readonly InvocationSummary[], originMs: number, errorsByKey: ReadonlyMap<string, Occurrence[]>): { slices: Slice[]; lanes: number } {
  const ends: number[] = [];
  const slices = [...invocations].sort((a, b) => a.atMs - b.atMs || b.wallMs - a.wallMs).map(invocation => {
    const startMs = invocation.atMs - originMs;
    const endMs = startMs + invocation.wallMs;
    let lane = ends.findIndex(end => end <= startMs);
    if (lane === -1) lane = ends.push(endMs) - 1;
    else ends[lane] = endMs;
    return { invocation, startMs, endMs, lane, color: hashColor(sliceName(invocation)), errors: errorsByKey.get(invocation.key) ?? [] };
  });
  return { slices, lanes: Math.max(1, ends.length) };
}

export function layoutTrace(detail: TraceDetail): Layout {
  const originMs = Math.min(...detail.invocations.map(invocation => invocation.atMs));
  const errorsByKey = new Map<string, Occurrence[]>();
  for (const occurrence of detail.occurrences) errorsByKey.set(occurrence.invocationKey, [...errorsByKey.get(occurrence.invocationKey) ?? [], occurrence]);
  const workers = detail.invocations.filter(invocation => invocation.stage === "worker");
  const objects = new Map<string, InvocationSummary[]>();
  for (const invocation of detail.invocations) {
    if (invocation.stage !== "object") continue;
    const id = invocation.objectId ?? "unknown";
    objects.set(id, [...objects.get(id) ?? [], invocation]);
  }
  const groups: Group[] = [];
  if (workers.length > 0) {
    const packed = pack(workers, originMs, errorsByKey);
    groups.push({ id: "worker", title: "stats", subtitle: "Worker", lanes: packed.lanes, slices: packed.slices });
  }
  for (const [id, invocations] of objects) {
    const packed = pack(invocations, originMs, errorsByKey);
    const entrypoint = invocations[0]?.label.match(/^[A-Za-z]+/u)?.[0] ?? "Object";
    groups.push({ id: `object:${id}`, title: entrypoint, subtitle: `Durable Object ${id.slice(0, 8)}`, lanes: packed.lanes, slices: packed.slices });
  }
  const spanMs = Math.max(1, ...groups.flatMap(group => group.slices.map(slice => slice.endMs)));
  return { groups, spanMs, originMs };
}

function niceStep(rawMs: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(rawMs, 1e-3)));
  const scaled = rawMs / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}

export function duration(ms: number): string {
  if (ms < 1) return ms === 0 ? "0 ms" : `${ms.toFixed(ms < 0.1 ? 2 : 1)} ms`;
  if (ms < 1000) return `${Math.round(ms * 10) / 10} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

const SHORTCUTS: readonly [string, string][] = [["W", "zoom in"], ["S", "zoom out"], ["A", "pan left"], ["D", "pan right"], ["F", "fit"]];

export function TraceTimeline(props: {
  readonly detail: TraceDetail;
  readonly selected: string | null;
  readonly onSelect: (key: string | null) => void;
}): JSX.Element {
  const layout = createMemo(() => layoutTrace(props.detail));
  const fit = (): [number, number] => {
    const span = layout().spanMs;
    return [-span * 0.02, span * 1.04];
  };
  const [view, setView] = createSignal<[number, number]>(fit());
  const [hovered, setHovered] = createSignal<Slice | null>(null);
  let canvas: HTMLDivElement | undefined;
  const [canvasWidth, setCanvasWidth] = createSignal(0);
  const resize = new ResizeObserver(entries => { setCanvasWidth(entries[0]?.contentRect.width ?? 0); });
  onCleanup(() => resize.disconnect());

  createEffect(() => props.detail.traceId, () => { setView(fit()); });

  const viewSpan = () => view()[1] - view()[0];
  const x = (ms: number) => ((ms - view()[0]) / viewSpan()) * 100;
  const place = (slice: Slice) => {
    const left = x(slice.startMs);
    const right = x(slice.endMs);
    const visible = right >= 0 && left <= 100;
    const from = Math.max(0, left);
    return { visible, style: `left:${from}%;width:${Math.max(0, Math.min(100, right) - from)}%`, clipped: `${left < 0 ? " clip-start" : ""}${right > 100 ? " clip-end" : ""}` };
  };
  const reveal = (slice: Slice) => {
    const [from, to] = view();
    if (slice.endMs >= from && slice.startMs <= to) return;
    const span = to - from;
    const center = (slice.startMs + Math.min(slice.endMs, slice.startMs + span)) / 2;
    setView([center - span / 2, center + span / 2]);
  };
  const ticks = createMemo(() => {
    const [from, to] = view();
    const step = niceStep((to - from) / (canvasWidth() > 0 ? Math.max(2, Math.floor(canvasWidth() / 72)) : 8));
    const first = Math.ceil(from / step) * step;
    const values: number[] = [];
    for (let value = first; value <= to && values.length < 40; value += step) values.push(Math.round(value / step) * step);
    return values;
  });
  const slices = createMemo(() => layout().groups.flatMap(group => group.slices));
  const ordered = createMemo(() => [...slices()].sort((a, b) => a.startMs - b.startMs || a.lane - b.lane));
  const selectedSlice = createMemo(() => slices().find(slice => slice.invocation.key === props.selected) ?? null);
  const rootSlice = createMemo(() => layout().groups.find(group => group.id === "worker")?.slices[0] ?? null);

  const zoom = (factor: number, anchorMs = (view()[0] + view()[1]) / 2) => {
    const [from, to] = view();
    const span = Math.max(MIN_VIEW_MS, (to - from) * factor);
    const ratio = (anchorMs - from) / (to - from);
    setView([anchorMs - span * ratio, anchorMs + span * (1 - ratio)]);
  };
  const pan = (fraction: number) => {
    const shift = viewSpan() * fraction;
    setView(([from, to]) => [from + shift, to + shift]);
  };
  const focusSelection = () => {
    const slice = selectedSlice();
    if (slice === null) { setView(fit()); return; }
    const span = Math.max(MIN_VIEW_MS * 4, slice.endMs - slice.startMs);
    setView([slice.startMs - span * 0.25, slice.endMs + span * 0.25]);
  };
  const step = (delta: number) => {
    const list = ordered();
    if (list.length === 0) return;
    const index = list.findIndex(slice => slice.invocation.key === props.selected);
    const next = list[index === -1 ? 0 : Math.min(list.length - 1, Math.max(0, index + delta))];
    if (next === undefined) return;
    props.onSelect(next.invocation.key);
    reveal(next);
    queueMicrotask(() => canvas?.querySelector<HTMLButtonElement>(`[data-key="${next.invocation.key}"]`)?.focus());
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    const action = ({ w: () => zoom(0.7), s: () => zoom(1 / 0.7), a: () => pan(-0.15), d: () => pan(0.15), f: focusSelection, arrowright: () => step(1), arrowleft: () => step(-1), escape: () => props.onSelect(null) } as Record<string, (() => void) | undefined>)[key];
    if (action === undefined) return;
    event.preventDefault();
    action();
  };
  const onWheel = (event: WheelEvent) => {
    if (canvas === undefined) return;
    const bounds = canvas.getBoundingClientRect();
    const anchorMs = view()[0] + ((event.clientX - bounds.left) / bounds.width) * viewSpan();
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoom(event.deltaY > 0 ? 1.15 : 1 / 1.15, anchorMs);
    } else if (event.shiftKey) {
      event.preventDefault();
      pan((event.deltaY + event.deltaX) / bounds.width);
    }
  };
  const rows = createMemo(() => {
    let top = 0;
    return layout().groups.map(group => {
      const tracksTop = top;
      top += group.lanes * TRACK_HEIGHT;
      return { group, tracksTop };
    });
  });
  const height = createMemo(() => rows().reduce((sum, row) => sum + row.group.lanes * TRACK_HEIGHT, 0));
  const sliceTop = (tracksTop: number, lane: number) => tracksTop + lane * TRACK_HEIGHT + SLICE_INSET;
  const flows = createMemo(() => {
    const root = rootSlice();
    const rootRow = rows().find(row => row.group.id === "worker");
    if (root === null || rootRow === undefined) return [];
    return rows().filter(row => row.group.id !== "worker").flatMap(row => row.group.slices.map(slice => ({
      key: slice.invocation.key,
      atMs: slice.startMs,
      from: sliceTop(rootRow.tracksTop, root.lane) + TRACK_HEIGHT - 2 * SLICE_INSET,
      to: sliceTop(row.tracksTop, slice.lane)
    })));
  });

  return (
    <div class="tl" role="group" aria-label="Trace timeline" tabindex="0" onKeyDown={onKeyDown}>
      <div class="tl-toolbar">
        <div class="tl-zoom" role="toolbar" aria-label="Timeline zoom">
          <button class="btn btn-small btn-icon" type="button" aria-label="Zoom out" onClick={() => zoom(1 / 0.7)}>−</button>
          <button class="btn btn-small btn-icon" type="button" aria-label="Zoom in" onClick={() => zoom(0.7)}>+</button>
          <button class="btn btn-small" type="button" onClick={() => setView(fit())}>Fit</button>
        </div>
        <span class="tl-span">{duration(viewSpan())} visible</span>
        <span class="tl-keys" aria-hidden="true"><For each={SHORTCUTS}>{([key, label]) => <span title={label}><kbd>{key}</kbd></span>}</For></span>
      </div>
      <div class="tl-frame">
        <div class="tl-gutter-head" />
        <div class="tl-ruler" aria-hidden="true">
          <For each={ticks()}>{tick => <span class="tl-tick" style={`left:${x(tick)}%`}>{duration(tick)}</span>}</For>
        </div>
        <div class="tl-gutter" style={`height:${height()}px`}>
          <For each={rows()}>{row => (
            <For each={Array.from({ length: row.group.lanes }, (_, lane) => lane)}>{lane => (
              <span class={lane === 0 ? "tl-track-name first" : "tl-track-name"} style={`top:${row.tracksTop + lane * TRACK_HEIGHT}px`}>
                <Show when={lane === 0}>
                  <span class="tl-group-title">{row.group.title}</span>
                  <span class="tl-group-sub">{row.group.subtitle}</span>
                </Show>
              </span>
            )}</For>
          )}</For>
        </div>
        <div class="tl-canvas" style={`height:${height()}px`} ref={element => { canvas = element; resize.observe(element); }} onWheel={onWheel} onPointerLeave={() => setHovered(null)}>
          <For each={ticks()}>{tick => <span class="tl-grid" style={`left:${x(tick)}%`} />}</For>
          <For each={rows()}>{row => (
            <>
              <span class="tl-row-rule" style={`top:${row.tracksTop}px`} />
                <For each={row.group.slices}>{slice => {
                  const failed = () => slice.invocation.failed || slice.errors.length > 0;
                  const isSelected = () => props.selected === slice.invocation.key;
                  const placed = () => place(slice);
                  return (
                    <button
                      type="button"
                      data-key={slice.invocation.key}
                      hidden={!placed().visible}
                      class={`tl-slice c${slice.color}${failed() ? " failed" : ""}${isSelected() ? " selected" : ""}${placed().clipped}`}
                      style={`top:${sliceTop(row.tracksTop, slice.lane)}px;${placed().style}`}
                      tabindex={isSelected() || (props.selected === null && slice === rootSlice()) ? 0 : -1}
                      aria-pressed={isSelected() ? "true" : "false"}
                      aria-label={`${sliceName(slice.invocation)}, ${duration(slice.invocation.wallMs)} wall, starts at ${duration(slice.startMs)}${failed() ? ", failed" : ""}`}
                      onClick={() => props.onSelect(isSelected() ? null : slice.invocation.key)}
                      onPointerEnter={() => setHovered(slice)}
                      onFocus={() => setHovered(null)}
                    >
                      <span class="tl-slice-label">{sliceName(slice.invocation)}</span>
                      <span class="tl-slice-time">{duration(slice.invocation.wallMs)}</span>
                    </button>
                  );
                }}</For>
            </>
          )}</For>
          <For each={flows()}>{flow => (
            <span class="tl-flow" hidden={x(flow.atMs) < 0 || x(flow.atMs) > 100} style={`left:${x(flow.atMs)}%;top:${flow.from}px;height:${Math.max(0, flow.to - flow.from)}px`} aria-hidden="true" />
          )}</For>
          <Show when={hovered()}>{slice => (
            <div class="tl-tip" role="tooltip" style={`left:${Math.min(70, Math.max(0, x(slice().startMs)))}%;top:${(rows().find(row => row.group.slices.includes(slice()))?.tracksTop ?? 0) + slice().lane * TRACK_HEIGHT + TRACK_HEIGHT}px`}>
              <b>{slice().invocation.label}</b>
              <span>{duration(slice().invocation.wallMs)} wall · {duration(slice().invocation.cpuMs)} CPU · starts +{duration(slice().startMs)}</span>
            </div>
          )}</Show>
        </div>
      </div>
      <SelectionPanel slice={selectedSlice()} originMs={layout().originMs} traceId={props.detail.traceId} />
    </div>
  );
}

const STAMP = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

function SelectionPanel(props: { readonly slice: Slice | null; readonly originMs: number; readonly traceId: string }): JSX.Element {
  return (
    <section class="tl-details" aria-label="Current selection">
      <header class="tl-details-head"><span>Current selection</span></header>
      <Show when={props.slice} fallback={<p class="tl-details-empty">Select a slice to see its invocation. <kbd>←</kbd><kbd>→</kbd> step through slices.</p>}>
        {slice => {
          const invocation = () => slice().invocation;
          const rows = (): [string, string][] => [
            ["Name", invocation().label],
            ["Start", `+${duration(slice().startMs)} · ${STAMP.format(invocation().atMs)}`],
            ["Wall time", duration(invocation().wallMs)],
            ["CPU time", `${duration(invocation().cpuMs)} for the whole invocation`],
            ["Outcome", invocation().outcome + (invocation().status === null ? "" : ` · HTTP ${invocation().status}`)],
            ["Kind", `${invocation().stage === "worker" ? "Worker" : "Durable Object"} ${invocation().kind}`],
            ...(invocation().objectId === null ? [] : [["Object", invocation().objectId ?? ""] as [string, string]]),
            ["Version", invocation().version ?? "unknown"],
            ["Trace", props.traceId]
          ];
          return (
            <div class="tl-details-body">
              <dl class="kv">
                <For each={rows()}>{([key, value]) => <><dt>{key}</dt><dd class={key === "Object" || key === "Trace" || key === "Version" ? "mono" : undefined}>{value}</dd></>}</For>
              </dl>
              <div class="tl-details-errors">
                <Show when={slice().errors.length > 0} fallback={<p class="cell-note">{invocation().failed ? "Failed with no captured exception." : "No errors in this invocation."}</p>}>
                  <For each={slice().errors}>{error => <ErrorFrames occurrence={error} />}</For>
                </Show>
              </div>
            </div>
          );
        }}
      </Show>
    </section>
  );
}

export function ErrorFrames(props: { readonly occurrence: Pick<Occurrence, "name" | "message" | "operation" | "frames" | "source"> }): JSX.Element {
  return (
    <div class="frames">
      <div class="frames-head">
        <b>{props.occurrence.name}</b>
        <Show when={props.occurrence.operation}>{operation => <span class="op-tag">{operation()}</span>}</Show>
        <span class="cell-note">{props.occurrence.source}</span>
      </div>
      <p class={props.occurrence.message === null ? "frames-message withheld" : "frames-message"}>{props.occurrence.message ?? "Message withheld: only listed error types keep their text."}</p>
      <ol class="frames-list">
        <For each={props.occurrence.frames}>{frame => (
          <li class={isInApp(frame) ? "in-app" : undefined}>
            <span class="frame-fn">{frame.fn ?? "anonymous"}</span>
            <span class="frame-loc">{frame.file}:{frame.line}:{frame.column}</span>
          </li>
        )}</For>
      </ol>
    </div>
  );
}

export function TraceView(props: { readonly detail: TraceDetail; readonly selected: string | null; readonly onSelect: (key: string | null) => void }): JSX.Element {
  return (
    <>
      <div class="trace-head">
        <b>{props.detail.invocations.find(invocation => invocation.stage === "worker")?.label ?? "Root not received"}</b>
        <span class="cell-note mono">{props.detail.traceId}</span>
      </div>
      <Show when={!props.detail.rootPresent}><div class="notice notice-warn" role="status"><span>The Worker invocation that started this trace was not received, so it is incomplete.</span></div></Show>
      <Show when={props.detail.truncated}><div class="notice notice-warn" role="status"><span>Only the first 16 invocations are shown.</span></div></Show>
      <TraceTimeline detail={props.detail} selected={props.selected} onSelect={props.onSelect} />
      <p class="observe-footnote">Wall and CPU time are measured by the platform per invocation. CPU is a total for the invocation; where in the slice it was spent is not recorded.</p>
    </>
  );
}

export function defaultSlice(detail: TraceDetail): string | null {
  const failing = detail.invocations.find(invocation => detail.occurrences.some(occurrence => occurrence.invocationKey === invocation.key));
  return failing?.key ?? detail.invocations.find(invocation => invocation.stage === "worker")?.key ?? detail.invocations[0]?.key ?? null;
}
