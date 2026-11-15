import { createMemo, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { EmptyState } from "@laputa-systems/ui-dashboard";
import type { ApplicationSummary } from "../../../observe/application/telemetry";
import { Sparkline } from "../../components/Sparkline";
import { Widget } from "../../components/ui";
import { age, count, milliseconds, percent } from "../../format";
import { MIN_SCORED_EVENTS } from "../../health";
import { useTelemetry } from "../../state";
import { PanelChart } from "../host/shared";
import { applicationOverview } from "./native-overview";
import "./native-overview.css";
import { createUpdateEffect } from "../../effect";

export function ApplicationOverview(props: {
  readonly data: ApplicationSummary;
  readonly refreshing: boolean;
  readonly loadedAtMs: number;
  readonly onRequests: () => void;
  readonly onErrors: () => void;
  readonly deployment: { readonly title: string; readonly atMs: number } | undefined;
  readonly onDeployments: () => void;
  readonly onReady?: (data: ApplicationSummary) => void;
}): JSX.Element {
  const { now } = useTelemetry();
  const model = createMemo(() => applicationOverview(props.data));
  let drawnVersion: ApplicationSummary | undefined;
  const drawn = new Set<string>();
  const chartDrawn = (chart: string) => {
    const data = props.data;
    if (drawnVersion !== data) { drawnVersion = data; drawn.clear(); }
    drawn.add(chart);
    if (drawn.size === 3) props.onReady?.(data);
  };
  onSettled(() => { if (model().events === 0) props.onReady?.(props.data); });
  createUpdateEffect(() => props.data, data => { if (model().events === 0) props.onReady?.(data); });
  const time = (atMs: number) => new Date(atMs).toLocaleString();
  const historical = () => props.loadedAtMs - props.data.toMs > 30_000;
  const perMinute = (value: number | undefined) => `${count(value)}/min`;
  return <div class="native-overview" aria-busy={props.refreshing ? "true" : "false"} data-from-ms={props.data.fromMs} data-to-ms={props.data.toMs}>
    <Widget title="Application overview" meta={props.refreshing ? "Refreshing" : `Updated ${age(props.loadedAtMs, now())}`}>
      <div class="native-health-line">
        <span class={`native-state ${model().needsAttention ? "needs-attention" : ""}`}>
          <span aria-hidden="true">●</span>
          {model().needsAttention ? "Attention needed" : model().events > 0 ? "No failures reported" : "No activity reported"}
        </span>
        <Show when={props.data.openIssues > 0}>
          <button type="button" class="native-text-link" onClick={props.onErrors}>Review {count(props.data.openIssues)} open {props.data.openIssues === 1 ? "issue" : "issues"}</button>
        </Show>
        <Show when={model().http && model().failed > model().failures}>
          <button type="button" class="native-text-link" onClick={props.onRequests}>{count(model().failed - model().failures)} other unsuccessful application events</button>
        </Show>
        <Show when={props.data.totals}>
          {total => <span class="cell-note">Last event {age(total().lastAtMs, now())}</span>}
        </Show>
      </div>
      <div class="native-diagnosis" aria-label="Investigation context">
        <Show when={model().firstFailure}>{bucket => <div>First {model().http ? "server errors" : "failures"} observed in bucket starting {time(bucket().atMs)} (bucket width {milliseconds(props.data.stepMs)}). <button type="button" class="native-text-link" onClick={props.onRequests}>Investigate events →</button></div>}</Show>
        <Show when={model().latencyChange}>{change => <div>Mean wall time rose to {milliseconds(change().meanMs)} across {count(change().count)} events at {time(change().atMs)}. The first measured bucket at {time(change().baselineAtMs)} averaged {milliseconds(change().baselineMeanMs)} across {count(change().baselineCount)} events (bucket width {milliseconds(props.data.stepMs)}). <button type="button" class="native-text-link" onClick={props.onRequests}>Investigate events →</button></div>}</Show>
        <div>{historical() ? "Historical window" : "Current window"}: <Show when={props.data.totals} fallback="No event time available">{total => <>last event {time(total().lastAtMs)}{!historical() && now() - total().lastAtMs > Math.max(props.data.stepMs * 2, 60_000) ? " · Activity may be stale" : ""}</>}</Show></div>
        <Show when={props.deployment}>{deployment => <div>Latest deployment: {deployment().title} · {time(deployment().atMs)} <button type="button" class="native-text-link" onClick={props.onDeployments}>View deployments →</button></div>}</Show>
      </div>
      <div class="native-summary-strip" aria-label="Project summary">
        <button type="button" class="native-summary-item" onClick={props.onRequests}>
          <span class="native-summary-label">{model().http ? "HTTP requests" : "Application events"}</span>
          <strong>{count(model().count)}</strong>
          <span class="cell-note">In the selected window</span>
          <Sparkline series={[{ values: model().traffic.values }]} times={model().traffic.times} label="Activity trend" zeroBased />
        </button>
        <button type="button" class="native-summary-item" onClick={props.onRequests}>
          <span class="native-summary-label">{model().http ? "Server errors" : "Failed work"}</span>
          <strong>{model().events === 0 ? "—" : count(model().failures)}</strong>
          <span class="cell-note">{model().http && model().count >= MIN_SCORED_EVENTS ? `${percent(model().errorPercent ?? undefined)} of requests` : model().http ? "HTTP 5xx responses" : "Cancellations excluded"}</span>
          <Sparkline series={[{ values: model().failureTrack.values }]} times={model().failureTrack.times} label="Failure trend" zeroBased />
        </button>
        <button type="button" class="native-summary-item" onClick={props.onRequests}>
          <span class="native-summary-label">Mean wall time</span>
          <strong>{milliseconds(model().meanMs ?? undefined)}</strong>
          <span class="cell-note">{model().http ? "Per HTTP response" : "Per application event"}</span>
          <Sparkline series={[{ values: model().mean.values }]} times={model().mean.times} label="Latency trend" zeroBased />
        </button>
        <button type="button" class="native-summary-item" onClick={props.onErrors}>
          <span class="native-summary-label">Open issues</span>
          <strong>{count(props.data.openIssues)}</strong>
          <span class="cell-note">Current issue state</span>
          <span class="native-summary-note">{props.data.openIssues > 0 ? "Review errors and diagnostics →" : "No open issues"}</span>
        </button>
      </div>
    </Widget>
    <Show when={model().events > 0} fallback={<Widget title="Activity"><EmptyState title="No application events in this window" detail="Choose a wider range or wait for this service to report activity." /></Widget>}>
      <div class="native-overview-charts">
        <Widget title={model().http ? "Request traffic" : "Application activity"} expandable>
          <PanelChart label={model().http ? "HTTP requests per minute" : "Application events per minute"} area series={[{ label: model().http ? "requests" : "events", color: "blue", track: model().traffic }]} format={perMinute} min={0} stepMs={props.data.stepMs} onDraw={() => chartDrawn("traffic")} />
        </Widget>
        <Widget title={model().http ? "Server errors" : "Failed work"} expandable>
          <PanelChart label={model().http ? "HTTP server errors over time" : "Application failures over time"} series={[{ label: model().http ? "5xx" : "failed", color: "critical", track: model().failureTrack }]} format={count} min={0} stepMs={props.data.stepMs} onDraw={() => chartDrawn("errors")} />
        </Widget>
        <Widget title={model().http ? "Response latency" : "Work duration"} expandable>
          <PanelChart label={model().http ? "HTTP response wall time" : "Application work wall time"} series={[{ label: "mean", color: "blue", track: model().mean }, { label: "maximum", color: "violet", track: model().maximum }]} format={milliseconds} min={0} stepMs={props.data.stepMs} onDraw={() => chartDrawn("latency")} />
        </Widget>
      </div>
      <Widget title="Where time goes" meta="Observed wall time">
        <ol class="native-operation-list">
          <For each={model().operations}>{operation => <li>
            <div class="native-operation-line"><span title={operation.operation}>{operation.label}</span><strong>{milliseconds(operation.wallMs)}</strong></div>
            <div class="native-operation-bar" aria-hidden="true"><span style={{ width: `${operation.widthPercent}%` }} /></div>
            <div class="native-operation-detail"><span>{count(operation.count)} {model().http ? "requests" : "events"} · {milliseconds(operation.meanMs)} mean</span><Show when={operation.failures > 0}><span>{count(operation.failures)} {model().http ? "server errors" : "failed"}</span></Show></div>
          </li>}</For>
        </ol>
        <Show when={model().omittedOperations > 0 || model().truncatedOperations}><p class="cell-note">Showing five operations from the busiest 20.</p></Show>
        <p class="cell-note">Elapsed time includes waits and overlapping work. It is not CPU time or billing.</p>
        <button type="button" class="native-text-link" onClick={props.onRequests}>Explore recent events →</button>
      </Widget>
    </Show>
  </div>;
}
