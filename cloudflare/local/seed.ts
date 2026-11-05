import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFrame, type SourceBatch } from "../src/ingest/encode.ts";
import { BUCKET_MS } from "../src/projects/queries.ts";
import { scenario } from "./scenario.ts";
import { productionProjects, type Stack } from "./stack.ts";
import { CLOUDFLARE_ROOT } from "./topology.ts";

export const SEED_HOST_NAME = "local-stack-host";
const BATCH = JSON.parse(readFileSync(join(CLOUDFLARE_ROOT, "../fixtures/v2/sources/linux-normal.json"), "utf8")) as SourceBatch;

export interface Host {
  readonly hostId: string;
  readonly token: string;
}

function u64(value: unknown): bigint {
  if (typeof value !== "string") throw new TypeError("fixture u64 is not a string");
  return BigInt(value);
}

export async function addHost(stack: Stack, name = SEED_HOST_NAME): Promise<Host> {
  const response = await stack.fetch("/api/v1/admin/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  if (response.status !== 201) throw new Error(`creating host ${name} answered ${response.status}: ${await response.text()}`);
  return await response.json() as Host;
}

export async function ingestFixture(stack: Stack, host: Host, lastAtMs: number, seqOffset = 0n): Promise<number> {
  const offset = BigInt(lastAtMs) - u64(BATCH.samples[BATCH.samples.length - 1]!["atMs"]);
  const samples = BATCH.samples.map(sample => ({ ...sample, atMs: (u64(sample["atMs"]) + offset).toString(), seq: (u64(sample["seq"]) + seqOffset).toString() }));
  const response = await stack.anonymous("/ingest/v2/batches", {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/vnd.stats.ingest.v2" },
    body: encodeFrame({ ...BATCH, hostId: host.hostId, samples })
  });
  await response.arrayBuffer();
  return response.status;
}

export async function seed(stack: Stack, nowMs: number): Promise<void> {
  const host = await addHost(stack);
  const status = await ingestFixture(stack, host, nowMs - 60_000);
  if (status !== 200) throw new Error(`seeding the fixture batch answered ${status}`);
  await collectAt(stack, nowMs);
}

export async function collectAt(stack: Stack, nowMs: number): Promise<void> {
  const scheduledMs = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
  const outcome = await stack.collect(scenario(productionProjects(stack.stats), scheduledMs));
  if (outcome !== "ok") throw new Error(`the collection at ${new Date(scheduledMs).toISOString()} ended ${outcome}`);
}
