import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { prepareInvocation, prepareRollout, type MessagePolicy, type ObservedError, type ObservedInvocation, type Preparation } from "../../src/observe/core/model.ts";
import { cleanup, health, ingest, initializeStore, issueOccurrences, listIssues, listTraces, nextCleanupAt, readTrace, recordRollouts, rolloutImpact, setIssueState, type SqlDatabase } from "../../src/observe/core/store.ts";
import { MAX_ISSUES, MAX_RETAINED_INVOCATIONS, RETENTION_MS } from "../../src/observe/core/limits.ts";
import { BUNDLE_STACK, D, DO_STACK, H, T0, database, object, synthetic, traceId, worker, wrap } from "./support.ts";

const POLICY: MessagePolicy = { safeNames: new Set() };
const NOW = T0 + 1000;

async function prepare(...invocations: ObservedInvocation[]): Promise<Preparation[]> {
  return Promise.all(invocations.map(invocation => prepareInvocation(invocation, POLICY)));
}

const uncaught: ObservedError = { source: "uncaught", operation: null, name: "TypeError", message: "cause b", stack: DO_STACK };
const propagated: ObservedError = { ...uncaught, stack: null };
const caught: ObservedError = { source: "caught", operation: "ingest.store", name: "AppError", message: "cause a", stack: BUNDLE_STACK };

function counts(db: SqlDatabase): { invocations: number; occurrences: number; issues: number } {
  const n = (table: string): number => db.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n;
  return { invocations: n("observe_invocations"), occurrences: n("observe_occurrences"), issues: n("observe_issues") };
}

await test("replaying an envelope many times stores one invocation and one occurrence", async () => {
  const db = database();
  const batch = await prepare(worker(1, { status: 500, errors: [caught] }));
  assert.equal(ingest(db, batch, NOW).accepted, 1);
  for (let i = 0; i < 5; i++) assert.deepEqual(ingest(db, batch, NOW + i * H), { accepted: 0, duplicate: 1, conflict: 0, expired: 0, future: 0, rejected: 0, issueCapacity: 0 });
  assert.deepEqual(counts(db), { invocations: 1, occurrences: 1, issues: 1 });
  assert.equal(listIssues(db, NOW + 6 * H).items[0]!.occurrences, 1);
  assert.equal(health(db, NOW + 6 * H).duplicate, 5);
});

await test("the same key with different content is a conflict and leaves the original", async () => {
  const db = database();
  ingest(db, await prepare(worker(1, { cpuMs: 2 })), NOW);
  assert.equal(ingest(db, await prepare(worker(1, { cpuMs: 9 })), NOW).conflict, 1);
  assert.equal(listTraces(db, NOW).items[0]!.cpuMs, 2);
});

await test("a write failure mid-batch rolls back every row of the batch", async () => {
  const db = database();
  db.failOnRun = query => query.startsWith("INSERT INTO observe_issues");
  const batch = await prepare(worker(1), worker(2, { errors: [caught] }));
  assert.throws(() => ingest(db, batch, NOW), /injected write failure/u);
  db.failOnRun = null;
  assert.deepEqual(counts(db), { invocations: 0, occurrences: 0, issues: 0 });
  assert.equal(ingest(db, batch, NOW).accepted, 2);
});

await test("nothing older than the retention window is readable, even before cleanup", async () => {
  const db = database();
  ingest(db, await prepare(worker(1, { errors: [caught] }), object(1)), NOW);
  const fingerprint = listIssues(db, NOW).items[0]!.fingerprint;
  const edge = T0 + RETENTION_MS;
  const visible = (at: number) => ({
    traces: listTraces(db, at).items.length,
    trace: readTrace(db, at, traceId(1))?.invocations.length ?? 0,
    issues: listIssues(db, at).items.length,
    occurrences: issueOccurrences(db, at, fingerprint).items.length,
    live: health(db, at).liveInvocations,
    open: health(db, at).openIssues
  });
  assert.deepEqual(visible(edge - 1), { traces: 1, trace: 2, issues: 1, occurrences: 1, live: 2, open: 1 });
  assert.deepEqual(visible(edge), { traces: 0, trace: 1, issues: 0, occurrences: 0, live: 1, open: 0 });
  assert.deepEqual(visible(edge + 1), { traces: 0, trace: 0, issues: 0, occurrences: 0, live: 0, open: 0 });
  assert.equal(setIssueState(db, edge + 1, fingerprint, "resolved"), false);
  assert.equal(health(db, edge + 1).cleanupBacklog, 2);
  assert.equal(health(db, edge + H).cleanupLagMs, H);
});

