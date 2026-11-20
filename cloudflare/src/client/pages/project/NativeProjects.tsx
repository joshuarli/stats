import { createEffect, createMemo, createSignal, Errored, For, lazy, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { Badge, EmptyState, PageHeader, Skeleton } from "@laputa-systems/ui-dashboard";
import { createListQuery, loadServices } from "../../queries";
import { EntityCell, ErrorState, Notice, Widget } from "../../components/ui";
import { DeploymentEvents } from "../../components/DeploymentEvents";
import { createServiceDeployments, deploymentTitle } from "./Deployments";
import { createObservability } from "./Observe";
import { PanelChart } from "../host/shared";
import { PROJECT_REFRESH_TICKS, rangeMs, useTelemetry } from "../../state";
import { routeWithRange, readParam, writeParam } from "../../urlState";
import { age, bytes, count, errorMessage, milliseconds } from "../../format";
import { compareSortValues, createSort, SortHeader } from "../../components/sort";
import { cores, createServiceResources, NoServiceResources, resourceRows, ServiceResourcesView, type ResourceRow } from "../../components/ServiceResources";
import { combinedPoints, NEVER_IDLE_CORES, neverIdle, selectedWindow } from "../../service-metrics";
import { createServiceHealth, HealthBars } from "../../components/HealthBars";
import { Sparkline } from "../../components/Sparkline";
import type { ResourcePoint } from "../../../core/installation/service-resources-model";
import { createUpdateEffect } from "../../effect";
import { RETENTION_MS } from "../../../observe/core/limits";
import { getApplicationSummary, getApplicationTelemetry, type Service } from "../../api";
import type { ApplicationSummary, ApplicationTelemetry } from "../../../observe/application/telemetry";
import { applicationTrack } from "./native-series";
import { RecentApplicationEvents } from "./RecentApplicationEvents";
import { ServiceDeploySummary } from "../ServicePage";
import "./project.css";
import { startProjectJourney } from "../../project-journey";

const Platform = lazy(() => import("./Platform"));
const IssuesWidget = lazy(() => import("./ObserveSection").then(module => ({ default: module.IssuesWidget })));
const ObserveModal = lazy(() => import("./ObserveSection").then(module => ({ default: module.ObserveModal })));
const ApplicationOverview = lazy(() => import("./ApplicationOverview").then(module => ({ default: module.ApplicationOverview })));
const SUMMARY_WINDOW_LIMIT = 5;

function summaryOnly(value: ApplicationSummary | ApplicationTelemetry): ApplicationSummary {
  if (!("recent" in value)) return value;
  return { provenance: value.provenance, fromMs: value.fromMs, toMs: value.toMs, stepMs: value.stepMs, totals: value.totals, openIssues: value.openIssues, buckets: value.buckets, operations: value.operations, moreOperations: value.moreOperations };
}

export function NativeServicesPage(): JSX.Element {
  const { range, now, tick, manualTick } = useTelemetry();
  const { data: services, error: listError } = createListQuery(loadServices);
  createUpdateEffect(() => `${Math.floor(tick() / PROJECT_REFRESH_TICKS)}:${manualTick()}`, () => { void refresh(services); });
  const hostIds = createMemo(() => [...new Set(services().flatMap(service => service.hostIds))].sort());
  const resources = createServiceResources(hostIds);
  const usage = createMemo(() => {
    const byService = new Map<string, ResourceRow[]>();
    for (const row of resourceRows(resources.results() ?? [])) {
      if (!services().some(service => service.name === row.service && service.hostIds.includes(row.hostId))) continue;
      byService.set(row.service, [...(byService.get(row.service) ?? []), row]);
    }
    const totals = new Map<string, ServiceUsage>();
    for (const [name, rows] of byService) {
      const points = combinedPoints(rows);
      const cpu = points.map(point => point.cpuCores).filter((value): value is number => value !== null);
      const memory = points.map(point => point.memoryBytes).filter((value): value is number => value !== null);
      totals.set(name, { points, cpu: cpu.length === 0 ? null : cpu.reduce((sum, value) => sum + value, 0) / cpu.length, memory: memory.at(-1) ?? null, neverIdle: neverIdle(points) });
    }
    return totals;
  });
  const { sort, sortBy } = createSort<"service" | "health" | "cpu" | "memory" | "deploy">({ key: "cpu", direction: -1 });
  const sorted = createMemo(() => {
    const key = sort().key;
    const value = (service: Service): number | string | null => {
      if (key === "service") return service.name;
      if (key === "health") return service.health === undefined || service.health.status === "unprobed" ? null : service.health.status === "down" ? 0 : 1;
      if (key === "cpu") return usage().get(service.name)?.cpu ?? null;
      if (key === "memory") return usage().get(service.name)?.memory ?? null;
      const latest = service.latestDeployment;
      return latest?.status === "available" ? latest.deployment.atMs : null;
    };
    return [...services()].sort((left, right) => {
      const leftValue = value(left);
      const rightValue = value(right);
      if (leftValue === null || rightValue === null) return leftValue === rightValue ? left.name.localeCompare(right.name) : leftValue === null ? 1 : -1;
      return compareSortValues(leftValue, rightValue) * sort().direction || left.name.localeCompare(right.name);
    });
  });
  return <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}><Loading fallback={<Skeleton rows={2} />}>
    <Show when={listError() !== null}><Notice tone="warn">{errorMessage(listError())}</Notice></Show>
    <Show when={resources.error()}>{message => <Notice tone="warn">Resource use could not be read: {message()}</Notice>}</Show>
    <Widget id="services" title="Services" bodyClass="flush" meta={<span class="cell-note">Health bars and trends cover the selected window; CPU is its mean, memory the latest reading</span>}><Show when={services().length} fallback={<EmptyState title="No services are configured." detail="Create one with statsctl service create; see docs/operations.md." />}>
      <div class="table-scroll" role="region" aria-label="Services table"><table class="data-table services-table" aria-label="Services"><thead><tr>
        <SortHeader label="Service" sortKey="service" sort={sort()} onSort={sortBy} />
        <SortHeader label="Health" sortKey="health" sort={sort()} onSort={sortBy} />
        <SortHeader label="CPU" sortKey="cpu" sort={sort()} onSort={sortBy} />
        <SortHeader label="Memory" sortKey="memory" sort={sort()} onSort={sortBy} />
        <SortHeader label="Last deploy" sortKey="deploy" sort={sort()} onSort={sortBy} />
      </tr></thead><tbody>
        <For each={sorted()} keyed={service => service.name}>{service => <tr>
          <td><EntityCell marker={<span class={`status-dot tone-${healthTone(service().health)}`} aria-hidden="true" />} name={service().name} href={routeWithRange(`#/service/${encodeURIComponent(service().name)}`, range())} id={service().unit ?? `${service().hostIds.length} ${service().hostIds.length === 1 ? "host" : "hosts"}`} /></td>
          <td><HealthCell service={service()} /></td>
          <td><UsageCell usage={usage().get(service().name)} loading={resources.results() === null} kind="cpu" label={service().name} /></td>
          <td><UsageCell usage={usage().get(service().name)} loading={resources.results() === null} kind="memory" label={service().name} /></td>
          <td><Show when={(() => { const latest = service().latestDeployment; return latest?.status === "available" ? latest : null; })()} fallback={<span class="cell-note">none recorded</span>}>{latest => <span class="cell-stack"><span class="mono">{deploymentTitle(latest(), latest().deployment, "service")}</span><span class="cell-note">{age(latest().deployment.atMs, now())}</span></span>}</Show></td>
        </tr>}</For>
      </tbody></table></div>
    </Show></Widget>
  </Loading></Errored>;
}

