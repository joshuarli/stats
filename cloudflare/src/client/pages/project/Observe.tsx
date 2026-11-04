import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ApiFailure } from "../../api";
import { age, bytes, count } from "../../format";
import { useTelemetry } from "../../state";
import { readParam, writeParam } from "../../urlState";
import { Segmented, Skeleton, Widget } from "../../components/ui";
import { decodeExploration, decodeHealth, decodeImpact, decodeIssue, decodeIssues, decodeOccurrences, decodeTrace, decodeTraces, type ObserveHealth } from "../../../observe/client/decode";
import { Modal } from "../../components/Modal";
import type { Exploration, IssueRef, IssueState, IssueSummary, Occurrence, Page, RolloutImpact, TraceDetail, TraceSummary, VersionStats } from "../../../observe/core/store";
import type { TimeWindow } from "../../chart-data";
import { VERSION } from "../../../observe/core/model";
import { defaultSlice, duration, ErrorFrames, TraceView } from "./TraceTimeline";
import { routeShift, type RouteShift } from "../../../observe/client/impact";
import "./observe.css";

import type { ObservedService } from "../../../observe/services";
const TRACE_ID = /^[0-9a-f]{32}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
export const MOMENT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

export type ObserveRead = <T>(path: string, signal: AbortSignal, decode: (value: unknown) => T) => Promise<T>;

function observeBase(service: ObservedService): string {
  return `/api/observe/${service}`;
}

async function readFrom<T>(base: string, path: string, signal: AbortSignal, decode: (value: unknown) => T): Promise<T> {
  let response: Response;
  try { response = await fetch(`${base}${path}`, { signal, credentials: "same-origin", cache: "no-store" }); }
  catch (cause) { throw new ApiFailure(0, "The observability collector could not be reached", cause); }
  if (response.status === 404 && path.startsWith("/traces/")) throw new ApiFailure(404, "This trace has expired or was never recorded");
  if (response.status === 404 && path.startsWith("/rollouts/")) throw new ApiFailure(404, "This deployment has not reached the collector yet; deployments are forwarded every 5 minutes");
  if (!response.ok) throw new ApiFailure(response.status, `The observability collector is unavailable (${response.status})`);
  try { return decode(await response.json()); }
  catch (cause) { throw new ApiFailure(0, "The observability collector sent an invalid response", cause); }
}

export function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

type TraceFilter = "all" | "failed";

export type Band =
  | { readonly kind: "slow" }
  | { readonly kind: "cell"; readonly fromMs: number; readonly toMs: number; readonly minWallMs: number; readonly maxWallMs: number | null };

function parseBand(value: string | null): Band | null {
  if (value === "slow") return { kind: "slow" };
  const cell = value === null ? null : /^cell:(\d{1,16}):(\d{1,16}):(\d{1,8}):(\d{1,8}|)$/u.exec(value);
  if (cell === null || cell === undefined) return null;
  return { kind: "cell", fromMs: Number(cell[1]), toMs: Number(cell[2]), minWallMs: Number(cell[3]), maxWallMs: cell[4] === "" ? null : Number(cell[4]) };
}

function bandParam(band: Band | null): string | null {
  if (band === null) return null;
  return band.kind === "slow" ? "slow" : `cell:${band.fromMs}:${band.toMs}:${band.minWallMs}:${band.maxWallMs ?? ""}`;
}

export type ModalView =
  | { readonly kind: "issue"; readonly fingerprint: string }
  | { readonly kind: "trace"; readonly traceId: string }
  | { readonly kind: "deployment"; readonly id: string; readonly label: string };

function parseModal(value: string | null): ModalView[] {
  const match = value === null ? null : /^(issue|trace|deployment):([A-Za-z0-9._:+-]{1,64})$/u.exec(value);
  if (match === null) return [];
  if (match[1] === "issue") return FINGERPRINT.test(match[2]!) ? [{ kind: "issue", fingerprint: match[2]! }] : [];
  if (match[1] === "trace") return TRACE_ID.test(match[2]!) ? [{ kind: "trace", traceId: match[2]! }] : [];
  return VERSION.test(match[2]!) ? [{ kind: "deployment", id: match[2]!, label: "Deployment" }] : [];
}

function modalParam(view: ModalView | undefined): string | null {
  if (view === undefined) return null;
  return view.kind === "issue" ? `issue:${view.fingerprint}` : view.kind === "trace" ? `trace:${view.traceId}` : `deployment:${view.id}`;
}

