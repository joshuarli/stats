import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ApiFailure } from "../../api";
import { age, bytes, count } from "../../format";
import { useTelemetry } from "../../state";
import { readParam, writeParam } from "../../urlState";
import { decodeExploration, decodeHealth, decodeIssues, decodeOccurrences, decodeTrace, decodeTraces, type ObserveHealth } from "../../../observe/client/decode";
import { Term } from "../../components/Info";
import type { Exploration, IssueState, IssueSummary, Occurrence, Page, TraceDetail, TraceSummary } from "../../../observe/core/store";
import type { TimeWindow } from "../../chart-data";
import { VERSION } from "../../../observe/core/model";
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

export type KeyedResult<T> =
  | { readonly kind: "ok"; readonly key: string; readonly value: T }
  | { readonly kind: "error"; readonly key: string; readonly message: string };

export function keyedValue<T>(result: KeyedResult<T> | null, key: string | null): T | null {
  return key !== null && result?.kind === "ok" && result.key === key ? result.value : null;
}

export function keyedError<T>(result: KeyedResult<T> | null, key: string | null): string | null {
  return key !== null && result?.kind === "error" && result.key === key ? result.message : null;
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

export function createObservability(
  service: ObservedService,
  refreshKey: () => string,
  windowKey: () => string,
  windowAt: () => TimeWindow,
  exploring: () => boolean,
  errorsOpen: () => boolean = () => true
) {
  const base = observeBase(service);
  const read: ObserveRead = (path, signal, decode) => readFrom(base, path, signal, decode);
  const [modals, setModals] = createSignal<readonly ModalView[]>(parseModal(readParam("modal")));
  const [health, setHealth] = createSignal<ObserveHealth | null>(null);
  const [band, setBand] = createSignal<Band | null>(parseBand(readParam("band")));
  const [issueResult, setIssueResult] = createSignal<KeyedResult<Page<IssueSummary>> | null>(null);
  const [exploreResult, setExploreResult] = createSignal<KeyedResult<{ readonly exploration: Exploration; readonly traces: Page<TraceSummary> }> | null>(null);
  const [traceResult, setTraceResult] = createSignal<KeyedResult<TraceDetail> | null>(null);
  const [occurrencesResult, setOccurrencesResult] = createSignal<KeyedResult<Page<Occurrence>> | null>(null);
  const [mutationError, setMutationError] = createSignal<string | null>(null);
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
  const [mutation, setMutation] = createSignal(0);
  const issueKey = () => `${issueState()}:${introducedIn() ?? ""}`;
  const exploreKey = () => `${windowKey()}|${traceFilter()}|${route() ?? ""}|${bandParam(band()) ?? ""}`;
  const issues = createMemo(() => keyedValue(issueResult(), issueKey()));
  const issuesError = createMemo(() => keyedError(issueResult(), issueKey()));
  const exploration = createMemo(() => keyedValue(exploreResult(), exploreKey())?.exploration ?? null);
  const traces = createMemo(() => keyedValue(exploreResult(), exploreKey())?.traces ?? null);
  const exploreError = createMemo(() => keyedError(exploreResult(), exploreKey()));
  const trace = createMemo(() => keyedValue(traceResult(), traceId()));
  const traceError = createMemo(() => keyedError(traceResult(), traceId()));
  const occurrences = createMemo(() => keyedValue(occurrencesResult(), issueId()));
  const occurrencesError = createMemo(() => keyedError(occurrencesResult(), issueId()));

  createEffect(() => ({ key: issueKey(), tick: refreshKey(), state: issueState(), introduced: introducedIn(), mutation: mutation() }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void Promise.all([
      read("/health", controller.signal, decodeHealth),
      read(`/issues?${new URLSearchParams({ state: query.state, limit: "100", ...(query.introduced === null ? {} : { introducedIn: query.introduced }) })}`, controller.signal, decodeIssues)
    ]).then(([nextHealth, nextIssues]) => {
      if (controller.signal.aborted) return;
      setHealth(nextHealth);
      setIssueResult({ kind: "ok", key: query.key, value: nextIssues });
      if (issueId() === null || !nextIssues.items.some(issue => issue.fingerprint === issueId())) selectIssue(nextIssues.items[0]?.fingerprint ?? null, false);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setIssueResult({ kind: "error", key: query.key, message: message(cause, "The observability collector is unavailable") }); });
  });

  createEffect(() => ({ key: exploreKey(), tick: refreshKey(), window: windowKey(), filter: traceFilter(), route: route(), band: bandParam(band()), active: exploring() }), query => {
    if (!query.active) return;
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
      setExploreResult({ kind: "ok", key: query.key, value: { exploration: nextExploration, traces: nextTraces } });
      if (traceId() === null || current !== null || readParam("trace") === null) {
        const first = nextTraces.items.find(item => item.traceId !== null)?.traceId ?? null;
        if (traceId() === null || !nextTraces.items.some(item => item.traceId === traceId())) selectTrace(first, false);
      }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setExploreResult({ kind: "error", key: query.key, message: message(cause, "The observability collector is unavailable") }); });
  });

  createEffect(() => ({ id: traceId(), tick: refreshKey() }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    if (query.id === null) { setTraceResult(null); return; }
    const id = query.id;
    void read(`/traces/${id}`, controller.signal, value => decodeTrace(value, id)).then(value => {
      if (controller.signal.aborted) return;
      setTraceResult({ kind: "ok", key: id, value });
      if (!value.invocations.some(invocation => invocation.key === slice())) setSlice(defaultSlice(value));
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setTraceResult({ kind: "error", key: id, message: message(cause, "Trace unavailable") });
    });
  });

  createEffect(() => ({ id: issueId(), tick: refreshKey(), mutation: mutation(), active: errorsOpen() }), query => {
    if (!query.active) return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    if (query.id === null) { setOccurrencesResult(null); return; }
    const id = query.id;
    void read(`/issues/${id}/occurrences?limit=100`, controller.signal, decodeOccurrences).then(value => {
      if (controller.signal.aborted) return;
      setOccurrencesResult({ kind: "ok", key: id, value });
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setOccurrencesResult({ kind: "error", key: id, message: message(cause, "Occurrences unavailable") }); });
  });

  function selectTrace(id: string | null, remember = true): void {
    if (id !== traceId()) setSlice(null);
    setTraceId(id);
    if (remember) writeParam("trace", id);
  }
  function selectIssue(id: string | null, remember = true): void {
    if (id !== issueId()) setMutationError(null);
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
    setMutationError(null);
    try {
      const response = await fetch(`${base}/issues/${fingerprint}/state`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
      if (!response.ok) throw new ApiFailure(response.status, `Could not mark the issue ${state} (${response.status})`);
      setMutation(value => value + 1);
    } catch (cause) {
      setMutationError(message(cause, "Could not change the issue"));
    } finally {
      setResolving(false);
    }
  };

  return { read, modals, backModal, closeModals, openDeployment, mutation, health, traces, exploration, band, chooseBand, issues, issuesError, exploreError, occurrencesError, mutationError, traceFilter, filterTraces, route, filterRoute, issueState, filterIssues, introducedIn, filterIntroduced, traceId, selectTrace, issueId, selectIssue, openIssue, slice, setSlice, trace, traceError, occurrences, openTrace, changeState, resolving };
}