await test("a replay after expiry cannot resurrect or extend an invocation", async () => {
  const db = database();
  const batch = await prepare(worker(1));
  ingest(db, batch, NOW);
  const later = T0 + RETENTION_MS + H;
  assert.equal(ingest(db, batch, later).expired, 1);
  cleanup(db, later);
  assert.equal(ingest(db, batch, later).expired, 1);
  assert.deepEqual(counts(db), { invocations: 0, occurrences: 0, issues: 0 });
});

await test("future-dated events are rejected, and slightly early ones count from receipt", async () => {
  const db = database();
  const result = ingest(db, await prepare(worker(1, { eventAtMs: NOW + 10 * 60_000 }), worker(2, { eventAtMs: NOW + 60_000 })), NOW);
  assert.equal(result.future, 1);
  assert.equal(result.accepted, 1);
  assert.equal(listTraces(db, NOW + RETENTION_MS - 1).items.length, 1);
  assert.equal(listTraces(db, NOW + RETENTION_MS).items.length, 0);
});

await test("an object's uncaught error seen by its caller counts once, in either arrival order", async () => {
  for (const order of ["caller-first", "object-first"] as const) {
    const db = database();
    const callerSide = worker(1, { status: 500, outcome: "exception", errors: [propagated] });
    const objectSide = object(1, { outcome: "exception", errors: [uncaught] });
    const batches = order === "caller-first" ? [callerSide, objectSide] : [objectSide, callerSide];
    for (const invocation of batches) ingest(db, await prepare(invocation), NOW);
    const issues = listIssues(db, NOW).items;
    assert.equal(issues.length, 1, order);
    assert.equal(issues[0]!.occurrences, 1, order);
    assert.equal(issues[0]!.frame, "failB (src/index.ts:15)", order);
    const trace = readTrace(db, NOW, traceId(1))!;
    assert.equal(trace.occurrences.length, 1, order);
    assert.equal(trace.rootPresent, true, order);
  }
});

await test("a resolved issue reopens on a new occurrence after resolution, not on a replay or a late one", async () => {
  const db = database();
  const first = await prepare(worker(1, { errors: [caught] }));
  ingest(db, first, NOW);
  const fingerprint = listIssues(db, NOW).items[0]!.fingerprint;
  assert.equal(setIssueState(db, NOW + H, fingerprint, "resolved"), true);
  ingest(db, first, NOW + 2 * H);
  ingest(db, await prepare(worker(2, { eventAtMs: NOW + H - 1, errors: [caught] })), NOW + 2 * H);
  assert.equal(listIssues(db, NOW + 2 * H).items[0]!.state, "resolved");
  ingest(db, await prepare(worker(3, { eventAtMs: NOW + 2 * H, errors: [caught] })), NOW + 2 * H);
  const issue = listIssues(db, NOW + 2 * H).items[0]!;
  assert.equal(issue.state, "open");
  assert.equal(issue.occurrences, 3);
  assert.equal(listIssues(db, NOW + 2 * H, { state: "resolved" }).items.length, 0);
});

await test("issue counts and first seen describe only retained occurrences", async () => {
  const db = database();
  ingest(db, await prepare(worker(1, { errors: [caught] })), NOW);
  ingest(db, await prepare(worker(2, { eventAtMs: T0 + 3 * D, errors: [caught] })), T0 + 3 * D);
  const at = T0 + RETENTION_MS + H;
  const issue = listIssues(db, at).items[0]!;
  assert.equal(issue.occurrences, 1);
  assert.equal(issue.firstAtMs, T0 + 3 * D);
});

await test("trace pages are deterministic across equal timestamps, and bad cursors fail", async () => {
  const db = database();
  ingest(db, await prepare(...Array.from({ length: 7 }, (_, n) => worker(n))), NOW);
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = listTraces(db, NOW, cursor === undefined ? { limit: 3 } : { limit: 3, cursor });
    seen.push(...page.items.map(item => item.key));
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  assert.throws(() => listTraces(db, NOW, { cursor: "1' OR 1=1" }), RangeError);
  assert.throws(() => listTraces(db, NOW, { limit: 0 }), RangeError);
  assert.throws(() => readTrace(db, NOW, "not-a-trace"), RangeError);
});