function healthLabel(service: Service): string {
  if (service.healthUrl === null) return "no health URL";
  const health = service.health;
  if (health === undefined || health.status === "unprobed") return "health not probed yet";
  return health.status === "up" ? "healthy" : "health check failing";
}

function ServiceResourcesSection(props: { readonly service: Service }): JSX.Element {
  const { hosts } = useTelemetry();
  const resources = createServiceResources(() => props.service.hostIds);
  const hostName = (hostId: string) => hosts().find(host => host.hostId === hostId)?.name ?? hostId;
  const health = createServiceHealth(() => props.service.healthUrl === null ? null : props.service.name);
  return <>
    <Widget id="service-health" title="Health" meta={<span class="cell-note mono">{props.service.healthUrl ?? "no health URL"}</span>}>
      <Show when={props.service.healthUrl !== null} fallback={<p class="cell-note">This service has no health URL. Set one with statsctl service update --health-url.</p>}>
        <Show when={health.error()}>{message => <Notice tone="warn">{message()}</Notice>}</Show>
        <Show when={health.history()} fallback={<Skeleton rows={1} />}>{history => <HealthBars history={history()} label={`${props.service.name} health`} />}</Show>
      </Show>
    </Widget>
    <ServiceResourcesView results={resources.results()} error={resources.error()} only={props.service.name} hostName={hostName}
      empty={<NoServiceResources detail={`No host agent reports a cgroup service named ${props.service.name}. Add {"name": "${props.service.name}", "unit": ...} to the services list in the agent configuration on its hosts.`} />} />
  </>;
}

