import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import diagnostics from "node:diagnostics_channel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Installation } from "../src/deployments/installation";
import { HISTORY_KINDS } from "../src/limits";
import { OBSERVE_CHANNEL, WORKLOAD_CLASS, type ChannelMessage, type OperationMessage } from "../src/observe/producer/channel";
import { hostHistoryClass, OperationRun, projectHistoryClass, type HostHistoryResolution } from "../src/operations";
import { PROJECT_KINDS } from "../src/projects/history";
import type { CollectorRun } from "../src/projects/store";
import { frameFor, INGEST_TYPE, readAck } from "./ingest-worker";

const NOW = 1_793_510_415_000;

let messages: ChannelMessage[] = [];
const listen = (message: unknown) => { messages.push(message as ChannelMessage); };

beforeEach(() => {
  messages = [];
  diagnostics.subscribe(OBSERVE_CHANNEL, listen);
});

afterEach(() => {
  diagnostics.unsubscribe(OBSERVE_CHANNEL, listen);
});

function stub() {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
}

async function createHost(name: string): Promise<{ hostId: string; token: string }> {
  const result = await runInDurableObject(stub(), async (instance: Installation) => instance.createHost(name));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function ingestRequest(token: string, body: BodyInit): Request {
  return new Request("https://installation/ingest", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": INGEST_TYPE }, body });
}

async function invoke<T>(body: (instance: Installation, state: DurableObjectState) => Promise<T>): Promise<{ result: T; published: ChannelMessage[] }> {
  const start = messages.length;
  const result = await runInDurableObject(stub(), body);
  const published = messages.slice(start).filter(message => message.kind !== "operation" || message.operation !== "cleanup.retention");
  return { result, published };
}

function only(published: readonly ChannelMessage[]): OperationMessage {
  expect(published).toHaveLength(1);
  const message = published[0]!;
  if (message.kind !== "operation") throw new Error(`expected an operation message, got ${message.kind}`);
  return message;
}

function ingest(token: string, body: Uint8Array<ArrayBuffer>) {
  return invoke(async instance => instance.fetch(ingestRequest(token, body)));
}

function run(overrides: Partial<CollectorRun> & { points: { metric: string; bucketMs: number; value: number }[] }): CollectorRun {
  return { ok: true, atMs: NOW, detail: "ok", rowsRead: 1, durationMs: 1, upstreamQueries: 3, collected: [{ project: "stuff", points: overrides.points }], storeOwners: [] };
}

describe("host.ingest", () => {
  it("reports the counts of its acknowledgment and the rows of its cursors in one message", async () => {
    const host = await createHost("counted");
    const body = frameFor("partial-acceptance", host.hostId);
    const first = await invoke(async (instance, state) => {
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      const storage = { exec: (query: string, ...bindings: unknown[]) => { const cursor = state.storage.sql.exec(query, ...bindings); cursors.push(cursor); return cursor; } } as SqlStorage;
      const operation = new OperationRun(storage);
      const response = await instance.ingest(ingestRequest(host.token, body), operation);
      const ack = await readAck(response);
      operation.finish();
      return { ack, cursors, total: operation.sql.total() };
    });
    const ack = first.result.ack;
    const message = only(first.published);
    expect(message.operation).toBe("host.ingest");
    if (message.operation !== "host.ingest") return;
    expect(message.synthetic).toBe(false);
    expect(message.work.persisted).toBe(ack.accepted);
    expect(message.work.duplicate).toBe(ack.duplicates);
    expect(message.work.received).toBe(ack.accepted + ack.duplicates + ack.rejected.length);
    expect(message.work.rejected).toEqual({
      invalid_sample: ack.rejected.filter(entry => entry.code === "invalid_sample").length,
      too_old: ack.rejected.filter(entry => entry.code === "too_old").length,
      conflict: ack.rejected.filter(entry => entry.code === "conflict").length
    });
    expect(message.work.inputBytes).toBe(body.byteLength);
    const cursors = first.result.cursors;
    expect(message.rows).toEqual({
      read: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      written: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
      statements: cursors.length
    });
    expect(message.rows).toEqual(first.result.total);
    expect(message.rows.written).toBeGreaterThan(ack.accepted);
  });

  it("reports a replay of the same batch as duplicates that persist nothing", async () => {
    const host = await createHost("replayed");
    const body = frameFor("linux-normal", host.hostId);
    const first = only((await ingest(host.token, body)).published);
    const replay = await ingest(host.token, body);
    const second = only(replay.published);
    expect(first.operation === "host.ingest" && first.work.persisted).toBe(2);
    expect(second.operation === "host.ingest" && second.work).toMatchObject({ received: 2, persisted: 0, duplicate: 2 });
    expect(await readAck(replay.result)).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
    expect(second.rows.written).toBeLessThan(first.rows.written);
  });

  it("reports a request rejected before any sample was judged with received zero and the bytes it read", async () => {
    const host = await createHost("refused");
    const body = frameFor("linux-normal", host.hostId);
    const refused = await ingest("wrong-token", body);
    expect(refused.result.status).toBe(401);
    const message = only(refused.published);
    expect(message.operation === "host.ingest" && message.work).toEqual({ received: 0, persisted: 0, duplicate: 0, rejected: { invalid_sample: 0, too_old: 0, conflict: 0 }, inputBytes: body.byteLength });
    const malformed = await ingest(host.token, new Uint8Array([1, 2, 3]));
    expect(malformed.result.status).toBe(400);
    expect(only(malformed.published).operation).toBe("host.ingest");
  });

  it("flags the synthetic check host and no other", async () => {
    const synthetic = await createHost("synthetic-check");
    const ordinary = await createHost("synthetic-check-2");
    expect(only((await ingest(synthetic.token, frameFor("linux-normal", synthetic.hostId))).published).synthetic).toBe(true);
    expect(only((await ingest(ordinary.token, frameFor("linux-normal", ordinary.hostId))).published).synthetic).toBe(false);
  });
});

describe("history operations", () => {
  async function read(path: string, headers: Record<string, string> = {}) {
    return invoke(async instance => instance.fetch(new Request(`https://installation${path}`, { headers })));
  }

  it("records a host history read as rebuilt and its conditional repeat as hit-304", async () => {
    const host = await createHost("history");
    await ingest(host.token, frameFor("linux-normal", host.hostId));
    const path = `/hosts/${host.hostId}/history?range=1h&kind=summary`;
    const built = await read(path);
    expect(built.result.status).toBe(200);
    const rebuilt = only(built.published);
    expect(rebuilt).toMatchObject({ operation: "host.history", synthetic: false, workloadClass: "raw:summary" });
    expect(rebuilt.operation === "host.history" && rebuilt.work.cache).toBe("rebuilt");
    expect(rebuilt.operation === "host.history" && rebuilt.work.outputBytes).toBe((await built.result.arrayBuffer()).byteLength);
    expect(rebuilt.operation === "host.history" && rebuilt.work.points).toBeGreaterThan(0);

    const repeat = await read(path, { "If-None-Match": built.result.headers.get("etag")! });
    expect(repeat.result.status).toBe(304);
    const hit = only(repeat.published);
    expect(hit.operation === "host.history" && hit.work).toEqual({ points: 0, cells: 0, outputBytes: 0, cache: "hit-304" });
    expect(hit.rows.statements).toBeGreaterThan(0);
    expect(hit.rows.written).toBe(0);
  });

  it("separates a bundle from a single kind and marks the synthetic host", async () => {
    const host = await createHost("synthetic-check");
    await ingest(host.token, frameFor("linux-normal", host.hostId));
    const bundle = only((await read(`/hosts/${host.hostId}/history?range=6h&kinds=summary,disks`)).published);
    expect(bundle).toMatchObject({ operation: "host.history", synthetic: true, workloadClass: "raw:bundle" });
  });

  it("records a project history read as rebuilt and its conditional repeat as hit-304", async () => {
    await invoke(async instance => instance.recordCollectorRun(run({ points: [{ metric: "worker.invocations", bucketMs: NOW - 600_000 - ((NOW - 600_000) % 300_000), value: 4 }] })));
    const path = "/projects/stuff/history?range=1h&kind=worker";
    const built = await read(path);
    expect(built.result.status).toBe(200);
    const rebuilt = only(built.published);
    expect(rebuilt).toMatchObject({ operation: "project.history", synthetic: false, workloadClass: "samples:worker" });
    expect(rebuilt.operation === "project.history" && rebuilt.work.cache).toBe("rebuilt");
    const repeat = await read(path, { "If-None-Match": built.result.headers.get("etag")! });
    expect(repeat.result.status).toBe(304);
    const hit = only(repeat.published);
    expect(hit).toMatchObject({ operation: "project.history", workloadClass: "samples:worker" });
    expect(hit.operation === "project.history" && hit.work.cache).toBe("hit-304");
  });

  it("publishes a plain invocation mark for a history request that names no workload", async () => {
    const missing = await read("/hosts/h_00000000000000000000000000000000/history?range=1h");
    expect(missing.result.status).toBe(404);
    expect(missing.published).toHaveLength(1);
    expect(missing.published[0]!.kind).toBe("invocation");
  });

  it("keeps every workload class inside the closed bound", () => {
    const resolutions: HostHistoryResolution[] = ["raw", "1m", "1h"];
    const host = resolutions.flatMap(resolution => [...HISTORY_KINDS.map(kind => [kind]), [...HISTORY_KINDS]].map(kinds => hostHistoryClass(resolution, kinds)));
    const metricKinds = PROJECT_KINDS.filter(kind => kind !== "collector");
    const project = (["samples", "hours"] as const).flatMap(source => [...metricKinds.map(kind => [kind]), [...metricKinds]].map(kinds => projectHistoryClass(source, kinds)));
    project.push(projectHistoryClass("runs", ["collector"]));
    for (const classes of [host, project]) {
      expect(new Set(classes).size).toBeLessThanOrEqual(24);
      for (const workloadClass of classes) expect(workloadClass).toMatch(WORKLOAD_CLASS);
    }
  });
});

describe("background operations", () => {
  it("records a collector run once, and an identical repeat as zero changed rows", async () => {
    const points = [
      { metric: "worker.invocations", bucketMs: 1_793_509_200_000, value: 4 },
      { metric: "worker.invocations", bucketMs: 1_793_509_500_000, value: 6 }
    ];
    const first = only((await invoke(async instance => instance.recordCollectorRun(run({ points })))).published);
    expect(first).toMatchObject({ operation: "collector.record", synthetic: false, work: { runs: 1, metricRows: 2, hourRollups: 1, upstreamQueries: 3 } });
    expect(first.rows.written).toBeGreaterThan(0);
    const repeat = only((await invoke(async instance => instance.recordCollectorRun(run({ points })))).published);
    expect(repeat).toMatchObject({ work: { runs: 1, metricRows: 0, hourRollups: 0, upstreamQueries: 3 } });
  });

  it("counts a failed collector run as zero runs and still publishes its rows", async () => {
    const failed = only((await invoke(async instance => instance.recordCollectorRun({ ...run({ points: [] }), ok: false, detail: "upstream refused" }))).published);
    expect(failed).toMatchObject({ operation: "collector.record", work: { runs: 0, metricRows: 0, hourRollups: 0, upstreamQueries: 3 } });
    expect(failed.rows.written).toBeGreaterThan(0);
  });

  it("records the expiry sweep with the rows it removed", async () => {
    const host = await createHost("retained");
    await ingest(host.token, frameFor("linux-normal", host.hostId));
    await invoke(async (_instance, state) => state.storage.sql.exec("INSERT INTO project_samples (project, metric, bucket_ms, value) VALUES ('stuff', 'worker.invocations', 1000, 1)").rowsWritten);
    const alarmed = messages.length;
    await runDurableObjectAlarm(stub());
    const sweeps = messages.slice(alarmed).filter((message): message is OperationMessage => message.kind === "operation" && message.operation === "cleanup.retention");
    const removing = sweeps.filter(message => message.operation === "cleanup.retention" && message.work.expired > 0);
    expect(removing).toHaveLength(1);
    const message = removing[0]!;
    expect(message.operation === "cleanup.retention" && message.work.backlog).toBe(0);
    expect(message.rows.statements).toBeGreaterThanOrEqual(5);
    expect(sweeps.every(sweep => sweep.rows.statements >= 5)).toBe(true);
  });

  it("records a deployment poll once even when it is refused", async () => {
    const poll = { project: "stuff", worker: "stuff", atMs: NOW, error: null, truncated: false, versions: [], deployments: [] };
    const accepted = await invoke(async instance => instance.recordDeploymentPoll(poll));
    const message = only(accepted.published);
    expect(message.operation).toBe("deployments.poll");
    expect(message.rows.written).toBeGreaterThan(0);
    const refused = messages.length;
    await expect(runInDurableObject(stub(), async (instance: Installation) => instance.recordDeploymentPoll({ ...poll, project: "unknown" }))).rejects.toThrow("unknown deployment project");
    const published = messages.slice(refused).filter(entry => entry.kind !== "operation" || entry.operation !== "cleanup.retention");
    expect(published.map(entry => entry.kind === "operation" ? entry.operation : entry.kind)).toEqual(["deployments.poll"]);
  });
});
