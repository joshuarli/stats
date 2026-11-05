import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { encodeFrame, type SourceBatch } from "../src/ingest/encode.ts";
import { BUCKET_MS } from "../src/projects/queries.ts";
import { RECORDED_AT_MS, scenario } from "../local/scenario.ts";
import { arrivalMs, sampleAt } from "../local/samples.ts";
import { addHost } from "../local/seed.ts";
import { productionProjects, startStack, type Stack } from "../local/stack.ts";
import { CLOUDFLARE_ROOT } from "../local/topology.ts";

export type Provenance = "local-measured" | "fixture-replay" | "modeled";

export interface BenchOptions {
  readonly warmupBatches: number;
  readonly batches: number;
  readonly statsOutput?: string;
}

interface Counts {
  readonly invocations: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly statements: number;
}

const INGEST_TYPE = "application/vnd.stats.ingest.v2";
const BATCH = JSON.parse(readFileSync(join(CLOUDFLARE_ROOT, "../fixtures/v2/sources/linux-normal.json"), "utf8")) as SourceBatch;
const TEMPLATE = BATCH.samples[0]!;
const require = createRequire(import.meta.url);

function versions(): { readonly miniflare: string; readonly workerd: string } {
  const miniflare = require.resolve("miniflare");
  const local = createRequire(miniflare);
  const version = (name: string) => (JSON.parse(readFileSync(local.resolve(`${name}/package.json`), "utf8")) as { version: string }).version;
  return { miniflare: version("miniflare"), workerd: version("workerd") };
}

function revision(): { readonly revision: string; readonly dirty: boolean } {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: CLOUDFLARE_ROOT, encoding: "utf8" }).trim();
  return { revision: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
}

function installationBytes(stack: Stack): number {
  const directory = join(stack.persist, "do", `${stack.stats.name}-Installation`);
  return readdirSync(directory).filter(name => /^[0-9a-f]{64}\.sqlite(-wal)?$/u.test(name)).reduce((total, name) => total + statSync(join(directory, name)).size, 0);
}

interface Summary { readonly kind: string; readonly operation?: string; readonly rows?: { readonly read: number; readonly written: number; readonly statements: number }; readonly work?: Readonly<Record<string, number>> }

