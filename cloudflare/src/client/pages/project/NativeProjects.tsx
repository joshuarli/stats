import { createEffect, createMemo, createSignal, Errored, For, lazy, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { Badge, EmptyState, PageHeader, Skeleton } from "@laputa-systems/ui-dashboard";
import { loadServices } from "../../queries";
import { ErrorState, Notice, Widget } from "../../components/ui";
import { DeploymentEvents } from "../../components/DeploymentEvents";
import { createServiceDeployments, DeploymentRail, DeploymentsWidget, deploymentTitle } from "./Deployments";
import { createObservability } from "./Observe";
import { PanelChart } from "../host/shared";
import { PROJECT_REFRESH_TICKS, rangeMs, useTelemetry } from "../../state";
import { routeWithRange, readParam, writeParam } from "../../urlState";
import { age, count, errorMessage, milliseconds } from "../../format";
import { createUpdateEffect } from "../../effect";
import { RETENTION_MS } from "../../../observe/core/limits";
import { getApplicationSummary, getApplicationTelemetry, type Service } from "../../api";
import type { ApplicationSummary, ApplicationTelemetry } from "../../../observe/application/telemetry";
import { applicationTrack } from "./native-series";
import { RecentApplicationEvents } from "./RecentApplicationEvents";
import "./project.css";

const Platform = lazy(() => import("./Platform"));
const IssuesWidget = lazy(() => import("./ObserveSection").then(module => ({ default: module.IssuesWidget })));
const ObserveModal = lazy(() => import("./ObserveSection").then(module => ({ default: module.ObserveModal })));
const ApplicationOverview = lazy(() => import("./ApplicationOverview").then(module => ({ default: module.ApplicationOverview })));

export function NativeProjectsPage(): JSX.Element {
  const { range, now, tick, manualTick } = useTelemetry();
  const services = createMemo(loadServices);
  createUpdateEffect(() => `${Math.floor(tick() / PROJECT_REFRESH_TICKS)}:${manualTick()}`, () => { void refresh(services); });
  return <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}><Loading fallback={<Skeleton rows={2} />}>
    <Widget title="Projects"><Show when={services().length} fallback={<EmptyState title="No services registered" detail="Register a service to see its application telemetry." />}>
      <div class="table-scroll"><table class="data-table" aria-label="Projects"><thead><tr><th>Project</th><th>Hosts</th><th>Last deploy</th></tr></thead><tbody>
        <For each={services()}>{service => <tr><td><a href={routeWithRange(`#/project/${encodeURIComponent(service.name)}`, range())}>{service.name}</a></td><td>{service.hostIds.length}</td><td><Show when={service.latestDeployment?.status === "available" ? service.latestDeployment : null} fallback="No deployment recorded">{latest => <>{deploymentTitle(latest(), latest().deployment)} · {age(latest().deployment.atMs, now())}</>}</Show></td></tr>}</For>
      </tbody></table></div>
    </Show></Widget>
  </Loading></Errored>;
}

export function NativeProjectPage(): JSX.Element {
  const params = useParams();
  const services = createMemo(loadServices);
  const { range, tick, manualTick } = useTelemetry();
  createUpdateEffect(() => `${Math.floor(tick() / PROJECT_REFRESH_TICKS)}:${manualTick()}`, () => { void refresh(services); });
  return <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}><Loading fallback={<Skeleton rows={2} />}>
    <Show when={services().find(service => service.name === params.projectId)?.name} keyed fallback={<EmptyState title="Project not found" detail="This service is not registered." action={<a href={routeWithRange("#/projects", range())}>Back to projects</a>} />}>
      {name => <NativeProject service={services().find(service => service.name === name)!} />}
    </Show>
  </Loading></Errored>;
}

type Section = "overview" | "deploys" | "errors" | "requests" | "signals" | "platform";
const sections: readonly Section[] = ["overview", "deploys", "errors", "requests", "signals", "platform"];
function initialSection(): Section {
  return sections.find(item => item === readParam("section")) ?? (readParam("deployment") !== null ? "deploys" : readParam("issue") !== null ? "errors" : "overview");
}

