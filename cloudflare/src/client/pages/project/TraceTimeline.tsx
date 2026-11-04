import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { InvocationSummary, Occurrence, TraceDetail } from "../../../observe/core/store";
import { isInApp } from "../../../observe/core/stack";
import { Icon } from "../../components/Icon";
import { Badge } from "../../components/ui";
import { Waterfall, WaterfallSummary, type WaterfallRow } from "../../components/Waterfall";

const MIN_VIEW_MS = 0.5;
const WORKER_COLOR = 0;
const OBJECT_COLOR = 2;

interface Step {
  readonly invocation: InvocationSummary;
  readonly startMs: number;
  readonly endMs: number;
  readonly depth: number;
  readonly errors: readonly Occurrence[];
  readonly failed: boolean;
}

interface Layout {
  readonly steps: readonly Step[];
  readonly spanMs: number;
  readonly originMs: number;
}

export function layoutTrace(detail: TraceDetail): Layout {
  const originMs = Math.min(...detail.invocations.map(invocation => invocation.atMs));
  const errorsByKey = new Map<string, Occurrence[]>();
  for (const occurrence of detail.occurrences) errorsByKey.set(occurrence.invocationKey, [...errorsByKey.get(occurrence.invocationKey) ?? [], occurrence]);
  const byStart = (a: InvocationSummary, b: InvocationSummary) => a.atMs - b.atMs || b.wallMs - a.wallMs;
  const workers = detail.invocations.filter(invocation => invocation.stage === "worker").sort(byStart);
  const objects = detail.invocations.filter(invocation => invocation.stage === "object").sort(byStart);
  const step = (invocation: InvocationSummary, depth: number): Step => {
    const errors = errorsByKey.get(invocation.key) ?? [];
    const startMs = invocation.atMs - originMs;
    return { invocation, startMs, endMs: startMs + invocation.wallMs, depth, errors, failed: invocation.failed || errors.length > 0 };
  };
  const steps = [...workers.map(invocation => step(invocation, 0)), ...objects.map(invocation => step(invocation, workers.length > 0 ? 1 : 0))];
  return { steps, spanMs: Math.max(1, ...steps.map(entry => entry.endMs)), originMs };
}

