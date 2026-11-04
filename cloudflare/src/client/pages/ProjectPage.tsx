import { createMemo, createSignal, Errored, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { getProjectHistories, type Project } from "../api";
import { errorMessage } from "../format";
import { collectorStatus } from "../status";
import { createUpdateEffect } from "../effect";
import { loadProjects, loadQuery } from "../queries";
import { useTelemetry, PROJECT_REFRESH_TICKS } from "../state";
import { PageHeader } from "../components/PageHeader";
import { SectionBar, type SectionLink } from "../components/SectionBar";
import { Badge, EmptyState, ErrorState, Notice, Skeleton, Widget } from "../components/ui";
import { StatusStrip } from "./host/Status";
import { CollectorWidget } from "./project/Collector";
import { CostWidget } from "./project/Cost";
import { D1StatementsWidget, D1Widget } from "./project/D1";
import { createProjectDeployments, DeploymentRail, DeploymentsWidget } from "./project/Deployments";
import { DeploymentEvents } from "../components/DeploymentEvents";
import { ProbesWidget } from "./project/Probes";
import { OperationsWidget, StorageWidget } from "./project/R2";
import { DurableObjectsWidget, RoutesWidget } from "./project/Routes";
import { metricTrack } from "../history";
import { buildProjectCells, hasAnyValue, silenceMinutes, type ProjectData } from "./project/series";
import { CpuTimeWidget, RequestsWidget, StatusWidget } from "./project/Worker";
import { createObservability, IssuesWidget, ObserveModal, RolloutImpactPanel } from "./project/Observe";
import { RequestExplorerWidget } from "./project/Requests";
import { rangeMs } from "../state";
import { RETENTION_MS } from "../../observe/core/limits";
import { isObservedService } from "../../observe/services";

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
          when={project()}
          fallback={
            <EmptyState
              icon="host"
              title="Project not found"
              detail="The project id is not in this installation's configuration."
              action={<a class="btn" href="#/projects">Back to projects</a>}
            />
          }
        >
          {(found) => <ProjectView project={found()} />}
        </Show>
      </Loading>
    </Errored>
  );
}