export function createObservability(service: ObservedService, refreshKey: () => string, windowKey: () => string, windowAt: () => TimeWindow) {
  const base = observeBase(service);
  const read: ObserveRead = (path, signal, decode) => readFrom(base, path, signal, decode);
  const [modals, setModals] = createSignal<readonly ModalView[]>(parseModal(readParam("modal")));
  const [health, setHealth] = createSignal<ObserveHealth | null>(null);
  const [traces, setTraces] = createSignal<Page<TraceSummary> | null>(null);
  const [exploration, setExploration] = createSignal<Exploration | null>(null);
  const [band, setBand] = createSignal<Band | null>(parseBand(readParam("band")));
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

  createEffect(() => ({ tick: refreshKey(), state: issueState(), introduced: introducedIn(), mutation: mutation() }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void Promise.all([
      read("/health", controller.signal, decodeHealth),
      read(`/issues?${new URLSearchParams({ state: query.state, limit: "100", ...(query.introduced === null ? {} : { introducedIn: query.introduced }) })}`, controller.signal, decodeIssues)
    ]).then(([nextHealth, nextIssues]) => {
      if (controller.signal.aborted) return;
      setHealth(nextHealth);
      setIssues(nextIssues);
      setError(null);
      if (issueId() === null || !nextIssues.items.some(issue => issue.fingerprint === issueId())) selectIssue(nextIssues.items[0]?.fingerprint ?? null, false);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(message(cause, "The observability collector is unavailable")); });
  });

  createEffect(() => ({ tick: refreshKey(), window: windowKey(), filter: traceFilter(), route: route(), band: bandParam(band()) }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const { fromMs, toMs } = windowAt();
    const span = { from: String(Math.round(fromMs)), to: String(Math.round(toMs)) };
    void read(`/explore?${new URLSearchParams({ ...span, ...(query.route === null ? {} : { route: query.route }) })}`, controller.signal, decodeExploration).then(async nextExploration => {
      const current = parseBand(query.band);
      const routeStats = nextExploration.routes.find(item => item.label === nextExploration.route);
      const traceQuery = new URLSearchParams({ limit: "100", ...span });
      if (query.filter === "failed") traceQuery.set("failed", "true");
      if (nextExploration.route !== null) traceQuery.set("label", nextExploration.route);
      if (current !== null) traceQuery.set("order", "slowest");
      if (current?.kind === "slow" && routeStats !== undefined) traceQuery.set("minWall", String(routeStats.p95WallMs));
      if (current?.kind === "cell") {
        traceQuery.set("from", String(current.fromMs));
        traceQuery.set("to", String(current.toMs));
        traceQuery.set("minWall", String(current.minWallMs));
        if (current.maxWallMs !== null) traceQuery.set("maxWall", String(current.maxWallMs));
      }
      const nextTraces = await read(`/traces?${traceQuery}`, controller.signal, decodeTraces);
      if (controller.signal.aborted) return;
      setExploration(nextExploration);
      setTraces(nextTraces);
      setError(null);
      if (traceId() === null || current !== null) {
        const first = nextTraces.items.find(item => item.traceId !== null)?.traceId ?? null;
        if (traceId() === null || !nextTraces.items.some(item => item.traceId === traceId())) selectTrace(first, false);
      }
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
      if (!value.invocations.some(invocation => invocation.key === slice())) setSlice(defaultSlice(value));
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
  const filterRoute = (value: string | null) => { setRoute(value); writeParam("route", value); chooseBand(null); };
  const chooseBand = (value: Band | null) => { setBand(value); writeParam("band", bandParam(value)); };
  const filterIssues = (value: IssueState) => { setIssueState(value); writeParam("issues", value === "open" ? null : value); selectIssue(null, false); };
  const filterIntroduced = (value: string | null) => { setIntroducedIn(value); writeParam("introduced", value); selectIssue(null, false); };
  const showModals = (next: readonly ModalView[]) => {
    setModals(next);
    writeParam("modal", modalParam(next.at(-1)));
  };
  const openModal = (view: ModalView) => showModals([...modals(), view]);
  const backModal = () => showModals(modals().slice(0, -1));
  const closeModals = () => showModals([]);
  const openIssue = (fingerprint: string) => openModal({ kind: "issue", fingerprint });
  const openTrace = (traceId: string) => openModal({ kind: "trace", traceId });
  const openDeployment = (id: string, label: string) => openModal({ kind: "deployment", id, label });
  const [resolving, setResolving] = createSignal(false);
  const changeState = async (fingerprint: string, state: IssueState) => {
    setResolving(true);
    try {
      const response = await fetch(`${base}/issues/${fingerprint}/state`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
      if (!response.ok) throw new ApiFailure(response.status, `Could not mark the issue ${state} (${response.status})`);
      setMutation(value => value + 1);
    } catch (cause) {
      setError(message(cause, "Could not change the issue"));
    } finally {
      setResolving(false);
    }
  };

  return { read, modals, backModal, closeModals, openDeployment, mutation, health, traces, exploration, band, chooseBand, issues, error, traceFilter, filterTraces, route, filterRoute, issueState, filterIssues, introducedIn, filterIntroduced, traceId, selectTrace, issueId, selectIssue, openIssue, slice, setSlice, trace, traceError, occurrences, openTrace, changeState, resolving };
}

export type Observability = ReturnType<typeof createObservability>;

export function versionName(version: string, label: string | null): string {
  return label ?? (version.length > 12 ? version.slice(0, 8) : version);
}

export function HealthMeta(props: { readonly health: ObserveHealth | null }): JSX.Element {
  const { now } = useTelemetry();
  return (
    <Show when={props.health}>{health => (
      <span class="observe-health" title={`${count(health().liveInvocations)} invocations retained · ${bytes(health().databaseBytes)} on disk · cleanup lag ${duration(health().cleanupLagMs)}`}>
        <span class={`status-dot ${health().newestAtMs !== null && now() - health().newestAtMs! < 10 * 60_000 ? "tone-ok" : "tone-warn"}`} />
        <span class="observe-health-text">{health().newestAtMs === null ? "nothing received yet" : `last event ${age(health().newestAtMs, now())}`}</span>
      </span>
    )}</Show>
  );
}

export function IssueDetail(props: { readonly issue: IssueSummary; readonly occurrences: Page<Occurrence> | null; readonly observe: Observability }): JSX.Element {
  const { now } = useTelemetry();
  const o = props.observe;
  const issue = () => props.issue;
  const representative = () => props.occurrences?.items[0] ?? null;
  return (
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
            <For each={props.occurrences?.items ?? []}>{occurrence => (
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
  );
}

export function IssuesWidget(props: { readonly observe: Observability }): JSX.Element {
  const { now } = useTelemetry();
  const o = props.observe;
  const items = () => o.issues()?.items ?? [];
  const current = createMemo(() => items().find(issue => issue.fingerprint === o.issueId()) ?? null);
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
              <Show when={current()}>{issue => <IssueDetail issue={issue()} occurrences={o.occurrences()} observe={o} />}</Show>
            </div>
          </div>
        </Show>
      </Show>
    </Widget>
  );
}

export function RouteLabel(props: { readonly label: string }): JSX.Element {
  const parts = () => {
    const match = /^([A-Z]+) (\/.*)$/u.exec(props.label);
    return match === null ? { method: null, path: props.label } : { method: match[1]!, path: match[2]! };
  };
  return (
    <b class="route-label">
      <Show when={parts().method}>{method => <span class="route-method">{method()}</span>}</Show>
      <For each={parts().path.split("/")}>{(segment, index) => <>{index() > 0 ? <>/<wbr /></> : null}{segment}</>}</For>
    </b>
  );
}

function cpuValue(ms: number): string {
  return duration(ms).replace(/ ms$/u, "");
}

function cpuChange(shift: RouteShift): JSX.Element {
  if (shift.cpuChangeMs === null) return <>—</>;
  const change = shift.cpuChangeMs;
  const text = Math.abs(change) < 0.005 ? "0 ms" : `${change > 0 ? "+" : "−"}${duration(Math.abs(change))}`;
  const tone = !shift.exceedsTwoStdErr ? undefined : change > 0 ? "impact-cpu-worse" : "impact-cpu-better";
  return <><b class={tone}>{text}</b><span class="impact-cpu-note cell-note">± {shift.twoStdErrMs === null ? "?" : duration(shift.twoStdErrMs)}</span></>;
}

const IMPACT_CPU_ROWS = 8;

function ImpactCpu(props: { readonly impact: RolloutImpact }): JSX.Element {
  const shifts = () => props.impact.routes.map(route => routeShift(route, props.impact.introduced)).filter(shift => shift.before !== null && shift.after !== null);
  const shown = () => [...shifts()].sort((a, b) => Number(b.exceedsTwoStdErr) - Number(a.exceedsTwoStdErr)).slice(0, IMPACT_CPU_ROWS);
  return (
    <Show when={shifts().length > 0}>
      <h3 class="observe-subhead impact-cpu-head">CPU by route</h3>
      <div class="table-scroll" role="region" aria-label="CPU by route">
        <table class="data-table compact impact-cpu">
          <thead>
            <tr>
              <th>Route</th>
              <th class="numeric impact-cpu-value">CPU per call</th>
              <th class="numeric impact-cpu-change">Change</th>
            </tr>
          </thead>
          <tbody>
            <For each={shown()}>{shift => (
              <tr>
                <td><Show when={shift.stage === "object"}><span class="op-tag">object</span> </Show><RouteLabel label={shift.label} /><span class="impact-cpu-note cell-note">{count(shift.before!.requests)} → {count(shift.after!.requests)} calls</span></td>
                <td class="numeric">{cpuValue(shift.before!.cpuMeanMs)} → <b>{duration(shift.after!.cpuMeanMs)}</b></td>
                <td class="numeric">{cpuChange(shift)}</td>
              </tr>
            )}</For>
          </tbody>
        </table>
      </div>
      <p class="observe-footnote">Mean CPU from every stored invocation, recorded in whole milliseconds. A change is colored only when it exceeds twice its combined standard error.{shifts().length > shown().length ? ` ${shown().length} of ${shifts().length} routes, changes beyond that first; pnpm observe deployment lists all.` : ""}</p>
    </Show>
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
    void props.observe.read(`/rollouts/${query.id}/impact`, controller.signal, value => decodeImpact(value, query.id)).then(value => {
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
              <ImpactCpu impact={value()} />
            </Show>
          </>
        );
      }}</Show>
    </section>
  );
}

function IssueModalBody(props: { readonly fingerprint: string; readonly observe: Observability }): JSX.Element {
  const [issue, setIssue] = createSignal<IssueSummary | null>(null);
  const [occurrences, setOccurrences] = createSignal<Page<Occurrence> | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  createEffect(() => ({ id: props.fingerprint, mutation: props.observe.mutation() }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void Promise.all([props.observe.read(`/issues/${query.id}`, controller.signal, decodeIssue), props.observe.read(`/issues/${query.id}/occurrences?limit=100`, controller.signal, decodeOccurrences)]).then(([nextIssue, nextOccurrences]) => {
      if (controller.signal.aborted) return;
      setIssue(nextIssue);
      setOccurrences(nextOccurrences);
      setFailure(null);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setFailure(message(cause, "Issue unavailable")); });
  });
  return (
    <>
      <Show when={failure()}>{text => <div class="notice notice-warn" role="alert"><span>{text()}</span></div>}</Show>
      <Show when={issue()} fallback={failure() === null ? <Skeleton rows={6} /> : null}>{value => <IssueDetail issue={value()} occurrences={occurrences()} observe={props.observe} />}</Show>
    </>
  );
}

function TraceModalBody(props: { readonly traceId: string; readonly read: ObserveRead }): JSX.Element {
  const [detail, setDetail] = createSignal<TraceDetail | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [slice, setSlice] = createSignal<string | null>(null);
  createEffect(() => props.traceId, id => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void props.read(`/traces/${id}`, controller.signal, value => decodeTrace(value, id)).then(value => {
      if (controller.signal.aborted) return;
      setDetail(value);
      setFailure(null);
      setSlice(defaultSlice(value));
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setFailure(message(cause, "Trace unavailable")); });
  });
  return (
    <>
      <Show when={failure()}>{text => <div class="notice notice-warn" role="alert"><span>{text()}</span></div>}</Show>
      <Show when={detail()} fallback={failure() === null ? <Skeleton rows={6} /> : null}>{value => <TraceView detail={value()} selected={slice()} onSelect={setSlice} />}</Show>
    </>
  );
}

function modalTitle(view: ModalView): string {
  return view.kind === "issue" ? "Issue" : view.kind === "trace" ? "Trace" : view.label;
}

export function ObserveModal(props: { readonly observe: Observability; readonly refreshKey: string }): JSX.Element {
  const o = props.observe;
  const top = () => o.modals().at(-1);
  const previous = () => o.modals().at(-2);
  return (
    <Show when={top()} keyed>{view => (
      <Modal
        title={modalTitle(view)}
        label={modalTitle(view)}
        onClose={o.closeModals}
        onBack={previous() === undefined ? undefined : o.backModal}
        backLabel={previous() === undefined ? undefined : modalTitle(previous()!)}
      >
        {view.kind === "issue" ? <IssueModalBody fingerprint={view.fingerprint} observe={o} />
          : view.kind === "trace" ? <TraceModalBody traceId={view.traceId} read={o.read} />
          : <RolloutImpactPanel deploymentId={view.id} refreshKey={props.refreshKey} observe={o} />}
      </Modal>
    )}</Show>
  );
}