function NativeProject(props: { readonly service: Service }): JSX.Element {
  const serviceName = props.service.name;
  const { range, view, now, tick, manualTick } = useTelemetry();
  const refreshKey = () => `${Math.floor(tick() / PROJECT_REFRESH_TICKS)}:${manualTick()}`;
  const [section, setSection] = createSignal<Section>(serviceName === "stats" || initialSection() !== "platform" ? initialSection() : "overview");
  const deployments = createServiceDeployments(() => serviceName, range, refreshKey, { active: () => section() === "deploys" });
  const [data, setData] = createSignal<ApplicationSummary | ApplicationTelemetry | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);
  const [loadedAtMs, setLoadedAtMs] = createSignal(0);
  let loadedWindow: string | null = null;
  let loadedKey: string | null = null;
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
    if (data() !== null && loadedKey === key && (!query.recent || detail() !== null)) { setRefreshing(false); setError(null); return; }
    const window = windowAt();
    const controller = new AbortController();
    if (loadedWindow !== selection) setData(null);
    setError(null);
    setRefreshing(true);
    if (window.fromMs >= window.toMs) { setError("The selected window is outside application telemetry retention."); setRefreshing(false); return; }
    const read = query.recent ? getApplicationTelemetry : getApplicationSummary;
    void read(query.service, window.fromMs, window.toMs, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setData(value);
      loadedWindow = selection;
      loadedKey = key;
      setLoadedAtMs(Date.now());
      setRefreshing(false);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) { setError(errorMessage(failure)); setRefreshing(false); } });
    return () => controller.abort();
  });
  const latest = () => { const value = props.service.latestDeployment; return value?.status === "available" ? value : null; };
  const showSection = (next: Section) => { setSection(next); writeParam("section", next); };
  const events = createMemo(() => deployments.events().map(event => ({ ...event, onSelect: () => { showSection("deploys"); event.onSelect(); } })));
  return <DeploymentEvents value={events}>
    <PageHeader title={props.service.name} titleExtra={<Badge tone="neutral">Application telemetry</Badge>}>
      <div class="project-pills" aria-label="Project health">
        <Show when={data()?.totals}>{total => <><button class="project-pill tone-neutral" onClick={() => showSection("requests")}>{count(total().requests)} HTTP requests</button><button class={`project-pill tone-${total().status5xx > 0 ? "bad" : "neutral"}`} onClick={() => showSection("signals")}>{count(total().status5xx)} 5xx</button></>}</Show>
        <Show when={data() !== null || observe.health() !== null}><button class="project-pill tone-neutral" onClick={() => showSection("errors")}>{observe.health()?.openIssues ?? data()?.openIssues} open errors</button></Show>
        <Show when={latest()}>{value => <button class="project-pill tone-neutral" onClick={() => showSection("deploys")}>{deploymentTitle(value(), value().deployment, "service")} · {age(value().deployment.atMs, now())}</button>}</Show>
      </div>
    </PageHeader>
    <div class="project-layout">
      <nav class="project-sidebar" aria-label="Project sections"><For each={sections.filter(item => item !== "platform" || serviceName === "stats")}>{item => <div class={`project-nav-entry${section() === item ? " open" : ""}`}><button class={`project-nav-item project-section-head${section() === item ? " active" : ""}`} type="button" aria-current={section() === item ? "page" : undefined} onClick={() => showSection(item)}><span class="project-nav-title">{item === "deploys" ? "Deployments" : item[0]!.toUpperCase() + item.slice(1)}</span><span class="project-nav-summary">{item === "platform" ? "sampled platform operations" : item === "overview" ? "application activity" : item === "deploys" ? "release markers and comparison" : item === "requests" ? "HTTP and work events" : item === "signals" ? "events, status and wall time" : "issues and diagnostics"}</span></button></div>}</For></nav>
      <div class="project-content">
        <Show when={section() === "deploys"}><div class={deployments.listed() ? "project-body with-rail" : "project-body"}><Show when={deployments.listed()}><DeploymentRail deployments={deployments} /></Show><div class="project-main"><DeploymentsWidget deployments={deployments} /></div></div></Show>
        <Show when={section() === "errors"}><Loading fallback={<Skeleton rows={4} />}><IssuesWidget observe={observe} /></Loading></Show>
        <Show when={section() === "platform" && serviceName === "stats"}><Loading fallback={<Skeleton rows={3} />}><Platform windowAt={windowAt} refreshKey={refreshKey} selection={() => `${range()}:${view()?.fromMs ?? ""}:${view()?.toMs ?? ""}`} now={now} /></Loading></Show>
        <Show when={section() !== "deploys" && section() !== "errors" && section() !== "platform"}>
          <Show when={error()}>{message => <Notice tone="warn">{message()}</Notice>}</Show><Show when={data()} fallback={error() === null ? <Skeleton rows={3} /> : <EmptyState title="Telemetry could not be read" detail="Use Refresh to retry." />}>{telemetry => <>
            <Show when={section() === "overview"}><Loading fallback={<Skeleton rows={3} chart />}><ApplicationOverview data={telemetry()} refreshing={refreshing()} loadedAtMs={loadedAtMs()} onRequests={() => showSection("requests")} onErrors={() => showSection("errors")} /></Loading></Show>
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