export function duration(ms: number): string {
  if (ms < 1) return ms === 0 ? "0 ms" : `${ms.toFixed(ms < 0.1 ? 2 : 1)} ms`;
  if (ms < 1000) return `${Math.round(ms * 10) / 10} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

const SHORTCUTS: readonly [string, string][] = [["W", "zoom in"], ["S", "zoom out"], ["A", "pan left"], ["D", "pan right"], ["F", "fit"], ["↑↓", "step"]];

function stepNote(invocation: InvocationSummary): string {
  return invocation.stage === "worker" ? "Worker" : `Durable Object${invocation.objectId === null ? "" : ` ${invocation.objectId.slice(0, 8)}`}`;
}

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
  let root: HTMLDivElement | undefined;

  createEffect(() => props.detail.traceId, () => { setView(fit()); });

  const viewSpan = () => view()[1] - view()[0];
  const steps = () => layout().steps;
  const selectedStep = createMemo(() => layout().steps.find(entry => entry.invocation.key === props.selected) ?? null);
  const costliest = createMemo(() => layout().steps.reduce<Step | undefined>((best, entry) => best === undefined || entry.invocation.cpuMs > best.invocation.cpuMs ? entry : best, undefined));
  const stats = createMemo(() => {
    const top = costliest();
    return [
      { label: "Total wall", value: duration(layout().spanMs), note: `${steps().length} ${steps().length === 1 ? "invocation" : "invocations"}` },
      { label: "Total CPU", value: duration(steps().reduce((sum, entry) => sum + entry.invocation.cpuMs, 0)) },
      { label: "Most CPU", value: top?.invocation.label ?? "—", note: top === undefined ? undefined : duration(top.invocation.cpuMs) }
    ];
  });
  const rows = createMemo((): WaterfallRow[] => {
    const top = steps().length > 1 && (costliest()?.invocation.cpuMs ?? 0) > 0 ? costliest() : undefined;
    return steps().map(entry => ({
      id: entry.invocation.key,
      label: entry.invocation.label,
      note: stepNote(entry.invocation),
      tag: entry === top ? "TOP" : undefined,
      depth: entry.depth,
      from: entry.startMs,
      to: entry.endMs,
      color: entry.invocation.stage === "worker" ? WORKER_COLOR : OBJECT_COLOR,
      failed: entry.failed,
      values: [duration(entry.invocation.wallMs), duration(entry.invocation.cpuMs)],
      detail: () => <StepDetail step={entry} traceId={props.detail.traceId} />
    }));
  });
  const reveal = (entry: Step) => {
    const [from, to] = view();
    if (entry.endMs >= from && entry.startMs <= to) return;
    const span = to - from;
    const center = (entry.startMs + Math.min(entry.endMs, entry.startMs + span)) / 2;
    setView([center - span / 2, center + span / 2]);
  };
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
    const entry = selectedStep();
    if (entry === null) { setView(fit()); return; }
    const span = Math.max(MIN_VIEW_MS * 4, entry.endMs - entry.startMs);
    setView([entry.startMs - span * 0.25, entry.endMs + span * 0.25]);
  };
  const move = (delta: number) => {
    const list = steps();
    if (list.length === 0) return;
    const index = list.findIndex(entry => entry.invocation.key === props.selected);
    const next = list[index === -1 ? 0 : Math.min(list.length - 1, Math.max(0, index + delta))];
    if (next === undefined) return;
    props.onSelect(next.invocation.key);
    reveal(next);
    queueMicrotask(() => root?.querySelector<HTMLButtonElement>(`[data-key="${next.invocation.key}"]`)?.focus());
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    const action = ({ w: () => zoom(0.7), s: () => zoom(1 / 0.7), a: () => pan(-0.15), d: () => pan(0.15), f: focusSelection, arrowdown: () => move(1), arrowup: () => move(-1), escape: () => props.onSelect(null) } as Record<string, (() => void) | undefined>)[key];
    if (action === undefined) return;
    event.preventDefault();
    action();
  };
  const onWheel = (event: WheelEvent) => {
    const bounds = root?.querySelector(".wf-axis-head")?.getBoundingClientRect();
    if (bounds === undefined) return;
    const anchorMs = view()[0] + ((event.clientX - bounds.left) / bounds.width) * viewSpan();
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoom(event.deltaY > 0 ? 1.15 : 1 / 1.15, anchorMs);
    } else if (event.shiftKey) {
      event.preventDefault();
      pan((event.deltaY + event.deltaX) / bounds.width);
    }
  };

  return (
    <div class="tl" role="group" aria-label="Trace timeline" tabindex="0" ref={element => { root = element; }} onKeyDown={onKeyDown} onWheel={onWheel}>
      <div class="tl-toolbar">
        <div class="tl-zoom" role="toolbar" aria-label="Timeline zoom">
          <button class="btn btn-small btn-icon" type="button" aria-label="Zoom out" onClick={() => zoom(1 / 0.7)}>−</button>
          <button class="btn btn-small btn-icon" type="button" aria-label="Zoom in" onClick={() => zoom(0.7)}>+</button>
          <button class="btn btn-small" type="button" onClick={() => setView(fit())}>Fit</button>
        </div>
        <span class="tl-span">{duration(viewSpan())} visible</span>
        <span class="tl-keys" aria-hidden="true"><For each={SHORTCUTS}>{([key, label]) => <span title={label}><kbd>{key}</kbd></span>}</For></span>
      </div>
      <WaterfallSummary stats={stats()} />
      <Waterfall
        label="Trace invocations"
        stepLabel="Invocation"
        columns={["Wall", "CPU"]}
        axis={{ from: view()[0], to: view()[1], format: duration }}
        rows={rows()}
        expanded={props.selected}
        onExpand={props.onSelect}
      />
    </div>
  );
}

const STAMP = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

function StepDetail(props: { readonly step: Step; readonly traceId: string }): JSX.Element {
  const invocation = () => props.step.invocation;
  const facts = (): [string, string][] => [
    ["Start", `+${duration(props.step.startMs)} · ${STAMP.format(invocation().atMs)}`],
    ["Wall time", duration(invocation().wallMs)],
    ["CPU time", `${duration(invocation().cpuMs)} for the whole invocation`],
    ["Outcome", invocation().outcome + (invocation().status === null ? "" : ` · HTTP ${invocation().status}`)],
    ["Kind", `${invocation().stage === "worker" ? "Worker" : "Durable Object"} ${invocation().kind}`],
    ...(invocation().objectId === null ? [] : [["Object", invocation().objectId ?? ""] as [string, string]]),
    ["Version", invocation().version ?? "unknown"],
    ["Trace", props.traceId]
  ];
  const first = () => props.step.errors[0];
  return (
    <div role="region" aria-label="Current selection">
      <Show when={props.step.failed}>
        <div class="wf-callout">
          <Icon name="alert" size={15} />
          <Show when={first()} fallback={<span>Failed with no captured exception.</span>}>
            {error => (
              <span>
                <b>{error().name}</b>{error().message === null ? "" : `: ${error().message}`}
                <Show when={props.step.errors.length > 1}> (+{props.step.errors.length - 1} more)</Show>
              </span>
            )}
          </Show>
        </div>
      </Show>
      <div class="wf-panels">
        <section class="wf-panel" aria-label="Invocation">
          <h3 class="wf-panel-title">Invocation</h3>
          <dl class="kv">
            <For each={facts()}>{([key, value]) => <><dt>{key}</dt><dd class={key === "Object" || key === "Trace" || key === "Version" ? "mono" : undefined}>{value}</dd></>}</For>
          </dl>
        </section>
        <section class="wf-panel" aria-label="Errors">
          <h3 class="wf-panel-title">Errors</h3>
          <Show when={props.step.errors.length > 0} fallback={<p class="cell-note">No errors in this invocation.</p>}>
            <For each={props.step.errors}>{error => <ErrorFrames occurrence={error} />}</For>
          </Show>
        </section>
      </div>
    </div>
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
        <For each={props.occurrence.frames}>{frame => {
          const shown = () => frame.original ?? frame;
          const generated = `${frame.file}:${frame.line}:${frame.column}`;
          return (
            <li class={isInApp(shown()) ? "in-app" : undefined} title={frame.original === null ? undefined : `bundle ${generated}`}>
              <span class="frame-fn">{shown().fn ?? frame.fn ?? "anonymous"}</span>
              <span class="frame-loc">
                {shown().file}:{shown().line}:{shown().column}
                <Show when={frame.original === null && isInApp(frame)}><span class="frame-unmapped" title="No source map is registered for this version">unmapped</span></Show>
              </span>
            </li>
          );
        }}</For>
      </ol>
    </div>
  );
}

export function TraceView(props: { readonly detail: TraceDetail; readonly selected: string | null; readonly onSelect: (key: string | null) => void }): JSX.Element {
  const failed = () => props.detail.invocations.some(invocation => invocation.failed) || props.detail.occurrences.length > 0;
  return (
    <>
      <div class="trace-head">
        <b>{props.detail.invocations.find(invocation => invocation.stage === "worker")?.label ?? "Root not received"}</b>
        <span class="cell-note mono">{props.detail.traceId}</span>
        <Badge tone={failed() ? "bad" : "ok"} dot>{failed() ? "Failed" : "OK"}</Badge>
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
