import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ApiFailure } from "../../api";
import { age, count } from "../../format";
import { useTelemetry } from "../../state";
import { Badge, Skeleton, Widget, type Tone } from "../../components/ui";
import { decodeDeploymentComparison, decodeDeploymentHistory } from "../../../deployments/decode";
import type { Deployment, DeploymentHistory } from "../../../deployments/model";
import type { ComparisonWindow, DeploymentComparison, MetricComparison } from "../../../deployments/compare";
import "./deployments.css";

async function read<T>(path: string, signal: AbortSignal, decode: (value: unknown) => T): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { signal, credentials: "same-origin", cache: "no-store" }); }
  catch (cause) { throw new ApiFailure(0, "Deployment history request failed", cause); }
  if (!response.ok) throw new ApiFailure(response.status, `Deployment history unavailable (${response.status})`);
  try { return decode(await response.json()); }
  catch (cause) { throw new ApiFailure(0, "Invalid deployment history response", cause); }
}

function display(value: number | null, unit = ""): string {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: unit === "USD" ? 6 : 3 })}${unit === "USD" ? " USD" : unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
}

function signed(value: number, text: string): string {
  return value > 0 ? `+${text}` : text;
}

function change(metric: MetricComparison): { readonly amount: string; readonly share: string } {
  if (metric.delta === null) return { amount: "—", share: "" };
  if (metric.unit === "%") return { amount: `${signed(metric.delta, display(metric.delta))} pp`, share: "" };
  const share = metric.deltaPercent === null ? "" : signed(metric.deltaPercent, `${metric.deltaPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
  return { amount: signed(metric.delta, display(metric.delta, metric.unit)), share };
}

const VERDICT_TONE: Record<MetricComparison["verdict"], Tone> = {
  improved: "ok",
  regressed: "bad",
  unchanged: "neutral",
  "insufficient-data": "neutral",
  confounded: "warn"
};

const RANGE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const MOMENT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

function span(bounds: { readonly fromMs: number; readonly toMs: number }): string {
  return RANGE.formatRange(bounds.fromMs, bounds.toMs);
}

export type ProjectDeployments = ReturnType<typeof createProjectDeployments>;

export function createProjectDeployments(projectId: () => string, refreshKey: () => string) {
  const [history, setHistory] = createSignal<DeploymentHistory | null>(null);
  const [selected, setSelected] = createSignal("");
  const [window, setWindow] = createSignal<ComparisonWindow>("1h");
  const [comparison, setComparison] = createSignal<DeploymentComparison | null>(null);
  const [historyError, setHistoryError] = createSignal<string | null>(null);
  const [comparisonError, setComparisonError] = createSignal<string | null>(null);
  let loadedProject = "";

  createEffect(() => ({ project: projectId(), tick: refreshKey() }), ({ project }) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    if (loadedProject !== project) { setHistory(null); setSelected(""); setComparison(null); loadedProject = project; }
    void read(`/api/v1/projects/${encodeURIComponent(project)}/deployments`, controller.signal, value => decodeDeploymentHistory(value, project)).then(value => {
      if (controller.signal.aborted) return;
      setHistory(value);
      setHistoryError(null);
      setSelected(current => value.deployments.some(deployment => deployment.id === current) ? current : value.deployments[0]?.id ?? "");
    }).catch((error: unknown) => { if (!controller.signal.aborted) setHistoryError(error instanceof Error ? error.message : "Deployment history unavailable"); });
  });

  createEffect(() => ({ project: projectId(), id: selected(), window: window(), tick: refreshKey() }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    setComparisonError(null);
    if (query.id === "") { setComparison(null); return; }
    void read(`/api/v1/projects/${encodeURIComponent(query.project)}/deployments/${query.id}/comparison?window=${query.window}`, controller.signal, value => decodeDeploymentComparison(value, query.id, query.window)).then(value => {
      if (!controller.signal.aborted) setComparison(value);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setComparison(null);
      setComparisonError(error instanceof Error ? error.message : "Deployment comparison unavailable");
    });
  });

  const versions = createMemo(() => new Map((history()?.versions ?? []).map(version => [version.id, version])));
  const tag = (id: string) => versions().get(id)?.tag ?? id.slice(0, 8);
  const name = (deployment: Deployment) => deployment.versions.map(version => `${tag(version.id)} ${version.percentage}%`).join(" / ");
  const title = (deployment: Deployment) => deployment.versions.map(version => deployment.versions.length === 1 ? tag(version.id) : `${tag(version.id)} ${version.percentage}%`).join(" / ");
  const events = createMemo(() => (history()?.deployments ?? []).map(deployment => ({ atMs: deployment.atMs, label: `deploy ${name(deployment)}` })));
  const current = createMemo(() => history()?.deployments.find(deployment => deployment.id === selected()));
  const stale = () => {
    const value = comparison();
    return value !== null && (value.deploymentId !== selected() || value.window !== window());
  };
  const problem = (): string | null => {
    const value = history();
    if (value === null) return null;
    if (!value.enabled) return "Deployment tracking is disabled. Configure DEPLOYMENTS_ACCOUNT_ID and the read-only DEPLOYMENTS_API_TOKEN secret.";
    if (value.sync === null) return "Waiting for the first deployment poll.";
    if (value.sync.error !== null) return `Deployment polling failed: ${value.sync.error}. Previously collected history is retained.`;
    if (value.sync.truncated) return "Deployment backfill reached its limit; comparisons are withheld.";
    if (value.sync.lastSuccessAtMs === null || Date.now() - value.sync.lastSuccessAtMs > 15 * 60_000) return "Deployment history is stale; comparisons may be withheld.";
    return null;
  };

  return { history, selected, setSelected, window, setWindow, comparison, stale, historyError, comparisonError, name, title, events, current, problem };
}

function ComparisonTable(props: { readonly comparison: DeploymentComparison }): JSX.Element {
  return (
    <>
      <p class="deployment-windows">
        <span><b>Before</b> {span(props.comparison.before)} · {count(props.comparison.beforeInvocations ?? undefined)} invocations</span>
        <span><b>After</b> {span(props.comparison.after)} · {count(props.comparison.afterInvocations ?? undefined)} invocations</span>
      </p>
      <Show when={props.comparison.reasons.length > 0}>
        <div class="notice notice-warn deployment-reasons" role="status">
          <span><b>No verdict</b><ul><For each={props.comparison.reasons}>{reason => <li>{reason}</li>}</For></ul></span>
        </div>
      </Show>
      <div class="table-scroll" role="region" aria-label="Deployment metric comparison">
        <table class="data-table compact deployment-table">
          <thead><tr><th>Metric</th><th class="numeric">Before</th><th class="numeric">After</th><th class="numeric">Change</th><th>Signal</th></tr></thead>
          <tbody>
            <For each={props.comparison.metrics}>{metric => {
              const delta = () => change(metric);
              return (
                <tr>
                  <th scope="row">{metric.label}</th>
                  <td class="numeric">{display(metric.before, metric.unit)}</td>
                  <td class="numeric">{display(metric.after, metric.unit)}</td>
                  <td class="numeric">{delta().amount}<span class="cell-note deployment-share">{delta().share}</span></td>
                  <td><Badge tone={VERDICT_TONE[metric.verdict]}>{metric.verdict.replaceAll("-", " ")}</Badge></td>
                </tr>
              );
            }}</For>
          </tbody>
        </table>
      </div>
      <Show when={props.comparison.warnings.length > 0}>
        <ul class="deployment-warnings"><For each={props.comparison.warnings}>{warning => <li>{warning}</li>}</For></ul>
      </Show>
    </>
  );
}

export function DeploymentsWidget(props: { readonly deployments: ProjectDeployments }): JSX.Element {
  const { now } = useTelemetry();
  const { history, selected, setSelected, window, setWindow, comparison, stale, historyError, comparisonError, title, current, problem } = props.deployments;
  const summary = () => {
    const value = history();
    if (value?.sync?.lastSuccessAtMs == null) return undefined;
    return `checked ${age(value.sync.lastSuccessAtMs, now())} · ${value.deployments.length} retained`;
  };
  const notice = () => historyError() ?? problem();
  return (
    <Widget id="deployments" class="wide" title="Deployments" meta={<span>{summary()}</span>} expandable>
      <Show when={notice()}>{text => <div class="notice notice-warn" role="status"><span>{text()}</span></div>}</Show>
      <Show when={history() === null && historyError() === null}><Skeleton rows={4} /></Show>
      <Show when={history()?.enabled === true && history()?.deployments.length === 0 && historyError() === null}>
        <p class="panel-label">No deployments have been recorded for this Worker yet.</p>
      </Show>
      <Show when={(history()?.deployments.length ?? 0) > 0}>
        <div class="deployments-layout">
          <ul class="deployment-list" aria-label="Deployment">
            <For each={history()?.deployments ?? []}>{deployment => (
              <li>
                <button type="button" class="deployment-item" aria-current={selected() === deployment.id ? "true" : "false"} onClick={() => setSelected(deployment.id)}>
                  <span class="deployment-item-head"><b>{title(deployment)}</b><span title={MOMENT.format(deployment.atMs)}>{age(deployment.atMs, now())}</span></span>
                  <span class="deployment-item-note">{deployment.message ?? "No message"}</span>
                </button>
              </li>
            )}</For>
          </ul>
          <div class="deployment-detail" aria-busy={stale() ? "true" : "false"}>
            <div class="deployment-head">
              <Show when={current()}>{deployment => (
                <div class="deployment-title">
                  <b>{title(deployment())}</b>
                  <span class="cell-note" title={deployment().id}>{MOMENT.format(deployment().atMs)} · {deployment().source} · {deployment().id.slice(0, 8)}</span>
                  <Show when={deployment().message}>{message => <p class="deployment-message">{message()}</p>}</Show>
                </div>
              )}</Show>
              <div class="segmented" role="group" aria-label="Before / after window">
                <button class="segment" type="button" aria-pressed={window() === "1h" ? "true" : "false"} aria-label="1 hour each" onClick={() => setWindow("1h")}>1h</button>
                <button class="segment" type="button" aria-pressed={window() === "24h" ? "true" : "false"} aria-label="24 hours each" onClick={() => setWindow("24h")}>24h</button>
              </div>
            </div>
            <Show when={comparisonError()}>{message => <div class="notice notice-warn" role="alert"><span>{message()}</span></div>}</Show>
            <Show when={comparison()} fallback={comparisonError() === null ? <Skeleton rows={6} /> : <p class="panel-label">Comparison unavailable.</p>}>{value => (
              <div class={stale() ? "deployment-comparison pending" : "deployment-comparison"}><ComparisonTable comparison={value()} /></div>
            )}</Show>
          </div>
        </div>
      </Show>
    </Widget>
  );
}
