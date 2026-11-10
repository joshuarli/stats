import { createEffect, createMemo, For, Show, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { age, axisTime, count, percent } from "../../format";
import { useTelemetry } from "../../state";
import { Skeleton } from "@laputa-systems/ui-dashboard";
import { createPagedList, Segmented, ShowMore, Widget } from "../../components/ui";
import { compareSortValues, createSort, SortHeader } from "../../components/sort";
import { DeploymentEvents } from "../../components/DeploymentEvents";
import type { RouteStats, TraceSummary } from "../../../observe/core/store";
import type { SamplingSummary } from "../../../observe/core/counts";
import { TraceView } from "./TraceTimeline";
import { LatencyHeatmap } from "./Heatmap";

const LIST_PAGE = 12;
import { duration, HealthMeta, MOMENT, RouteLabel, type Observability } from "./Observe";

function statusTone(trace: TraceSummary): string {
  if (trace.failed) return "tone-bad";
  if (trace.status !== null && trace.status >= 400) return "tone-warn";
  return "tone-ok";
}

function latency(ms: number | null): string {
  return ms === null ? "sampled out" : duration(ms);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

type RouteSort = "none" | "route" | "requests" | "failed" | "cpu" | "p50" | "p95" | "p99" | "p95Cpu";

function routeValue(route: RouteStats, key: RouteSort): number | string | null {
  switch (key) {
    case "route": return route.label;
    case "requests": return route.observed ?? route.requests;
    case "failed": return route.failed;
    case "cpu": return route.cpuMs;
    case "p50": return route.p50WallMs;
    case "p95": return route.p95WallMs;
    case "p99": return route.p99WallMs;
    case "p95Cpu": return route.p95CpuMs;
    case "none": return null;
  }
}

function RouteTable(props: { readonly routes: readonly RouteStats[]; readonly sampling: SamplingSummary | undefined; readonly selected: string | null; readonly onSelect: (route: string | null) => void }): JSX.Element {
  const sampled = () => props.sampling !== undefined;
  const observed = (route: RouteStats) => route.observed ?? route.requests;
  const { sort, sortBy } = createSort<RouteSort>({ key: "none", direction: 1 });
  const totalCpu = createMemo(() => Math.max(1, props.routes.reduce((sum, route) => sum + route.cpuMs, 0)));
  const totals = createMemo(() => ({ requests: props.routes.reduce((sum, route) => sum + observed(route), 0), failed: props.routes.reduce((sum, route) => sum + route.failed, 0) }));
  const sorted = createMemo(() => {
    const key = sort().key;
    if (key === "none") return props.routes;
    const direction = sort().direction;
    return [...props.routes].sort((left, right) => {
      const leftValue = routeValue(left, key);
      const rightValue = routeValue(right, key);
      if (leftValue === null || rightValue === null) {
        if (leftValue === null && rightValue === null) return left.label.localeCompare(right.label);
        return leftValue === null ? 1 : -1;
      }
      return compareSortValues(leftValue, rightValue) * direction || left.label.localeCompare(right.label);
    });
  });
  return (
    <div class="table-scroll route-table-scroll" role="region" aria-label="Routes">
      <table class="data-table compact route-table">
        <thead>
          <tr>
            <SortHeader label="Route" sortKey="route" sort={sort()} onSort={sortBy} />
            <SortHeader label="Requests" sortKey="requests" sort={sort()} onSort={sortBy} class="numeric" />
            <SortHeader label="Failed" sortKey="failed" sort={sort()} onSort={sortBy} class="numeric" />
            <SortHeader label="CPU share" sortKey="cpu" sort={sort()} onSort={sortBy} class="cpu-col" />
            <SortHeader label={sampled() ? "p50 (sampled)" : "p50"} sortKey="p50" sort={sort()} onSort={sortBy} class="numeric" />
            <SortHeader label={sampled() ? "p95 (sampled)" : "p95"} sortKey="p95" sort={sort()} onSort={sortBy} class="numeric" />
            <SortHeader label={sampled() ? "p99 (sampled)" : "p99"} sortKey="p99" sort={sort()} onSort={sortBy} class="numeric" />
            <SortHeader label={sampled() ? "p95 CPU (sampled)" : "p95 CPU"} sortKey="p95Cpu" sort={sort()} onSort={sortBy} class="numeric" />
          </tr>
        </thead>
        <tbody>
          <tr class={props.selected === null ? "selected" : undefined}>
            <td><button type="button" class="route-pick" aria-pressed={props.selected === null ? "true" : "false"} onClick={() => props.onSelect(null)}><b>All routes</b></button></td>
            <td class="numeric">{count(totals().requests)}</td>
            <td class="numeric">{totals().requests === 0 ? "—" : percent((totals().failed / totals().requests) * 100)}</td>
            <td />
            <td /><td /><td /><td />
          </tr>
          <For each={sorted()}>{route => (
            <tr class={props.selected === route.label ? "selected" : undefined}>
              <td><button type="button" class="route-pick" aria-pressed={props.selected === route.label ? "true" : "false"} onClick={() => props.onSelect(props.selected === route.label ? null : route.label)}><RouteLabel label={route.label} /></button></td>
              <td class="numeric">{count(observed(route))}</td>
              <td class={route.failed > 0 ? "numeric failed-cell" : "numeric"}>{route.failed === 0 ? "0" : percent((route.failed / observed(route)) * 100)}</td>
              <td class="cpu-col"><span class="share"><span class="share-bar" style={`width:${(route.cpuMs / totalCpu()) * 100}%`} /><span class="share-text">{percent((route.cpuMs / totalCpu()) * 100)}</span></span></td>
              <td class="numeric">{latency(route.p50WallMs)}</td>
              <td class="numeric strong">{latency(route.p95WallMs)}</td>
              <td class="numeric">{latency(route.p99WallMs)}</td>
              <td class="numeric">{latency(route.p95CpuMs)}</td>
            </tr>
          )}</For>
        </tbody>
      </table>
    </div>
  );
}

export function RequestExplorerWidget(props: { readonly observe: Observability; readonly windowLabel: string }): JSX.Element {
  const { now } = useTelemetry();
  const o = props.observe;
  const events = useContext(DeploymentEvents);
  const items = () => o.traces()?.items ?? [];
  const paged = createPagedList(items, LIST_PAGE);
  createEffect(() => items().findIndex(item => item.traceId !== null && item.traceId === o.traceId()), index => { if (index >= 0) paged.reveal(index); });
  const exploration = () => o.exploration();
  const selectedRoute = createMemo(() => exploration()?.routes.find(route => route.label === exploration()?.route) ?? null);
  const maxWall = createMemo(() => Math.max(1, ...items().map(item => item.wallMs)));
  const band = () => o.band();
  const comparison = createMemo(() => {
    const current = band();
    const route = selectedRoute();
    if (current === null || items().length === 0) return null;
    const cpu = items().map(item => item.cpuMs + item.objectCpuMs);
    const objectShare = items().reduce((sum, item) => sum + item.objectCpuMs, 0) / Math.max(1, cpu.reduce((sum, value) => sum + value, 0));
    return { calls: items().length, wall: median(items().map(item => item.wallMs)), cpu: median(cpu), objectShare, typical: route === null || route.p50WallMs === null || route.p50CpuMs === null ? null : { wall: route.p50WallMs, cpu: route.p50CpuMs } };
  });
  const bandLabel = () => {
    const current = band();
    if (current === null) return null;
    if (current.kind === "slow") return selectedRoute() === null ? "Slowest calls" : `Calls at or above p95 (${latency(selectedRoute()!.p95WallMs)})`;
    return `${axisTime(current.fromMs, (exploration()?.toMs ?? now()) - (exploration()?.fromMs ?? 0))} · ${duration(current.minWallMs)}–${current.maxWallMs === null ? "more" : duration(current.maxWallMs)}`;
  };
  const moveSelection = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const list = items().filter(item => item.traceId !== null);
    const index = list.findIndex(item => item.traceId === o.traceId());
    const target = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : null;
    const next = target === null ? undefined : list[Math.min(list.length - 1, Math.max(0, target))];
    if (next?.traceId == null) return;
    event.preventDefault();
    o.selectTrace(next.traceId);
    const row = items().indexOf(next);
    paged.reveal(row);
    const rows = event.currentTarget;
    requestAnimationFrame(() => rows.querySelectorAll<HTMLButtonElement>(".trace-row")[row]?.focus());
  };
  return (
    <Widget id="route-explorer" class="wide observe" title="Requests by route" meta={<><span class="observe-window">{props.windowLabel}</span><HealthMeta health={o.health()} /></>} expandable>
      <Show when={o.exploreError()}>{text => <div class="notice notice-warn" role="status"><span>{text()}</span></div>}</Show>
      <Show when={exploration()} fallback={o.exploreError() === null ? <Skeleton rows={6} chart /> : null}>{value => (
        <Show when={value().routes.length > 0} fallback={<p class="panel-label observe-empty">No requests were observed in this window.</p>}>
          <Show when={value().sampling}>{sampling => (
            <p class="panel-label observe-sampling" role="note">Sampled: {count(sampling().kept)} of {count(sampling().observed)} invocations are kept. Request and failure counts are exact; percentiles, CPU share, and the traces below come from the kept invocations only.</p>
          )}</Show>
          <RouteTable routes={value().routes} sampling={value().sampling} selected={value().route} onSelect={o.filterRoute} />
          <div class="explore-head">
            <h3 class="observe-subhead">Latency{value().sampling === undefined ? "" : " (sampled)"} · {value().route ?? "all routes"}</h3>
            <div class="explore-actions">
              <Segmented label="Trace outcome" value={o.traceFilter()} options={[["all", "All"], ["failed", "Failed"]]} onChange={o.filterTraces} />
              <Segmented label="Calls" value={band() === null ? "recent" : band()!.kind === "slow" ? "slow" : "cell"} options={[["recent", "Recent"], ["slow", value().route === null ? "Slowest" : "≥ p95"], ...(band()?.kind === "cell" ? [["cell", "Selected"] as ["cell", string]] : [])]} onChange={choice => { if (choice === "recent") o.chooseBand(null); else if (choice === "slow") o.chooseBand({ kind: "slow" }); }} />
            </div>
          </div>
          <LatencyHeatmap heatmap={value().heatmap} toMs={value().toMs} band={band()} events={events()} onSelect={o.chooseBand} onMarker={event => { if (event.id !== undefined) o.openDeployment(event.id, event.label.replace(/^deploy /u, "Deployment ")); }} />
          <Show when={comparison()}>{summary => (
            <p class="hot-summary">
              <b>{bandLabel()}</b>: {count(summary().calls)} {summary().calls === 1 ? "call" : "calls"}, median {duration(summary().wall)} wall and {duration(summary().cpu)} CPU, {Math.round(summary().objectShare * 100)}% of it in the Durable Object
              <Show when={summary().typical}>{typical => <span class="cell-note"> · typical call {duration(typical().wall)} wall, {duration(typical().cpu)} CPU</span>}</Show>
            </p>
          )}</Show>
          <div class="trace-layout">
            <div class="trace-list" role="listbox" tabindex="-1" aria-label="Traces" onKeyDown={moveSelection}>
              <div class="trace-list-head" aria-hidden="true"><span /><span>{band() === null ? "Recent" : "Slowest first"}</span><span>Duration</span><span class="numeric">CPU</span><span class="numeric">When</span></div>
              <Show when={items().length > 0} fallback={<p class="panel-label observe-empty trace-empty">No calls match.</p>}>
                <For each={paged.visible()}>{item => (
                  <button type="button" role="option" class="trace-row" disabled={item.traceId === null} title={item.traceId === null ? "This invocation published no trace context" : MOMENT.format(item.atMs)} tabindex={o.traceId() === item.traceId ? 0 : -1} aria-selected={o.traceId() === item.traceId ? "true" : "false"} onClick={() => { if (item.traceId !== null) o.selectTrace(item.traceId); }}>
                    <span class={`status-dot ${statusTone(item)}`} aria-label={item.failed ? "failed" : "ok"} />
                    <span class="trace-route"><RouteLabel label={item.label} /><span class="cell-note">{item.status === null ? item.outcome : item.status}{item.objectInvocations > 0 ? ` · ${item.objectInvocations} DO` : ""}</span></span>
                    <span class="trace-span"><span class="trace-span-bar" style={`width:${Math.max(1.5, (item.wallMs / maxWall()) * 100)}%`} /><span class="trace-span-text">{duration(item.wallMs)}</span></span>
                    <span class="numeric cell-note">{duration(item.cpuMs + item.objectCpuMs)}</span>
                    <span class="numeric cell-note">{age(item.atMs, now())}</span>
                  </button>
                )}</For>
                <ShowMore hidden={paged.hidden()} noun="calls" onMore={paged.more} />
              </Show>
            </div>
            <div class="trace-detail">
              <Show when={o.traceError()}>{text => <div class="notice notice-warn" role="alert"><span>{text()}</span></div>}</Show>
              <Show when={o.trace()} fallback={o.traceError() === null && items().length > 0 ? <Skeleton rows={6} /> : null}>{detail => <TraceView detail={detail()} selected={o.slice()} onSelect={o.setSlice} />}</Show>
            </div>
          </div>
        </Show>
      )}</Show>
    </Widget>
  );
}
