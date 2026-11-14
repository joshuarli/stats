import { generate } from "../../deploy/orange/generate.mts";
import { freePort, startSession, type Session } from "../../deploy/orange/session.mts";
import { encodeFrame, type SourceBatch } from "../src/ingest/encode.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gatewaySecret, startGateway, type LocalGateway } from "./gateway.ts";

export interface BackendStart {
  readonly state: string;
  readonly statsOutput: string;
  readonly observeOutput: string;
  readonly initialize: boolean;
}
export interface BackendReady {
  readonly event: "backend-ready";
  readonly origin: string;
  readonly workerOrigin: string;
  readonly pid: number;
  readonly producers: readonly { readonly service: string; readonly origin: string }[];
}
export type BackendMessage = BackendReady | { readonly event: "backend-error" };
let session: Session | undefined;
let gateway: LocalGateway | undefined;
let serial = Promise.resolve();
let stopping = false;
const secret = gatewaySecret();

async function dispose(): Promise<void> {
  await gateway?.close();
  gateway = undefined;
  await session?.stop();
  session = undefined;
}
async function activate(options: BackendStart): Promise<void> {
  await dispose();
  const generated = generate(options.state, { kind: "dev", release: "local", gatewaySecret: secret, nowMs: null }, "in-place", { stats: options.statsOutput, observe: options.observeOutput });
  const descriptor = JSON.parse(readFileSync(generated.stats, "utf8")) as { vars: Record<string, string> };
  descriptor.vars["PROJECTS"] = "[]";
  writeFileSync(generated.stats, JSON.stringify(descriptor), { mode: 0o600 });
  session = await startSession(options.state, await freePort());
  gateway = await startGateway(session.origin, secret);
  if (options.initialize) {
    const hosts = await fetch(`${gateway.origin}/api/v1/hosts`);
    if (!hosts.ok) throw new Error(`hosts answered ${hosts.status}`);
    const data = await hosts.json() as { hosts: unknown[] };
    if (data.hosts.length === 0) {
      const created = await fetch(`${gateway.origin}/api/v1/admin/hosts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "local-stack-host" }) });
      if (created.status !== 201) throw new Error(`host creation answered ${created.status}`);
      const host = await created.json() as { hostId: string; token: string };
      const source = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../fixtures/v2/sources/linux-normal.json"), "utf8")) as SourceBatch;
      const offset = BigInt(Date.now() - 60_000) - BigInt(String(source.samples.at(-1)!["atMs"]));
      const samples = source.samples.map(sample => ({ ...sample, atMs: (BigInt(String(sample["atMs"])) + offset).toString() }));
      const ingested = await fetch(`${gateway.origin}/ingest/v2/batches`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/vnd.stats.ingest.v2" }, body: encodeFrame({ ...source, hostId: host.hostId, samples }) });
      if (ingested.status !== 200) throw new Error(`fixture ingest answered ${ingested.status}: ${await ingested.text()}`);
      const service = await fetch(`${gateway.origin}/api/v1/admin/services`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "local-service", hostIds: [host.hostId] }) });
      if (service.status !== 201) throw new Error(`service creation answered ${service.status}`);
    }
  }
  if (stopping) return;
  process.send?.({ event: "backend-ready", origin: gateway.origin, workerOrigin: session.origin, pid: session.child.pid!, producers: [] } satisfies BackendReady);
}
async function shutdown(): Promise<void> {
  stopping = true;
  await serial;
  await dispose();
  if (process.connected) process.disconnect?.();
}
if (import.meta.main) {
  process.on("message", (message: BackendStart | "shutdown") => {
    if (message === "shutdown") { void shutdown(); return; }
    if (stopping) return;
    serial = serial.then(() => activate(message)).catch(async error => { console.error(error); await dispose(); process.send?.({ event: "backend-error" } satisfies BackendMessage); });
  });
  process.once("disconnect", () => { void shutdown(); });
}
