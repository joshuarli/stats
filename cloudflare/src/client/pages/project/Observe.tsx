import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ApiFailure } from "../../api";
import { age, bytes, count } from "../../format";
import { useTelemetry } from "../../state";
import { readParam, writeParam } from "../../urlState";
import { jumpTo, Skeleton, Widget } from "../../components/ui";
import { decodeHealth, decodeImpact, decodeIssues, decodeOccurrences, decodeTrace, decodeTraces, type ObserveHealth } from "../../../observe/decode";
import type { IssueRef, IssueState, IssueSummary, Occurrence, Page, RolloutImpact, TraceDetail, TraceSummary, VersionStats } from "../../../observe/core/store";
import { VERSION } from "../../../observe/core/model";
import { duration, ErrorFrames, TraceTimeline } from "./TraceTimeline";
import "./observe.css";

const BASE = "/api/observe";
const TRACE_ID = /^[0-9a-f]{32}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const MOMENT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

async function read<T>(path: string, signal: AbortSignal, decode: (value: unknown) => T): Promise<T> {
  let response: Response;
  try { response = await fetch(`${BASE}${path}`, { signal, credentials: "same-origin", cache: "no-store" }); }
  catch (cause) { throw new ApiFailure(0, "The observability collector could not be reached", cause); }
  if (response.status === 404 && path.startsWith("/traces/")) throw new ApiFailure(404, "This trace has expired or was never recorded");
  if (response.status === 404 && path.startsWith("/rollouts/")) throw new ApiFailure(404, "This deployment has not reached the collector yet; deployments are forwarded every 5 minutes");
  if (!response.ok) throw new ApiFailure(response.status, `The observability collector is unavailable (${response.status})`);
  try { return decode(await response.json()); }
  catch (cause) { throw new ApiFailure(0, "The observability collector sent an invalid response", cause); }
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

type TraceFilter = "all" | "failed";

export function createObservability(refreshKey: () => string) {
  const [health, setHealth] = createSignal<ObserveHealth | null>(null);
  const [traces, setTraces] = createSignal<Page<TraceSummary> | null>(null);
  const [issues, setIssues] = createSignal<Page<IssueSummary> | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [traceFilter, setTraceFilter] = createSignal<TraceFilter>(readParam("traces") === "failed" ? "failed" : "all");
  const [route, setRoute] = createSignal<string | null>(readParam("route"));
  const [issueState, setIssueState] = createSignal<IssueState>(readParam("issues") === "resolved" ? "resolved" : "open");
  const initialIntroduced = readParam("introduced");
  const [introducedIn, setIntroducedIn] = createSignal<string | null>(initialIntroduced !== null && VERSION.test(initialIntroduced) ? initialIntroduced : null);
  const initialTrace = readParam("trace");
  const initialIssue = readParam("issue");
  const [traceId, setTraceId] = createSignal<string | null>(initialTrace !== null && TRACE_ID.test(initialTrace) ? initialTrace : null);
  const [issueId, setIssueId] = createSignal<string | null>(initialIssue !== null && FINGERPRINT.test(initialIssue) ? initialIssue : null);
  const [slice, setSlice] = createSignal<string | null>(null);
  const [trace, setTrace] = createSignal<TraceDetail | null>(null);
  const [traceError, setTraceError] = createSignal<string | null>(null);
  const [occurrences, setOccurrences] = createSignal<Page<Occurrence> | null>(null);
  const [mutation, setMutation] = createSignal(0);

  createEffect(() => ({ tick: refreshKey(), filter: traceFilter(), route: route(), state: issueState(), introduced: introducedIn(), mutation: mutation() }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const traceQuery = new URLSearchParams({ limit: "100" });
    if (query.filter === "failed") traceQuery.set("failed", "true");
    if (query.route !== null) traceQuery.set("label", query.route);
    void Promise.all([
      read("/health", controller.signal, decodeHealth),
      read(`/traces?${traceQuery}`, controller.signal, decodeTraces),
      read(`/issues?${new URLSearchParams({ state: query.state, limit: "100", ...(query.introduced === null ? {} : { introducedIn: query.introduced }) })}`, controller.signal, decodeIssues)
    ]).then(([nextHealth, nextTraces, nextIssues]) => {
      if (controller.signal.aborted) return;
      setHealth(nextHealth);
      setTraces(nextTraces);
      setIssues(nextIssues);
      setError(null);
      if (traceId() === null) selectTrace(nextTraces.items.find(item => item.traceId !== null)?.traceId ?? null, false);
      if (issueId() === null || !nextIssues.items.some(issue => issue.fingerprint === issueId())) selectIssue(nextIssues.items[0]?.fingerprint ?? null, false);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(message(cause, "The observability collector is unavailable")); });
  });

  createEffect(() => ({ id: traceId(), tick: refreshKey() }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    if (query.id === null) { setTrace(null); setTraceError(null); return; }
    const id = query.id;
    void read(`/traces/${id}`, controller.signal, value => decodeTrace(value, id)).then(value => {
      if (controller.signal.aborted) return;
      setTrace(value);
      setTraceError(null);
      if (!value.invocations.some(invocation => invocation.key === slice())) setSlice(value.invocations.find(invocation => invocation.stage === "worker")?.key ?? value.invocations[0]?.key ?? null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setTrace(null);
      setTraceError(message(cause, "Trace unavailable"));
    });
  });

  createEffect(() => ({ id: issueId(), tick: refreshKey(), mutation: mutation() }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    if (query.id === null) { setOccurrences(null); return; }
    void read(`/issues/${query.id}/occurrences?limit=100`, controller.signal, decodeOccurrences).then(value => {
      if (!controller.signal.aborted) setOccurrences(value);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(message(cause, "Occurrences unavailable")); });
  });

  function selectTrace(id: string | null, remember = true): void {
    setTraceId(id);
    if (remember) writeParam("trace", id);
  }
  function selectIssue(id: string | null, remember = true): void {
    setIssueId(id);
    if (remember) writeParam("issue", id);
  }
  const filterTraces = (value: TraceFilter) => { setTraceFilter(value); writeParam("traces", value === "all" ? null : value); };
  const filterRoute = (value: string | null) => { setRoute(value); writeParam("route", value); };
  const filterIssues = (value: IssueState) => { setIssueState(value); writeParam("issues", value === "open" ? null : value); selectIssue(null, false); };
  const filterIntroduced = (value: string | null) => { setIntroducedIn(value); writeParam("introduced", value); selectIssue(null, false); };
  const openIssue = (fingerprint: string) => {
    selectIssue(fingerprint);
    jumpTo("issues");
  };
  const openTrace = (id: string) => {
    selectTrace(id);
    jumpTo("traces");
  };
  const [resolving, setResolving] = createSignal(false);
  const changeState = async (fingerprint: string, state: IssueState) => {
    setResolving(true);
    try {
      const response = await fetch(`${BASE}/issues/${fingerprint}/state`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
      if (!response.ok) throw new ApiFailure(response.status, `Could not mark the issue ${state} (${response.status})`);
      setMutation(value => value + 1);
    } catch (cause) {
      setError(message(cause, "Could not change the issue"));
    } finally {
      setResolving(false);
    }
  };

  return { health, traces, issues, error, traceFilter, filterTraces, route, filterRoute, issueState, filterIssues, introducedIn, filterIntroduced, traceId, selectTrace, issueId, selectIssue, openIssue, slice, setSlice, trace, traceError, occurrences, openTrace, changeState, resolving };
}

export type Observability = ReturnType<typeof createObservability>;

export function versionName(version: string, label: string | null): string {
  return label ?? (version.length > 12 ? version.slice(0, 8) : version);
}

function HealthMeta(props: { readonly health: ObserveHealth | null }): JSX.Element {
  const { now } = useTelemetry();
  return (
    <Show when={props.health}>{health => (
      <span class="observe-health" title={`${count(health().liveInvocations)} invocations retained · ${bytes(health().databaseBytes)} on disk · cleanup lag ${duration(health().cleanupLagMs)}`}>
        <span class={`status-dot ${health().newestAtMs !== null && now() - health().newestAtMs! < 10 * 60_000 ? "tone-ok" : "tone-warn"}`} />
        {health().newestAtMs === null ? "nothing received yet" : `last event ${age(health().newestAtMs, now())}`}
      </span>
    )}</Show>
  );
}

function Segmented<T extends string>(props: { readonly label: string; readonly value: T; readonly options: readonly [T, string][]; readonly onChange: (value: T) => void }): JSX.Element {
  return (
    <div class="segmented" role="group" aria-label={props.label}>
      <For each={props.options}>{([value, label]) => (
        <button type="button" class="segment" aria-pressed={props.value === value ? "true" : "false"} onClick={() => props.onChange(value)}>{label}</button>
      )}</For>
    </div>
  );
}

function RouteLabel(props: { readonly label: string }): JSX.Element {
  const parts = () => {
    const match = /^([A-Z]+) (\/.*)$/u.exec(props.label);
    return match === null ? { method: null, path: props.label } : { method: match[1]!, path: match[2]! };
  };
  const segments = () => parts().path.split("/");
  return (
    <b class="route-label">
      <Show when={parts().method}>{method => <span class="route-method">{method()}</span>}</Show>
      <For each={segments()}>{(segment, index) => <>{index() > 0 ? <>/<wbr /></> : null}{segment}</>}</For>
    </b>
  );
}

function statusTone(trace: TraceSummary): string {
  if (trace.failed) return "tone-bad";
  if (trace.status !== null && trace.status >= 400) return "tone-warn";
  return "tone-ok";
}

export function TracesWidget(props: { readonly observe: Observability }): JSX.Element {
  const { now } = useTelemetry();
  const o = props.observe;
  const items = () => o.traces()?.items ?? [];
  const maxWall = createMemo(() => Math.max(1, ...items().map(item => item.wallMs)));
  const routes = createMemo(() => [...new Set([...(o.route() === null ? [] : [o.route()!]), ...items().map(item => item.label)])].sort());
  const moveSelection = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const list = items().filter(item => item.traceId !== null);
    const index = list.findIndex(item => item.traceId === o.traceId());
    const target = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : null;
    const next = target === null ? undefined : list[Math.min(list.length - 1, Math.max(0, target))];
    if (next?.traceId == null) return;
    event.preventDefault();
    o.selectTrace(next.traceId);
    event.currentTarget.querySelectorAll<HTMLButtonElement>(".trace-row")[list.indexOf(next)]?.focus();
  };
  return (
    <Widget id="traces" class="wide observe" title="Traces" meta={<><span>last 7 days</span><HealthMeta health={o.health()} /></>} expandable>
      <Show when={o.error()}>{text => <div class="notice notice-warn" role="status"><span>{text()}</span></div>}</Show>
      <div class="observe-toolbar">
        <Segmented label="Trace outcome" value={o.traceFilter()} options={[["all", "All"], ["failed", "Failed"]]} onChange={o.filterTraces} />
        <label class="observe-select">
          <span class="sr-only">Route</span>
          <select value={o.route() ?? ""} onChange={event => o.filterRoute(event.currentTarget.value === "" ? null : event.currentTarget.value)}>
            <option value="">All routes</option>
            <For each={routes()}>{route => <option value={route}>{route}</option>}</For>
          </select>
        </label>
        <span class="observe-count">{o.traces() === null ? "" : `${count(items().length)}${o.traces()?.next === null ? "" : "+"} traces`}</span>
      </div>
      <Show when={o.traces() !== null} fallback={o.error() === null ? <Skeleton rows={6} /> : null}>
        <Show when={items().length > 0} fallback={<p class="panel-label observe-empty">{o.traceFilter() === "failed" ? "No failed requests in the last 7 days." : "No invocations were observed in the last 7 days."}</p>}>
          <div class="trace-layout">
            <div class="trace-list" role="listbox" tabindex="-1" aria-label="Traces" onKeyDown={moveSelection}>
              <div class="trace-list-head" aria-hidden="true"><span /><span>Route</span><span>Duration</span><span class="numeric">CPU</span><span class="numeric">When</span></div>
              <For each={items()}>{item => (
                <button type="button" role="option" class="trace-row" disabled={item.traceId === null} title={item.traceId === null ? "This invocation published no trace context" : MOMENT.format(item.atMs)} tabindex={o.traceId() === item.traceId ? 0 : -1} aria-selected={o.traceId() === item.traceId ? "true" : "false"} onClick={() => { if (item.traceId !== null) o.selectTrace(item.traceId); }}>
                  <span class={`status-dot ${statusTone(item)}`} aria-label={item.failed ? "failed" : "ok"} />
                  <span class="trace-route"><RouteLabel label={item.label} /><span class="cell-note">{item.status === null ? item.outcome : item.status}{item.objectInvocations > 0 ? ` · ${item.objectInvocations} DO` : ""}</span></span>
                  <span class="trace-span"><span class="trace-span-bar" style={`width:${Math.max(1.5, (item.wallMs / maxWall()) * 100)}%`} /><span class="trace-span-text">{duration(item.wallMs)}</span></span>
                  <span class="numeric cell-note">{duration(item.cpuMs + item.objectCpuMs)}</span>
                  <span class="numeric cell-note">{age(item.atMs, now())}</span>
                </button>
              )}</For>
            </div>
            <div class="trace-detail">
              <Show when={o.traceError()}>{text => <div class="notice notice-warn" role="alert"><span>{text()}</span></div>}</Show>
              <Show when={o.trace()} fallback={o.traceError() === null ? <Skeleton rows={6} /> : null}>{detail => (
                <>
                  <div class="trace-head">
                    <b>{detail().invocations.find(invocation => invocation.stage === "worker")?.label ?? "Root not received"}</b>
                    <span class="cell-note mono">{detail().traceId}</span>
                  </div>
                  <Show when={!detail().rootPresent}><div class="notice notice-warn" role="status"><span>The Worker invocation that started this trace was not received, so it is incomplete.</span></div></Show>
                  <Show when={detail().truncated}><div class="notice notice-warn" role="status"><span>Only the first 16 invocations are shown.</span></div></Show>
                  <TraceTimeline detail={detail()} selected={o.slice()} onSelect={o.setSlice} />
                  <p class="observe-footnote">Wall and CPU time are measured by the platform per invocation. CPU is a total for the invocation; where in the slice it was spent is not recorded.</p>
                </>
              )}</Show>
            </div>
          </div>
        </Show>
      </Show>
    </Widget>
  );
}

export function IssuesWidget(props: { readonly observe: Observability }): JSX.Element {
  const { now } = useTelemetry();
  const o = props.observe;
  const items = () => o.issues()?.items ?? [];
  const current = createMemo(() => items().find(issue => issue.fingerprint === o.issueId()) ?? null);
  const representative = createMemo(() => o.occurrences()?.items[0] ?? null);
  const introducedVersions = createMemo(() => {
    const versions = new Map<string, string>();
    const selected = o.introducedIn();
    if (selected !== null) versions.set(selected, versionName(selected, null));
    for (const issue of items()) if (issue.firstVersion !== null) versions.set(issue.firstVersion, versionName(issue.firstVersion, issue.firstVersionLabel));
    return [...versions];
  });
  const moveSelection = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const index = items().findIndex(issue => issue.fingerprint === o.issueId());
    const target = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? items().length - 1 : null;
    const next = target === null ? undefined : items()[Math.min(items().length - 1, Math.max(0, target))];
    if (next === undefined) return;
    event.preventDefault();
    o.selectIssue(next.fingerprint);
    event.currentTarget.querySelectorAll<HTMLButtonElement>(".issue-item")[items().indexOf(next)]?.focus();
  };
  return (
    <Widget id="issues" class="wide observe" title="Errors" meta={<span>{o.issues() === null ? "" : `${count(items().length)} ${o.issueState()} · last 7 days`}</span>} expandable>
      <div class="observe-toolbar">
        <Segmented label="Issue state" value={o.issueState()} options={[["open", "Open"], ["resolved", "Resolved"]]} onChange={o.filterIssues} />
        <label class="observe-select">
          <span class="sr-only">Introduced in</span>
          <select value={o.introducedIn() ?? ""} onChange={event => o.filterIntroduced(event.currentTarget.value === "" ? null : event.currentTarget.value)}>
            <option value="">Any version</option>
            <For each={introducedVersions()}>{([version, label]) => <option value={version}>Introduced in {label}</option>}</For>
          </select>
        </label>
      </div>
      <Show when={o.issues() !== null} fallback={o.error() === null ? <Skeleton rows={5} /> : null}>
        <Show when={items().length > 0} fallback={<p class="panel-label observe-empty">{o.issueState() === "open" ? "No open issues in the last 7 days." : "No resolved issues with occurrences in the last 7 days."}</p>}>
          <div class="issue-layout">
            <div class="issue-list" role="listbox" tabindex="-1" aria-label="Issues" onKeyDown={moveSelection}>
              <For each={items()}>{issue => (
                <button type="button" role="option" class="issue-item" tabindex={o.issueId() === issue.fingerprint ? 0 : -1} aria-selected={o.issueId() === issue.fingerprint ? "true" : "false"} onClick={() => o.selectIssue(issue.fingerprint)}>
                  <span class="issue-item-head">
                    <b>{issue.name}</b>
                    <Show when={issue.operation}>{operation => <span class="op-tag">{operation()}</span>}</Show>
                    <span class="issue-count">{count(issue.occurrences)}</span>
                  </span>
                  <span class="issue-frame mono">{issue.frame ?? "no stack"}</span>
                  <span class="issue-when">last {age(issue.lastAtMs, now())} · first {age(issue.firstAtMs, now())}<Show when={issue.firstVersion}>{version => <> · since <span class="version-tag">{versionName(version(), issue.firstVersionLabel)}</span></>}</Show></span>
                </button>
              )}</For>
            </div>
            <div class="issue-detail">
              <Show when={current()}>{issue => (
                <>
                  <div class="issue-head">
                    <div class="issue-title">
                      <b>{issue().name}</b>
                      <Show when={issue().operation}>{operation => <span class="op-tag">{operation()}</span>}</Show>
                    </div>
                    <button class="btn btn-small" type="button" disabled={o.resolving()} onClick={() => void o.changeState(issue().fingerprint, issue().state === "open" ? "resolved" : "open")}>
                      {issue().state === "open" ? "Resolve" : "Reopen"}
                    </button>
                  </div>
                  <dl class="issue-facts">
                    <div><dt>Occurrences</dt><dd>{count(issue().occurrences)}</dd></div>
                    <div><dt>First seen</dt><dd title="Within the retained 7 days, not proof it never happened earlier">{age(issue().firstAtMs, now())}</dd></div>
                    <div><dt>Last seen</dt><dd>{age(issue().lastAtMs, now())}</dd></div>
                    <div><dt>Introduced in</dt><dd title={issue().firstVersion ?? undefined}>{issue().firstVersion === null ? "unknown" : versionName(issue().firstVersion!, issue().firstVersionLabel)}<span class="issue-fact-note">{count(issue().versions)} {issue().versions === 1 ? "version" : "versions"}</span></dd></div>
                  </dl>
                  <Show when={representative()} fallback={<Skeleton rows={4} />}>{occurrence => <ErrorFrames occurrence={occurrence()} />}</Show>
                  <h3 class="observe-subhead">Occurrences</h3>
                  <div class="table-scroll" role="region" aria-label="Occurrences">
                    <table class="data-table compact occurrence-table">
                      <thead><tr><th>When</th><th>Version</th><th>Source</th><th class="numeric">Trace</th></tr></thead>
                      <tbody>
                        <For each={o.occurrences()?.items ?? []}>{occurrence => (
                          <tr>
                            <td title={MOMENT.format(occurrence.atMs)}>{age(occurrence.atMs, now())}</td>
                            <td class="mono cell-note">{occurrence.version?.slice(0, 8) ?? "unknown"}</td>
                            <td class="cell-note">{occurrence.source}</td>
                            <td class="numeric">
                              <Show when={occurrence.traceId} fallback={<span class="cell-note">none</span>}>{id => <button type="button" class="link" onClick={() => o.openTrace(id())}>Open trace</button>}</Show>
                            </td>
                          </tr>
                        )}</For>
                      </tbody>
                    </table>
                  </div>
                </>
              )}</Show>
            </div>
          </div>
        </Show>
      </Show>
    </Widget>
  );
}

function failureRate(rows: readonly VersionStats[]): { requests: number; failed: number; text: string } {
  const requests = rows.reduce((sum, row) => sum + row.requests, 0);
  const failed = rows.reduce((sum, row) => sum + row.failed, 0);
  return { requests, failed, text: requests === 0 ? "no requests" : `${((failed / requests) * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%` };
}

function baseline(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

function IssueLinks(props: { readonly title: string; readonly issues: readonly IssueRef[]; readonly onOpen: (fingerprint: string) => void }): JSX.Element {
  return (
    <Show when={props.issues.length > 0}>
      <div class="impact-issues">
        <span class="impact-issues-title">{props.title}</span>
        <For each={props.issues}>{issue => (
          <button type="button" class="impact-issue" onClick={() => props.onOpen(issue.fingerprint)}>
            <b>{issue.name}</b>
            <Show when={issue.operation}>{operation => <span class="op-tag">{operation()}</span>}</Show>
            <span class="issue-frame mono">{issue.frame ?? "no stack"}</span>
            <span class="issue-count">{count(issue.occurrences)}</span>
          </button>
        )}</For>
      </div>
    </Show>
  );
}

export function RolloutImpactPanel(props: { readonly deploymentId: string; readonly refreshKey: string; readonly observe: Observability }): JSX.Element {
  const [impact, setImpact] = createSignal<RolloutImpact | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(() => ({ id: props.deploymentId, tick: props.refreshKey }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    if (impact()?.rolloutId !== query.id) setImpact(null);
    void read(`/rollouts/${query.id}/impact`, controller.signal, value => decodeImpact(value, query.id)).then(value => {
      if (controller.signal.aborted) return;
      setImpact(value);
      setError(null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setImpact(null);
      setError(message(cause, "Deployment errors unavailable"));
    });
  });
  const summary = (value: RolloutImpact) => {
    if (value.state === "expired") return "Older than the 7 days of retained errors, so new issues cannot be told apart.";
    if (value.introduced.length === 0) return "This deployment introduced no new version, so no issue can be new in it.";
    const groups = value.newIssues.length;
    const regressions = value.regressions.length;
    return `${groups === 0 ? "No" : count(groups)} new issue ${groups === 1 ? "group" : "groups"} · ${regressions === 0 ? "no" : count(regressions)} ${regressions === 1 ? "regression" : "regressions"}`;
  };
  return (
    <section class="impact" aria-label="Errors after this deployment">
      <h3 class="observe-subhead">Errors after this deployment</h3>
      <Show when={error()}>{text => <p class="cell-note">{text()}</p>}</Show>
      <Show when={impact()} fallback={error() === null ? <Skeleton rows={2} /> : null}>{value => {
        const before = () => failureRate(value().versions.filter(version => !version.introduced));
        const after = () => failureRate(value().versions.filter(version => version.introduced));
        return (
          <>
            <p class="impact-summary">{summary(value())}</p>
            <Show when={value().state === "measured" && value().introduced.length > 0}>
              <p class="impact-rate">
                Failed requests {before().text} → <b>{after().text}</b>
                <span class="cell-note"> · {count(before().requests)} → {count(after().requests)} requests · compared with {baseline(value().baselineMs)} of earlier data</span>
              </p>
              <IssueLinks title="New" issues={value().newIssues} onOpen={props.observe.openIssue} />
              <IssueLinks title="Regressed" issues={value().regressions} onOpen={props.observe.openIssue} />
              <p class="observe-footnote">An issue counts as new when every retained occurrence ran on a version this deployment introduced. That says where it appeared, not that the deployment caused it.</p>
            </Show>
          </>
        );
      }}</Show>
    </section>
  );
}
