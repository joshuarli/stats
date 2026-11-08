import { createMemo, createSignal, Errored, For, Loading, onCleanup, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { getServiceIssues, type Service } from "../api";
import { age } from "../format";
import { loadServices } from "../queries";
import { PROJECT_REFRESH_TICKS, useTelemetry } from "../state";
import { PageHeader } from "@laputa-systems/ui-dashboard";
import { EmptyState, ErrorState, Skeleton, Widget } from "../components/ui";
import { createUpdateEffect } from "../effect";
import { createServiceDeployments, DeploymentRail, DeploymentsWidget } from "./project/Deployments";
import { DeploymentEvents } from "../components/DeploymentEvents";
import type { ServiceDeploymentHistory } from "../../core/installation/services";
import type { DeploymentHistory } from "../../deployments/model";
import type { IssueSummary } from "../../observe/core/store";
import type { ServiceComparison, WorkMeasurement, WorkSide, WorkSummary } from "../../deployments/service-compare";
import "./project/project.css";
import "./project/services.css";

export function ServicePage(): JSX.Element {
  const params = useParams();
  const { tick, manualTick } = useTelemetry();
  const serviceTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const services = createMemo(loadServices);
  const service = createMemo(() => services().find(candidate => candidate.name === (params.serviceName ?? "")));
  createUpdateEffect(() => `${serviceTick()}:${manualTick()}`, () => { void refresh(services); });
  return (
    <Errored fallback={(error, reset) => <ErrorState error={error()} retry={reset} />}>
      <Loading fallback={<Skeleton rows={2} />}>
        <Show
          when={service()?.name}
          keyed
          fallback={<EmptyState icon="host" title="Service not found" detail="The service name is not in this installation." action={<a class="btn" href="#/services">Back to services</a>} />}
        >
          {name => <ServiceView service={services().find(candidate => candidate.name === name)!} />}
        </Show>
      </Loading>
    </Errored>
  );
}

function isServiceHistory(value: DeploymentHistory | null): value is ServiceDeploymentHistory {
  return value !== null && "markers" in value;
}

function ServiceView(props: { readonly service: Service }): JSX.Element {
  const { range, now, tick, manualTick } = useTelemetry();
  const serviceTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const deployments = createServiceDeployments(() => props.service.name, range, () => `${serviceTick()}:${manualTick()}`);
  const settled = () => deployments.history() !== null || deployments.historyError() !== null;
  const latest = () => deployments.history()?.deployments[0];
  const marker = createMemo(() => {
    const history = deployments.history();
    return isServiceHistory(history) ? history.markers.find(item => item.deploymentId === latest()?.id) ?? null : null;
  });
  const comparison = createMemo((): ServiceComparison | null => {
    const value = deployments.comparison();
    return value !== null && "work" in value ? value : null;
  });
  const work = createMemo(() => comparison()?.work ?? []);
  const application = createMemo(() => comparison()?.sources.find(source => source.source === "application") ?? null);
  const probe = createMemo(() => comparison()?.sources.find(source => source.source === "probe") ?? null);
  const [issues, setIssues] = createSignal<readonly IssueSummary[] | null>(null);
  const [issuesUnavailable, setIssuesUnavailable] = createSignal(false);
  const loadIssues = () => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    setIssuesUnavailable(false);
    void getServiceIssues(props.service.name, controller.signal).then(page => {
      if (!controller.signal.aborted) setIssues(page.items);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setIssues([]);
      setIssuesUnavailable(true);
    });
  };
  loadIssues();
  createUpdateEffect(() => `${serviceTick()}:${manualTick()}`, loadIssues);
  const after = createMemo(() => comparison()?.reasons.length ? null : totals(work().map(summary => summary.after), comparison()?.after ?? null));
  const release = () => latest() === undefined ? null : deployments.title(latest()!);
  const probeText = () => {
    const source = probe();
    if (source === null) return "probe unavailable, no comparison";
    return source.status === "available" ? `probe available, ${source.detail}` : `probe unavailable, ${source.detail}`;
  };
  return (
    <DeploymentEvents value={deployments.events}>
      <PageHeader title={props.service.name} />
      <p class="service-facts">
        <span>{props.service.hostIds.length} {props.service.hostIds.length === 1 ? "host" : "hosts"}</span>
        <span>{release() === null ? "release unavailable" : `release ${release()}`}</span>
        <span>{marker() === null ? "marker unavailable" : `marker ${marker()!.markerId}`}</span>
        <span>{props.service.healthUrl === null ? "health probe unavailable, no health URL" : `probing ${props.service.healthUrl}`}</span>
        <Show when={props.service.unit}>{unit => <span>unit {unit()}</span>}</Show>
        <span>{probeText()}</span>
        <span>{describeWork(after())}</span>
        <span>{issuesUnavailable() ? "issues unavailable" : issues() === null ? "issues loading" : `${issues()!.length} open ${issues()!.length === 1 ? "issue" : "issues"}`}</span>
        <Show when={latest()}>{deployment => <span>last deploy {deployments.title(deployment())}, {age(deployment().atMs, now())}</span>}</Show>
      </p>
      <div class="project-page">
        <Show when={settled()} fallback={<Skeleton rows={4} chart class="skeleton-deployments" />}>
          <div class={deployments.listed() ? "project-body with-rail" : "project-body"}>
            <Show when={deployments.listed()}><DeploymentRail deployments={deployments} /></Show>
            <div class="project-main">
              <DeploymentsWidget deployments={deployments} />
              <ServiceWork comparison={comparison()} application={application()?.detail ?? null} work={work()} issues={issues()} issuesUnavailable={issuesUnavailable()} />
            </div>
          </div>
        </Show>
      </div>
    </DeploymentEvents>
  );
}

