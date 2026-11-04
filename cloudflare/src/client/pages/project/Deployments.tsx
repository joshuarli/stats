import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ApiFailure } from "../../api";
import { age, count } from "../../format";
import { useTelemetry, type Range } from "../../state";
import { readParam, writeParam } from "../../urlState";
import { jumpTo, Skeleton, Widget } from "../../components/ui";
import { decodeDeploymentComparison, decodeDeploymentHistory } from "../../../deployments/decode";
import type { Deployment, DeploymentHistory } from "../../../deployments/model";
import type { ComparisonWindow, DeploymentComparison, MetricComparison } from "../../../deployments/compare";
import "./deployments.css";

async function read<T>(what: "Deployment history" | "Deployment comparison", path: string, signal: AbortSignal, decode: (value: unknown) => T): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { signal, credentials: "same-origin", cache: "no-store" }); }
  catch (cause) { throw new ApiFailure(0, `${what} request failed`, cause); }
  if (!response.ok) throw new ApiFailure(response.status, `${what} unavailable (${response.status})`);
  try { return decode(await response.json()); }
  catch (cause) { throw new ApiFailure(0, `Invalid ${what.toLowerCase()} response`, cause); }
}

function figure(value: number | null, unit = ""): string {
  if (value === null) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: unit === "USD" ? 6 : 3 });
}

function suffix(unit: string): string {
  return unit === "%" ? "%" : unit === "" ? "" : ` ${unit}`;
}

function signed(value: number, text: string): string {
  return value > 0 ? `+${text}` : text;
}

function movement(metric: MetricComparison): string {
  return `${figure(metric.before, metric.unit)} → ${figure(metric.after, metric.unit)}${suffix(metric.unit)}`;
}

function delta(metric: MetricComparison): string {
  if (metric.delta === null) return "";
  if (metric.unit === "%") return `${signed(metric.delta, figure(metric.delta))} pp`;
  if (metric.deltaPercent === null) return `${signed(metric.delta, figure(metric.delta, metric.unit))}${suffix(metric.unit)}`;
  return `${signed(metric.deltaPercent, metric.deltaPercent.toLocaleString(undefined, { maximumFractionDigits: 1 }))}%`;
}

const VERDICT_CLASS: Record<MetricComparison["verdict"], string> = {
  improved: "improved",
  regressed: "regressed",
  unchanged: "quiet",
  "insufficient-data": "quiet",
  confounded: "quiet"
};

const RANGE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const MOMENT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

function span(bounds: { readonly fromMs: number; readonly toMs: number }): string {
  return RANGE.formatRange(bounds.fromMs, bounds.toMs);
}

export type ProjectDeployments = ReturnType<typeof createProjectDeployments>;

const WINDOW_FOR_RANGE: Record<Range, ComparisonWindow> = { "1h": "1h", "6h": "6h", "24h": "24h", "7d": "24h", "30d": "24h" };