function healthTone(health: Service["health"]): "ok" | "bad" | "neutral" {
  return health?.status === "up" ? "ok" : health?.status === "down" ? "bad" : "neutral";
}

interface ServiceUsage {
  readonly points: readonly ResourcePoint[];
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly neverIdle: boolean;
}

function UsageCell(props: { readonly usage: ServiceUsage | undefined; readonly loading: boolean; readonly kind: "cpu" | "memory"; readonly label: string }): JSX.Element {
  const { range, view, now } = useTelemetry();
  const window = createMemo(() => selectedWindow(range(), view(), now()));
  const values = () => props.usage?.points.map(point => props.kind === "cpu" ? point.cpuCores : point.memoryBytes) ?? [];
  const value = () => props.kind === "cpu" ? cores(props.usage?.cpu ?? null) : bytes(props.usage?.memory ?? undefined);
  return <Show when={!props.loading} fallback={<span class="cell-note">…</span>}>
    <Show when={props.usage !== undefined} fallback={<span class="cell-note">no cgroup data</span>}>
      <div class="cell-stack">
        <div class="cpu-cell">
          <span class="metric-value-small">{value()}</span>
          <Sparkline series={[{ values: values() }]} times={props.usage!.points.map(point => point.atMs)} window={window()} label={`${props.label} ${props.kind === "cpu" ? "CPU" : "memory"} trend`} class="spark-inline" zeroBased />
        </div>
        <Show when={props.kind === "cpu" && props.usage!.neverIdle}><span class="cell-note tone-warn" title={`CPU stayed at or above ${NEVER_IDLE_CORES} cores for the whole window`}>never idle</span></Show>
      </div>
    </Show>
  </Show>;
}

function HealthCell(props: { readonly service: Service }): JSX.Element {
  const health = createServiceHealth(() => props.service.healthUrl === null ? null : props.service.name);
  return <Show when={props.service.healthUrl !== null} fallback={<span class="cell-note">no health URL</span>}>
    <Show when={health.history()} fallback={<span class="cell-note">{health.error() ?? "…"}</span>}>{history => <HealthBars history={history()} label={`${props.service.name} health`} compact />}</Show>
  </Show>;
}

export function NativeServicePage(): JSX.Element {
  const params = useParams();
  const { data: services, error: listError } = createListQuery(loadServices);
  const { range, tick, manualTick } = useTelemetry();
  createUpdateEffect(() => `${Math.floor(tick() / PROJECT_REFRESH_TICKS)}:${manualTick()}`, () => { void refresh(services); });
  return <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}><Loading fallback={<Skeleton rows={2} />}>
      <Show when={listError() !== null}><Notice tone="warn">{errorMessage(listError())}</Notice></Show>
    <Show when={services().find(service => service.name === (params.serviceName ?? params.projectId))?.name} keyed fallback={<EmptyState title="Service not found" detail="This service is not registered." action={<a href={routeWithRange("#/services", range())}>Back to services</a>} />}>
      {name => <NativeProject service={services().find(service => service.name === name)!} />}
    </Show>
  </Loading></Errored>;
}

type Section = "overview" | "resources" | "deploys" | "errors" | "requests" | "signals" | "platform";
const sections: readonly Section[] = ["overview", "resources", "deploys", "errors", "requests", "signals", "platform"];
function initialSection(): Section {
  return sections.find(item => item === readParam("section")) ?? (readParam("deployment") !== null ? "deploys" : readParam("issue") !== null ? "errors" : "overview");
}