interface Totals {
  readonly successes: number;
  readonly failures: number;
  readonly events: number;
  readonly failureRate: number | null;
  readonly meanDurationMs: number | null;
  readonly throughputPerMinute: number | null;
}

function totals(sides: readonly WorkSide[], bounds: { readonly fromMs: number; readonly toMs: number } | null): Totals | null {
  if (sides.length === 0) return null;
  const successes = sides.reduce((sum, side) => sum + side.successes, 0);
  const failures = sides.reduce((sum, side) => sum + side.failures, 0);
  const events = successes + failures;
  const duration = sides.reduce((sum, side) => sum + (side.meanDurationMs ?? 0) * side.successes, 0);
  const minutes = bounds === null ? 0 : (bounds.toMs - bounds.fromMs) / 60_000;
  return {
    successes, failures, events,
    failureRate: events === 0 ? null : failures / events * 100,
    meanDurationMs: successes === 0 ? null : duration / successes,
    throughputPerMinute: minutes === 0 ? null : events / minutes
  };
}

function number(value: number | null, digits = 1): string {
  return value === null ? "unavailable" : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function describeWork(value: Totals | null): string {
  if (value === null) return "throughput unavailable";
  return `${number(value.throughputPerMinute)} events/min after, ${number(value.failureRate)}% failed, ${number(value.meanDurationMs)} ms mean`;
}

function ServiceWork(props: { readonly comparison: ServiceComparison | null; readonly application: string | null; readonly work: readonly WorkSummary[]; readonly issues: readonly IssueSummary[] | null; readonly issuesUnavailable: boolean }): JSX.Element {
  return (
    <Widget id="service-work" class="wide" title="Application work">
      <Show when={props.comparison !== null} fallback={<p class="panel-label">unavailable, no deployment comparison</p>}>
        <Show when={props.work.length > 0 && props.comparison!.reasons.length === 0} fallback={<p class="panel-label">unavailable, {props.comparison!.reasons[0] ?? props.application ?? "no application telemetry"}</p>}>
          <div class="service-work">
            <WorkTimeline before={props.work[0]!.before} after={props.work[0]!.after} marker={props.comparison!.after.fromMs} />
            <div class="table-scroll" role="region" aria-label="Application operations">
              <table class="data-table compact service-work-table" aria-label="Application operations">
                <thead><tr><th>Operation</th><th class="numeric">Events before → after</th><th class="numeric">Failure before → after</th><th class="numeric">Mean latency before → after</th><th>Work per unit</th></tr></thead>
                <tbody>
                  <For each={props.work}>{summary => (
                    <tr>
                      <th scope="row" class="mono">{summary.operation}</th>
                      <td class="numeric">{summary.before.successes + summary.before.failures} → {summary.after.successes + summary.after.failures}</td>
                      <td class="numeric">{number(summary.before.failureRate)}% → {number(summary.after.failureRate)}%</td>
                      <td class="numeric">{number(summary.before.meanDurationMs)} → {number(summary.after.meanDurationMs)} ms</td>
                      <td><WorkKeys summary={summary} /></td>
                    </tr>
                  )}</For>
                </tbody>
              </table>
            </div>
            <Issues issues={props.issues} unavailable={props.issuesUnavailable} />
          </div>
        </Show>
      </Show>
    </Widget>
  );
}

function WorkTimeline(props: { readonly before: WorkSide; readonly after: WorkSide; readonly marker: number }): JSX.Element {
  const peak = Math.max(1, ...[...props.before.buckets, ...props.after.buckets].map(bucket => bucket.successes + bucket.failures));
  const bars = (side: WorkSide) => side.buckets.map(bucket => (
    <span
      class={bucket.failures > 0 ? "service-work-bar failed" : "service-work-bar"}
      style={{ height: `${Math.max(1, (bucket.successes + bucket.failures) / peak * 100)}%` }}
      title={`${new Date(bucket.atMs).toISOString()}: ${bucket.successes} successful, ${bucket.failures} failed`}
    />
  ));
  return (
    <div class="service-work-chart" role="img" aria-label="Application events per five-minute bucket before and after the deployment marker">
      <div class="service-work-half"><span class="service-work-label">before</span><div class="service-work-bars">{bars(props.before)}</div></div>
      <div class="service-work-marker" title={`deployment marker ${new Date(props.marker).toISOString()}`}><span>marker</span></div>
      <div class="service-work-half"><span class="service-work-label">after</span><div class="service-work-bars">{bars(props.after)}</div></div>
    </div>
  );
}

function WorkKeys(props: { readonly summary: WorkSummary }): JSX.Element {
  const keys = [...new Set([...props.summary.before.work, ...props.summary.after.work].map(item => item.key))].sort();
  return (
    <Show when={keys.length > 0} fallback={<span class="cell-note">no work counters</span>}>
      <div class="service-work-keys">
        <For each={keys}>{key => <span>{key}: {measurement(props.summary.before.work.find(item => item.key === key))} → {measurement(props.summary.after.work.find(item => item.key === key))}</span>}</For>
      </div>
    </Show>
  );
}

function measurement(value: WorkMeasurement | undefined): string {
  if (value === undefined || !value.complete) return value?.reason ?? "unavailable";
  const parts = [`${value.total.toLocaleString()} units`];
  if (value.durationPerUnitMs !== null) parts.push(`${number(value.durationPerUnitMs, 3)} ms/unit`);
  if (value.cpuPerUnit !== null) parts.push(`${number(value.cpuPerUnit, 6)} CPU-s/unit`);
  if (value.ioPerUnit !== null) parts.push(`${number(value.ioPerUnit, 3)} B/unit`);
  return parts.join(", ");
}

function Issues(props: { readonly issues: readonly IssueSummary[] | null; readonly unavailable: boolean }): JSX.Element {
  return (
    <Show when={!props.unavailable} fallback={<p class="cell-note">issues unavailable</p>}>
      <Show when={props.issues !== null} fallback={<p class="cell-note">issues loading</p>}>
        <Show when={props.issues!.length > 0} fallback={<p class="cell-note">0 open issues</p>}>
          <details class="service-issues">
            <summary>{props.issues!.length} open {props.issues!.length === 1 ? "issue" : "issues"}</summary>
            <ul><For each={props.issues!.slice(0, 8)}>{issue => <li><span class="mono">{issue.operation ?? "request"}</span> {issue.name} · {issue.occurrences} occurrences</li>}</For></ul>
          </details>
        </Show>
      </Show>
    </Show>
  );
}
