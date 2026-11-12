import { createEffect, createMemo, createSignal, Errored, For, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { getServiceIssues, type Service } from "../api";
import { age } from "../format";
import { loadServices } from "../queries";
import { PROJECT_REFRESH_TICKS, useTelemetry } from "../state";
import { routeWithRange } from "../urlState";
import { EmptyState, PageHeader, Skeleton } from "@laputa-systems/ui-dashboard";
import { ErrorState, Widget } from "../components/ui";
import { compareSortValues, createSort, SortHeader } from "../components/sort";
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
  const { tick, manualTick, range } = useTelemetry();
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
          fallback={<EmptyState icon="host" title="Service not found" detail="The service name is not in this installation." action={<a class="btn" href={routeWithRange("#/services", range())}>Back to services</a>} />}
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
  const serviceName = props.service.name;
  const { range, now, tick, manualTick } = useTelemetry();
  const serviceTick = createMemo(() => Math.floor(tick() / PROJECT_REFRESH_TICKS));
  const deployments = createServiceDeployments(() => serviceName, range, () => `${serviceTick()}:${manualTick()}`);
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
  createEffect(() => `${serviceName}:${serviceTick()}:${manualTick()}`, () => {
    const controller = new AbortController();
    setIssues(null);
    setIssuesUnavailable(false);
    void getServiceIssues(serviceName, controller.signal).then(page => {
      if (!controller.signal.aborted) setIssues(page.items);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setIssuesUnavailable(true);
    });
    return () => controller.abort();
  });
  const after = createMemo(() => totals(work().map(summary => summary.after), comparison()?.after ?? null));
  const release = () => latest() === undefined ? null : deployments.title(latest()!);
  const probeText = () => {
    const source = probe();
    if (source === null) return "Health: not probed";
    if (source.status === "available") return "Health probe data: available";
    if (source.detail.includes("runs no health probes")) return "Health: not probed on this target";
    if (source.detail.includes("no health URL")) return "Health: not set";
    return "Health: collecting";
  };
  return (
    <DeploymentEvents value={deployments.events}>
      <PageHeader title={props.service.name} />
      <p class="service-facts">
        <span>{props.service.hostIds.length} {props.service.hostIds.length === 1 ? "host" : "hosts"}</span>
        <span>{release() === null ? "Release: —" : `Release: ${release()}`}</span>
        <span title={marker()?.markerId ?? ""}>{latest() === undefined ? "Last deploy: —" : `Last deploy: ${age(latest()!.atMs, now())}`}</span>
        <span>{probeText()}</span>
        <span>{describeWork(after())}{deployments.stale() && comparison() !== null ? " · previous comparison window" : ""}</span>
        <span>{issuesUnavailable() ? "Issues: unavailable" : issues() === null ? "Issues: loading" : `${issues()!.length} open ${issues()!.length === 1 ? "issue" : "issues"}`}</span>
      </p>
      <div class="project-page">
        <Show when={settled()} fallback={<Skeleton rows={4} chart class="skeleton-deployments" />}>
          <div class={deployments.listed() ? "project-body with-rail" : "project-body"}>
            <Show when={deployments.listed()}><DeploymentRail deployments={deployments} /></Show>
            <div class="project-main">
              <DeploymentsWidget deployments={deployments} />
              <ServiceWork comparison={comparison()} stale={deployments.stale()} application={application()?.detail ?? null} work={work()} issues={issues()} issuesUnavailable={issuesUnavailable()} />
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

function withUnit(value: number | null, unit: string): string {
  return value === null ? "unavailable" : `${number(value)}${unit}`;
}

function describeWork(value: Totals | null): string {
  if (value === null) return "throughput unavailable";
  const failure = value.failureRate === null ? "unavailable failure rate" : `${number(value.failureRate)}% failed`;
  const latency = value.meanDurationMs === null ? "unavailable mean latency" : `${number(value.meanDurationMs)} ms mean`;
  return `${number(value.throughputPerMinute)} events/min after, ${failure}, ${latency}`;
}

function ServiceWork(props: { readonly comparison: ServiceComparison | null; readonly stale: boolean; readonly application: string | null; readonly work: readonly WorkSummary[]; readonly issues: readonly IssueSummary[] | null; readonly issuesUnavailable: boolean }): JSX.Element {
  const { sort, sortBy } = createSort<"none" | "operation" | "events" | "failure" | "latency">({ key: "none", direction: 1 });
  const rows = () => {
    const key = sort().key;
    if (key === "none") return props.work;
    const direction = sort().direction;
    const value = (summary: WorkSummary): number | string | null => {
      if (key === "operation") return summary.operation;
      if (key === "events") return summary.after.successes + summary.after.failures;
      if (key === "failure") return summary.after.failureRate;
      return summary.after.meanDurationMs;
    };
    return [...props.work].sort((left, right) => {
      const leftValue = value(left);
      const rightValue = value(right);
      if (leftValue === null || rightValue === null) {
        if (leftValue === null && rightValue === null) return left.operation.localeCompare(right.operation);
        return leftValue === null ? 1 : -1;
      }
      return compareSortValues(leftValue, rightValue) * direction || left.operation.localeCompare(right.operation);
    });
  };
  return (
    <Widget id="service-work" class="wide" title="Application work">
      <Show when={props.comparison !== null} fallback={<p class="panel-label">Collecting usage since the deploy…</p>}>
        <Show when={props.work.length > 0} fallback={<p class="panel-label">{props.application ?? "Collecting usage since the deploy…"}</p>}>
          <div class="service-work">
            <Show when={props.stale}><p class="service-work-note" role="status">Updating comparison; application work uses the previous window.</p></Show>
            <Show when={props.comparison!.reasons.length > 0}>
              <p class="service-work-note">The comparison has limitations; see the deployment comparison above for details.</p>
            </Show>
            <WorkTimeline before={props.work[0]!.before} after={props.work[0]!.after} marker={props.comparison!.after.fromMs} />
            <div class="table-scroll" role="region" aria-label="Application operations">
              <table class="data-table compact service-work-table" aria-label="Application operations">
                <thead><tr>
                  <SortHeader label="Operation" sortKey="operation" sort={sort()} onSort={sortBy} />
                  <SortHeader label="Events before → after" sortKey="events" sort={sort()} onSort={sortBy} class="numeric" />
                  <SortHeader label="Failure before → after" sortKey="failure" sort={sort()} onSort={sortBy} class="numeric" />
                  <SortHeader label="Mean latency before → after" sortKey="latency" sort={sort()} onSort={sortBy} class="numeric" />
                  <th>Work per unit</th>
                </tr></thead>
                <tbody>
                  <For each={rows()}>{summary => (
                    <tr>
                      <th scope="row" class="mono">{summary.operation}</th>
                      <td class="numeric">{summary.before.successes + summary.before.failures} → {summary.after.successes + summary.after.failures}</td>
                      <td class="numeric">{withUnit(summary.before.failureRate, "%")} → {withUnit(summary.after.failureRate, "%")}</td>
                      <td class="numeric">{summary.before.meanDurationMs !== null && summary.after.meanDurationMs !== null ? `${number(summary.before.meanDurationMs)} → ${number(summary.after.meanDurationMs)} ms` : `${withUnit(summary.before.meanDurationMs, " ms")} → ${withUnit(summary.after.meanDurationMs, " ms")}`}</td>
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
