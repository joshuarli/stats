import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ApiFailure } from "../../api";
import { DeploymentEvents } from "../../components/DeploymentEvents";
import { Widget } from "../../components/ui";
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

function change(metric: MetricComparison): string {
  if (metric.delta === null) return "—";
  const sign = metric.delta > 0 ? "+" : "";
  // A zero baseline has no meaningful relative percentage.
  if (metric.unit === "%") return `${sign}${display(metric.delta)} pp`;
  return `${sign}${display(metric.delta, metric.unit)}${metric.deltaPercent === null ? "" : ` (${metric.deltaPercent > 0 ? "+" : ""}${display(metric.deltaPercent, "%")})`}`;
}

export function ProjectDeployments(props: { readonly projectId: string; readonly refreshKey: string; readonly children: JSX.Element }): JSX.Element {
  const [history, setHistory] = createSignal<DeploymentHistory | null>(null);
  const [selected, setSelected] = createSignal("");
  const [window, setWindow] = createSignal<ComparisonWindow>("1h");
  const [comparison, setComparison] = createSignal<DeploymentComparison | null>(null);
  const [historyError, setHistoryError] = createSignal<string | null>(null);
  const [comparisonError, setComparisonError] = createSignal<string | null>(null);
  let loadedProject = "";

  createEffect(() => ({ project: props.projectId, tick: props.refreshKey }), ({ project }) => {
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

  createEffect(() => ({ project: props.projectId, id: selected(), window: window(), tick: props.refreshKey }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    setComparison(null);
    setComparisonError(null);
    if (query.id === "") return;
    void read(`/api/v1/projects/${encodeURIComponent(query.project)}/deployments/${query.id}/comparison?window=${query.window}`, controller.signal, value => decodeDeploymentComparison(value, query.id, query.window)).then(value => {
      if (!controller.signal.aborted) setComparison(value);
    }).catch((error: unknown) => { if (!controller.signal.aborted) setComparisonError(error instanceof Error ? error.message : "Deployment comparison unavailable"); });
  });

  const versions = createMemo(() => new Map((history()?.versions ?? []).map(version => [version.id, version])));
  const name = (deployment: Deployment) => deployment.versions.map(version => `${versions().get(version.id)?.tag ?? version.id.slice(0, 8)} ${version.percentage}%`).join(" / ");
  const events = createMemo(() => (history()?.deployments ?? []).map(deployment => ({ atMs: deployment.atMs, label: `deploy ${name(deployment)}` })));
  const current = createMemo(() => history()?.deployments.find(deployment => deployment.id === selected()));
  const state = () => {
    const value = history();
    if (value === null) return "Loading deployment history…";
    if (!value.enabled) return "Deployment tracking is disabled. Configure DEPLOYMENTS_ACCOUNT_ID and the read-only DEPLOYMENTS_API_TOKEN secret.";
    if (value.sync === null) return "Waiting for the first deployment poll.";
    if (value.sync.error !== null) return `Deployment polling failed: ${value.sync.error}. Previously collected history is retained.`;
    if (value.sync.truncated) return "Deployment backfill reached its limit; comparisons are withheld.";
    if (value.sync.lastSuccessAtMs === null || Date.now() - value.sync.lastSuccessAtMs > 15 * 60_000) return "Deployment history is stale; comparisons may be withheld.";
    return `Last checked ${new Date(value.sync.lastSuccessAtMs).toLocaleString()}. ${value.deployments.length} deployment events retained.`;
  };

  return (
    <DeploymentEvents.Provider value={events}>
      <Widget id="deployments" title="Deployments" expandable>
        <p class="panel-label" role="status">{historyError() ?? state()}</p>
        <Show when={(history()?.deployments.length ?? 0) > 0}>
          <div class="deployment-controls">
            <label>Deployment
              <select value={selected()} onChange={event => setSelected(event.currentTarget.value)}>
                <For each={history()?.deployments ?? []}>{deployment => <option value={deployment.id}>{new Date(deployment.atMs).toLocaleString()} · {name(deployment)}</option>}</For>
              </select>
            </label>
            <label>Before / after window
              <select value={window()} onChange={event => setWindow(event.currentTarget.value === "24h" ? "24h" : "1h")}>
                <option value="1h">1 hour each</option><option value="24h">24 hours each</option>
              </select>
            </label>
          </div>
          <Show when={current()}>{deployment => <p class="panel-label">Deployment {deployment().id} · {deployment().source}{deployment().message ? ` · ${deployment().message}` : ""}</p>}</Show>
          <Show when={comparisonError()}>{message => <p role="alert">{message()}</p>}</Show>
          <Show when={comparison()} fallback={<p class="panel-label">{comparisonError() === null ? "Loading comparison…" : "Comparison unavailable."}</p>}>{value => (
            <>
              <p class="panel-label">Before: {new Date(value().before.fromMs).toLocaleString()} – {new Date(value().before.toMs).toLocaleString()} ({display(value().beforeInvocations)} invocations). After: {new Date(value().after.fromMs).toLocaleString()} – {new Date(value().after.toMs).toLocaleString()} ({display(value().afterInvocations)} invocations).</p>
              <Show when={value().reasons.length > 0}><p class="deployment-notice" role="status">No verdict: {value().reasons.join(" ")}</p></Show>
              <div class="deployment-table" tabIndex={0} role="region" aria-label="Deployment metric comparison">
                <table>
                  <thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Change</th><th>Signal</th></tr></thead>
                  <tbody><For each={value().metrics}>{metric => <tr><th scope="row">{metric.label}</th><td>{display(metric.before, metric.unit)}</td><td>{display(metric.after, metric.unit)}</td><td>{change(metric)}</td><td>{metric.verdict.replaceAll("-", " ")}</td></tr>}</For></tbody>
                </table>
              </div>
              <p class="panel-label">{value().warnings.join(" ")}</p>
            </>
          )}</Show>
        </Show>
      </Widget>
      {props.children}
    </DeploymentEvents.Provider>
  );
}
