import { createEffect, createMemo, createSignal, Errored, For, isPending, Loading, onCleanup, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { getProjectHistories, type Project } from "../api";
import { age, bytes, count, dollarsPrecise, errorMessage, milliseconds, percent } from "../format";
import { loadProjects } from "../queries";
import { collectorStatus } from "../status";
import { PROJECT_REFRESH_TICKS, rangeMs, useTelemetry } from "../state";
import { metricTrack, type MetricHistory, type ProjectHistories } from "../history";
import { EntityCell, EmptyState, ErrorState, Skeleton, StateCell, Widget } from "../components/ui";
import { PanelChart, PanelLabel } from "./host/shared";
import { createUpdateEffect } from "../effect";
import type { DeploymentHistory } from "../../deployments/model";
import type { TimeWindow } from "../chart-data";
import { deploymentTitle, loadDeploymentHistory } from "./project/Deployments";
import { createProjectLedger, historyKinds, settledWindow } from "./project/ledger-load";
import { MONTH_MS, type Amount, type LedgerHistories } from "./project/cost-ledger";
import { ratio } from "./project/math";
import { provisionalFromMs } from "./project/series";
import "./project/projects.css";

const DAYS_PER_MONTH = MONTH_MS / 86_400_000;

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
  const { range, tick, manualTick } = useTelemetry();
  const projectTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const projects = createMemo(loadProjects);
  createUpdateEffect(() => `${projectTick()}:${manualTick()}`, () => { void refresh(projects); });
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
        <div class="table-scroll projects-table-scroll" role="region" aria-label="Projects table">
          <table class="data-table projects-table" aria-label="Projects">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col" class="numeric">Requests</th>
                <th scope="col" class="numeric">5xx</th>
                <th scope="col" class="numeric">CPU</th>
                <th scope="col" class="numeric">Est. cost</th>
                <th scope="col">Last deploy</th>
                <th scope="col">Collector</th>
                <th scope="col"><span class="sr-only">Trends</span></th>
              </tr>
            </thead>
            <For each={projects()}>{(project) => <ProjectRow project={project} />}</For>
          </table>
        </div>
      </Widget>
    </Show>
  );
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

