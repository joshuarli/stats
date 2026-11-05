import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ApiFailure } from "../../api";
import { age, count } from "../../format";
import { minimumZoomMs, useTelemetry, type Range } from "../../state";
import { readParam, writeParam } from "../../urlState";
import { createPagedList, jumpTo, ShowMore, Skeleton, Widget } from "../../components/ui";
import { Info, Term } from "../../components/Info";
import { decodeDeploymentComparison, decodeDeploymentHistory } from "../../../deployments/decode";
import { decodeServiceComparison, decodeServiceDeploymentHistory } from "../../../deployments/service-decode";
import type { Deployment, DeploymentHistory } from "../../../deployments/model";
import type { ServiceComparison } from "../../../deployments/service-compare";
import { rolloutWindow } from "./rollout";
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

export function loadDeploymentHistory(projectId: string, signal: AbortSignal): Promise<DeploymentHistory> {
  return read("Deployment history", `/api/v1/projects/${encodeURIComponent(projectId)}/deployments`, signal, value => decodeDeploymentHistory(value, projectId));
}

export function loadServiceDeploymentHistory(service: string, signal: AbortSignal): Promise<DeploymentHistory> {
  return read("Deployment history", `/api/v1/services/${encodeURIComponent(service)}/deployments`, signal, value => decodeServiceDeploymentHistory(value, service));
}

export type DeploymentKind = "project" | "service";
type AnyComparison = DeploymentComparison | ServiceComparison;

interface DeploymentRoutes {
  readonly collection: "projects" | "services";
  readonly subject: string;
  readonly history: (id: string, signal: AbortSignal) => Promise<DeploymentHistory>;
  readonly comparison: (value: unknown, deploymentId: string, window: ComparisonWindow) => AnyComparison;
  readonly versionLabel: (id: string, tag: string | null) => string;
}

const ROUTES: Readonly<Record<DeploymentKind, DeploymentRoutes>> = {
  project: { collection: "projects", subject: "Worker", history: loadDeploymentHistory, comparison: decodeDeploymentComparison, versionLabel: (id, tag) => tag ?? id.slice(0, 8) },
  service: { collection: "services", subject: "service", history: loadServiceDeploymentHistory, comparison: decodeServiceComparison, versionLabel: (id, tag) => tag ?? id }
};