await test("trace filters select failed roots and summarize their object stages", async () => {
  const db = database();
  ingest(db, await prepare(worker(1), object(1, { cpuMs: 7 }), object(1, { cpuMs: 5, trace: { traceId: traceId(1), spanId: "00000000000000aa" } }), worker(2, { status: 503 })), NOW);
  const failed = listTraces(db, NOW, { failed: true }).items;
  assert.deepEqual(failed.map(trace => trace.traceId), [traceId(2)]);
  const ok = listTraces(db, NOW, { failed: false }).items[0]!;
  assert.equal(ok.objectInvocations, 2);
  assert.equal(ok.objectCpuMs, 12);
});

await test("a trace lists its root first, then object stages in time order", async () => {
  const db = database();
  ingest(db, await prepare(object(1, { eventAtMs: T0 + 5, trace: { traceId: traceId(1), spanId: "00000000000000b2" } }), object(1, { eventAtMs: T0 }), worker(1, { eventAtMs: T0 + 3 })), NOW);
  const trace = readTrace(db, NOW, traceId(1))!;
  assert.deepEqual(trace.invocations.map(invocation => [invocation.stage, invocation.atMs]), [["worker", T0 + 3], ["object", T0], ["object", T0 + 5]]);
});

await test("a trace whose root never arrived is marked incomplete", async () => {
  const db = database();
  ingest(db, await prepare(object(1)), NOW);
  assert.equal(readTrace(db, NOW, traceId(1))!.rootPresent, false);
  assert.equal(readTrace(db, NOW, traceId(9)), null);
});

await test("new issue groups beyond the cap are counted, and their occurrences stay on traces", async () => {
  const db = database();
  const errors = Array.from({ length: MAX_ISSUES + 1 }, (_, n): ObservedInvocation =>
    worker(n, { errors: [{ ...caught, stack: `    at fn${n} (index.js:1:1)` }] }));
  const result = ingest(db, await prepare(...errors), NOW);
  assert.equal(result.issueCapacity, 1);
  assert.equal(counts(db).issues, MAX_ISSUES);
  assert.equal(readTrace(db, NOW, traceId(MAX_ISSUES))!.occurrences.length, 1);
});

await test("over capacity, cleanup evicts the oldest successful invocations first and reports it", () => {
  const db = database();
  const batch: Preparation[] = [];
  for (let n = 0; n < MAX_RETAINED_INVOCATIONS + 10; n++) batch.push(synthetic(n, T0 + n, n < 5));
  ingest(db, batch, T0 + MAX_RETAINED_INVOCATIONS + 10);
  const cleaned = cleanup(db, T0 + MAX_RETAINED_INVOCATIONS + 10);
  assert.equal(cleaned.evicted, 10);
  assert.equal(counts(db).invocations, MAX_RETAINED_INVOCATIONS);
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_invocations WHERE failed = 1")[0]!.n, 5);
  assert.equal(health(db, T0 + MAX_RETAINED_INVOCATIONS + 10).evicted, 10);
});

await test("fourteen days at the measured volume reach a flat steady state", () => {
  const db = database();
  const perHour = Math.ceil(10_000 / 24);
  let n = 0;
  let alarmAt: number | null = null;
  const live: number[] = [];
  const pages: number[] = [];
  for (let hour = 0; hour < 14 * 24; hour++) {
    const start = T0 + hour * H;
    const batch: Preparation[] = [];
    for (let i = 0; i < perHour; i++) batch.push(synthetic(n++, start + Math.floor((i * H) / perHour), i % 50 === 0));
    for (const preparation of batch) ingest(db, [preparation], start + H - 1);
    const now = start + H;
    if (alarmAt === null || alarmAt <= now) {
      let cleaned = cleanup(db, now);
      while (cleaned.more) cleaned = cleanup(db, now);
      alarmAt = nextCleanupAt(db, now, cleaned);
    }
    if (hour % 24 === 23) {
      live.push(health(db, now).liveInvocations);
      pages.push(db.rows<{ page_count: number }>("PRAGMA page_count")[0]!.page_count);
    }
  }
  const steady = live.slice(7);
  assert.ok(steady.every(value => Math.abs(value - perHour * 24 * 7) <= perHour * 2), `live counts ${steady.join(",")}`);
  assert.ok(pages.at(-1)! <= pages[7]! * 1.05, `page counts ${pages.join(",")}`);
  const final = health(db, T0 + 14 * D);
  assert.ok(final.cleanupLagMs <= H, `cleanup lag ${final.cleanupLagMs}`);
});