export function createProjectDeployments(projectId: () => string, range: () => Range, refreshKey: () => string) {
  const [history, setHistory] = createSignal<DeploymentHistory | null>(null);
  const [selected, setSelected] = createSignal("");
  const window = createMemo(() => WINDOW_FOR_RANGE[range()]);
  const [comparison, setComparison] = createSignal<DeploymentComparison | null>(null);
  const [historyError, setHistoryError] = createSignal<string | null>(null);
  const [comparisonError, setComparisonError] = createSignal<string | null>(null);
  let loadedProject = "";

  createEffect(() => ({ project: projectId(), tick: refreshKey() }), ({ project }) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    if (loadedProject !== project) { setHistory(null); setSelected(""); setComparison(null); loadedProject = project; }
    void read("Deployment history", `/api/v1/projects/${encodeURIComponent(project)}/deployments`, controller.signal, value => decodeDeploymentHistory(value, project)).then(value => {
      if (controller.signal.aborted) return;
      setHistory(value);
      setHistoryError(null);
      setSelected(current => value.deployments.some(deployment => deployment.id === current) ? current : value.deployments.find(deployment => deployment.id === readParam("deployment"))?.id ?? value.deployments[0]?.id ?? "");
    }).catch((error: unknown) => { if (!controller.signal.aborted) setHistoryError(error instanceof Error ? error.message : "Deployment history unavailable"); });
  });

  createEffect(() => ({ project: projectId(), id: selected(), window: window(), tick: refreshKey() }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    setComparisonError(null);
    if (query.id === "") { setComparison(null); return; }
    void read("Deployment comparison", `/api/v1/projects/${encodeURIComponent(query.project)}/deployments/${query.id}/comparison?window=${query.window}`, controller.signal, value => decodeDeploymentComparison(value, query.id, query.window)).then(value => {
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
  const select = (id: string) => {
    setSelected(id);
    writeParam("deployment", id);
  };

  const events = createMemo(() => (history()?.deployments ?? []).map(deployment => ({
    id: deployment.id,
    atMs: deployment.atMs,
    label: `deploy ${name(deployment)}`,
    short: title(deployment),
    onSelect: () => {
      select(deployment.id);
      jumpTo("deployments");
    }
  })));
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

  return { history, selected, select, window, comparison, stale, historyError, comparisonError, name, title, events, current, problem };
}

function ComparisonTable(props: { readonly comparison: DeploymentComparison }): JSX.Element {
  const windows = () => `Before ${span(props.comparison.before)}\nAfter ${span(props.comparison.after)}`;
  const caveats = () => props.comparison.warnings.length;
  return (
    <>
      <p class="deployment-windows" title={windows()}>{props.comparison.window} each side · {count(props.comparison.beforeInvocations ?? undefined)} → {count(props.comparison.afterInvocations ?? undefined)} invocations</p>
      <Show when={props.comparison.reasons.length > 0}>
        <div class="notice notice-warn deployment-reasons" role="status">
          <span><b>No verdict</b><ul><For each={props.comparison.reasons}>{reason => <li>{reason}</li>}</For></ul></span>
        </div>
      </Show>
      <div class="table-scroll" role="region" aria-label="Deployment metric comparison">
        <table class="data-table compact deployment-table">
          <thead><tr><th>Metric</th><th class="numeric">Before → after</th></tr></thead>
          <tbody>
            <For each={props.comparison.metrics}>{metric => (
              <tr>
                <th scope="row">{metric.label}</th>
                <td class="numeric" title={metric.verdict.replaceAll("-", " ")}>
                  {movement(metric)}
                  <Show when={delta(metric)}>{text => <span class={`deployment-delta ${VERDICT_CLASS[metric.verdict]}`}>({text()})</span>}</Show>
                  <span class="sr-only">, {metric.verdict.replaceAll("-", " ")}</span>
                </td>
              </tr>
            )}</For>
          </tbody>
        </table>
      </div>
      <Show when={caveats() > 0}>
        <details class="deployment-warnings">
          <summary>{caveats()} {caveats() === 1 ? "caveat" : "caveats"}</summary>
          <ul><For each={props.comparison.warnings}>{warning => <li>{warning}</li>}</For></ul>
        </details>
      </Show>
    </>
  );
}

export function DeploymentsWidget(props: { readonly deployments: ProjectDeployments; readonly impact?: ((deploymentId: string) => JSX.Element) | undefined }): JSX.Element {
  const { now } = useTelemetry();
  const { history, selected, select, comparison, stale, historyError, comparisonError, title, current, problem } = props.deployments;
  const moveSelection = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const items = history()?.deployments ?? [];
    const index = items.findIndex(deployment => deployment.id === selected());
    const target = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    const next = target === null ? undefined : items[Math.min(items.length - 1, Math.max(0, target))];
    if (next === undefined) return;
    event.preventDefault();
    select(next.id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>(".deployment-item")[items.indexOf(next)]?.focus();
  };
  const summary = () => {
    const value = history();
    if (value?.sync?.lastSuccessAtMs == null) return undefined;
    return `checked ${age(value.sync.lastSuccessAtMs, now())}`;
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
          <div class="deployment-list" role="listbox" tabindex="-1" aria-label="Deployment" onKeyDown={moveSelection}>
            <For each={history()?.deployments ?? []}>{deployment => (
              <button type="button" role="option" class="deployment-item" title={deployment.message ?? undefined} tabindex={selected() === deployment.id ? 0 : -1} aria-selected={selected() === deployment.id ? "true" : "false"} onClick={() => select(deployment.id)}>
                <span class="deployment-item-head"><b>{title(deployment)}</b><span title={MOMENT.format(deployment.atMs)}>{age(deployment.atMs, now())}</span></span>
                <span class="deployment-item-note">{deployment.message ?? "No message"}</span>
              </button>
            )}</For>
          </div>
          <div class="deployment-detail" aria-busy={stale() ? "true" : "false"}>
            <div class="deployment-head">
              <Show when={current()}>{deployment => (
                <div class="deployment-title">
                  <b>{title(deployment())}</b>
                  <span class="cell-note" title={`${deployment().id}${deployment().message === null ? "" : `\n${deployment().message}`}`}>{RANGE.format(deployment().atMs)} · {deployment().source}</span>
                </div>
              )}</Show>
            </div>
            <Show when={comparisonError()}>{message => <div class="notice notice-warn" role="alert"><span>{message()}</span></div>}</Show>
            <Show when={comparison()} fallback={comparisonError() === null ? <Skeleton rows={6} /> : <p class="panel-label">Comparison unavailable.</p>}>{value => (
              <div class={stale() ? "deployment-comparison pending" : "deployment-comparison"}><ComparisonTable comparison={value()} /></div>
            )}</Show>
            <Show when={props.impact !== undefined && current()}>{deployment => props.impact?.(deployment().id)}</Show>
          </div>
        </div>
      </Show>
    </Widget>
  );
}
