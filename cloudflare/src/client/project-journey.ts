import type { JsonReadMeasurement } from "./api.ts";
import { readTimings } from "../observe/application/timing.ts";
import type { Range } from "./state.ts";

type Source = "navigation" | "range" | "refresh";
let intent: { readonly source: Source; readonly at: number } | null = null;
let navigated = false;
const documentStartedOnProject = typeof location !== "undefined" && location.hash.startsWith("#/project/");

export function noteProjectIntent(source: Source): void {
  intent = { source, at: performance.now() };
}

export function observeProjectNavigation(): () => void {
  const clicked = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (anchor === null) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin === location.origin && url.hash.startsWith("#/project/")) noteProjectIntent("navigation");
  };
  document.addEventListener("click", clicked, true);
  return () => document.removeEventListener("click", clicked, true);
}

export interface ProjectJourney {
  readonly schemaVersion: 1;
  readonly source: Source;
  readonly range: Range;
  readonly cache: boolean;
  readonly outcome: "ok" | "error" | "cancelled";
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly trace: { readonly traceId: string; readonly spanId: string };
  readonly work: Readonly<Record<string, number>>;
}

export function startProjectJourney(range: Range, options: { readonly navigation: boolean }) {
  const now = performance.now();
  const selected = intent !== null && now - intent.at < (intent.source === "navigation" ? 120_000 : 1000) ? intent : null;
  intent = null;
  const source = selected?.source ?? (options.navigation ? "navigation" : "refresh");
  const started = selected?.at ?? (options.navigation && !navigated && documentStartedOnProject ? 0 : now);
  navigated = true;
  const trace = { traceId: crypto.randomUUID().replaceAll("-", ""), spanId: crypto.randomUUID().replaceAll("-", "").slice(0, 16) };
  const work: Record<string, number> = {};
  const frames = new Set<number>();
  let cache = false, closed = false, paintPending = false, dataAt: number | undefined;
  let expected: { readonly fromMs: number; readonly toMs: number } | undefined;
  const us = (value: number) => Math.round(Math.max(0, value) * 1000);
  const frame = (run: () => void) => {
    const id = requestAnimationFrame(() => { frames.delete(id); if (!closed) run(); });
    frames.add(id);
  };
  const finish = (outcome: ProjectJourney["outcome"]) => {
    if (closed) return;
    closed = true;
    for (const id of frames) cancelAnimationFrame(id);
    frames.clear();
    const detail: ProjectJourney = { schemaVersion: 1, source, range, cache, outcome, startedAtMs: Math.round(performance.timeOrigin + started), durationMs: Math.max(0, performance.now() - started), trace, work };
    window.dispatchEvent(new CustomEvent<ProjectJourney>("stats:project-journey", { detail }));
  };
  return {
    trace,
    measured: (measurement: JsonReadMeasurement) => {
      if (closed) return;
      Object.assign(work, readTimings(measurement.serverTiming), { bootstrap_us: us(measurement.startedMs - started), fetch_us: us(measurement.fetchMs), body_us: us(measurement.bodyMs), decode_us: us(measurement.decodeMs) });
    },
    dataReady: (window: { readonly fromMs: number; readonly toMs: number }, cached: boolean) => {
      if (closed) return;
      expected = window;
      cache = cached;
      dataAt = performance.now();
      frame(() => { work["health_us"] = us(performance.now() - started); });
    },
    chartsReady: (window: { readonly fromMs: number; readonly toMs: number }) => {
      if (closed || paintPending || dataAt === undefined || window.fromMs !== expected?.fromMs || window.toMs !== expected.toMs) return;
      paintPending = true;
      frame(() => { work["render_us"] = us(performance.now() - dataAt!); finish("ok"); });
    },
    fail: () => finish("error"),
    cancel: () => finish("cancelled")
  };
}