const V1 = "v1-3172128e";
const V2 = "v2-2221f9c2";
const errorB: ObservedError = { ...caught, operation: "deployments.poll", stack: "    at pollB (index.js:9:1)" };
const errorC: ObservedError = { ...caught, operation: "collector.record", stack: "    at recordC (index.js:7:1)" };

async function rollout(id: string, atMs: number, shares: { version: string; percent: number }[]) {
  return prepareRollout({ id, atMs, source: "api", message: null, shares });
}

await test("rollouts are idempotent by id, and conflicting, malformed, or expired ones are counted", async () => {
  const db = database();
  const first = await rollout("r1", T0, [{ version: V1, percent: 100 }]);
  assert.deepEqual(recordRollouts(db, [first, first], [{ version: V1, label: "v1.0", message: null }], NOW), { accepted: 1, duplicate: 1, conflict: 0, expired: 0, rejected: 0 });
  const changed = await rollout("r1", T0, [{ version: V2, percent: 100 }]);
  const malformed = await rollout("r2", T0, [{ version: V1, percent: 60 }, { version: V2, percent: 20 }]);
  const old = await rollout("r3", T0 - 31 * D, [{ version: V1, percent: 100 }]);
  assert.deepEqual(recordRollouts(db, [changed, malformed, old], [], NOW), { accepted: 0, duplicate: 0, conflict: 1, expired: 1, rejected: 1 });
});

await test("a rollout's impact separates new issue groups, carried-over issues, and regressions by version", async () => {
  const db = database();
  const R2 = T0 + 2 * D;
  recordRollouts(db, [await rollout("r1", T0 - D, [{ version: V1, percent: 100 }]), await rollout("r2", R2, [{ version: V2, percent: 100 }])], [{ version: V2, label: "v2.0", message: null }], R2);
  ingest(db, await prepare(
    worker(1, { version: V1, eventAtMs: T0 + D, errors: [caught] }),
    worker(2, { version: V1, eventAtMs: T0 + D + 1, errors: [errorC] })
  ), T0 + D + 2);
  const fingerprintC = listIssues(db, T0 + D + 2).items.find(issue => issue.operation === "collector.record")!.fingerprint;
  setIssueState(db, T0 + D + H, fingerprintC, "resolved");
  ingest(db, await prepare(
    worker(3, { version: V2, eventAtMs: R2 + H, errors: [caught] }),
    worker(4, { version: V2, eventAtMs: R2 + H + 1, status: 500, errors: [errorB] }),
    worker(5, { version: V2, eventAtMs: R2 + H + 2, errors: [errorC] }),
    worker(6, { version: V2, eventAtMs: R2 + H + 3 })
  ), R2 + 2 * H);
  const impact = rolloutImpact(db, R2 + 2 * H, "r2")!;
  assert.equal(impact.state, "measured");
  assert.deepEqual(impact.introduced, [V2]);
  assert.equal(impact.previousRolloutId, "r1");
  assert.deepEqual(impact.newIssues.map(issue => issue.operation), ["deployments.poll"]);
  assert.deepEqual(impact.regressions.map(issue => issue.operation), ["collector.record"]);
  assert.deepEqual(impact.versions, [
    { version: V1, label: null, introduced: false, requests: 2, failed: 2 },
    { version: V2, label: "v2.0", introduced: true, requests: 4, failed: 3 }
  ]);
  assert.equal(impact.baselineMs, D);
  const introducedB = listIssues(db, R2 + 2 * H, { introducedIn: V2 }).items;
  assert.deepEqual(introducedB.map(issue => [issue.operation, issue.firstVersion, issue.firstVersionLabel]), [["deployments.poll", V2, "v2.0"]]);
});

