import { createEffect, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { getServiceHealth } from "../api";
import type { HealthBar, ServiceHealthHistory } from "../../core/installation/service-health-model";
import { errorMessage, milliseconds } from "../format";
import { useTelemetry } from "../state";
import { barState, selectedWindow, uptime } from "../service-metrics";
import "./health-bars.css";

function meanLatency(bars: readonly HealthBar[]): number | null {
  const measured = bars.filter(bar => bar.meanMs !== null);
  return measured.length === 0 ? null : measured.reduce((sum, bar) => sum + bar.meanMs!, 0) / measured.length;
}

function describe(bar: HealthBar, stepMs: number): string {
  const range = `${new Date(bar.atMs).toLocaleString()} – ${new Date(bar.atMs + stepMs).toLocaleTimeString()}`;
  if (bar.probes === 0) return `${range}: no probe results`;
  const latency = bar.meanMs === null ? "" : `, ${milliseconds(bar.meanMs)} mean`;
  return `${range}: ${bar.up} of ${bar.probes} probes up${latency}`;
}

/** Loads one service's probe history for the selected window, keeping the last result through a failed refresh. */
export function createServiceHealth(service: () => string | null) {
  const { range, view, now, tick, manualTick } = useTelemetry();
  const [history, setHistory] = createSignal<ServiceHealthHistory | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let loaded: string | null = null;
  createEffect(() => ({ service: service(), range: range(), view: view(), refresh: `${tick()}:${manualTick()}` }), query => {
    if (query.service === null) return;
    const selection = `${query.service}:${query.range}:${query.view?.fromMs ?? ""}:${query.view?.toMs ?? ""}`;
    if (loaded !== selection) setHistory(null);
    const { fromMs, toMs } = selectedWindow(query.range, query.view, now());
    const controller = new AbortController();
    void getServiceHealth(query.service, fromMs, toMs, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      loaded = selection;
      setHistory(value);
      setError(null);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  });
  return { history, error };
}

export function HealthBars(props: { readonly history: ServiceHealthHistory; readonly label: string; readonly compact?: boolean | undefined }): JSX.Element {
  const percent = () => uptime(props.history.bars);
  const latency = () => meanLatency(props.history.bars);
  return (
    <div class={props.compact === true ? "health-bars compact" : "health-bars"}>
      <div class="health-bar-strip" role="img" aria-label={`${props.label}: ${percent() === null ? "no probe results" : `${percent()!.toFixed(2)}% of probes up`} in the selected window`}>
        <For each={props.history.bars}>{bar => <span class={`health-bar ${barState(bar)}`} title={describe(bar, props.history.stepMs)} />}</For>
      </div>
      <div class="health-bar-summary">
        <span>{percent() === null ? "no probes" : `${percent()!.toFixed(percent()! === 100 ? 0 : 2)}% up`}</span>
        <Show when={latency()}>{value => <span class="cell-note">{milliseconds(value())} mean</span>}</Show>
      </div>
    </div>
  );
}
