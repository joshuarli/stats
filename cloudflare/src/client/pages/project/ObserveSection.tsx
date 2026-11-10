import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { age, count } from "../../format";
import { useTelemetry } from "../../state";
import { createPagedList, Segmented, ShowMore, Widget } from "../../components/ui";
import { compareSortValues, createSort, SortHeader } from "../../components/sort";
import { decodeImpact, decodeIssue, decodeOccurrences, decodeTrace } from "../../../observe/client/decode";
import { Modal, Skeleton } from "@laputa-systems/ui-dashboard";
import { Info, Term } from "../../components/Info";
import type { IssueRef, IssueSummary, Occurrence, Page, RolloutImpact, TraceDetail, VersionStats } from "../../../observe/core/store";
import { routeShift, type RouteShift } from "../../../observe/client/impact";
import { ErrorFrames, TraceView } from "./TraceTimeline";
import { defaultSlice, duration, keyedError, keyedValue, message, MOMENT, RouteLabel, versionName, type KeyedResult, type ModalView, type Observability, type ObserveRead } from "./Observe";

const ISSUE_PAGE = 12;
const OCCURRENCE_PAGE = 10;

function IssueDetail(props: { readonly issue: IssueSummary; readonly occurrences: Page<Occurrence> | null; readonly occurrencesError: string | null; readonly observe: Observability }): JSX.Element {
  const { now } = useTelemetry();
  const o = props.observe;
  const issue = () => props.issue;
  const representative = () => props.occurrences?.items[0] ?? null;
  const { sort, sortBy } = createSort<"none" | "when" | "version" | "source">({ key: "none", direction: 1 });
  const occurrenceItems = createMemo(() => {
    const items = props.occurrences?.items ?? [];
    const key = sort().key;
    if (key === "none") return items;
    const direction = sort().direction;
    return [...items].sort((left, right) => {
      const leftValue = key === "when" ? left.atMs : key === "version" ? (left.version ?? "") : left.source;
      const rightValue = key === "when" ? right.atMs : key === "version" ? (right.version ?? "") : right.source;
      return compareSortValues(leftValue, rightValue) * direction || left.atMs - right.atMs;
    });
  });
  const occurrences = createPagedList(occurrenceItems, OCCURRENCE_PAGE);
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
        <div><dt><Term hint="The earliest retained occurrence. Retention is 7 days, so this is not proof the issue never happened earlier.">First seen</Term></dt><dd>{age(issue().firstAtMs, now())}</dd></div>
        <div><dt>Last seen</dt><dd>{age(issue().lastAtMs, now())}</dd></div>
        <div><dt><Term hint="The version of the earliest retained occurrence. Unknown when that occurrence recorded no version.">Introduced in</Term></dt><dd title={issue().firstVersion ?? undefined}>{issue().firstVersion === null ? "unknown" : versionName(issue().firstVersion!, issue().firstVersionLabel)}<span class="issue-fact-note">{count(issue().versions)} {issue().versions === 1 ? "version" : "versions"}</span></dd></div>
      </dl>
      <Show when={props.occurrencesError}>{text => <div class="notice notice-warn" role="status"><span>{text()}</span></div>}</Show>
      <Show when={representative()} fallback={props.occurrencesError === null ? <Skeleton rows={4} /> : null}>{occurrence => <ErrorFrames occurrence={occurrence()} />}</Show>
      <h3 class="observe-subhead">Occurrences</h3>
      <div class="table-scroll" role="region" aria-label="Occurrences">
        <table class="data-table compact occurrence-table">
          <thead><tr>
            <SortHeader label="When" sortKey="when" sort={sort()} onSort={sortBy} />
            <SortHeader label="Version" sortKey="version" sort={sort()} onSort={sortBy} />
            <SortHeader label="Source" sortKey="source" sort={sort()} onSort={sortBy} />
            <th class="numeric">Trace</th>
          </tr></thead>
          <tbody>
            <For each={occurrences.visible()}>{occurrence => (
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
      <ShowMore hidden={occurrences.hidden()} noun="occurrences" onMore={occurrences.more} />
    </>
  );
}

export function IssuesWidget(props: { readonly observe: Observability }): JSX.Element {
  const { now } = useTelemetry();
  const o = props.observe;
  const items = () => o.issues()?.items ?? [];
  const paged = createPagedList(items, ISSUE_PAGE);
  createEffect(() => items().findIndex(issue => issue.fingerprint === o.issueId()), index => { if (index >= 0) paged.reveal(index); });
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
    const row = items().indexOf(next);
    paged.reveal(row);
    const rows = event.currentTarget;
    requestAnimationFrame(() => rows.querySelectorAll<HTMLButtonElement>(".issue-item")[row]?.focus());
  };
  return (
    <Widget id="issues" class="wide observe" title="Errors" meta={<span>{o.issues() === null ? "" : `${count(items().length)} ${o.issueState()} · last 7 days`}</span>} expandable>
      <div class="observe-toolbar">
        <Segmented label="Issue state" value={o.issueState()} options={[["open", "Open"], ["resolved", "Resolved"]]} onChange={o.filterIssues} />
        <label class="observe-select">
          <span class="ui-sr-only">Introduced in</span>
          <select value={o.introducedIn() ?? ""} onChange={event => o.filterIntroduced(event.currentTarget.value === "" ? null : event.currentTarget.value)}>
            <option value="">Any version</option>
            <For each={introducedVersions()}>{([version, label]) => <option value={version}>Introduced in {label}</option>}</For>
          </select>
        </label>
      </div>
      <Show when={o.issuesError() ?? o.mutationError()}>{text => <div class="notice notice-warn" role="status"><span>{text()}</span></div>}</Show>
      <Show when={o.issues() !== null} fallback={o.issuesError() === null ? <Skeleton rows={5} /> : null}>
        <Show when={items().length > 0} fallback={<p class="panel-label observe-empty">{o.issueState() === "open" ? "No open issues in the last 7 days." : "No resolved issues with occurrences in the last 7 days."}</p>}>
          <div class="issue-layout">
            <div class="issue-list" role="listbox" tabindex="-1" aria-label="Issues" onKeyDown={moveSelection}>
              <For each={paged.visible()}>{issue => (
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
              <ShowMore hidden={paged.hidden()} noun="issues" onMore={paged.more} />
            </div>
            <div class="issue-detail">
              <Show when={current()}>{issue => <IssueDetail issue={issue()} occurrences={o.occurrences()} occurrencesError={o.occurrencesError()} observe={o} />}</Show>
            </div>
          </div>
        </Show>
      </Show>
    </Widget>
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
  const { sort, sortBy } = createSort<"significance" | "route" | "cpu" | "change">({ key: "significance", direction: 1 });
  const shifts = () => props.impact.routes.map(route => routeShift(route, props.impact.introduced)).filter(shift => shift.before !== null && shift.after !== null);
  const shown = () => {
    const all = [...shifts()];
    const key = sort().key;
    const direction = sort().direction;
    const sorted = key === "significance"
      ? all.sort((a, b) => Number(b.exceedsTwoStdErr) - Number(a.exceedsTwoStdErr))
      : all.sort((a, b) => {
        const leftValue = key === "route" ? a.label : key === "cpu" ? a.after!.cpuMeanMs : a.cpuChangeMs ?? null;
        const rightValue = key === "route" ? b.label : key === "cpu" ? b.after!.cpuMeanMs : b.cpuChangeMs ?? null;
        if (leftValue === null || rightValue === null) {
          if (leftValue === null && rightValue === null) return a.label.localeCompare(b.label);
          return leftValue === null ? 1 : -1;
        }
        return compareSortValues(leftValue, rightValue) * direction || a.label.localeCompare(b.label);
      });
    return sorted.slice(0, IMPACT_CPU_ROWS);
  };
  return (
    <Show when={shifts().length > 0}>
      <h3 class="observe-subhead impact-cpu-head">CPU by route <Info title="CPU by route">Mean CPU from every stored invocation, recorded in whole milliseconds. A change is colored only when it exceeds twice its combined standard error. The pnpm observe deployment command lists every route.</Info></h3>
      <div class="table-scroll" role="region" aria-label="CPU by route">
        <table class="data-table compact impact-cpu">
          <thead>
            <tr>
              <SortHeader label="Route" sortKey="route" sort={sort()} onSort={sortBy} />
              <SortHeader label="CPU per call" sortKey="cpu" sort={sort()} onSort={sortBy} class="numeric impact-cpu-value" />
              <SortHeader label="Change" sortKey="change" sort={sort()} onSort={sortBy} class="numeric impact-cpu-change" />
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
      <Show when={shifts().length > shown().length}><p class="observe-footnote">Showing {shown().length} of {shifts().length} routes{sort().key === "significance" ? "; significant changes first" : ""}.</p></Show>
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

function IssueLinks(props: { readonly title: string; readonly hint: string; readonly issues: readonly IssueRef[]; readonly onOpen: (fingerprint: string) => void }): JSX.Element {
  return (
    <Show when={props.issues.length > 0}>
      <div class="impact-issues">
        <span class="impact-issues-title"><Term hint={props.hint}>{props.title}</Term></span>
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
  const [result, setResult] = createSignal<KeyedResult<RolloutImpact> | null>(null);
  const impact = () => keyedValue(result(), props.deploymentId);
  const error = () => keyedError(result(), props.deploymentId);
  createEffect(() => ({ id: props.deploymentId, tick: props.refreshKey }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void props.observe.read(`/rollouts/${query.id}/impact`, controller.signal, value => decodeImpact(value, query.id)).then(value => {
      if (controller.signal.aborted) return;
      setResult({ kind: "ok", key: query.id, value });
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setResult({ kind: "error", key: query.id, message: message(cause, "Deployment errors unavailable") });
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
                <Term hint={`${count(before().requests)} requests on earlier versions and ${count(after().requests)} on versions this deployment introduced. Compared with ${baseline(value().baselineMs)} of earlier data.`}>Failed requests</Term> {before().text} → <b>{after().text}</b>
              </p>
              <IssueLinks title="New" hint="An issue counts as new when every retained occurrence ran on a version this deployment introduced. That says where it appeared, not that the deployment caused it." issues={value().newIssues} onOpen={props.observe.openIssue} />
              <IssueLinks title="Regressed" hint="An issue that was resolved before this deployment and has occurred again since, on a version it introduced." issues={value().regressions} onOpen={props.observe.openIssue} />
              <ImpactCpu impact={value()} />
            </Show>
          </>
        );
      }}</Show>
    </section>
  );
}

function IssueModalBody(props: { readonly fingerprint: string; readonly observe: Observability }): JSX.Element {
  const [issueResult, setIssueResult] = createSignal<KeyedResult<IssueSummary> | null>(null);
  const [occurrencesResult, setOccurrencesResult] = createSignal<KeyedResult<Page<Occurrence>> | null>(null);
  const issue = () => keyedValue(issueResult(), props.fingerprint);
  const failure = () => keyedError(issueResult(), props.fingerprint);
  const occurrences = () => keyedValue(occurrencesResult(), props.fingerprint);
  const occurrencesError = () => keyedError(occurrencesResult(), props.fingerprint);
  createEffect(() => ({ id: props.fingerprint, mutation: props.observe.mutation() }), query => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void props.observe.read(`/issues/${query.id}`, controller.signal, decodeIssue).then(value => {
      if (!controller.signal.aborted) setIssueResult({ kind: "ok", key: query.id, value });
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setIssueResult({ kind: "error", key: query.id, message: message(cause, "Issue unavailable") }); });
    void props.observe.read(`/issues/${query.id}/occurrences?limit=100`, controller.signal, decodeOccurrences).then(value => {
      if (!controller.signal.aborted) setOccurrencesResult({ kind: "ok", key: query.id, value });
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setOccurrencesResult({ kind: "error", key: query.id, message: message(cause, "Occurrences unavailable") }); });
  });
  return (
    <>
      <Show when={failure()}>{text => <div class="notice notice-warn" role="alert"><span>{text()}</span></div>}</Show>
      <Show when={issue()} fallback={failure() === null ? <Skeleton rows={6} /> : null}>{value => <IssueDetail issue={value()} occurrences={occurrences()} occurrencesError={occurrencesError()} observe={props.observe} />}</Show>
    </>
  );
}

function TraceModalBody(props: { readonly traceId: string; readonly read: ObserveRead }): JSX.Element {
  const [result, setResult] = createSignal<KeyedResult<TraceDetail> | null>(null);
  const [slice, setSlice] = createSignal<string | null>(null);
  const detail = () => keyedValue(result(), props.traceId);
  const failure = () => keyedError(result(), props.traceId);
  createEffect(() => props.traceId, id => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void props.read(`/traces/${id}`, controller.signal, value => decodeTrace(value, id)).then(value => {
      if (controller.signal.aborted) return;
      setResult({ kind: "ok", key: id, value });
      setSlice(defaultSlice(value));
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setResult({ kind: "error", key: id, message: message(cause, "Trace unavailable") }); });
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
