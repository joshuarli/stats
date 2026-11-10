import { createEffect, createMemo, createSignal, Errored, For, lazy, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { getProjectHistories, type Project } from "../api";
import { age, errorMessage, percent } from "../format";
import { collectorStatus } from "../status";
import { createUpdateEffect } from "../effect";
import { createRefreshRetention, loadProjects, loadQuery } from "../queries";
import { windowParams } from "../history-path";
import { useTelemetry, PROJECT_REFRESH_TICKS, rangeMs } from "../state";
import { Badge, EmptyState, PageHeader, Skeleton } from "@laputa-systems/ui-dashboard";
import { Info } from "../components/Info";
import { ErrorState, Notice, Widget } from "../components/ui";
import { CollectorWidget } from "./project/Collector";
import { D1Widget } from "./project/D1";
import { createProjectDeployments, DeploymentRail, DeploymentsWidget } from "./project/Deployments";
import { DeploymentEvents } from "../components/DeploymentEvents";
import { ProbesWidget } from "./project/Probes";
import { OperationsWidget, StorageWidget } from "./project/R2";
import { DurableObjectsWidget } from "./project/DurableObjects";
import { metricTrack, type ProjectHistories } from "../history";
import { hasAnyValue, silenceMinutes, type ProjectData } from "./project/series";
import { CpuTimeWidget, RequestsWidget, StatusWidget } from "./project/Worker";
import { createObservability, type Observability } from "./project/Observe";
import { createMonthSpend, createProjectLedger, historyKinds, settledWindow } from "./project/ledger-load";
import { HOUR_MS } from "../../limits";
import { CostLedger } from "./project/CostLedger";
import "./project/project.css";
import { readParam, writeParam } from "../urlState";
import { LIMITS } from "../health";
import { RETENTION_MS } from "../../observe/core/limits";
import { isObservedService } from "../../observe/services";
import type { TimeWindow } from "../chart-data";

type SectionId = "overview" | "deploys" | "errors" | "requests" | "signals";
const SECTION_IDS: readonly SectionId[] = ["overview", "deploys", "errors", "requests", "signals"];

function isSectionId(value: string): value is SectionId {
  return (SECTION_IDS as readonly string[]).includes(value);
}
const IssuesWidget = lazy(() => import("./project/ObserveSection").then(module => ({ default: module.IssuesWidget })));
const ObserveModal = lazy(() => import("./project/ObserveSection").then(module => ({ default: module.ObserveModal })));
const RolloutImpactPanel = lazy(() => import("./project/ObserveSection").then(module => ({ default: module.RolloutImpactPanel })));
const RequestExplorerWidget = lazy(() => import("./project/Requests").then(module => ({ default: module.RequestExplorerWidget })));
const LINKED_SECTIONS: readonly (readonly [string, SectionId])[] = [["deployment", "deploys"], ["issue", "errors"], ["issues", "errors"], ["introduced", "errors"], ["route", "requests"], ["band", "requests"], ["traces", "requests"], ["trace", "requests"]];

export function ProjectPage(): JSX.Element {
  const params = useParams();
  const { tick, manualTick } = useTelemetry();
  const projectTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const projects = createMemo(loadProjects);
  const project = createMemo(() => projects().find(candidate => candidate.id === (params.projectId ?? "")));
  createUpdateEffect(() => `${projectTick()}:${manualTick()}`, () => { void refresh(projects); });
  return (
    <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
      <Loading fallback={<Skeleton rows={2} />}>
        <Show
          when={project()?.id}
          keyed
          fallback={
            <EmptyState
              icon="host"
              title="Project not found"
              detail="The project id is not in this installation's configuration."
              action={<a class="btn" href="#/projects">Back to projects</a>}
            />
          }
        >
          {id => <ProjectView project={projects().find(candidate => candidate.id === id)!} />}
        </Show>
      </Loading>
    </Errored>
  );
}

function initialSection(observed: boolean): SectionId {
  const section = readParam("section");
  if (section !== null && isSectionId(section)) {
    if (observed || (section !== "errors" && section !== "requests")) return section;
  }
  const linked = LINKED_SECTIONS.find(([param]) => readParam(param) !== null)?.[1];
  if (linked !== undefined && (observed || (linked !== "errors" && linked !== "requests"))) return linked;
  const opened = (readParam("open") ?? "").split(",").find((entry): entry is SectionId => (SECTION_IDS as readonly string[]).includes(entry));
  if (opened !== undefined && opened !== "overview" && (observed || (opened !== "errors" && opened !== "requests"))) return opened;
  return "overview";
}

function ProjectView(props: { readonly project: Project }): JSX.Element {
  const { range, query, view, now, tick, manualTick } = useTelemetry();
  const projectTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const [refreshError, setRefreshError] = createSignal<string | null>(null);
  const service = isObservedService(props.project.worker) ? props.project.worker : null;
  const [active, setActive] = createSignal<SectionId>(initialSection(service !== null));
  let requestsButton: HTMLButtonElement | undefined;
  createEffect(() => true, () => {
    const syncSection = () => { setActive(initialSection(service !== null)); };
    window.addEventListener("hashchange", syncSection);
    return () => window.removeEventListener("hashchange", syncSection);
  });
  const id = () => props.project.id;
  const hasBuckets = () => props.project.buckets.length > 0;
  const hasNamespaces = () => props.project.durableObjectNamespaces.length > 0;
  const hasDatabases = () => props.project.d1Databases.length > 0;
  const kinds = () => historyKinds(props.project);
  const retention = createRefreshRetention();
  const histories = createMemo<ProjectHistories>(previous =>
    loadQuery(
      signal => getProjectHistories(id(), query(), kinds(), signal),
      { key: `${id()}|${windowParams(query())}`, previous, retention, onError: error => setRefreshError(error === null ? null : errorMessage(error)) }
    )
  );
  const worker = () => histories().worker;
  const collector = () => histories().collector;

  const doRefresh = async () => {
    setRefreshError(null);
    try {
      await refresh(histories);
    } catch (error) {
      setRefreshError(errorMessage(error));
    }
  };
  createUpdateEffect(() => `${projectTick()}:${manualTick()}`, () => { void doRefresh(); });

  const data = createMemo((): ProjectData => ({
    worker: worker(),
    routes: histories().routes,
    durableObjects: histories()["durable-objects"],
    r2: histories().r2,
    d1: histories().d1,
    d1Statements: histories()["d1-statements"],
    probes: histories().probes,
    probeNames: props.project.probes.map(probe => probe.name),
    buckets: props.project.buckets,
    databases: props.project.d1Databases,
    silence: silenceMinutes(collector(), now(), props.project.collector.lastSuccessAtMs)
  }));
  const status = createMemo(() => collectorStatus(props.project.collector, now()));
  const collectorNote = () => {
    switch (status().label) {
      case "collecting": return undefined;
      case "waiting": return "The collector has not run yet, so there is no data.";
      case "failing": return "The last collection failed. Figures show what was collected before it.";
      case "stale": return "The collector has not succeeded recently, so the newest buckets may be missing.";
    }
  };
  const hasData = createMemo(() => hasAnyValue(metricTrack(data().worker, "worker.invocations"), ...props.project.buckets.map(bucket => metricTrack(data().r2, `r2.${bucket}.storageBytes`))));

  const ledgerWindow = createMemo((): TimeWindow => settledWindow(worker(), HOUR_MS, view()));
  const windowLabel = () => view() !== null
    ? "Zoomed window, up to the last settled bucket, vs the window before it"
    : `Settled hour ending ${age(ledgerWindow().toMs, now())} vs the hour before`;
  const observeWindow = () => {
    const zoomed = view();
    if (zoomed !== null) return zoomed;
    const end = now();
    return { fromMs: end - Math.min(rangeMs[range()], RETENTION_MS), toMs: end };
  };
  const observeWindowLabel = () => view() !== null ? "zoomed window" : rangeMs[range()] > RETENTION_MS ? "last 7 days (traces keep 7)" : `last ${range()}`;
  const observe: Observability | null = service !== null ? createObservability(service, () => `${projectTick()}:${manualTick()}`, () => `${range()}:${view()?.fromMs ?? ""}:${view()?.toMs ?? ""}`, observeWindow, () => active() === "requests", () => active() === "errors") : null;
  const settledMs = createMemo(() => settledWindow(worker(), HOUR_MS, null).toMs);
  const monthSpend = createMonthSpend(() => props.project, settledMs, () => `${projectTick()}:${manualTick()}`);
  const { ledger, error: ledgerLoadError, baselineError } = createProjectLedger(
    () => props.project, ledgerWindow, () => { const zoomed = view(); return zoomed === null ? "settled-hour" : `${zoomed.fromMs}:${zoomed.toMs}`; }, () => `${projectTick()}:${manualTick()}`,
    observe === null ? null : { read: observe.read, retentionMs: RETENTION_MS, now },
    monthSpend.spend
  );

  const showSection = (section: SectionId) => {
    if (active() === section) return;
    setActive(section);
    writeParam("section", section);
    writeParam("open", null);
  };

  const deployments = createProjectDeployments(id, range, () => `${projectTick()}:${manualTick()}`, () => active() === "deploys");
  const deploymentsSettled = () => deployments.history() !== null || deployments.historyError() !== null;
  const events = createMemo(() => deployments.events().map(event => ({ ...event, onSelect: () => { showSection("deploys"); event.onSelect(); } })));
  const latest = () => deployments.history()?.deployments[0];

  const serverErrors = createMemo(() => {
    const total = (metric: string) => metricTrack(worker(), metric).values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const calls = total("worker.invocations");
    return calls > 0 ? (total("worker.status.5xx") / calls) * 100 : undefined;
  });
  const serverErrorTone = () => {
    const share = serverErrors();
    const limits = LIMITS.workerServerErrorPercent;
    return share === undefined ? "neutral" : share >= limits.critical ? "bad" : share >= limits.elevated ? "warn" : "neutral";
  };
  const probesUp = createMemo(() => {
    const probes = histories().probes;
    if (probes === undefined) return undefined;
    const latestUp = props.project.probes.map(probe => [...metricTrack(probes, `probe.${probe.name}.up`).values].reverse().find(value => value !== null) ?? null);
    return { up: latestUp.filter(value => value !== null && value >= 1).length, known: latestUp.filter(value => value !== null).length, total: props.project.probes.length };
  });
  const openIssues = () => observe?.health()?.openIssues;

  const navItems = createMemo(() => {
    const items: { id: SectionId; title: string; summary: () => JSX.Element }[] = [{ id: "overview", title: "Overview", summary: () => "cost and usage" }];
    items.push({ id: "deploys", title: "Deployments", summary: () => {
      const deployment = latest();
      if (deployment !== undefined) return <>{deployments.title(deployment)} · {age(deployment.atMs, now())}</>;
      return deploymentsSettled() ? (deployments.historyError() ?? "none recorded") : <span class="summary-pending" aria-hidden="true" />;
    } });
    if (observe !== null) {
      items.push({ id: "errors", title: "Errors", summary: () => observe.health() !== null ? `${observe.health()?.openIssues ?? 0} open` : observe.issuesError() ?? <span class="summary-pending" aria-hidden="true" /> });
      items.push({ id: "requests", title: "Requests", summary: () => `routes, latency and traces · ${observeWindowLabel()}` });
    }
    items.push({ id: "signals", title: "Signals", summary: () => ["requests", "status", "CPU", ...(hasBuckets() ? ["R2"] : []), ...(hasDatabases() ? ["D1"] : []), ...(props.project.probes.length > 0 ? ["endpoints"] : []), ...(hasNamespaces() ? ["Durable Objects"] : []), "collector"].join(" · ") });
    return items;
  });

  return (
    <DeploymentEvents value={events}>
      <PageHeader
        title={props.project.name}
        titleExtra={<><Badge tone={status().tone} dot>{status().label}</Badge><Show when={collectorNote()}>{(note) => <Info title="Collector status">{note()}</Info>}</Show></>}
      >
        <Errored fallback={null}>
          <Loading fallback={<div class="project-pills project-pills-pending" aria-hidden="true" />}>
            <div class="project-pills" aria-label="Project health">
              <button type="button" class={`project-pill tone-${serverErrorTone()}`} onClick={() => showSection("signals")}>5xx {serverErrors() === undefined ? "—" : percent(Number((serverErrors() ?? 0).toPrecision(2)))}</button>
              <Show when={openIssues() !== undefined}>
                <button type="button" class={`project-pill tone-${(openIssues() ?? 0) > 0 ? "bad" : "neutral"}`} onClick={() => showSection("errors")}>{openIssues()} open {openIssues() === 1 ? "error" : "errors"}</button>
              </Show>
              <Show when={probesUp()}>{probes => (
                <button type="button" class={`project-pill tone-${probes().known > probes().up ? "bad" : "neutral"}`} onClick={() => showSection("signals")}>{probes().up}/{probes().total} endpoints up</button>
              )}</Show>
              <Show when={latest()}>{deployment => (
                <button type="button" class="project-pill tone-neutral" onClick={() => showSection("deploys")}>{deployments.title(deployment())} <em>{age(deployment().atMs, now())}</em></button>
              )}</Show>
            </div>
          </Loading>
        </Errored>
      </PageHeader>
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>
      <div class="project-layout">
        <nav class="project-sidebar" aria-label="Project sections">
          <For each={navItems()}>{item => (
            <div id={`section-${item.id}`} class={active() === item.id ? "project-nav-entry open" : "project-nav-entry"}>
              <button
                type="button"
                data-section={item.id}
                class={`project-nav-item project-section-head${active() === item.id ? " active" : ""}`}
                aria-current={active() === item.id ? "page" : undefined}
                aria-expanded={active() === item.id ? "true" : "false"}
                ref={element => { if (item.id === "requests") requestsButton = element; }}
                onClick={() => showSection(item.id)}
              >
                <span class="project-nav-title project-section-title">{item.title}</span>
                <span class="project-nav-summary project-section-summary">{item.summary()}</span>
              </button>
            </div>
          )}</For>
        </nav>
        <div class="project-content">
          <Show when={active() === "overview"}>
            <Errored fallback={(error) => <ErrorState error={error()} compact />}>
              <Loading fallback={<Skeleton rows={4} chart class="skeleton-ledger" />}>
                <Show
                  when={hasData()}
                  fallback={
                    <Widget title="Data">
                      <EmptyState title="No data was collected in this range." detail="Missing data is shown as a gap, never as zero." icon="activity" />
                    </Widget>
                  }
                >
                  <Show when={baselineError()}>{message => (
                    <Notice tone="warn">{`The previous window could not be read, so changes are not shown: ${message()}`}</Notice>
                  )}</Show>
                  <Show when={monthSpend.error()}>{message => (
                    <Notice tone="warn">{`This month's spend could not be read: ${message()}`}</Notice>
                  )}</Show>
                  <Show when={ledger()} fallback={ledgerLoadError() === null ? <Skeleton rows={4} class="skeleton-ledger" /> : <ErrorState error={new Error(ledgerLoadError() ?? "")} compact />}>
                    {current => <CostLedger report={current().report} histories={current().histories} previousHistories={current().previous} windowLabel={windowLabel()} spendPending={monthSpend.spend() === null && monthSpend.error() === null} onFindRoute={observe === null ? undefined : label => { observe.filterRoute(label); showSection("requests"); queueMicrotask(() => requestsButton?.focus()); }} />}
                  </Show>
                </Show>
              </Loading>
            </Errored>
          </Show>

          <Show when={active() === "deploys"}>
            <Show when={deploymentsSettled()} fallback={<Skeleton rows={4} chart class="skeleton-deployments" />}>
              <div class={deployments.listed() ? "project-body with-rail" : "project-body"}>
                <Show when={deployments.listed()}><DeploymentRail deployments={deployments} /></Show>
                <div class="project-main">
                  <DeploymentsWidget deployments={deployments} impact={observe === null ? undefined : deploymentId => <Loading fallback={<Skeleton rows={2} />}><RolloutImpactPanel deploymentId={deploymentId} refreshKey={`${projectTick()}:${manualTick()}`} observe={observe} /></Loading>} />
                </div>
              </div>
            </Show>
          </Show>

          <Show when={observe}>{state => (
            <>
              <Show when={active() === "errors"}>
                <Loading fallback={<Skeleton rows={5} />}><IssuesWidget observe={state()} /></Loading>
              </Show>
              <Show when={active() === "requests"}>
                <Loading fallback={<Skeleton rows={4} chart />}><RequestExplorerWidget observe={state()} windowLabel={observeWindowLabel()} /></Loading>
              </Show>
              <Show when={state().modals().length > 0}><Loading fallback={null}><ObserveModal observe={state()} refreshKey={`${projectTick()}:${manualTick()}`} /></Loading></Show>
            </>
          )}</Show>

          <Show when={active() === "signals"}>
            <Errored fallback={(error) => <ErrorState error={error()} compact />}>
              <Loading fallback={<Skeleton rows={4} chart class="skeleton-signals" />}>
                <section class="charts" aria-label="Charts">
                  <RequestsWidget data={data()} />
                  <StatusWidget data={data()} />
                  {hasBuckets() ? <OperationsWidget data={data()} /> : null}
                  <CpuTimeWidget data={data()} />
                  {hasBuckets() ? <StorageWidget data={data()} /> : null}
                  {hasDatabases() ? <D1Widget data={data()} view={view()} /> : null}
                  {props.project.probes.length > 0 ? <ProbesWidget data={data()} /> : null}
                  {hasNamespaces() ? <DurableObjectsWidget data={data()} /> : null}
                  <CollectorWidget data={data()} collector={props.project.collector} now={now()} rowsRead={collector().runs.at(-1)?.rowsRead} />
                </section>
              </Loading>
            </Errored>
          </Show>
        </div>
      </div>
    </DeploymentEvents>
  );
}