function ProjectView(props: { readonly project: Project }): JSX.Element {
  const { range, query, view, now, tick, manualTick } = useTelemetry();
  const projectTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const [refreshError, setRefreshError] = createSignal<string | null>(null);
  const id = () => props.project.id;
  const hasBuckets = () => props.project.buckets.length > 0;
  const hasNamespaces = () => props.project.durableObjectNamespaces.length > 0;
  const hasDatabases = () => props.project.d1Databases.length > 0;
  const histories = createMemo(() => loadQuery(signal => getProjectHistories(id(), query(), {
    durableObjects: hasNamespaces(),
    d1: hasDatabases(),
    probes: props.project.probes.length > 0
  }, signal)));
  const worker = () => histories().worker;
  const routes = () => histories().routes;
  const durableObjects = () => histories()["durable-objects"];
  const r2 = () => histories().r2;
  const d1 = () => histories().d1;
  const d1Statements = () => histories()["d1-statements"];
  const collector = () => histories().collector;
  const probes = () => histories().probes;

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
    routes: routes(),
    durableObjects: durableObjects(),
    r2: r2(),
    d1: d1(),
    d1Statements: d1Statements(),
    probes: probes(),
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
      case "failing": return "The last collection failed. Charts show what was collected before it.";
      case "stale": return "The collector has not succeeded recently, so the newest buckets may be missing.";
    }
  };
  const cells = createMemo(() => buildProjectCells(data(), view()));
  const hasData = createMemo(() => hasAnyValue(metricTrack(data().worker, "worker.invocations"), ...props.project.buckets.map(bucket => metricTrack(data().r2, `r2.${bucket}.storageBytes`))));
  const rowsRead = createMemo(() => collector().runs.at(-1)?.rowsRead);
  const service = isObservedService(props.project.worker) ? props.project.worker : null;
  const observed = service !== null;
  const observeWindow = () => {
    const zoomed = view();
    if (zoomed !== null) return zoomed;
    const end = now();
    return { fromMs: end - Math.min(rangeMs[range()], RETENTION_MS), toMs: end };
  };
  const observeWindowLabel = () => view() !== null ? "zoomed window" : rangeMs[range()] > RETENTION_MS ? "last 7 days (traces keep 7)" : `last ${range()}`;
  const observe = service !== null ? createObservability(service, () => `${projectTick()}:${manualTick()}`, () => `${range()}:${view()?.fromMs ?? ""}:${view()?.toMs ?? ""}`, observeWindow) : null;
  const moreSections = (): SectionLink[] => [
    ...(observed ? [{ label: "Routes", anchor: "route-explorer" }, { label: "Errors", anchor: "issues" }] : []),
    { label: "Deployment", anchor: "deployments" },
    { label: "Cost", anchor: "cost" },
    ...(observed ? [] : [{ label: "Routes", anchor: "routes" }]),
    ...(hasDatabases() ? [{ label: "D1", anchor: "d1" }] : []),
    ...(hasNamespaces() ? [{ label: "Durable Objects", anchor: "durable-objects" }] : [])
  ];
  const deployments = createProjectDeployments(id, range, () => `${projectTick()}:${manualTick()}`);
  const deploymentsSettled = () => deployments.history() !== null || deployments.historyError() !== null;

  return (
    <DeploymentEvents value={deployments.events}>
      <PageHeader
        title={props.project.name}
        titleExtra={<Badge tone={status().tone} dot>{status().label}</Badge>}
      >
        <Show when={collectorNote()}>{(note) => <span class="page-sub">{note()}</span>}</Show>
      </PageHeader>
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>
      <div class={deployments.listed() ? "project-body with-rail" : "project-body"}>
        <Show when={deployments.listed()}><DeploymentRail deployments={deployments} /></Show>
        <div class="project-main">
          <Errored fallback={(error) => <ErrorState error={error()} compact />}>
            <Loading fallback={<Skeleton rows={4} chart />}>
              <Show
                when={hasData()}
                fallback={
                  <Widget title="Data">
                    <EmptyState title="No data was collected in this range." detail="Missing data is shown as a gap, never as zero." icon="activity" />
                  </Widget>
                }
              >
                <StatusStrip cells={cells()} label="Project summary" class="dense" />
                <SectionBar cells={cells()} more={moreSections()} />
                <Show when={deploymentsSettled()} fallback={<Skeleton rows={4} chart />}>
                <section class="charts" aria-label="Charts">
                  <DeploymentsWidget deployments={deployments} impact={observe === null ? undefined : id => <RolloutImpactPanel deploymentId={id} refreshKey={`${projectTick()}:${manualTick()}`} observe={observe} />} />
                  <CostWidget data={data()} view={view()} />
                  {observed ? null : <RoutesWidget data={data()} view={view()} />}
                  {hasDatabases() ? <D1StatementsWidget data={data()} view={view()} /> : null}
                  <RequestsWidget data={data()} />
                  <StatusWidget data={data()} />
                  {hasBuckets() ? <OperationsWidget data={data()} /> : null}
                  <CpuTimeWidget data={data()} />
                  {hasBuckets() ? <StorageWidget data={data()} /> : null}
                  {hasDatabases() ? <D1Widget data={data()} view={view()} /> : null}
                  {props.project.probes.length > 0 ? <ProbesWidget data={data()} /> : null}
                  {hasNamespaces() ? <DurableObjectsWidget data={data()} /> : null}
                  <CollectorWidget data={data()} collector={props.project.collector} now={now()} rowsRead={rowsRead()} />
                </section>
                </Show>
              </Show>
            </Loading>
          </Errored>
          <Show when={observe}>{state => (
            <section class="charts observe-section" aria-label="Errors and traces">
              <RequestExplorerWidget observe={state()} windowLabel={observeWindowLabel()} />
              <IssuesWidget observe={state()} />
              <ObserveModal observe={state()} refreshKey={`${projectTick()}:${manualTick()}`} />
            </section>
          )}</Show>
        </div>
      </div>
    </DeploymentEvents>
  );
}
