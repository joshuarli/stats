import { createMemo, createSignal, Errored, Loading, refresh, Show } from "solid-js";
import type { ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { getProjectHistories, type Project } from "../api";
import { age, errorMessage, percent } from "../format";
import { collectorStatus } from "../status";
import { createUpdateEffect } from "../effect";
import { loadProjects, loadQuery } from "../queries";
import { useTelemetry, PROJECT_REFRESH_TICKS, rangeMs } from "../state";
import { PageHeader } from "../components/PageHeader";
import { Info } from "../components/Info";
import { Badge, EmptyState, ErrorState, Notice, Skeleton, Widget } from "../components/ui";
import { CollectorWidget } from "./project/Collector";
import { D1Widget } from "./project/D1";
import { createProjectDeployments, DeploymentRail, DeploymentsWidget } from "./project/Deployments";
import { DeploymentEvents } from "../components/DeploymentEvents";
import { ProbesWidget } from "./project/Probes";
import { OperationsWidget, StorageWidget } from "./project/R2";
import { DurableObjectsWidget } from "./project/DurableObjects";
import { metricTrack } from "../history";
import { hasAnyValue, silenceMinutes, type ProjectData } from "./project/series";
import { CpuTimeWidget, RequestsWidget, StatusWidget } from "./project/Worker";
import { createObservability, IssuesWidget, ObserveModal, RolloutImpactPanel, type Observability } from "./project/Observe";
import { RequestExplorerWidget } from "./project/Requests";
import { createProjectLedger, historyKinds, settledWindow } from "./project/ledger-load";
import { CostLedger } from "./project/CostLedger";
import "./project/project.css";
import { readParam, writeParam } from "../urlState";
import { LIMITS } from "../health";
import { RETENTION_MS } from "../../observe/core/limits";
import { isObservedService } from "../../observe/services";
import type { TimeWindow } from "../chart-data";

type SectionId = "deploys" | "errors" | "requests" | "signals";
const SECTION_IDS: readonly SectionId[] = ["deploys", "errors", "requests", "signals"];
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

function initialSections(): ReadonlySet<SectionId> {
  const listed = (readParam("open") ?? "").split(",").filter((entry): entry is SectionId => (SECTION_IDS as readonly string[]).includes(entry));
  const linked = LINKED_SECTIONS.filter(([param]) => readParam(param) !== null).map(([, section]) => section);
  return new Set([...listed, ...linked]);
}

function Section(props: ParentProps<{ readonly id: SectionId; readonly title: string; readonly summary: JSX.Element; readonly open: boolean; readonly onToggle: () => void }>): JSX.Element {
  return (
    <section class={`project-section${props.open ? " open" : ""}`} id={`section-${props.id}`}>
      <button type="button" class="project-section-head" aria-expanded={props.open ? "true" : "false"} onClick={() => props.onToggle()}>
        <span class="project-section-twist" aria-hidden="true">›</span>
        <span class="project-section-title">{props.title}</span>
        <span class="project-section-summary">{props.summary}</span>
      </button>
      <Show when={props.open}><div class="project-section-body">{props.children}</div></Show>
    </section>
  );
}

function ProjectView(props: { readonly project: Project }): JSX.Element {
  const { range, query, view, now, tick, manualTick } = useTelemetry();
  const projectTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const [refreshError, setRefreshError] = createSignal<string | null>(null);
  const [sections, setSections] = createSignal<ReadonlySet<SectionId>>(initialSections());
  const id = () => props.project.id;
  const hasBuckets = () => props.project.buckets.length > 0;
  const hasNamespaces = () => props.project.durableObjectNamespaces.length > 0;
  const hasDatabases = () => props.project.d1Databases.length > 0;
  const kinds = () => historyKinds(props.project);
  const histories = createMemo(() => loadQuery(signal => getProjectHistories(id(), query(), kinds(), signal)));
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

  const ledgerWindow = createMemo((): TimeWindow => settledWindow(worker(), rangeMs[range()], view()));
  const windowLabel = () => view() !== null
    ? "Zoomed window, up to the last settled bucket, vs the window before it"
    : `Settled ${range()} ending ${age(ledgerWindow().toMs, now())} vs the ${range()} before`;
  const service = isObservedService(props.project.worker) ? props.project.worker : null;
  const observeWindow = () => {
    const zoomed = view();
    if (zoomed !== null) return zoomed;
    const end = now();
    return { fromMs: end - Math.min(rangeMs[range()], RETENTION_MS), toMs: end };
  };
  const observeWindowLabel = () => view() !== null ? "zoomed window" : rangeMs[range()] > RETENTION_MS ? "last 7 days (traces keep 7)" : `last ${range()}`;
  const observe: Observability | null = service !== null ? createObservability(service, () => `${projectTick()}:${manualTick()}`, () => `${range()}:${view()?.fromMs ?? ""}:${view()?.toMs ?? ""}`, observeWindow, () => sections().has("requests")) : null;
  const { ledger, error: ledgerLoadError, baselineError } = createProjectLedger(
    () => props.project, ledgerWindow, () => `${projectTick()}:${manualTick()}`,
    observe === null ? null : { read: observe.read, retentionMs: RETENTION_MS, now }
  );

  const toggleSection = (section: SectionId) => {
    setSections(current => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section); else next.add(section);
      writeParam("open", next.size === 0 ? null : SECTION_IDS.filter(entry => next.has(entry)).join(","));
      return next;
    });
  };
  const openSection = (section: SectionId) => {
    if (!sections().has(section)) toggleSection(section);
    requestAnimationFrame(() => document.getElementById(`section-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const deployments = createProjectDeployments(id, range, () => `${projectTick()}:${manualTick()}`);
  const deploymentsSettled = () => deployments.history() !== null || deployments.historyError() !== null;
  const events = createMemo(() => deployments.events().map(event => ({ ...event, onSelect: () => { openSection("deploys"); event.onSelect(); } })));
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

  return (
    <DeploymentEvents value={events}>
      <PageHeader
        title={props.project.name}
        titleExtra={<><Badge tone={status().tone} dot>{status().label}</Badge><Show when={collectorNote()}>{(note) => <Info title="Collector status">{note()}</Info>}</Show></>}
      >
        <Loading fallback={null}>
        <div class="project-pills" aria-label="Project health">
          <button type="button" class={`project-pill tone-${serverErrorTone()}`} onClick={() => openSection("signals")}>5xx {serverErrors() === undefined ? "—" : percent(Number((serverErrors() ?? 0).toPrecision(2)))}</button>
          <Show when={openIssues() !== undefined}>
            <button type="button" class={`project-pill tone-${(openIssues() ?? 0) > 0 ? "bad" : "neutral"}`} onClick={() => openSection("errors")}>{openIssues()} open {openIssues() === 1 ? "error" : "errors"}</button>
          </Show>
          <Show when={probesUp()}>{probes => (
            <button type="button" class={`project-pill tone-${probes().known > probes().up ? "bad" : "neutral"}`} onClick={() => openSection("signals")}>{probes().up}/{probes().total} endpoints up</button>
          )}</Show>
          <Show when={latest()}>{deployment => (
            <button type="button" class="project-pill tone-neutral" onClick={() => openSection("deploys")}>{deployments.title(deployment())} <em>{age(deployment().atMs, now())}</em></button>
          )}</Show>
        </div>
        </Loading>
      </PageHeader>
      <Show when={refreshError()}>
        {(message) => <Notice tone="warn">{message()}</Notice>}
      </Show>
      <div class="project-page">
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
              <Show when={baselineError()}>{message => (
                <Notice tone="warn">{`The previous window could not be read, so changes are not shown: ${message()}`}</Notice>
              )}</Show>
              <Show when={ledger()} fallback={ledgerLoadError() === null ? <Skeleton rows={4} /> : <ErrorState error={new Error(ledgerLoadError() ?? "")} compact />}>
                {current => <CostLedger ledger={current().ledger} histories={current().histories} windowLabel={windowLabel()} />}
              </Show>
            </Show>
          </Loading>
        </Errored>

        <Section id="deploys" title="Deployments" open={sections().has("deploys")} onToggle={() => toggleSection("deploys")}
          summary={<Show when={latest()} fallback={deployments.historyError() ?? "none recorded"}>{deployment => <>{deployments.title(deployment())} · {age(deployment().atMs, now())}{deployment().message === null ? "" : ` · ${deployment().message}`}</>}</Show>}>
          <Show when={deploymentsSettled()} fallback={<Skeleton rows={4} chart />}>
            <div class={deployments.listed() ? "project-body with-rail" : "project-body"}>
              <Show when={deployments.listed()}><DeploymentRail deployments={deployments} /></Show>
              <div class="project-main">
                <DeploymentsWidget deployments={deployments} impact={observe === null ? undefined : deploymentId => <RolloutImpactPanel deploymentId={deploymentId} refreshKey={`${projectTick()}:${manualTick()}`} observe={observe} />} />
              </div>
            </div>
          </Show>
        </Section>

        <Show when={observe}>{state => (
          <>
            <Section id="errors" title="Errors" open={sections().has("errors")} onToggle={() => toggleSection("errors")}
              summary={state().health() !== null ? `${state().health()?.openIssues ?? 0} open` : state().error() ?? "loading"}>
              <IssuesWidget observe={state()} />
            </Section>
            <Section id="requests" title="Requests" open={sections().has("requests")} onToggle={() => toggleSection("requests")}
              summary={`routes, latency and traces · ${observeWindowLabel()}`}>
              <RequestExplorerWidget observe={state()} windowLabel={observeWindowLabel()} />
            </Section>
            <ObserveModal observe={state()} refreshKey={`${projectTick()}:${manualTick()}`} />
          </>
        )}</Show>

        <Section id="signals" title="Signals" open={sections().has("signals")} onToggle={() => toggleSection("signals")}
          summary={["requests", "status", "CPU", ...(hasBuckets() ? ["R2"] : []), ...(hasDatabases() ? ["D1"] : []), ...(props.project.probes.length > 0 ? ["endpoints"] : []), ...(hasNamespaces() ? ["Durable Objects"] : []), "collector"].join(" · ")}>
          <Errored fallback={(error) => <ErrorState error={error()} compact />}>
            <Loading fallback={<Skeleton rows={4} chart />}>
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
        </Section>
      </div>
    </DeploymentEvents>
  );
}
