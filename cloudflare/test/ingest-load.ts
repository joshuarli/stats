import { env, runInDurableObject } from "cloudflare:test";
import diagnostics from "node:diagnostics_channel";
import { tokenHash } from "../src/auth";
import { encodeFrame, type SourceBatch } from "../src/ingest/encode.ts";
import type { Installation } from "../src/cloudflare/installation";
import { OBSERVE_CHANNEL, type ChannelMessage } from "../src/observe/producer/channel";
import { INGEST_TYPE, readAck, source, type DecodedAck } from "./ingest-worker";

export const HOST_ID = "h_00000000000000000000000000000001";
export const TOKEN = `nft_${"A".repeat(43)}`;
export const HOUR = 3_600_000;
export const FIRST_AT_MS = Math.floor(1_793_510_400_000 / HOUR) * HOUR - 10 * 60_000;
export const SAMPLE_STEP_MS = 15_000;
export const BOOT_ID = "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f";

export interface Rows { readonly read: number; readonly written: number; readonly statements: number }
export interface Ingested { readonly ack: DecodedAck; readonly rows: Rows; readonly persisted: number }

export function stub() {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
}

type Field = Record<string, string>;

function bump(entry: Field, step: number, keys: readonly string[]): Field {
  const next = { ...entry };
  for (const key of keys) next[key] = (BigInt(entry[key]!) + BigInt(step)).toString();
  return next;
}

export function sampleAt(index: number): Record<string, unknown> {
  const template = source("linux-normal").samples[0] as Record<string, unknown>;
  const cpuTemplate = template["cpu"] as Field;
  const cpu = { ...cpuTemplate, user: bump(cpuTemplate, index * 1000, ["user"])["user"]!, system: bump(cpuTemplate, index * 1000, ["system"])["system"]!, idle: bump(cpuTemplate, index * 2000, ["idle"])["idle"]!, total: bump(cpuTemplate, index * 4000, ["total"])["total"]! };
  const nets = (template["nets"] as Field[]).map(net => bump(net, index * 1500, ["rxBytes", "txBytes"]));
  return {
    ...template,
    seq: String(900_000 + index * 15),
    monoMs: String(900_000_000 + index * SAMPLE_STEP_MS),
    atMs: String(FIRST_AT_MS + index * SAMPLE_STEP_MS),
    cpu,
    nets
  };
}

export async function createLoadHost(name = "load"): Promise<void> {
  const hash = await tokenHash(TOKEN);
  await runInDurableObject(stub(), async (instance: Installation, state) => {
    await instance.purgeHost(HOST_ID);
    state.storage.sql.exec("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES (?, ?, ?, 0)", HOST_ID, name, hash);
  });
}

let messages: ChannelMessage[] = [];
const listen = (message: unknown) => { messages.push(message as ChannelMessage); };

export function captureOperations(): () => void {
  messages = [];
  diagnostics.subscribe(OBSERVE_CHANNEL, listen);
  return () => diagnostics.unsubscribe(OBSERVE_CHANNEL, listen);
}

async function request(init: { readonly path: string; readonly method?: string; readonly headers?: Record<string, string>; readonly body?: BodyInit }, nowMs: number): Promise<{ response: Response; published: ChannelMessage[] }> {
  const start = messages.length;
  const response = await runInDurableObject(stub(), async (instance: Installation) => {
    Object.defineProperty(instance, "env", { value: { ...env, TEST_NOW_MS: String(nowMs) }, configurable: true });
    return instance.fetch(new Request(`https://installation${init.path}`, { method: init.method ?? "GET", headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) }));
  });
  return { response, published: messages.slice(start).filter(message => message.kind === "operation" && message.operation !== "cleanup.retention") };
}

export interface BatchSpec {
  readonly indices: readonly number[];
  readonly nowMs: number;
  readonly bootId?: string;
  readonly system?: Record<string, unknown>;
  readonly token?: string;
}

export async function ingestBatch(spec: BatchSpec): Promise<Ingested> {
  const batch: SourceBatch = { hostId: HOST_ID, bootId: spec.bootId ?? BOOT_ID, ...(spec.system === undefined ? {} : { system: spec.system }), samples: spec.indices.map(sampleAt) };
  const { response, published } = await request({ path: "/ingest", method: "POST", headers: { Authorization: `Bearer ${spec.token ?? TOKEN}`, "Content-Type": INGEST_TYPE }, body: encodeFrame(batch) }, spec.nowMs);
  const message = published.at(-1);
  if (message === undefined || message.kind !== "operation" || message.operation !== "host.ingest") throw new Error("no host.ingest summary");
  const ack = await readAck(response);
  return { ack, rows: message.rows, persisted: message.work.persisted };
}