export type Observability = ReturnType<typeof createObservability>;

export function versionName(version: string, label: string | null): string {
  return label ?? (version.length > 12 ? version.slice(0, 8) : version);
}

export function HealthMeta(props: { readonly health: ObserveHealth | null }): JSX.Element {
  const { now } = useTelemetry();
  return (
    <Show when={props.health}>{health => (
      <span class="observe-health">
        <span class={`status-dot ${health().newestAtMs !== null && now() - health().newestAtMs! < 10 * 60_000 ? "tone-ok" : "tone-warn"}`} />
        <span class="observe-health-text"><Term hint={`${count(health().liveInvocations)} invocations retained · ${bytes(health().databaseBytes)} on disk · cleanup lag ${duration(health().cleanupLagMs)}`}>{health().newestAtMs === null ? "nothing received yet" : `last event ${age(health().newestAtMs, now())}`}</Term></span>
      </span>
    )}</Show>
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

export function duration(ms: number): string {
  if (ms < 1) return ms === 0 ? "0 ms" : `${ms.toFixed(ms < 0.1 ? 2 : 1)} ms`;
  if (ms < 1000) return `${Math.round(ms * 10) / 10} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function defaultSlice(detail: TraceDetail): string | null {
  const failing = detail.invocations.find(invocation => detail.occurrences.some(occurrence => occurrence.invocationKey === invocation.key));
  return failing?.key ?? detail.invocations.find(invocation => invocation.stage === "worker")?.key ?? detail.invocations[0]?.key ?? null;
}
