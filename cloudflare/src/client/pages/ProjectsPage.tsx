import { createEffect, createMemo, createSignal, Errored, For, isPending, lazy, Loading, onCleanup, onSettled, refresh, Show, untrack, type ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { getProjectHistories, type Project } from "../api";
import { age, bytes, count, dollarsPrecise, errorMessage, milliseconds, percent } from "../format";
import { loadProjects } from "../queries";
import { collectorStatus } from "../status";
import { PROJECT_REFRESH_TICKS, rangeMs, useTelemetry } from "../state";
import { metricTrack, type MetricHistory, type ProjectHistories } from "../history";
import { EmptyState, Icon, Skeleton } from "@laputa-systems/ui-dashboard";
import { EntityCell, ErrorState, StateCell, Widget } from "../components/ui";
import { compareSortValues, createSort, SortHeader } from "../components/sort";
import { createUpdateEffect } from "../effect";
import type { DeploymentHistory } from "../../deployments/model";
import type { TimeWindow } from "../chart-data";
import { deploymentTitle, loadDeploymentHistory } from "./project/Deployments";
import { createProjectLedger, historyKinds, settledRangeWindow } from "./project/ledger-load";
import { windowUsage, type Amount, type LedgerHistories } from "../../cost/ledger.ts";
import { restoreListFocus, type ProjectSortKey } from "../list-state";
import { routeWithRange } from "../urlState";
import "./project/projects.css";

const Trends = lazy(() => import("./project/Trends").then(module => ({ default: module.Trends })));

interface ProjectMetrics {
  readonly requests: number | null;
  readonly cpuMs: number | null;
  readonly cost: number | null;
  readonly errorShare: number | null;
  readonly deployAtMs: number | null;
}

export function ProjectsPage(): JSX.Element {
  return (
    <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
      <Loading fallback={<Widget title="Projects"><Skeleton rows={2} /></Widget>}>
        <Projects />
      </Loading>
    </Errored>
  );
}

function Projects(): JSX.Element {
  const { range, now, tick, manualTick, lists } = useTelemetry();
  const projectTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const projects = createMemo(loadProjects);
  createUpdateEffect(() => `${projectTick()}:${manualTick()}`, () => { void refresh(projects); });
  const [search, setSearch] = createSignal(lists.projects.search);
  const { sort, sortBy } = createSort<ProjectSortKey>(lists.projects.sort);
  let returnProject = lists.projects.returnProject;
  lists.projects.returnProject = null;
  onCleanup(() => { lists.projects.search = search(); lists.projects.sort = sort(); });
  let searchInput: HTMLInputElement | undefined;
  const filter = createMemo(() => search().trim().toLowerCase());
  const matches = (project: Project) => filter() === "" || [project.name, project.id, project.worker].some(value => value.toLowerCase().includes(filter()));
  const matchingCount = createMemo(() => projects().filter(matches).length);
  const onProjectMount = (id: string, link: HTMLAnchorElement) => {
    if (returnProject !== id) return;
    returnProject = null;
    restoreListFocus(link);
  };
  const [metrics, setMetrics] = createSignal<ReadonlyMap<string, ProjectMetrics>>(new Map());
  const reportMetrics = (id: string, value: ProjectMetrics) => setMetrics(current => {
    const existing = current.get(id);
    if (existing !== undefined && existing.requests === value.requests && existing.cpuMs === value.cpuMs && existing.cost === value.cost && existing.errorShare === value.errorShare && existing.deployAtMs === value.deployAtMs) return current;
    const next = new Map(current);
    next.set(id, value);
    return next;
  });
  const sortedProjects = createMemo(() => {
    const key = sort().key;
    if (key === "none") return projects();
    const direction = sort().direction;
    const values = metrics();
    const value = (project: Project): number | string | null => {
      if (key === "name") return project.name;
      if (key === "collector") return collectorStatus(project.collector, now()).label;
      const entry = values.get(project.id);
      if (entry === undefined) return null;
      if (key === "requests") return entry.requests;
      if (key === "cpu") return entry.cpuMs;
      if (key === "cost") return entry.cost;
      if (key === "errors") return entry.errorShare;
      return entry.deployAtMs;
    };
    return [...projects()].sort((left, right) => {
      const leftValue = value(left);
      const rightValue = value(right);
      if (leftValue === null || rightValue === null) {
        if (leftValue === null && rightValue === null) return left.id.localeCompare(right.id);
        return leftValue === null ? 1 : -1;
      }
      return compareSortValues(leftValue, rightValue) * direction || left.id.localeCompare(right.id);
    });
  });
  return (
    <Show
      when={projects().length > 0}
      fallback={
        <Widget title="Projects">
          <EmptyState title="No projects are configured." detail="Projects are declared in cloudflare/cloudflare.config.ts." />
        </Widget>
      }
    >
      <Widget
        id="projects"
        title="Projects"
        class={isPending(projects) ? "widget-pending" : undefined}
        bodyClass="flush"
        meta={<span class="projects-basis">Settled {range()} vs the {range()} before · cost projected to 30 days at list price</span>}
      >
        <div class="table-toolbar">
          <label class="search">
            <span class="ui-sr-only">Search projects</span>
            <span class="search-icon"><Icon name="search" size={13} /></span>
            <input ref={element => { searchInput = element; }} type="search" placeholder="Filter projects" value={search()} onInput={event => setSearch(event.currentTarget.value)} />
          </label>
        </div>
        <Show when={matchingCount() === 0}>
          <EmptyState title="No projects match this view." detail="Clear the filter to see all projects." action={<button class="btn" type="button" onClick={() => { setSearch(""); searchInput?.focus(); }}>Clear filter</button>} />
        </Show>
        <ProjectsTable hidden={matchingCount() === 0}>
          <table class="data-table projects-table" aria-label="Projects">
            <thead>
              <tr>
                <SortHeader label="Project" sortKey="name" sort={sort()} onSort={sortBy} />
                <SortHeader label="Requests" sortKey="requests" sort={sort()} onSort={sortBy} class="numeric" />
                <SortHeader label="5xx" sortKey="errors" sort={sort()} onSort={sortBy} class="numeric" />
                <SortHeader label="CPU" sortKey="cpu" sort={sort()} onSort={sortBy} class="numeric" />
                <SortHeader label="Est. cost" sortKey="cost" sort={sort()} onSort={sortBy} class="numeric" />
                <SortHeader label="Last deploy" sortKey="deploy" sort={sort()} onSort={sortBy} />
                <SortHeader label="Collector" sortKey="collector" sort={sort()} onSort={sortBy} />
                <th scope="col"><span class="ui-sr-only">Trends</span></th>
              </tr>
            </thead>
            <For each={sortedProjects()}>{(project) => <ProjectRow project={project} visible={matches(project)} reportMetrics={reportMetrics} onNavigate={id => { lists.projects.returnProject = id; }} onMount={onProjectMount} />}</For>
          </table>
        </ProjectsTable>
      </Widget>
    </Show>
  );
}

function ProjectsTable(props: ParentProps<{ readonly hidden: boolean }>): JSX.Element {
  let region: HTMLDivElement | undefined;
  const [overflow, setOverflow] = createSignal(false);
  onSettled(() => {
    if (region === undefined) throw new Error("Projects table region is missing");
    const element = region;
    const table = element.querySelector("table");
    if (table === null) throw new Error("Projects table is missing");
    const update = () => setOverflow(element.scrollWidth > element.clientWidth);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(table);
    update();
    return () => observer.disconnect();
  });
  // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable regions need keyboard focus
  return <><div ref={element => { region = element; }} class="table-scroll projects-table-scroll" role="region" aria-label="Projects table" aria-describedby={overflow() ? "projects-scroll-hint" : undefined} tabindex="0" hidden={props.hidden}>{props.children}</div><Show when={!props.hidden && overflow()}><p class="projects-scroll-hint" id="projects-scroll-hint">Scroll horizontally for more columns.</p></Show></>;
}

function sumIn(history: MetricHistory | undefined, metric: string, window: TimeWindow): number | null {
  if (history === undefined) return null;
  const track = metricTrack(history, metric);
  let total: number | null = null;
  track.times.forEach((time, index) => {
    const value = track.values[index];
    if (time >= window.fromMs && time < window.toMs && value !== null && value !== undefined) total = (total ?? 0) + value;
  });
  return total;
}

function Change(props: { readonly amount: Amount | null; readonly worseUp: boolean | null; readonly money?: boolean | undefined }): JSX.Element {
  const text = () => {
    const amount = props.amount;
    if (amount === null || amount.before === null) return "";
    if (props.money === true) {
      const diff = amount.now - amount.before;
      if (Math.abs(diff) < Math.max(1e-7, Math.abs(amount.before) * 0.05)) return "±0";
      return `${diff > 0 ? "+" : "−"}${dollarsPrecise(Math.abs(diff))}`;
    }
    if (amount.before <= 0) return amount.now > 0 ? "new" : "";
    const value = amount.now / amount.before;
    if (Math.abs(value - 1) < 0.05) return "±0%";
    return value >= 2 ? `${value.toFixed(1)}×` : `${value > 1 ? "+" : "−"}${Math.abs((value - 1) * 100).toFixed(0)}%`;
  };
  const tone = () => {
    const amount = props.amount;
    if (props.worseUp === null || amount === null || amount.before === null || text() === "" || text().startsWith("±")) return "";
    return (amount.now > amount.before) === props.worseUp ? " worse" : " better";
  };
  return <Show when={text()}>{value => <span class={`projects-change${tone()}`}>{value()}</span>}</Show>;
}

function ProjectRow(props: { readonly project: Project; readonly visible: boolean; readonly reportMetrics: (id: string, value: ProjectMetrics) => void; readonly onNavigate: (id: string) => void; readonly onMount: (id: string, link: HTMLAnchorElement) => void }): JSX.Element {
  const { range, now, tick, manualTick } = useTelemetry();
  const projectTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const refreshKey = () => `${projectTick()}:${manualTick()}`;
  const [open, setOpen] = createSignal(false);
  const [fallbackHistories, setFallbackHistories] = createSignal<ProjectHistories | null>(null);
  const [historyError, setHistoryError] = createSignal<string | null>(null);
  const [deployments, setDeployments] = createSignal<DeploymentHistory | null>(null);
  const [deploymentsSettled, setDeploymentsSettled] = createSignal(false);
  const [deploymentsError, setDeploymentsError] = createSignal<string | null>(null);
  const status = createMemo(() => collectorStatus(props.project.collector, now()));

  createEffect(() => `${props.project.id}:${refreshKey()}`, () => {
    const controller = new AbortController();
    void loadDeploymentHistory(props.project.id, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setDeployments(value);
      setDeploymentsError(null);
      setDeploymentsSettled(true);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setDeploymentsError(errorMessage(error));
      setDeploymentsSettled(true);
    });
    return () => controller.abort();
  });

  const window = createMemo((): TimeWindow => {
    refreshKey();
    return settledRangeWindow(rangeMs[range()], untrack(now));
  });
  const { ledger, histories: ledgerHistories, error: ledgerError } = createProjectLedger(() => props.project, window, range, refreshKey, null, () => null);
  const loaded = ledger;
  const failure = () => ledgerError();
  const trendHistories = () => ledgerHistories() ?? fallbackHistories();

  createEffect(
    () => ({
      active: open() && props.visible && ledgerError() !== null,
      id: props.project.id,
      range: range(),
      tick: refreshKey()
    }),
    query => {
      if (!query.active) {
        if (!open()) {
          setFallbackHistories(null);
          setHistoryError(null);
        }
        return;
      }
      const controller = new AbortController();
      void getProjectHistories(query.id, { range: query.range }, historyKinds(props.project), controller.signal).then(value => {
        if (controller.signal.aborted) return;
        setFallbackHistories(value);
        setHistoryError(null);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setHistoryError(errorMessage(error));
      });
      return () => controller.abort();
    }
  );

  const worker = () => loaded()?.report.lines.find(line => line.id === "worker");
  const partialCost = () => loaded()?.report.warnings.some(warning => warning.code === "meter-no-data" || warning.code === "meter-partial-data") ?? false;
  const workerUsage = () => {
    const line = worker();
    const value = loaded();
    if (line === undefined || value === null || value === undefined) return null;
    return windowUsage(line, value.histories, value.previous, value.report.windows.current, value.report.windows.previous);
  };
  const calls = () => {
    const usage = workerUsage();
    return usage?.kind === "requests" ? usage.calls : null;
  };
  const cpu = () => {
    const usage = workerUsage();
    return usage?.kind === "requests" ? usage.cpuMs : null;
  };
  const serverErrors = () => {
    const value = loaded();
    const bounds = value?.report.windows.current;
    const previousBounds = value?.report.windows.previous;
    if (value === undefined || value === null || bounds === undefined || previousBounds === undefined) return null;
    const share = (source: LedgerHistories | undefined, at: TimeWindow) => {
      const errors = sumIn(source?.worker, "worker.status.5xx", at);
      const requests = sumIn(source?.worker, "worker.invocations", at);
      return errors === null || requests === null || requests <= 0 ? null : { errors, share: (errors / requests) * 100 };
    };
    const current = share(value.histories, bounds);
    if (current === null) return null;
    return { current, before: share(value.previous, previousBounds) };
  };
  const storedBytes = () => {
    const line = loaded()?.report.lines.find(entry => entry.id === "r2");
    return line?.usage.kind === "stored" ? line.usage.bytes.now : null;
  };
  const latest = () => {
    const history = deployments();
    const deployment = history?.deployments[0];
    return history === null || deployment === undefined ? null : { title: deploymentTitle(history, deployment), atMs: deployment.atMs };
  };
  createEffect(
    () => ({
      id: props.project.id,
      requests: calls()?.now ?? null,
      cpuMs: cpu()?.now ?? null,
      cost: partialCost() ? null : loaded()?.report.total.monthly.now ?? null,
      errorShare: serverErrors()?.current.share ?? null,
      deployAtMs: latest()?.atMs ?? null
    }),
    value => {
      props.reportMetrics(value.id, {
        requests: value.requests,
        cpuMs: value.cpuMs,
        cost: value.cost,
        errorShare: value.errorShare,
        deployAtMs: value.deployAtMs
      });
    }
  );
  const cpuDuration = (value: number) => value >= 3_600_000 ? `${(value / 3_600_000).toPrecision(3)} h` : value >= 60_000 ? `${(value / 60_000).toPrecision(3)} min` : value >= 1000 ? `${(value / 1000).toPrecision(3)} s` : milliseconds(Math.round(value));
  const pending = () => failure() === null ? (worker()?.price.kind === "uncollected" ? <span class="cell-note">no data</span> : loaded() !== null ? <span class="cell-note">unavailable</span> : <span class="cell-pending" aria-hidden="true" />) : <span class="cell-note" title={failure() ?? undefined}>unavailable</span>;

  return (
    <tbody class={open() ? "projects-group open" : "projects-group"} hidden={!props.visible}>
      <tr class="projects-row">
        <td>
          <EntityCell
            marker={<span class={`status-dot tone-${status().tone}`} aria-hidden="true" />}
            name={props.project.name}
            href={routeWithRange(`#/project/${props.project.id}`, range())}
            id={props.project.worker}
            onNavigate={() => props.onNavigate(props.project.id)}
            onLinkMount={link => props.onMount(props.project.id, link)}
          />
        </td>
        <td class="numeric">
          <Show when={calls()} fallback={pending()}>{amount => <span class="cell-stack"><span>{count(Math.round(amount().now))}<Change amount={amount()} worseUp={null} /></span><span class="cell-note">in {range()}</span></span>}</Show>
        </td>
        <td class="numeric">
          <Show when={serverErrors()} fallback={loaded() !== null ? <span class="cell-note">—</span> : pending()}>{value => (
            <span class="cell-stack">
              <span>{percent(Number(value().current.share.toPrecision(2)))}<Change amount={{ now: value().current.share, before: value().before?.share ?? null }} worseUp /></span>
              <span class="cell-note">{count(value().current.errors)} in window</span>
            </span>
          )}</Show>
        </td>
        <td class="numeric">
          <Show when={cpu()} fallback={pending()}>{amount => (
            <span class="cell-stack">
              <span>{cpuDuration(amount().now)}<Change amount={amount()} worseUp /></span>
              <span class="cell-note">{calls() === null || calls()!.now <= 0 ? "per request unavailable" : `${milliseconds(Number((amount().now / calls()!.now).toPrecision(2)))} per request`}</span>
            </span>
          )}</Show>
        </td>
        <td class="numeric">
          <Show when={loaded()} fallback={pending()}>{value => (
            <span class="cell-stack">
              <span class="cell-strong">{dollarsPrecise(value().report.total.monthly.now)}/mo<Change amount={value().report.total.monthly} worseUp money /></span>
              <span class="cell-note">{partialCost() ? "partial · missing cost data" : storedBytes() === null ? "no storage priced" : `incl. ${bytes(storedBytes() ?? 0)} R2`}</span>
            </span>
          )}</Show>
        </td>
        <td>
          <Show when={latest()} fallback={deploymentsError() !== null ? <span class="cell-note" role="status" title={deploymentsError() ?? undefined}>deployments unavailable</span> : deploymentsSettled() ? <span class="cell-note">none recorded</span> : <span class="cell-pending" aria-hidden="true" />}>{deployment => (
            <span class="cell-stack"><span class="mono">{deployment().title}</span><span class="cell-note" title={deploymentsError() ?? undefined}>{age(deployment().atMs, now())}{deploymentsError() === null ? "" : " · refresh failed"}</span></span>
          )}</Show>
        </td>
        <td><StateCell tone={status().tone} label={status().label} note={age(props.project.collector.lastSuccessAtMs, now())} /></td>
        <td class="projects-toggle">
          <button type="button" class="icon-button" aria-expanded={open() ? "true" : "false"} aria-label={`${open() ? "Hide" : "Show"} ${props.project.name} trends`} onClick={() => setOpen(value => !value)}>
            <span class="projects-chevron" aria-hidden="true">›</span>
          </button>
        </td>
      </tr>
      <Show when={open() && props.visible}>
        <tr class="projects-detail">
          <td colspan="8">
            <Show when={trendHistories()} fallback={historyError() === null ? <Skeleton rows={2} chart /> : <ErrorState error={new Error(historyError() ?? "")} compact />}>{value => <Loading fallback={<Skeleton rows={2} chart />}><Trends project={props.project} histories={value()} /></Loading>}</Show>
          </td>
        </tr>
      </Show>
    </tbody>
  );
}