function ProjectRow(props: { readonly project: Project }): JSX.Element {
  const { range, now, tick, manualTick } = useTelemetry();
  const projectTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const refreshKey = () => `${projectTick()}:${manualTick()}`;
  const [open, setOpen] = createSignal(false);
  const [histories, setHistories] = createSignal<ProjectHistories | null>(null);
  const [historyError, setHistoryError] = createSignal<string | null>(null);
  const [deployments, setDeployments] = createSignal<DeploymentHistory | null>(null);
  const [deploymentsSettled, setDeploymentsSettled] = createSignal(false);
  const status = createMemo(() => collectorStatus(props.project.collector, now()));

  createEffect(() => `${props.project.id}:${range()}:${refreshKey()}`, () => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void getProjectHistories(props.project.id, { range: range() }, historyKinds(props.project), controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setHistories(value);
      setHistoryError(null);
    }).catch((error: unknown) => { if (!controller.signal.aborted) setHistoryError(errorMessage(error)); });
  });
  createEffect(() => `${props.project.id}:${refreshKey()}`, () => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void loadDeploymentHistory(props.project.id, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setDeployments(value);
      setDeploymentsSettled(true);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setDeployments(null);
      setDeploymentsSettled(true);
    });
  });

  const window = createMemo((): TimeWindow | null => {
    const loaded = histories();
    return loaded === null ? null : settledWindow(loaded.worker, rangeMs[range()], null);
  });
  const ready = () => window() !== null;
  const { ledger, error: ledgerError } = createProjectLedger(() => props.project, () => window() ?? { fromMs: 0, toMs: 0 }, () => `${ready()}:${refreshKey()}`, null);
  const loaded = () => ready() ? ledger() : null;
  const failure = () => historyError() ?? ledgerError();

  const worker = () => loaded()?.ledger.lines.find(line => line.id === "worker");
  const perDay = (amount: Amount): Amount => ({ now: amount.now / DAYS_PER_MONTH, before: amount.before === null ? null : amount.before / DAYS_PER_MONTH });
  const calls = () => {
    const usage = worker()?.usage;
    return usage?.kind === "requests" ? perDay(usage.calls) : null;
  };
  const cpu = () => {
    const usage = worker()?.usage;
    return usage?.kind === "requests" ? perDay(usage.cpuMs) : null;
  };
  const serverErrors = () => {
    const value = loaded();
    const bounds = value?.ledger.window;
    const previousBounds = value?.ledger.previousWindow;
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
    const line = loaded()?.ledger.lines.find(entry => entry.id === "r2");
    return line?.usage.kind === "stored" ? line.usage.bytes.now : null;
  };
  const latest = () => {
    const history = deployments();
    const deployment = history?.deployments[0];
    return history === null || deployment === undefined ? null : { title: deploymentTitle(history, deployment), atMs: deployment.atMs };
  };
  const cpuDuration = (value: number) => value >= 3_600_000 ? `${(value / 3_600_000).toPrecision(3)} h` : value >= 60_000 ? `${(value / 60_000).toPrecision(3)} min` : value >= 1000 ? `${(value / 1000).toPrecision(3)} s` : milliseconds(Math.round(value));
  const pending = () => failure() === null ? <span class="cell-pending" aria-hidden="true" /> : <span class="cell-note" title={failure() ?? undefined}>unavailable</span>;

  return (
    <tbody class={open() ? "projects-group open" : "projects-group"}>
      <tr class="projects-row">
        <td>
          <EntityCell
            marker={<span class={`status-dot tone-${status().tone}`} aria-hidden="true" />}
            name={props.project.name}
            href={`#/project/${props.project.id}`}
            id={props.project.worker}
          />
        </td>
        <td class="numeric">
          <Show when={calls()} fallback={pending()}>{amount => <span class="cell-stack"><span>{count(Math.round(amount().now))}<Change amount={amount()} worseUp={null} /></span><span class="cell-note">per day</span></span>}</Show>
        </td>
        <td class="numeric">
          <Show when={serverErrors()} fallback={ready() && loaded() !== null ? <span class="cell-note">—</span> : pending()}>{value => (
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
              <span class="cell-note">{milliseconds(Number(((amount().now) / Math.max(1, calls()?.now ?? 1)).toPrecision(2)))} per request</span>
            </span>
          )}</Show>
        </td>
        <td class="numeric">
          <Show when={loaded()} fallback={pending()}>{value => (
            <span class="cell-stack">
              <span class="cell-strong">{dollarsPrecise(value().ledger.monthly.now)}/mo<Change amount={value().ledger.monthly} worseUp money /></span>
              <span class="cell-note">{storedBytes() === null ? "no storage priced" : `incl. ${bytes(storedBytes() ?? 0)} R2`}</span>
            </span>
          )}</Show>
        </td>
        <td>
          <Show when={latest()} fallback={deploymentsSettled() ? <span class="cell-note">none recorded</span> : <span class="cell-pending" aria-hidden="true" />}>{deployment => (
            <span class="cell-stack"><span class="mono">{deployment().title}</span><span class="cell-note">{age(deployment().atMs, now())}</span></span>
          )}</Show>
        </td>
        <td><StateCell tone={status().tone} label={status().label} note={age(props.project.collector.lastSuccessAtMs, now())} /></td>
        <td class="projects-toggle">
          <button type="button" class="icon-button" aria-expanded={open() ? "true" : "false"} aria-label={`${open() ? "Hide" : "Show"} ${props.project.name} trends`} onClick={() => setOpen(value => !value)}>
            <span class="projects-chevron" aria-hidden="true">›</span>
          </button>
        </td>
      </tr>
      <Show when={open()}>
        <tr class="projects-detail">
          <td colspan="8">
            <Show when={histories()} fallback={failure() === null ? <Skeleton rows={2} chart /> : <ErrorState error={new Error(failure() ?? "")} compact />}>{value => <Trends project={props.project} histories={value()} />}</Show>
          </td>
        </tr>
      </Show>
    </tbody>
  );
}

function Trends(props: { readonly project: Project; readonly histories: ProjectHistories }): JSX.Element {
  const worker = () => props.histories.worker;
  const common = () => ({ min: 0, compact: true, stepMs: worker().stepMs, provisionalFromMs: provisionalFromMs(worker()) });
  const calls = () => metricTrack(worker(), "worker.invocations");
  const probe = () => props.project.probes[0];
  const bucket = () => props.project.buckets[0];
  return (
    <div class="projects-trends">
      <div><PanelLabel>Requests</PanelLabel><PanelChart label={`${props.project.name} requests`} area series={[{ label: "requests", color: "blue", track: calls() }]} format={count} {...common()} /></div>
      <div><PanelLabel>CPU per request</PanelLabel><PanelChart label={`${props.project.name} CPU per request`} series={[{ label: "CPU/request", color: "violet", track: ratio(metricTrack(worker(), "worker.cpuMsSum"), calls(), 1, 1) }]} format={milliseconds} {...common()} /></div>
      <div><PanelLabel>5xx responses</PanelLabel><PanelChart label={`${props.project.name} 5xx`} area series={[{ label: "5xx", color: "critical", track: metricTrack(worker(), "worker.status.5xx") }]} format={count} {...common()} /></div>
      <Show when={probe()} fallback={
        <Show when={bucket()}>{name => (
          <div><PanelLabel>{name()} stored</PanelLabel><PanelChart label={`${name()} stored`} area series={[{ label: "stored", color: "aqua", track: metricTrack(props.histories.r2, `r2.${name()}.storageBytes`) }]} format={bytes} min={0} compact stepMs={props.histories.r2.stepMs} /></div>
        )}</Show>
      }>{target => {
        const probes = props.histories.probes;
        return probes === undefined ? null : <div><PanelLabel>{target().name} response time</PanelLabel><PanelChart label={`${target().name} response time`} series={[{ label: target().name, color: "aqua", track: metricTrack(probes, `probe.${target().name}.ms`) }]} format={milliseconds} min={0} compact stepMs={probes.stepMs} /></div>;
      }}</Show>
    </div>
  );
}
