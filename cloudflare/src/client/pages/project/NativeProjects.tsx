import { createEffect, createMemo, createSignal, Errored, For, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { EmptyState, PageHeader, Skeleton } from "@laputa-systems/ui-dashboard";
import { loadServices } from "../../queries";
import { ErrorState, Widget } from "../../components/ui";
import { DeploymentEvents } from "../../components/DeploymentEvents";
import { createServiceDeployments, DeploymentRail, DeploymentsWidget, deploymentTitle } from "./Deployments";
import { PROJECT_REFRESH_TICKS, rangeMs, useTelemetry } from "../../state";
import { routeWithRange, readParam, writeParam } from "../../urlState";
import { age } from "../../format";
import { RETENTION_MS } from "../../../observe/core/limits";
import { getApplicationTelemetry } from "../../api";
import type { Service } from "../../api";

export function nativeProjects(c: import("../../../core/capabilities").RuntimeCapabilities): boolean {
  return c.applicationEvents && !c.analyticsCollection && !c.cloudflareDeployments && !c.tailEvents;
}

export function NativeProjectsPage(): JSX.Element {
  const { range, now, tick, manualTick } = useTelemetry();
  const services = createMemo(loadServices);
  createEffect(() => `${Math.floor(tick() / PROJECT_REFRESH_TICKS)}:${manualTick()}`, () => { void refresh(services); });
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
  createEffect(() => `${Math.floor(tick() / PROJECT_REFRESH_TICKS)}:${manualTick()}`, () => { void refresh(services); });
  return <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}><Loading fallback={<Skeleton rows={2} />}>
    <Show when={services().find(service => service.name === params.projectId)} keyed fallback={<EmptyState title="Project not found" detail="This service is not registered." action={<a href={routeWithRange("#/projects", range())}>Back to projects</a>} />}>
      {service => <NativeProject service={service} />}
    </Show>
  </Loading></Errored>;
}

type Section = "overview" | "deploys" | "errors" | "requests" | "signals";
const sections: readonly Section[] = ["overview", "deploys", "errors", "requests", "signals"];
function NativeProject(props: { readonly service: Service }): JSX.Element {
  const { range, view, now, tick, manualTick } = useTelemetry();
  const refreshKey = () => `${Math.floor(tick() / PROJECT_REFRESH_TICKS)}:${manualTick()}`;
  const deployments = createServiceDeployments(() => props.service.name, range, refreshKey);
  const [section, setSection] = createSignal<Section>(sections.find(item => item === readParam("section")) ?? "overview");
  const [data, setData] = createSignal<Awaited<ReturnType<typeof getApplicationTelemetry>> | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(() => ({ range: range(), view: view(), refresh: refreshKey() }), ({ range: selected, view: zoom }) => {
    const end = Math.min(zoom?.toMs ?? now(), now());
    const start = Math.max(zoom?.fromMs ?? end - rangeMs[selected], now() - RETENTION_MS);
    const controller = new AbortController();
    setData(null); setError(null);
    if (start >= end) { setError("The selected window is outside application telemetry retention."); return; }
    void getApplicationTelemetry(props.service.name, start, end, controller.signal).then(setData).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Telemetry unavailable"); });
    return () => controller.abort();
  });
  const latest = () => { const value = props.service.latestDeployment; return value?.status === "available" ? value : null; };
  return <DeploymentEvents value={deployments.events}><PageHeader title={props.service.name} />
    <p class="service-facts"><span>{props.service.hostIds.length} hosts</span><span><Show when={latest()} fallback="No deployment recorded">{value => <>Last deploy: {deploymentTitle(value(), value().deployment)} · {age(value().deployment.atMs, now())}</>}</Show></span></p>
    <nav aria-label="Project sections"><For each={sections}>{item => <button class="btn" type="button" aria-current={section() === item ? "page" : undefined} onClick={() => { setSection(item); writeParam("section", item); }}>{item === "deploys" ? "Deployments" : item[0]!.toUpperCase() + item.slice(1)}</button>}</For></nav>
    <div class="project-page"><div class={deployments.listed() ? "project-body with-rail" : "project-body"}><Show when={deployments.listed()}><DeploymentRail deployments={deployments} /></Show><div class="project-main">
      <Show when={section() === "deploys"}><DeploymentsWidget deployments={deployments} /></Show>
      <Show when={section() !== "deploys"}><Show when={error() === null} fallback={<Widget title="Application telemetry"><p role="alert">{error()}</p></Widget>}><Show when={data()} fallback={<Skeleton rows={3} />}>
        {telemetry => <>
          <Show when={section() === "overview"}><Widget title="Application overview"><Show when={telemetry().totals} fallback={<p>No application events in this window.</p>}>{total => <p>{total().events} events · {total().failed} failed · {total().requests} HTTP requests · {(total().durationMsSum / total().events).toFixed(1)} ms mean wall time</p>}</Show><For each={telemetry().operations}>{operation => <p><span class="mono">{operation.operation}</span> · {operation.events} events · {operation.failed} failed</p>}</For><Show when={telemetry().moreOperations}><p>More operations omitted.</p></Show></Widget></Show>
          <Show when={section() === "signals"}><Widget title="Application signals"><Show when={telemetry().buckets.length} fallback={<p>No application events in this window.</p>}><div aria-label="Application signal buckets"><For each={telemetry().buckets}>{bucket => <p>{new Date(bucket.atMs).toLocaleString()} · {bucket.events} events · {bucket.failed} failed · {bucket.status2xx} 2xx · {bucket.status3xx} 3xx · {bucket.status4xx} 4xx · {bucket.status5xx} 5xx · {(bucket.durationMsSum / bucket.events).toFixed(1)} ms mean wall</p>}</For></div><p class="cell-note">Only buckets with events are shown; missing intervals are gaps.</p></Show></Widget></Show>
          <Show when={section() === "requests" || section() === "errors"}><Widget title={section() === "requests" ? "Recent events" : "Recent failures"}><Show when={telemetry().recent.filter(row => section() !== "errors" || row.event.outcome !== "ok").length} fallback={<p>No {section() === "errors" ? "failures" : "events"} in the recent sample.</p>}><div class="table-scroll"><table class="data-table"><thead><tr><th>Time</th><th>Operation</th><th>Outcome</th><th>Wall</th><th>Release</th><th>Work and diagnostics</th></tr></thead><tbody><For each={telemetry().recent.filter(row => section() !== "errors" || row.event.outcome !== "ok")}>{row => <tr><td>{new Date(row.event.atMs).toLocaleString()}</td><td>{row.event.operation}</td><td>{row.event.outcome}</td><td>{row.event.durationMs} ms</td><td>{row.event.release}</td><td>{Object.entries(row.event.work).map(([key, value]) => `${key}: ${value}`).join(", ")} {row.event.error?.code} {row.event.diagnostics?.name} {row.event.diagnostics?.message}</td></tr>}</For></tbody></table></div></Show><Show when={telemetry().moreRecent}><p>Showing the newest 50 events.</p></Show></Widget></Show>
        </>}
      </Show></Show></Show>
    </div></div></div></DeploymentEvents>;
}
