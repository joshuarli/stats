import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "../../src/binary/history.ts";
import { decodeProjectHistories, metricTrack, type ProjectHistories } from "../../src/client/history.ts";
import { PROJECT_SETTLE_MS } from "../../src/limits.ts";
import { windowStartMs } from "../../src/projects/metrics.ts";
import { BUCKET_MS } from "../../src/projects/queries.ts";
import { RECORDED_AT_MS, R2_ACTIONS, WORKER_STATUSES, D1_STATEMENTS, scenario, slots, values, type Scenario } from "../../local/scenario.ts";
import { CLOUDFLARE_ROOT, STATS_OUTPUT, readBuiltWorker } from "../../local/topology.ts";
import { addHost, ingestFixture as ingest } from "../../local/seed.ts";
import { cliEnv, productionProjects, startStack, type Stack } from "../../local/stack.ts";

const T = RECORDED_AT_MS;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PROJECT_SAMPLE_HORIZON_MS = 7 * DAY_MS;
const PROJECT_HOUR_HORIZON_MS = 30 * DAY_MS;
const BASE_KINDS = "worker,routes,r2,collector";

interface Frame {
  readonly etag: string | null;
  readonly bytes: Uint8Array;
  readonly histories: ProjectHistories;
}

async function history(stack: Stack, project: string, fromMs: number, toMs: number, extraKinds = ""): Promise<Frame> {
  const response = await stack.fetch(`/api/v1/projects/${project}/history?from=${fromMs}&to=${toMs}&kinds=${BASE_KINDS}${extraKinds}`);
  assert.equal(response.status, 200, `${project} history`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { etag: response.headers.get("etag"), bytes, histories: decodeProjectHistories(openHistory(bytes).root) };
}

function series(frame: Frame, kind: "worker" | "r2" | "d1" | "durable-objects", metric: string): Map<number, number | null> {
  const metrics = frame.histories[kind];
  assert.ok(metrics !== undefined, `frame has ${kind}`);
  const track = metricTrack(metrics, metric);
  return new Map(track.times.map((time, index) => [time, track.values[index] ?? null]));
}

function workerModel(model: Scenario, project: string, slotMs: number): number {
  return WORKER_STATUSES.reduce((sum, status) => sum + values.workerInvocations(model, project, slotMs, status), 0);
}

function sum(numbers: readonly number[]): number {
  return numbers.reduce((total, value) => total + value, 0);
}

interface CliResult {
  readonly status: number | null;
  readonly json: CostEnvelope;
}

interface CostLine {
  readonly id: string;
  readonly price: { readonly kind: string; readonly monthly?: { readonly now: number } };
  readonly usage?: { readonly calls?: { readonly now: number } };
  readonly coverage?: { readonly coveredMs: number; readonly windowMs: number };
  readonly children?: readonly CostLine[];
}

interface CostEnvelope {
  readonly schema: string;
  readonly windows: readonly { readonly fromMs: number; readonly toMs: number }[];
  readonly coverage: Readonly<Record<string, string>>;
  readonly units: { readonly periodMs?: number };
  readonly payload: { readonly projects: readonly { readonly id: string; readonly status: string; readonly report: { readonly units: { readonly periodMs: number }; readonly total: { readonly monthly: { readonly now: number; readonly before: number | null }; readonly confidence: string }; readonly comparison: { readonly change: unknown }; readonly lines: readonly CostLine[] } }[] };
}

async function statsctl(stack: Stack, args: readonly string[]): Promise<CliResult> {
  const child = spawn(process.execPath, ["--experimental-strip-types", join(CLOUDFLARE_ROOT, "src/cli/statsctl.ts"), ...args], { env: { ...process.env, ...cliEnv(stack.origin) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const status = await new Promise<number | null>(resolve => child.on("close", resolve));
  assert.notEqual(stdout, "", `statsctl ${args.join(" ")} printed nothing: ${stderr}`);
  return { status, json: JSON.parse(stdout) as CostEnvelope };
}

function settledWindow(model: Scenario): { fromMs: number; toMs: number } {
  const latest = Math.max(...slots(model, "logs.workersLogs").filter(slotMs => slotMs + BUCKET_MS + PROJECT_SETTLE_MS <= model.nowMs));
  return { fromMs: latest + BUCKET_MS - HOUR_MS, toMs: latest + BUCKET_MS };
}

async function projectsList(stack: Stack): Promise<{ id: string; collector: { lastRunAtMs: number | null; lastSuccessAtMs: number | null; lastError: string | null; stale: boolean } }[]> {
  const response = await stack.fetch("/api/v1/projects");
  assert.equal(response.status, 200);
  return await response.json() as { id: string; collector: { lastRunAtMs: number | null; lastSuccessAtMs: number | null; lastError: string | null; stale: boolean } }[];
}

async function until<V>(read: () => Promise<V>, done: (value: V) => boolean, what: string): Promise<V> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 1000)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

interface CollectorWork { readonly runs: number; readonly metricRows: number }

async function collectorWork(stack: Stack): Promise<CollectorWork> {
  const bucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
  const window = await stack.observe("stats", `/window?from=${bucket - HOUR_MS}&to=${bucket + 2 * BUCKET_MS}&operation=collector.record`) as { operations: { work: CollectorWork }[] };
  return { runs: sum(window.operations.map(row => row.work.runs)), metricRows: sum(window.operations.map(row => row.work.metricRows)) };
}

async function withStack(start: Parameters<typeof startStack>[0], body: (stack: Stack, replace: (next: Stack) => void) => Promise<void>): Promise<void> {
  let stack = await startStack(start);
  try {
    await body(stack, next => { stack = next; });
  } finally {
    await stack.dispose();
  }
}

const PROJECTS = productionProjects(readBuiltWorker(STATS_OUTPUT));

await test("S1: a successful collection stores the model's values and reports them over HTTP and statsctl", async () => {
  await withStack({ nowMs: T }, async stack => {
    const model = scenario(PROJECTS, T);
    assert.equal(await stack.collect(model), "ok");
    const fromMs = windowStartMs(T);
    const stuff = await history(stack, "stuff", fromMs, T);
    const invocations = series(stuff, "worker", "worker.invocations");
    for (const slotMs of slots(model, "logs.workersLogs")) assert.equal(invocations.get(slotMs), workerModel(model, "stuff", slotMs), `stuff worker ${slotMs}`);
    for (const bucket of ["stuff-mycrates", "stuff-mynpm", "stuff-mypypi"]) {
      const operations = series(stuff, "r2", `r2.${bucket}.ops.success`);
      for (const slotMs of slots(model, "events.r2CombinedOperations")) assert.equal(operations.get(slotMs), values.r2Operations(bucket, slotMs, R2_ACTIONS.indexOf("success")), `${bucket} ${slotMs}`);
    }
    const memories = series(await history(stack, "usr-memories", fromMs, T, ",d1"), "d1", "d1.queries");
    for (const slotMs of slots(model, "events.d1Queries")) assert.equal(memories.get(slotMs), sum(D1_STATEMENTS.map((_, statement) => values.d1Queries("usr-memories", slotMs, statement))));
    const objects = series(await history(stack, "stats", fromMs, T, ",durable-objects"), "durable-objects", "do.invocations");
    for (const slotMs of slots(model, "events.durableObjectsInvocations")) assert.equal(objects.get(slotMs), values.durableObjectInvocations("stats", slotMs));
    for (const project of await projectsList(stack)) {
      assert.deepEqual([project.collector.lastError, project.collector.stale], [null, false], project.id);
      assert.ok(project.collector.lastSuccessAtMs !== null && project.collector.lastSuccessAtMs >= T, project.id);
    }
    const cli = await statsctl(stack, ["cost", "--project", "stuff", "--window", "1h", "--json"]);
    assert.equal(cli.status, 0);
    assert.equal(cli.json.schema, "statsctl/1");
    const settled = settledWindow(model);
    assert.deepEqual(cli.json.windows[0], settled);
    const covered = slots(model, "logs.workersLogs").filter(slotMs => slotMs >= settled.fromMs && slotMs < settled.toMs);
    assert.equal(cli.json.coverage["stuff"], `qualified; worker ${Math.round(100 * covered.length * BUCKET_MS / HOUR_MS)}% of the window`);
    const report = cli.json.payload.projects[0]!.report;
    const worker = report.lines.find(line => line.id === "worker")!;
    assert.equal(worker.coverage?.coveredMs, covered.length * BUCKET_MS);
    assert.ok(Math.abs(worker.usage!.calls!.now - sum(covered.map(slotMs => workerModel(model, "stuff", slotMs))) * report.units.periodMs / (covered.length * BUCKET_MS)) < 1e-6);
  });
});

await test("S2: late and empty datasets read as missing or partial, never as zero cost or an improvement", async () => {
  await withStack({ nowMs: T }, async stack => {
    const model = scenario(PROJECTS, T, { "logs.workersLogs": { kind: "late", omitNewestSlots: 3 }, "events.r2CombinedOperations": { kind: "empty" } });
    assert.equal(await stack.collect(model), "ok");
    const frame = await history(stack, "stuff", windowStartMs(T), T);
    const invocations = series(frame, "worker", "worker.invocations");
    const present = slots(model, "logs.workersLogs");
    const missing = slots(scenario(PROJECTS, T), "logs.workersLogs").filter(slotMs => !present.includes(slotMs));
    assert.equal(missing.length, 3);
    for (const slotMs of missing) assert.equal(invocations.get(slotMs), null, `late slot ${slotMs} is missing, not zero`);
    for (const slotMs of present) assert.equal(invocations.get(slotMs), workerModel(model, "stuff", slotMs));
    const operations = series(frame, "r2", "r2.stuff-mycrates.ops.success");
    assert.ok([...operations.values()].every(value => value === null || value === 0), "no operations were reported");
    for (const [slotMs, value] of operations) if (slotMs + BUCKET_MS + PROJECT_SETTLE_MS > T) assert.equal(value, null, `unsettled ${slotMs}`);
    const cli = await statsctl(stack, ["cost", "--project", "stuff", "--window", "1h", "--json"]);
    assert.equal(cli.status, 0);
    assert.match(cli.json.coverage["stuff"] ?? "", /^qualified; worker \d+% of the window$/u);
    const report = cli.json.payload.projects[0]!.report;
    assert.equal(report.comparison.change, null);
    assert.equal(report.total.monthly.before, null);
    assert.ok(report.total.monthly.now > 0);
    const zeroPriced = report.lines.filter(line => line.price.kind === "priced" && line.price.monthly?.now === 0).map(line => line.id);
    assert.deepEqual(zeroPriced, []);
  });
});

await test("S3: overlapping windows replace stored values instead of summing them", async () => {
  await withStack({ nowMs: T }, async (initial, replace) => {
    let stack = initial;
    const first = scenario(PROJECTS, T);
    assert.equal(await stack.collect(first), "ok");
    const afterFirst = await until(() => collectorWork(stack), work => work.runs === 1, "the first collector.record");
    const analyticsSeries = async () => {
      const frames = await Promise.all(["stuff", "usr-memories", "stats"].map(async project => [project, await history(stack, project, windowStartMs(T), T, project === "usr-memories" ? ",d1,d1-statements,probes" : project === "stats" ? ",durable-objects,probes" : ",probes")] as const));
      const all = new Map<string, string>();
      let live = 0;
      for (const [project, frame] of frames) {
        for (const kind of ["worker", "routes", "r2", "durable-objects", "d1", "d1-statements", "probes"] as const) {
          const metrics = frame.histories[kind];
          if (metrics === undefined) continue;
          for (const metric of metrics.table.names()) {
            if (/^probe\..+\.ms$/u.test(metric) || metric === "do.storageBytes") live += 1;
            else all.set(`${project} ${metric}`, JSON.stringify(metricTrack(metrics, metric)));
          }
        }
      }
      return { all, live };
    };
    const firstSeries = await analyticsSeries();
    assert.equal(await stack.collect(first), "ok");
    const afterSecond = await until(() => collectorWork(stack), work => work.runs === 2, "the second collector.record");
    const secondSeries = await analyticsSeries();
    assert.deepEqual(secondSeries.all, firstSeries.all, "an identical second run changes no analytics series");
    assert.ok(afterSecond.metricRows - afterFirst.metricRows <= firstSeries.live, `the second run rewrote ${afterSecond.metricRows - afterFirst.metricRows} samples, more than the ${firstSeries.live} live-measured probe and store-size points`);
    for (const offset of [5, 10]) {
      stack = await stack.restart({ nowMs: T + offset * 60_000 });
      replace(stack);
      assert.equal(await stack.collect(scenario(PROJECTS, T + offset * 60_000)), "ok");
    }
    const latest = T + 10 * 60_000;
    const raisedSlot = windowStartMs(latest) + 30 * 60_000;
    const raised = scenario(PROJECTS, latest, {}, { project: "stuff", slotMs: raisedSlot, by: 1000 });
    assert.equal(await stack.collect(raised), "ok");
    const invocations = series(await history(stack, "stuff", windowStartMs(T), latest), "worker", "worker.invocations");
    const union = [...new Set([...slots(first, "logs.workersLogs"), ...slots(raised, "logs.workersLogs")])];
    for (const slotMs of union) assert.equal(invocations.get(slotMs), workerModel(raised, "stuff", slotMs), `slot ${slotMs}`);
    assert.equal(invocations.get(raisedSlot), workerModel(first, "stuff", raisedSlot) + 1000);
    const s1Slots = slots(first, "logs.workersLogs").filter(slotMs => slotMs !== raisedSlot);
    assert.equal(sum(s1Slots.map(slotMs => invocations.get(slotMs) ?? Number.NaN)), sum(s1Slots.map(slotMs => workerModel(first, "stuff", slotMs))));
  });
});

await test("S4: a failing dataset marks the collector failed and stale without touching ingest or earlier metrics, and the next run clears it", async () => {
  await withStack({ nowMs: T }, async (initial, replace) => {
    let stack = initial;
    const host = await addHost(stack);
    assert.equal(await stack.collect(scenario(PROJECTS, T)), "ok");
    const failAt = T + 20 * 60_000;
    stack = await stack.restart({ nowMs: failAt });
    replace(stack);
    assert.equal(await stack.collect(scenario(PROJECTS, failAt, { "states.r2CombinedStorage": { kind: "fail" } })), "exception");
    for (const project of await projectsList(stack)) {
      assert.deepEqual([project.collector.lastError, project.collector.stale, project.collector.lastSuccessAtMs !== null && project.collector.lastSuccessAtMs < failAt], ["collector_failed", true, true], project.id);
    }
    assert.equal(await ingest(stack, host, failAt - 60_000), 200);
    assert.equal((await stack.fetch("/api/v1/hosts")).status, 200);
    const earlier = series(await history(stack, "stuff", windowStartMs(T), T), "worker", "worker.invocations");
    const model = scenario(PROJECTS, T);
    for (const slotMs of slots(model, "logs.workersLogs")) assert.equal(earlier.get(slotMs), workerModel(model, "stuff", slotMs));
    await until(async () => (await stack.observe("stats", "/traces?limit=100") as { items: { kind: string; failed: boolean }[] }).items, items => items.some(item => item.kind === "scheduled" && item.failed), "the failed scheduled trace");
    const recoverAt = failAt + 5 * 60_000;
    stack = await stack.restart({ nowMs: recoverAt });
    replace(stack);
    assert.equal(await stack.collect(scenario(PROJECTS, recoverAt)), "ok");
    for (const project of await projectsList(stack)) assert.deepEqual([project.collector.lastError, project.collector.stale], [null, false], project.id);
  });
});

await test("S5: a restart on the same persistence directory keeps collector state, hosts, history frames, and the observe store", async () => {
  await withStack({ nowMs: T }, async (initial, replace) => {
    let stack = initial;
    const host = await addHost(stack);
    assert.equal(await ingest(stack, host, T - 60_000), 200);
    assert.equal(await stack.collect(scenario(PROJECTS, T)), "ok");
    const read = async () => ({
      projects: await projectsList(stack),
      hosts: await (await stack.fetch("/api/v1/hosts")).json() as unknown,
      frame: await history(stack, "stuff", windowStartMs(T), T)
    });
    const before = await read();
    const traces = async () => (await stack.observe("stats", "/traces?limit=100") as { items: unknown[] }).items.length;
    const caused = await until(traces, count => count === 6, "the host creation, ingest, collection, and three reads this test caused");
    stack = await stack.restart({ nowMs: T });
    replace(stack);
    assert.equal(await traces(), caused);
    const after = await read();
    assert.deepEqual(after.projects, before.projects);
    assert.deepEqual(after.hosts, before.hosts);
    assert.equal(after.frame.etag, before.frame.etag);
    assert.deepEqual(after.frame.bytes, before.frame.bytes);
  });
});

await test("S6: retention past the sample horizon drops five-minute rows and keeps hourly rows and newer data", async () => {
  await withStack({ nowMs: T }, async (initial, replace) => {
    let stack = initial;
    const host = await addHost(stack);
    assert.equal(await ingest(stack, host, T - 60_000), 200);
    const first = scenario(PROJECTS, T);
    assert.equal(await stack.collect(first), "ok");
    const later = T + PROJECT_SAMPLE_HORIZON_MS + HOUR_MS;
    assert.ok(later - T < PROJECT_HOUR_HORIZON_MS);
    stack = await stack.restart({ nowMs: later });
    replace(stack);
    const second = scenario(PROJECTS, later);
    assert.equal(await stack.collect(second), "ok");
    await stack.runAlarm();
    const expired = await stack.fetch(`/api/v1/hosts/${host.hostId}/latest`);
    assert.equal(expired.status, 404, "raw samples older than the raw horizon are gone");
    await expired.arrayBuffer();
    assert.equal(await ingest(stack, host, later - 60_000, 1_000_000n), 200);
    const old = await history(stack, "stuff", windowStartMs(T), T);
    assert.equal(old.histories.worker.stepMs, HOUR_MS, "the expired window reads from hourly rollups");
    const hourly = series(old, "worker", "worker.invocations");
    const hours = [...new Set(slots(first, "logs.workersLogs").map(slotMs => Math.floor(slotMs / HOUR_MS) * HOUR_MS))];
    for (const hourMs of hours) {
      assert.equal(hourly.get(hourMs), sum(slots(first, "logs.workersLogs").filter(slotMs => slotMs >= hourMs && slotMs < hourMs + HOUR_MS).map(slotMs => workerModel(first, "stuff", slotMs))), `hour ${hourMs}`);
    }
    const fresh = series(await history(stack, "stuff", windowStartMs(later), later), "worker", "worker.invocations");
    for (const slotMs of slots(second, "logs.workersLogs")) assert.equal(fresh.get(slotMs), workerModel(second, "stuff", slotMs));
    const latest = await stack.fetch(`/api/v1/hosts/${host.hostId}/latest`);
    assert.equal(latest.status, 200);
    assert.equal(Number((await latest.json() as { sample: { atMs: number } }).sample.atMs), later - 60_000);
  });
});