function NativeProject(props: { readonly service: Service }): JSX.Element {
  const serviceName = props.service.name;
  const { range, view, now, tick, manualTick } = useTelemetry();
  const refreshKey = createMemo(() => `${Math.floor(tick() / PROJECT_REFRESH_TICKS)}:${manualTick()}`);
  const [section, setSection] = createSignal<Section>(serviceName === "stats" || initialSection() !== "platform" ? initialSection() : "overview");
  const deployments = createServiceDeployments(() => serviceName, range, refreshKey, { active: () => section() === "deploys" });
  const [data, setData] = createSignal<ApplicationSummary | ApplicationTelemetry | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);
  const [loadedAtMs, setLoadedAtMs] = createSignal(0);
  let loadedWindow: string | null = null;
  let loadedKey: string | null = null;
  let revalidateCached = false;
  let journey: ReturnType<typeof startProjectJourney> | undefined;
  let entered = false;
  const summaries = new Map<string, { readonly data: ApplicationSummary; readonly atMs: number }>();
  const detail = (): ApplicationTelemetry | null => { const value = data(); return value !== null && "recent" in value ? value : null; };
  const windowAt = () => {
    const end = Math.min(view()?.toMs ?? now(), now());
    return { fromMs: Math.max(view()?.fromMs ?? end - rangeMs[range()], now() - RETENTION_MS), toMs: end };
  };
  const observe = createObservability(serviceName, refreshKey, () => `${range()}:${view()?.fromMs ?? ""}:${view()?.toMs ?? ""}`, windowAt, () => false, () => section() === "errors", { enabled: () => section() === "errors" });
  createEffect(() => true, () => {
    const sync = () => setSection(serviceName === "stats" || initialSection() !== "platform" ? initialSection() : "overview");
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  });
  createEffect(() => ({ service: serviceName, range: range(), view: view(), refresh: refreshKey(), recent: section() === "requests", active: section() === "overview" || section() === "requests" || section() === "signals" }), query => {
    if (!query.active) return;
    const selection = `${query.service}:${query.range}:${query.view?.fromMs ?? ""}:${query.view?.toMs ?? ""}`;
    const key = `${selection}:${query.refresh}`;
    if (!revalidateCached && data() !== null && loadedKey === key && (!query.recent || detail() !== null)) { setRefreshing(false); setError(null); return; }
    journey?.cancel();
    const measured = section() === "overview" ? startProjectJourney(query.range, { navigation: !entered }) : undefined;
    if (measured !== undefined) entered = true;
    journey = measured;
    const cached = query.recent ? undefined : summaries.get(key);
    if (cached !== undefined) {
      summaries.delete(key); summaries.set(key, cached);
      if (!revalidateCached) measured?.dataReady(cached.data, true);
      setData(cached.data); loadedWindow = selection; loadedKey = key;
      setLoadedAtMs(cached.atMs); setRefreshing(false); setError(null);
      if (!revalidateCached) return () => measured?.cancel();
    }
    const window = windowAt();
    const controller = new AbortController();
    let completed = false;
    if (loadedWindow !== selection) setData(null);
    setError(null);
    setRefreshing(true);
    if (window.fromMs >= window.toMs) { setError("The selected window is outside application telemetry retention."); setRefreshing(false); measured?.fail(); return; }
    const read = query.recent ? getApplicationTelemetry : getApplicationSummary;
    void read(query.service, window.fromMs, window.toMs, controller.signal, measured).then(value => {
      if (controller.signal.aborted) return;
      completed = true; revalidateCached = false;
      measured?.dataReady(value, false);
      setData(value);
      loadedWindow = selection;
      loadedKey = key;
      const atMs = Date.now();
      setLoadedAtMs(atMs);
      summaries.delete(key); summaries.set(key, { data: summaryOnly(value), atMs });
      while (summaries.size > SUMMARY_WINDOW_LIMIT) summaries.delete(summaries.keys().next().value!);
      setRefreshing(false);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) { completed = true; setError(errorMessage(failure)); setRefreshing(false); measured?.fail(); } });
    return () => { if (!completed) revalidateCached = true; controller.abort(); measured?.cancel(); };
  });
  const latest = () => { const value = props.service.latestDeployment; return value?.status === "available" ? value : null; };
  const showSection = (next: Section) => { setSection(next); writeParam("section", next); };
  const events = createMemo(() => deployments.events().map(event => ({ ...event, onSelect: () => { showSection("deploys"); event.onSelect(); } })));
  return <DeploymentEvents value={events}>
    <PageHeader title={props.service.name} titleExtra={<Badge tone={healthTone(props.service.health) === "ok" ? "ok" : healthTone(props.service.health) === "bad" ? "bad" : "neutral"} dot>{healthLabel(props.service)}</Badge>}>
      <div class="project-pills" aria-label="Project health">
        <Show when={data()?.totals}>{total => <><button class="project-pill tone-neutral" onClick={() => showSection("requests")}>{count(total().requests)} HTTP requests</button><button class={`project-pill tone-${total().status5xx > 0 ? "bad" : "neutral"}`} onClick={() => showSection("signals")}>{count(total().status5xx)} 5xx</button></>}</Show>
        <Show when={data() !== null || observe.health() !== null}><button class="project-pill tone-neutral" onClick={() => showSection("errors")}>{observe.health()?.openIssues ?? data()?.openIssues} open errors</button></Show>
        <Show when={latest()}>{value => <button class="project-pill tone-neutral" onClick={() => showSection("deploys")}>{deploymentTitle(value(), value().deployment, "service")} · {age(value().deployment.atMs, now())}</button>}</Show>
      </div>
    </PageHeader>
    <div class="project-layout">
      <nav class="project-sidebar" aria-label="Project sections"><For each={sections.filter(item => item !== "platform" || serviceName === "stats")}>{item => <div class={`project-nav-entry${section() === item ? " open" : ""}`}><button class={`project-nav-item project-section-head${section() === item ? " active" : ""}`} type="button" aria-current={section() === item ? "page" : undefined} onClick={() => showSection(item)}><span class="project-nav-title">{item === "deploys" ? "Deployments" : item[0]!.toUpperCase() + item.slice(1)}</span><span class="project-nav-summary">{item === "platform" ? "sampled platform operations" : item === "overview" ? "application activity" : item === "resources" ? "health, CPU, memory and disk" : item === "deploys" ? "release markers and comparison" : item === "requests" ? "HTTP and work events" : item === "signals" ? "events, status and wall time" : "issues and diagnostics"}</span></button></div>}</For></nav>
      <div class="project-content">
        <Show when={section() === "deploys"}><ServiceDeploySummary service={props.service} deployments={deployments} /></Show>
        <Show when={section() === "errors"}><Loading fallback={<Skeleton rows={4} />}><IssuesWidget observe={observe} /></Loading></Show>
        <Show when={section() === "resources"}><ServiceResourcesSection service={props.service} /></Show>
        <Show when={section() === "platform" && serviceName === "stats"}><Loading fallback={<Skeleton rows={3} />}><Platform windowAt={windowAt} refreshKey={refreshKey} selection={() => `${range()}:${view()?.fromMs ?? ""}:${view()?.toMs ?? ""}`} now={now} /></Loading></Show>
        <Show when={section() !== "deploys" && section() !== "errors" && section() !== "platform" && section() !== "resources"}>
          <Show when={error()}>{message => <Notice tone="warn">{message()}</Notice>}</Show><Show when={data()} fallback={error() === null ? <Skeleton rows={3} /> : <EmptyState title="Telemetry could not be read" detail="Use Refresh to retry." />}>{telemetry => <>
            <Show when={section() === "overview"}><Loading fallback={<Skeleton rows={3} chart />}><ApplicationOverview data={telemetry()} refreshing={refreshing()} loadedAtMs={loadedAtMs()} onRequests={() => showSection("requests")} onErrors={() => showSection("errors")} deployment={latest() ? { title: deploymentTitle(latest()!, latest()!.deployment, "service"), atMs: latest()!.deployment.atMs } : undefined} onDeployments={() => showSection("deploys")} onReady={value => journey?.chartsReady(value)} /></Loading></Show>
            <Show when={section() === "signals"}><ApplicationSignals data={telemetry()} /></Show>
            <Show when={section() === "requests"}><Show when={detail()} fallback={<Skeleton rows={3} />}>{recent => <RecentApplicationEvents data={recent()} />}</Show></Show>
          </>}</Show>
        </Show>
      </div>
    </div>
    <Show when={observe.modals().length > 0}><Loading fallback={null}><ObserveModal observe={observe} refreshKey={refreshKey()} /></Loading></Show>
  </DeploymentEvents>;
}

