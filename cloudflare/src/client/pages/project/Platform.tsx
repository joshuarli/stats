import { createEffect, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { EmptyState, Skeleton } from "@laputa-systems/ui-dashboard";
import type { PlatformTelemetry } from "../../../../../packages/platform-bridge/src/contract.ts";
import { getPlatformTelemetry } from "../../api";
import { count, errorMessage } from "../../format";
import { Notice, Widget } from "../../components/ui";
import "./platform.css";

export default function Platform(props: { readonly windowAt: () => { fromMs: number; toMs: number }; readonly refreshKey: () => string; readonly selection: () => string; readonly now: () => number }): JSX.Element {
  const [data, setData] = createSignal<PlatformTelemetry | null>(null);
  const [disabled, setDisabled] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [selected, setSelected] = createSignal("");
  let loadedWindow: string | null = null;
  createEffect(() => ({ selection: props.selection(), refresh: props.refreshKey() }), query => {
    const controller = new AbortController();
    const window = props.windowAt();
    if (loadedWindow !== query.selection) { setData(null); setDisabled(false); }
    setError(null); setLoading(true);
    if (window.fromMs >= window.toMs) { setError("The selected window is outside telemetry retention."); setLoading(false); return; }
    void getPlatformTelemetry(window.fromMs, window.toMs, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setData(value); setDisabled(value === null); loadedWindow = query.selection; setLoading(false);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) { setError(errorMessage(failure)); setLoading(false); } });
    return () => controller.abort();
  });
  const selectedRow = () => data()?.operations.find(row => `${row.operation}\n${row.release}` === selected()) ?? data()?.operations[0];
  const delivery = () => { const report = data()?.delivery; return report && report.atMs <= props.now() && props.now() - report.atMs <= 90_000 ? report : null; };
  return <div class="platform">
    <Show when={error()}>{message => <Notice tone="warn">Platform telemetry: {message()}</Notice>}</Show>
    <Show when={loading() && data() === null && !disabled()}><Skeleton rows={3} /></Show>
    <Show when={disabled()}><EmptyState title="Platform bridge unavailable" detail="The optional bridge is disabled or unconfigured." /></Show>
    <Show when={data()}>{telemetry => <>
      <Widget title="Observed platform operations">
        <p class="cell-note">Sampled observations, not complete totals. Actor invocations and nested SQLite operations are separate and must not be added together. Exporter loss is unknown.</p>
        <p class="cell-note">Separate outbound RPC and runtime gauges are unavailable for this pinned path. <a href="/rivet">Shared Engine</a> has a separate scope.</p>
        <Show when={telemetry().truncated}><p class="cell-note">Some operation groups were omitted.</p></Show>
        <Show when={telemetry().operations.length} fallback={<EmptyState title="No observed platform operations" detail="No sampled operations were found in this window." />}>
          <div class="table-scroll"><table class="data-table" aria-label="Observed platform operations"><thead><tr><th>Operation</th><th>Source release</th><th>Observed</th><th>Failures</th><th>Mean µs</th><th>Max µs</th><th>p50 upper</th><th>p95 upper</th></tr></thead><tbody>
            <For each={telemetry().operations}>{row => <tr><td><button type="button" class="platform-select" onClick={() => setSelected(`${row.operation}\n${row.release}`)}>{row.operation.includes(".sqlite.") ? "Nested SQLite" : "Actor invocation"}: {row.operation.replace("platform.", "")}</button></td><td>{row.release}</td><td>{count(row.count)}</td><td>{count(row.failed)}</td><td>{row.meanUs.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td><td>{count(row.maxUs)}</td><td>≤ {count(row.p50UpperUs)} µs</td><td>≤ {count(row.p95UpperUs)} µs</td></tr>}</For>
          </tbody></table></div>
        </Show>
      </Widget>
      <Show when={selectedRow()}>{row => <Widget title="Duration histogram"><p class="cell-note">{row().operation} · {row().release} · bin upper bounds in µs</p><div class="platform-histogram"><For each={row().histogram}>{(bin, index) => <div class="platform-bin"><span>{index() === 0 ? "≤" : `> ${count(row().histogram[index() - 1]!.upperUs)} to ≤`} {count(bin.upperUs)} µs</span><span class="platform-bar" style={{ width: `${100 * bin.count / row().count}%` }} /><strong>{count(bin.count)}</strong></div>}</For></div></Widget>}</Show>
      <Widget title="Bridge delivery"><p class="cell-note">Counters accumulate for the current bridge process and reset when it restarts. Exporter loss remains unknown.</p><Show when={delivery()} fallback={<p>Delivery report unavailable or stale.</p>}>{report => <><p class="cell-note">Reported {new Date(report().atMs).toLocaleString()} · bridge release {report().release} · configured root sampling {count(report().samplePpm)} ppm · exporter loss unknown</p><div class="platform-delivery"><For each={(["received", "admitted", "filtered", "invalid", "dropped", "queued", "sent"] as const)}>{key => <div><span>{key}</span> <strong>{count(report()[key])}</strong></div>}</For></div></>}</Show></Widget>
    </>}</Show>
  </div>;
}