export function deploymentTitle(history: DeploymentHistory, deployment: Deployment, kind: DeploymentKind = "project"): string {
  const tag = (id: string) => ROUTES[kind].versionLabel(id, history.versions.find(version => version.id === id)?.tag ?? null);
  return deployment.versions.map(version => deployment.versions.length === 1 ? tag(version.id) : `${tag(version.id)} ${version.percentage}%`).join(" / ");
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

export type ProjectDeployments = ReturnType<typeof createDeployments>;

const DEPLOYMENT_PAGE = 8;
const WINDOW_FOR_RANGE: Record<Range, ComparisonWindow> = { "1h": "1h", "6h": "6h", "24h": "24h", "7d": "24h", "30d": "24h" };

export function createProjectDeployments(projectId: () => string, range: () => Range, refreshKey: () => string) {
  return createDeployments("project", projectId, range, refreshKey);
}

export function createServiceDeployments(serviceName: () => string, range: () => Range, refreshKey: () => string) {
  return createDeployments("service", serviceName, range, refreshKey);
}

function createDeployments(kind: DeploymentKind, projectId: () => string, range: () => Range, refreshKey: () => string) {
  const routes = ROUTES[kind];
  const [history, setHistory] = createSignal<DeploymentHistory | null>(null);
  const [selected, setSelected] = createSignal("");
  const window = createMemo(() => WINDOW_FOR_RANGE[range()]);
  const [comparison, setComparison] = createSignal<AnyComparison | null>(null);
  const [historyError, setHistoryError] = createSignal<string | null>(null);
  const [comparisonError, setComparisonError] = createSignal<string | null>(null);
  let loadedProject = "";
  let linkPending = true;
  const { now, showWindow } = useTelemetry();

  createEffect(() => ({ project: projectId(), tick: refreshKey() }), ({ project }) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    if (loadedProject !== project) { setHistory(null); setSelected(""); setComparison(null); loadedProject = project; linkPending = true; }
    void routes.history(project, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setHistory(value);
      setHistoryError(null);
      setSelected(current => value.deployments.some(deployment => deployment.id === current) ? current : value.deployments.find(deployment => deployment.id === readParam("deployment"))?.id ?? value.deployments[0]?.id ?? "");
      if (linkPending) {
        linkPending = false;
        const linked = readParam("deployment");
        if (linked !== null && value.deployments.some(deployment => deployment.id === linked)) focusOn(value.deployments, linked);
      }
    }).catch((error: unknown) => { if (!controller.signal.aborted) setHistoryError(error instanceof Error ? error.message : "Deployment history unavailable"); });
  });

  createEffect(() => ({ project: projectId(), id: selected(), window: window(), tick: refreshKey() }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    setComparisonError(null);
    if (query.id === "") { setComparison(null); return; }
    void read("Deployment comparison", `/api/v1/${routes.collection}/${encodeURIComponent(query.project)}/deployments/${query.id}/comparison?window=${query.window}`, controller.signal, value => routes.comparison(value, query.id, query.window)).then(value => {
      if (!controller.signal.aborted) setComparison(value);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setComparison(null);
      setComparisonError(error instanceof Error ? error.message : "Deployment comparison unavailable");
    });
  });

  const versions = createMemo(() => new Map((history()?.versions ?? []).map(version => [version.id, version])));
  const tag = (id: string) => routes.versionLabel(id, versions().get(id)?.tag ?? null);
  const name = (deployment: Deployment) => deployment.versions.map(version => `${tag(version.id)} ${version.percentage}%`).join(" / ");
  const title = (deployment: Deployment) => {
    const value = history();
    return value === null ? deployment.id.slice(0, 8) : deploymentTitle(value, deployment, kind);
  };
  const select = (id: string) => {
    setSelected(id);
    writeParam("deployment", id);
  };

  const focusOn = (deployments: readonly Deployment[], id: string) => {
    const target = deployments.find(deployment => deployment.id === id);
    if (target === undefined) return;
    select(id);
    showWindow(rolloutWindow(deployments, target, now(), minimumZoomMs(target.atMs, now())));
  };
  const focus = (id: string) => focusOn(history()?.deployments ?? [], id);

  const events = createMemo(() => (history()?.deployments ?? []).map(deployment => ({
    id: deployment.id,
    atMs: deployment.atMs,
    label: `deploy ${name(deployment)}`,
    short: title(deployment),
    onSelect: () => {
      focus(deployment.id);
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
    if (value === null || kind === "service") return null;
    if (!value.enabled) return "Deployment tracking is disabled. Configure DEPLOYMENTS_ACCOUNT_ID and the read-only DEPLOYMENTS_API_TOKEN secret.";
    if (value.sync === null) return "Waiting for the first deployment poll.";
    if (value.sync.error !== null) return `Deployment polling failed: ${value.sync.error}. Previously collected history is retained.`;
    if (value.sync.truncated) return "Deployment backfill reached its limit; comparisons are withheld.";
    if (value.sync.lastSuccessAtMs === null || Date.now() - value.sync.lastSuccessAtMs > 15 * 60_000) return "Deployment history is stale; comparisons may be withheld.";
    return null;
  };

  const listed = () => (history()?.deployments.length ?? 0) > 0;

  return { history, listed, selected, select, focus, window, comparison, stale, historyError, comparisonError, name, title, events, current, problem, subject: routes.subject };
}

function sourcesOf(comparison: AnyComparison): ServiceComparison["sources"] | null {
  return "sources" in comparison ? comparison.sources : null;
}

function ComparisonTable(props: { readonly comparison: AnyComparison }): JSX.Element {
  const windows = () => `Before ${span(props.comparison.before)}. After ${span(props.comparison.after)}. The bucket the deployment landed in and the bucket after it are excluded.`;
  const caveats = () => props.comparison.warnings.length;
  return (
    <>
      <p class="deployment-windows">
        <Term hint={windows()}>{`${props.comparison.window} each side`}</Term>
        <Show when={sourcesOf(props.comparison)} fallback={<>{count(props.comparison.beforeInvocations ?? undefined)} → {count(props.comparison.afterInvocations ?? undefined)} invocations</>}>{sources => (
          <For each={sources()}>{source => <span class={`deployment-source ${source.status}`}>{source.source === "hosts" ? "Hosts" : "Health probe"}: {source.status === "available" ? source.detail : `unavailable, ${source.detail}`}</span>}</For>
        )}</Show>
      </p>
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
                  {sourcesOf(props.comparison) !== null && metric.before === null && metric.after === null ? "unavailable" : movement(metric)}
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

export function DeploymentRail(props: { readonly deployments: ProjectDeployments }): JSX.Element {
  const { now } = useTelemetry();
  const { history, selected, select, focus, title } = props.deployments;
  const paged = createPagedList(() => history()?.deployments ?? [], DEPLOYMENT_PAGE);
  createEffect(() => (history()?.deployments ?? []).findIndex(deployment => deployment.id === selected()), index => { if (index >= 0) paged.reveal(index); });
  const moveSelection = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const items = history()?.deployments ?? [];
    const index = items.findIndex(deployment => deployment.id === selected());
    const target = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    const next = target === null ? undefined : items[Math.min(items.length - 1, Math.max(0, target))];
    if (next === undefined) return;
    event.preventDefault();
    select(next.id);
    const row = items.indexOf(next);
    paged.reveal(row);
    const rows = event.currentTarget;
    requestAnimationFrame(() => rows.querySelectorAll<HTMLButtonElement>(".deployment-item")[row]?.focus());
  };
  const checked = () => {
    const value = history();
    return value?.sync?.lastSuccessAtMs == null ? undefined : `checked ${age(value.sync.lastSuccessAtMs, now())}`;
  };
  return (
    <aside class="deployment-rail" aria-label="Deployments">
      <div class="deployment-rail-head"><h2>Deployments</h2><span>{checked()}</span></div>
      <div class="deployment-list" role="listbox" tabindex="-1" aria-label="Deployment" onKeyDown={moveSelection}>
        <For each={paged.visible()}>{deployment => (
          <button type="button" role="option" class="deployment-item" tabindex={selected() === deployment.id ? 0 : -1} aria-selected={selected() === deployment.id ? "true" : "false"} onClick={() => focus(deployment.id)}>
            <span class="deployment-item-head"><b>{title(deployment)}</b><span title={MOMENT.format(deployment.atMs)}>{age(deployment.atMs, now())}</span></span>
          </button>
        )}</For>
        <ShowMore hidden={paged.hidden()} noun="deployments" onMore={paged.more} />
      </div>
    </aside>
  );
}

export function DeploymentsWidget(props: { readonly deployments: ProjectDeployments; readonly impact?: ((deploymentId: string) => JSX.Element) | undefined }): JSX.Element {
  const { view, resetZoom } = useTelemetry();
  const { history, listed, focus, comparison, stale, historyError, comparisonError, title, current, problem } = props.deployments;
  const notice = () => historyError() ?? problem();
  return (
    <Widget id="deployments" class="wide" title="Deployment" expandable>
      <Show when={notice()}>{text => <div class="notice notice-warn" role="status"><span>{text()}</span></div>}</Show>
      <Show when={history() === null && historyError() === null}><Skeleton rows={4} /></Show>
      <Show when={history()?.enabled === true && history()?.deployments.length === 0 && historyError() === null}>
        <p class="panel-label">No deployments have been recorded for this {props.deployments.subject} yet.</p>
      </Show>
      <Show when={listed()}>
        <div class="deployment-detail" aria-busy={stale() ? "true" : "false"}>
          <div class="deployment-head">
            <Show when={current()}>{deployment => (
              <div class="deployment-title">
                <b>{title(deployment())}</b>
                <span class="cell-note">{RANGE.format(deployment().atMs)} · {deployment().source}</span>
                <Info title="Deployment details">
                  <dl class="fact-list">
                    <dt>Deployed</dt><dd>{MOMENT.format(deployment().atMs)}</dd>
                    <dt>Source</dt><dd>{deployment().source}</dd>
                    <dt>Message</dt><dd>{deployment().message ?? "None recorded"}</dd>
                    <dt>ID</dt><dd class="mono">{deployment().id}</dd>
                  </dl>
                </Info>
                <Show
                  when={view() === null}
                  fallback={<button class="btn btn-small deployment-scope" type="button" onClick={resetZoom}>Show full range</button>}
                >
                  <button class="btn btn-small deployment-scope" type="button" onClick={() => focus(deployment().id)}>Zoom charts to this rollout</button>
                </Show>
              </div>
            )}</Show>
          </div>
          <div class="deployment-panels">
            <div class="deployment-panel">
              <Show when={comparisonError()}>{message => <div class="notice notice-warn" role="alert"><span>{message()}</span></div>}</Show>
              <Show when={comparison()} fallback={comparisonError() === null ? <Skeleton rows={6} /> : <p class="panel-label">Comparison unavailable.</p>}>{value => (
                <div class={stale() ? "deployment-comparison pending" : "deployment-comparison"}><ComparisonTable comparison={value()} /></div>
              )}</Show>
            </div>
            <Show when={props.impact !== undefined && current()}>{deployment => <div class="deployment-panel">{props.impact?.(deployment().id)}</div>}</Show>
          </div>
        </div>
      </Show>
    </Widget>
  );
}