function ApplicationSignals(props: { readonly data: ApplicationSummary }): JSX.Element {
  const track = (measure: Parameters<typeof applicationTrack>[1]) => applicationTrack(props.data, measure);
  return <section class="charts" aria-label="Application signals">
    <Widget title="Events" expandable><PanelChart label="Application event counts" series={[{ label: "events", color: "blue", track: track(bucket => bucket.events) }, { label: "failed", color: "critical", track: track(bucket => bucket.failed) }]} format={count} min={0} stepMs={props.data.stepMs} /></Widget>
    <Widget title="Response status" expandable><PanelChart label="HTTP response status" series={([
      ["2xx", "status2xx", "blue"], ["3xx", "status3xx", "aqua"], ["4xx", "status4xx", "violet"], ["5xx", "status5xx", "critical"]
    ] as const).map(([label, key, color]) => ({ label, color, track: track(bucket => bucket.requests === 0 ? null : bucket[key]) }))} format={count} min={0} stepMs={props.data.stepMs} /></Widget>
    <Widget title="Wall time" expandable><PanelChart label="Application event mean wall time" series={[{ label: "mean", color: "blue", track: track(bucket => bucket.durationMsSum / bucket.events) }, { label: "maximum", color: "violet", track: track(bucket => bucket.durationMsMax) }]} format={milliseconds} min={0} stepMs={props.data.stepMs} /></Widget>
    <p class="cell-note">Missing intervals remain gaps. Wall time measures elapsed application work, including waits.</p>
  </section>;
}