async function ingest(stack: Stack, options: BenchOptions): Promise<Record<string, unknown>> {
  const host = await addHost(stack, "bench");
  let counts: Counts = { invocations: 0, rowsRead: 0, rowsWritten: 0, statements: 0 };
  let persisted = 0;
  let requestBytes = 0;
  let responseBytes = 0;
  let before = 0;
  for (let batch = 0; batch < options.warmupBatches + options.batches; batch += 1) {
    if (batch === options.warmupBatches) before = installationBytes(stack);
    const body = encodeFrame({ ...BATCH, hostId: host.hostId, samples: [sampleAt(TEMPLATE, batch * 2), sampleAt(TEMPLATE, batch * 2 + 1)] });
    const result = await stack.installationAt(arrivalMs(batch * 2 + 1), "/ingest", { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": INGEST_TYPE }, body });
    if (result.status !== 200) throw new Error(`batch ${batch} answered ${result.status}`);
    const summary = (result.published as Summary[]).filter(message => message.kind === "operation" && message.operation === "host.ingest").at(-1);
    if (summary?.rows === undefined || summary.work === undefined) throw new Error(`batch ${batch} published no host.ingest summary`);
    if (summary.work["persisted"] !== 2) throw new Error(`batch ${batch} persisted ${summary.work["persisted"]} samples`);
    if (batch < options.warmupBatches) continue;
    counts = { invocations: counts.invocations + 1, rowsRead: counts.rowsRead + summary.rows.read, rowsWritten: counts.rowsWritten + summary.rows.written, statements: counts.statements + summary.rows.statements };
    persisted += 2;
    requestBytes += body.byteLength;
    responseBytes += result.body.byteLength;
  }
  return {
    workload: "ingest",
    batches: options.batches,
    ...counts,
    writtenPerSample: Number((counts.rowsWritten / persisted).toFixed(3)),
    statementsPerBatch: Number((counts.statements / counts.invocations).toFixed(3)),
    requestBytes,
    responseBytes,
    databaseGrowthBytes: installationBytes(stack) - before,
    provenance: {
      invocations: "fixture-replay",
      rowsRead: "local-measured",
      rowsWritten: "local-measured",
      statements: "local-measured",
      writtenPerSample: "local-measured",
      statementsPerBatch: "local-measured",
      requestBytes: "fixture-replay",
      responseBytes: "local-measured",
      databaseGrowthBytes: "local-measured"
    } satisfies Record<string, Provenance>
  };
}

interface OperationRow { readonly count: number; readonly rowsRead: number; readonly rowsWritten: number; readonly statements: number; readonly work: Readonly<Record<string, number>> }

async function operations(stack: Stack, operation: string): Promise<OperationRow[]> {
  const bucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
  return (await stack.observe("stats", `/window?from=${bucket - 3_600_000}&to=${bucket + 2 * BUCKET_MS}&operation=${operation}`) as { operations: OperationRow[] }).operations;
}

async function waitFor<V>(read: () => Promise<V>, done: (value: V) => boolean, what: string): Promise<V> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function collection(stack: Stack): Promise<Record<string, unknown>> {
  const writes = async () => (await stack.observe("stats", "/health") as { writes: { accepted: number; ingestRows: number } }).writes;
  const start = await writes();
  const before = installationBytes(stack);
  const calls = stack.analytics.calls.length;
  const outcome = await stack.collect(scenario(productionProjects(stack.stats), RECORDED_AT_MS));
  if (outcome !== "ok") throw new Error(`the collection ended ${outcome}`);
  const [row] = await waitFor(() => operations(stack, "collector.record"), rows => rows.reduce((total, entry) => total + entry.count, 0) === 1, "the collector.record operation");
  const traces = await waitFor(async () => (await stack.observe("stats", "/traces?limit=100") as { items: { kind: string; objectInvocations: number }[] }).items.filter(item => item.kind === "scheduled"), items => items.length === 1 && items[0]!.objectInvocations > 0, "the scheduled trace and its object invocations");
  const invocations = 1 + traces[0]!.objectInvocations;
  const end = await waitFor(writes, value => value.accepted - start.accepted >= invocations, "the collection's observation writes");
  return {
    workload: "collection",
    invocations,
    rowsRead: row!.rowsRead,
    rowsWritten: row!.rowsWritten,
    statements: row!.statements,
    metricRows: row!.work["metricRows"],
    upstreamQueries: row!.work["upstreamQueries"],
    analyticsRowsReturned: stack.analytics.calls.slice(calls).reduce((total, call) => total + call.rows, 0),
    databaseGrowthBytes: installationBytes(stack) - before,
    observationRowsPerInvocation: Number(((end.ingestRows - start.ingestRows) / (end.accepted - start.accepted)).toFixed(3)),
    provenance: {
      invocations: "local-measured",
      rowsRead: "local-measured",
      rowsWritten: "local-measured",
      statements: "local-measured",
      metricRows: "local-measured",
      upstreamQueries: "local-measured",
      analyticsRowsReturned: "modeled",
      databaseGrowthBytes: "local-measured",
      observationRowsPerInvocation: "local-measured"
    } satisfies Record<string, Provenance>
  };
}

export async function runBench(options: BenchOptions): Promise<Record<string, unknown>[]> {
  const common = { ...revision(), ...versions() };
  const results: Record<string, unknown>[] = [];
  const ingestStack = await startStack({ nowMs: RECORDED_AT_MS, ...(options.statsOutput === undefined ? {} : { statsOutput: options.statsOutput }) });
  try {
    results.push({ ...common, ...(await ingest(ingestStack, options)) });
  } finally {
    await ingestStack.dispose();
  }
  const collectionStack = await startStack({ nowMs: RECORDED_AT_MS, ...(options.statsOutput === undefined ? {} : { statsOutput: options.statsOutput }) });
  try {
    results.push({ ...common, ...(await collection(collectionStack)) });
  } finally {
    await collectionStack.dispose();
  }
  return results;
}

if (import.meta.main) {
  for (const result of await runBench({ warmupBatches: 40, batches: 1500 })) console.log(JSON.stringify(result));
}
