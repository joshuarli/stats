import { createEffect, createMemo, createSignal, Errored, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { getProjectCollector, getProjectMetrics, type Project } from "../api";
import { errorMessage } from "../format";
import { collectorStatus } from "../status";
import { loadProjects, loadQuery } from "../queries";
import { useTelemetry } from "../state";
import { PageHeader } from "../components/PageHeader";
import { Badge, EmptyState, ErrorState, Notice, Skeleton, Widget } from "../components/ui";
import { IncidentTimeline, StatusStrip } from "./host/Status";
import { CollectorWidget } from "./project/Collector";
import { ProbesWidget } from "./project/Probes";
import { OperationsWidget, StorageWidget } from "./project/R2";
import { DurableObjectsWidget, RoutesWidget } from "./project/Routes";
import { buildProjectCells, hasAnyValue, metricPoints, silenceMinutes, type ProjectData } from "./project/series";
import { CpuTimeWidget, RequestsWidget, StatusWidget } from "./project/Worker";

export function ProjectPage(): JSX.Element {
  const params = useParams();
  const { tick } = useTelemetry();
  const projects = createMemo(loadProjects);
  const project = createMemo(() => projects().find(candidate => candidate.id === (params.projectId ?? "")));
  createEffect(() => tick(), () => { void refresh(projects); }, { defer: true });
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
              action={<a class="btn" href="#/">Back to fleet</a>}
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
  const { range, view, now, tick } = useTelemetry();
  const [refreshError, setRefreshError] = createSignal<string | null>(null);
  const id = () => props.project.id;
  const worker = createMemo(() => loadQuery(signal => getProjectMetrics(id(), range(), "worker", signal)));
  const hasBuckets = () => props.project.buckets.length > 0;
  const hasNamespaces = () => props.project.durableObjectNamespaces.length > 0;
  const routes = createMemo(() => loadQuery(signal => getProjectMetrics(id(), range(), "routes", signal)));
  const durableObjects = createMemo(() => (hasNamespaces() ? loadQuery(signal => getProjectMetrics(id(), range(), "durable-objects", signal)) : Promise.resolve(undefined)));
  const r2 = createMemo(() => loadQuery(signal => getProjectMetrics(id(), range(), "r2", signal)));
  const collector = createMemo(() => loadQuery(signal => getProjectCollector(id(), range(), signal)));
  const probes = createMemo(() => (props.project.probes.length === 0 ? Promise.resolve(undefined) : loadQuery(signal => getProjectMetrics(id(), range(), "probes", signal))));

  const doRefresh = async () => {
    setRefreshError(null);
    try {
      await Promise.all([refresh(worker), refresh(routes), refresh(durableObjects), refresh(r2), refresh(collector), refresh(probes)]);
    } catch (error) {
      setRefreshError(errorMessage(error));
    }
  };
  createEffect(() => tick(), () => { void doRefresh(); }, { defer: true });

  const data = createMemo((): ProjectData => ({
    worker: worker(),
    routes: routes(),
    durableObjects: durableObjects(),
    r2: r2(),
    probes: probes(),
    probeNames: props.project.probes.map(probe => probe.name),
    buckets: props.project.buckets,
    silence: silenceMinutes(collector(), now(), props.project.collector.lastSuccessAtMs)
  }));
  const status = createMemo(() => collectorStatus(props.project.collector, now()));
  const cells = createMemo(() => buildProjectCells(data(), view()));
  const hasData = createMemo(() => hasAnyValue(metricPoints(data().worker, "worker.invocations"), ...props.project.buckets.map(bucket => metricPoints(data().r2, `r2.${bucket}.storageBytes`))));
  const rowsRead = createMemo(() => collector().runs.at(-1)?.rowsRead);

  return (
    <>
      <PageHeader
        title={props.project.name}
        titleExtra={<Badge tone={status().tone} dot>{status().label}</Badge>}
        hint={`Worker script, ${hasNamespaces() ? "Durable Objects, " : ""}${hasBuckets() ? "R2 buckets, " : ""}and the collector that reads them · drag a chart to zoom`}
      />
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>
      <Show when={status().label !== "collecting"}>
        <Notice tone="warn">
          {status().label === "waiting"
            ? "The collector has not run yet, so there is no data."
            : status().label === "failing"
              ? "The last collection failed. Charts show what was collected before it."
              : "The collector has not succeeded recently, so the newest buckets may be missing."}
        </Notice>
      </Show>
      <Errored fallback={(error) => <ErrorState error={error()} compact />}>
        <Loading fallback={<Skeleton rows={4} chart />}>
          <Show
            when={hasData()}
            fallback={
              <Widget title="Data" subtitle="Nothing collected in this range">
                <EmptyState title="No data was collected in this range." detail="Missing data is shown as a gap, never as zero." icon="activity" />
              </Widget>
            }
          >
            <StatusStrip cells={cells()} label="Project summary" threeColumns={cells().length === 5 || cells().length === 6} />
            <section class="columns" aria-label="Charts">
              <div class="column" role="region" aria-label="Left column">
                <RequestsWidget data={data()} />
                <StatusWidget data={data()} />
                <CpuTimeWidget data={data()} />
                <RoutesWidget data={data()} view={view()} />
                <Show when={props.project.probes.length > 0}>
                  <ProbesWidget data={data()} />
                </Show>
              </div>
              <div class="column" role="region" aria-label="Right column">
                <IncidentTimeline cells={cells()} />
                <Show when={hasNamespaces()}>
                  <DurableObjectsWidget data={data()} />
                </Show>
                <Show when={hasBuckets()}>
                  <OperationsWidget data={data()} />
                  <StorageWidget data={data()} />
                </Show>
                <CollectorWidget data={data()} collector={props.project.collector} now={now()} rowsRead={rowsRead()} />
              </div>
            </section>
          </Show>
        </Loading>
      </Errored>
    </>
  );
}