export function arrivalMs(lastIndex: number): number {
  return FIRST_AT_MS + lastIndex * SAMPLE_STEP_MS + 1000;
}

export async function history(path: string, nowMs: number, ifNoneMatch?: string): Promise<{ status: number; etag: string | null; body: Uint8Array }> {
  const { response } = await request({ path, headers: ifNoneMatch === undefined ? {} : { "If-None-Match": ifNoneMatch } }, nowMs);
  return { status: response.status, etag: response.headers.get("etag"), body: new Uint8Array(await response.arrayBuffer()) };
}

export interface TableDump { readonly [table: string]: readonly Record<string, unknown>[] }

export async function dumpTables(): Promise<TableDump> {
  return runInDurableObject(stub(), async (_instance: Installation, state) => {
    const sql = state.storage.sql;
    const read = (query: string) => sql.exec(query).toArray() as Record<string, unknown>[];
    return {
      samples: read("SELECT * FROM samples ORDER BY host_id, boot_id, seq"),
      rollups: read("SELECT * FROM rollups ORDER BY host_id, resolution, bucket_ms"),
      host_system: read("SELECT * FROM host_system ORDER BY host_id"),
      hosts: read("SELECT * FROM hosts ORDER BY host_id"),
      host_history_versions: read("SELECT * FROM host_history_versions ORDER BY host_id")
    };
  });
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface IngestStep { readonly indices: readonly number[]; readonly offsetMs?: number; readonly bootId?: string; readonly system?: boolean }

export const MIXED_SEQUENCE: readonly IngestStep[] = [
  { indices: [0, 1], system: true },
  { indices: [2, 3] },
  { indices: [4, 5] },
  { indices: [6, 7] },
  { indices: [6, 7] },
  { indices: [10, 11] },
  { indices: [8, 9] },
  { indices: [3, 4] },
  { indices: [12, 13], system: true },
  { indices: [14, 15] },
  { indices: Array.from({ length: 16 }, (_, index) => 16 + index) },
  { indices: [200, 201] },
  { indices: [202, 203] },
  { indices: [100, 101] },
  { indices: [300, 301], bootId: "11111111-2222-4333-8444-555555555555" },
  { indices: [302, 303], bootId: "11111111-2222-4333-8444-555555555555" }
];

export const SYSTEM_INFO = { agent: "0.1.0", arch: "x86_64", cpu: { cores: 16, maxMhz: 5756, model: "AMD Ryzen 9 9950X 16-Core Processor", sockets: 1, threads: 32 }, hostname: "threadripper", kernel: "7.2.9-2-stable", os: "Alpine Linux edge" };

export async function runSequence(steps: readonly IngestStep[]): Promise<Ingested[]> {
  const results: Ingested[] = [];
  let latest = 0;
  for (const step of steps) {
    latest = Math.max(latest, ...step.indices);
    results.push(await ingestBatch({ indices: step.indices, nowMs: arrivalMs(latest) + (step.offsetMs ?? 0), ...(step.bootId === undefined ? {} : { bootId: step.bootId }), ...(step.system === true ? { system: SYSTEM_INFO } : {}) }));
  }
  return results;
}

export async function historySnapshot(nowMs: number): Promise<Record<string, { status: number; etag: string | null; frame: string }>> {
  const paths = [
    `/hosts/${HOST_ID}/history?range=1h&kinds=summary,disks,nets,filesystems,block`,
    `/hosts/${HOST_ID}/history?range=6h&kind=summary`,
    `/hosts/${HOST_ID}/history?range=24h&kind=summary`,
    `/hosts/${HOST_ID}/history?range=7d&kind=summary`,
    `/hosts/${HOST_ID}/history?range=30d&kind=summary`
  ];
  const out: Record<string, { status: number; etag: string | null; frame: string }> = {};
  for (const path of paths) {
    const result = await history(path, nowMs);
    out[path] = { status: result.status, etag: result.etag, frame: hex(result.body) };
  }
  return out;
}