await test("a split rollout introduces only its new version, so errors also seen on the old one are not new", async () => {
  const db = database();
  recordRollouts(db, [await rollout("r1", T0, [{ version: V1, percent: 100 }]), await rollout("r2", T0 + D, [{ version: V1, percent: 50 }, { version: V2, percent: 50 }])], [], T0 + D);
  ingest(db, await prepare(
    worker(1, { version: V1, eventAtMs: T0 + D + H, errors: [errorB] }),
    worker(2, { version: V2, eventAtMs: T0 + D + H, errors: [errorC] }),
    worker(3, { version: V1, eventAtMs: T0 + D + H, errors: [caught] }),
    worker(4, { version: V2, eventAtMs: T0 + D + H, errors: [caught] })
  ), T0 + D + 2 * H);
  const impact = rolloutImpact(db, T0 + D + 2 * H, "r2")!;
  assert.deepEqual(impact.introduced, [V2]);
  assert.deepEqual(impact.newIssues.map(issue => issue.operation), ["collector.record"]);
});

await test("a rollout older than the observation window reports expired instead of guessing", async () => {
  const db = database();
  recordRollouts(db, [await rollout("r1", T0, [{ version: V2, percent: 100 }])], [], T0);
  ingest(db, await prepare(worker(1, { version: V2, eventAtMs: T0 + H, errors: [errorB] })), T0 + H);
  const impact = rolloutImpact(db, T0 + RETENTION_MS + H, "r1")!;
  assert.equal(impact.state, "expired");
  assert.deepEqual(impact.newIssues, []);
  assert.equal(rolloutImpact(db, NOW, "missing"), null);
});

await test("cleanup keeps 30 days of rollouts plus the newest older one as the baseline", async () => {
  const db = database();
  const now = T0 + 40 * D;
  recordRollouts(db, [], [{ version: "v0", label: "gone", message: null }, { version: V2, label: "kept", message: null }], T0 + D);
  recordRollouts(db, [await rollout("old-a", T0 + 1 * D, [{ version: V1, percent: 100 }]), await rollout("old-b", T0 + 5 * D, [{ version: V1, percent: 100 }]), await rollout("recent", T0 + 20 * D, [{ version: V2, percent: 100 }])], [], T0 + 20 * D);
  cleanup(db, now);
  assert.deepEqual(db.rows<{ id: string }>("SELECT id FROM observe_rollouts ORDER BY at_ms").map(row => row.id), ["old-b", "recent"]);
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_rollout_shares WHERE rollout_id = 'old-a'")[0]!.n, 0);
  assert.deepEqual(db.rows<{ version: string }>("SELECT version FROM observe_version_labels").map(row => row.version), [V2]);
});

await test("opening a store from before rollouts adds the resolution column and keeps its issues", () => {
  const legacy = new DatabaseSync(":memory:");
  legacy.exec("CREATE TABLE observe_issues (fingerprint TEXT PRIMARY KEY, name TEXT NOT NULL, operation TEXT, frame TEXT, state TEXT NOT NULL CHECK (state IN ('open', 'resolved')), state_at INTEGER NOT NULL) WITHOUT ROWID");
  legacy.exec("INSERT INTO observe_issues VALUES ('f', 'Error', NULL, NULL, 'open', 1)");
  const db = wrap(legacy);
  initializeStore(db);
  initializeStore(db);
  assert.ok(db.rows<{ name: string }>("PRAGMA table_info(observe_issues)").some(column => column.name === "resolved_at"));
  assert.equal(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_issues")[0]!.n, 1);
});

await test("an issue a rollout introduced stays new in it when it also appears on a later version", async () => {
  const db = database();
  const V3 = "v3-7f3a4b5c";
  recordRollouts(db, [await rollout("r1", T0, [{ version: V1, percent: 100 }]), await rollout("r2", T0 + D, [{ version: V2, percent: 100 }]), await rollout("r3", T0 + 2 * D, [{ version: V3, percent: 100 }])], [], T0 + 2 * D);
  ingest(db, await prepare(worker(1, { version: V1, eventAtMs: T0 + H }), worker(2, { version: V2, eventAtMs: T0 + D + H, errors: [errorB] }), worker(3, { version: V3, eventAtMs: T0 + 2 * D + H, errors: [errorB] })), T0 + 2 * D + 2 * H);
  assert.deepEqual(rolloutImpact(db, T0 + 2 * D + 2 * H, "r2")!.newIssues.map(issue => issue.operation), ["deployments.poll"]);
  assert.deepEqual(rolloutImpact(db, T0 + 2 * D + 2 * H, "r3")!.newIssues, []);
});
