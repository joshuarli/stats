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
import { getApplicationTelemetry, type Service } from "../../api";
import type { ApplicationTelemetry } from "../../../observe/application/telemetry";
import { applicationTrack } from "./native-series";
import "./project.css";

export { nativeProjects } from "./native-series";
const IssuesWidget = lazy(() => import("./ObserveSection").then(module => ({ default: module.IssuesWidget })));
const ObserveModal = lazy(() => import("./ObserveSection").then(module => ({ default: module.ObserveModal })));

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

type Section = "overview" | "deploys" | "errors" | "requests" | "signals";
const sections: readonly Section[] = ["overview", "deploys", "errors", "requests", "signals"];
function initialSection(): Section {
  return sections.find(item => item === readParam("section")) ?? (readParam("deployment") !== null ? "deploys" : readParam("issue") !== null ? "errors" : "overview");
}

function NativeProject(props: { readonly service: Service }): JSX.Element {
  const serviceName = props.service.name;
  const { range, view, now, tick, manualTick } = useTelemetry();
  const refreshKey = () => `${Math.floor(tick() / PROJECT_REFRESH_TICKS)}:${manualTick()}`;
  const deployments = createServiceDeployments(() => serviceName, range, refreshKey);
  const [section, setSection] = createSignal<Section>(initialSection());
  const [data, setData] = createSignal<ApplicationTelemetry | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const windowAt = () => {
    const end = Math.min(view()?.toMs ?? now(), now());
    return { fromMs: Math.max(view()?.fromMs ?? end - rangeMs[range()], now() - RETENTION_MS), toMs: end };
  };
  const observe = createObservability(serviceName, refreshKey, () => `${range()}:${view()?.fromMs ?? ""}:${view()?.toMs ?? ""}`, windowAt, () => false, () => section() === "errors");
  createEffect(() => true, () => {
    const sync = () => setSection(initialSection());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  });
  createEffect(() => ({ service: serviceName, range: range(), view: view(), refresh: refreshKey() }), query => {
    const window = windowAt();
    const controller = new AbortController();
    setData(null); setError(null);
    if (window.fromMs >= window.toMs) { setError("The selected window is outside application telemetry retention."); return; }
    void getApplicationTelemetry(query.service, window.fromMs, window.toMs, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  });
  const latest = () => { const value = props.service.latestDeployment; return value?.status === "available" ? value : null; };
  const showSection = (next: Section) => { setSection(next); writeParam("section", next); };
  const events = createMemo(() => deployments.events().map(event => ({ ...event, onSelect: () => { showSection("deploys"); event.onSelect(); } })));
  return <DeploymentEvents value={events}>
    <PageHeader title={props.service.name} titleExtra={<Badge tone="neutral">Application telemetry</Badge>}>
      <div class="project-pills" aria-label="Project health">
        <Show when={data()?.totals}>{total => <><button class="project-pill tone-neutral" onClick={() => showSection("requests")}>{count(total().requests)} HTTP requests</button><button class={`project-pill tone-${total().status5xx > 0 ? "bad" : "neutral"}`} onClick={() => showSection("signals")}>{count(total().status5xx)} 5xx</button></>}</Show>
        <Show when={observe.health()}>{health => <button class="project-pill tone-neutral" onClick={() => showSection("errors")}>{health().openIssues} open errors</button>}</Show>
        <Show when={latest()}>{value => <button class="project-pill tone-neutral" onClick={() => showSection("deploys")}>{deploymentTitle(value(), value().deployment, "service")} · {age(value().deployment.atMs, now())}</button>}</Show>
      </div>
    </PageHeader>
    <div class="project-layout">
      <nav class="project-sidebar" aria-label="Project sections"><For each={sections}>{item => <div class={`project-nav-entry${section() === item ? " open" : ""}`}><button class={`project-nav-item project-section-head${section() === item ? " active" : ""}`} type="button" aria-current={section() === item ? "page" : undefined} onClick={() => showSection(item)}><span class="project-nav-title">{item === "deploys" ? "Deployments" : item[0]!.toUpperCase() + item.slice(1)}</span><span class="project-nav-summary">{item === "overview" ? "application activity" : item === "deploys" ? "release markers and comparison" : item === "requests" ? "recent HTTP and application events" : item === "signals" ? "events, status and wall time" : "issues and diagnostics"}</span></button></div>}</For></nav>
      <div class="project-content">
        <Show when={section() === "deploys"}><div class={deployments.listed() ? "project-body with-rail" : "project-body"}><Show when={deployments.listed()}><DeploymentRail deployments={deployments} /></Show><div class="project-main"><DeploymentsWidget deployments={deployments} /></div></div></Show>
        <Show when={section() === "errors"}><Loading fallback={<Skeleton rows={4} />}><IssuesWidget observe={observe} /></Loading></Show>
        <Show when={section() !== "deploys" && section() !== "errors"}>
          <Show when={error() === null} fallback={<Notice tone="warn">{error()}</Notice>}><Show when={data()} fallback={<Skeleton rows={3} />}>{telemetry => <>
            <Show when={section() === "overview"}><Widget title="Application overview"><Show when={telemetry().totals} fallback={<EmptyState title="No application events in this window" detail="Events appear when this service reports work or handles instrumented requests." />}>{total => <p>{count(total().events)} events · {count(total().failed)} failed · {count(total().requests)} HTTP requests · {milliseconds(total().durationMsSum / total().events)} mean wall time</p>}</Show><For each={telemetry().operations}>{operation => <p><span class="mono">{operation.operation}</span> · {count(operation.events)} events · {count(operation.failed)} failed</p>}</For><Show when={telemetry().moreOperations}><p>Showing the 20 busiest operations.</p></Show></Widget></Show>
            <Show when={section() === "signals"}><ApplicationSignals data={telemetry()} /></Show>
            <Show when={section() === "requests"}><Widget title="Recent events"><Show when={telemetry().recent.length} fallback={<EmptyState title="No recent events in this window" />}><div class="table-scroll"><table class="data-table" aria-label="Recent application events"><thead><tr><th>Time</th><th>Operation</th><th>Outcome</th><th>Wall</th><th>Release</th><th>Work</th></tr></thead><tbody><For each={telemetry().recent}>{row => <tr><td>{new Date(row.event.atMs).toLocaleString()}</td><td>{row.event.operation}</td><td>{row.event.outcome}</td><td>{milliseconds(row.event.durationMs)}</td><td>{row.event.release}</td><td>{Object.entries(row.event.work).map(([key, value]) => `${key}: ${value}`).join(", ")}<Show when={row.event.error}><div>{row.event.error?.code}</div></Show></td></tr>}</For></tbody></table></div></Show><Show when={telemetry().moreRecent}><p>Showing the newest 50 events in the selected window.</p></Show><p class="cell-note">HTTP events report response status and time to response headers. Other events report application work.</p></Widget></Show>
          </>}</Show></Show>
        </Show>
      </div>
    </div>
    <Show when={observe.modals().length > 0}><Loading fallback={null}><ObserveModal observe={observe} refreshKey={refreshKey()} /></Loading></Show>
  </DeploymentEvents>;
}

function ApplicationSignals(props: { readonly data: ApplicationTelemetry }): JSX.Element {
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
