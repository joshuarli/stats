import { join } from "node:path";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";
import { createClient, type Client } from "rivetkit/client";
import { decodeFrame } from "../../../cloudflare/src/ingest/frame.ts";
import { validateSample } from "../../../cloudflare/src/ingest/sample.ts";
import { canonicalJson } from "../../../cloudflare/src/protocol.ts";
import { ROOT } from "../openorange/generate.mts";
import { freePort, processTree } from "../openorange/harness.mts";

export interface NativeProbeOptions { readonly runId: string }

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS samples (host_id TEXT NOT NULL, boot_id TEXT NOT NULL, seq TEXT NOT NULL, at_ms INTEGER NOT NULL, mono_ms INTEGER NOT NULL, cpu_total TEXT, payload TEXT NOT NULL, PRIMARY KEY (host_id, boot_id, seq)) STRICT",
  "CREATE TABLE IF NOT EXISTS rollups (bucket INTEGER PRIMARY KEY, samples INTEGER NOT NULL) STRICT",
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT",
  "CREATE TABLE IF NOT EXISTS schedule_log (note TEXT NOT NULL, at_ms INTEGER NOT NULL) STRICT",
];

const probe = actor({
  db: db({ onMigrate: async client => { for (const statement of SCHEMA) await client.execute(statement); } }),
  onFork: async (c, fork) => {
    await c.db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('fork_of', ?)", fork.actorId);
  },
  actions: {
    ingest(c, rows: readonly Record<string, string>[]) {
      return c.db.transaction(async tx => {
        let written = 0;
        for (const row of rows) {
          const inserted = await tx.execute(
            "INSERT OR IGNORE INTO samples (host_id, boot_id, seq, at_ms, mono_ms, cpu_total, payload) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
            row["hostId"], row["bootId"], row["seq"], Number(row["atMs"]), Number(row["monoMs"]), row["cpuTotal"], row["payload"]);
          written += inserted.length;
        }
        return { written };
      }, { name: "ingest" });
    },
    counts(c) {
      return c.db.execute<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, SUM(LENGTH(payload)) AS bytes FROM samples").then(rows => ({ count: Number(rows[0]?.["n"] ?? 0), payloadBytes: Number(rows[0]?.["bytes"] ?? 0) }));
    },
    failingTransaction(c) {
      return c.db.transaction(async tx => {
        await tx.execute("INSERT INTO samples (host_id, boot_id, seq, at_ms, mono_ms, cpu_total, payload) VALUES ('h', 'b', 'rollback-probe', 1, 1, '1', '{}')");
        throw new Error("intentional rollback probe");
      }, { name: "rollback-probe" });
    },
    upsertRollup(c, bucket: number, samples: number) {
      return c.db.transaction(async tx => {
        const rows = await tx.execute<{ samples: number }>("INSERT INTO rollups (bucket, samples) VALUES (?, ?) ON CONFLICT (bucket) DO UPDATE SET samples = samples + excluded.samples RETURNING samples", bucket, samples);
        return { samples: Number(rows[0]?.["samples"] ?? 0) };
      }, { name: "rollup" });
    },
    scheduleMaintenance(c, delayMs: number) {
      return c.schedule.after(delayMs, "tick", "probe").then(id => ({ id }));
    },
    tick(c, note: string) {
      return c.db.execute("INSERT INTO schedule_log (note, at_ms) VALUES (?, ?)", note, Date.now()).then(() => ({ ok: true }));
    },
    scheduleState(c) {
      return Promise.all([c.db.execute<{ note: string }>("SELECT note FROM schedule_log"), c.schedule.list()]).then(([rows, pending]) => ({ fired: rows.map(row => row["note"]), pending: pending.length }));
    },
    setMarker(c, value: string) {
      return c.db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('marker', ?)", value).then(() => ({ ok: true }));
    },
    marker(c) {
      return c.db.execute<{ v: string }>("SELECT v FROM meta WHERE k = 'marker'").then(rows => ({ marker: rows[0]?.["v"] ?? null }));
    },
  },
});

function fixtureRows(framePath: string): readonly Record<string, string>[] {
  const bytes = new Uint8Array(readFileSync(join(ROOT, "fixtures/v2", framePath)));
  const decoded = decodeFrame(bytes);
  if (!decoded.ok) throw new Error(`${framePath}: ${decoded.code} ${decoded.message}`);
  const rows: Record<string, string>[] = [];
  for (const sample of decoded.batch.samples) {
    const result = validateSample(sample);
    if (!result.ok) continue;
    const normalized = result.sample;
    rows.push({
      hostId: decoded.batch.hostId,
      bootId: decoded.batch.bootId,
      seq: normalized.seq,
      atMs: normalized.atMs,
      monoMs: normalized.monoMs,
      cpuTotal: normalized.cpu?.total ?? "0",
      payload: canonicalJson(normalized),
    });
  }
  return rows;
}

interface RegistryHandle { readonly registry: ReturnType<typeof setup>; readonly enginePort: number; readonly httpPort: number }

async function startRegistry(enginePort: number, storageDir: string, httpPort: number): Promise<RegistryHandle> {
  const registry = setup({ use: { probe }, enginePort, httpPort, namespace: "default", sqlite: { backend: "local" }, startEngine: true, noWelcome: true });
  await registry.startAndWait();
  return { registry, enginePort, httpPort };
}

const clientFor = async (enginePort: number): Promise<Client<any>> => createClient({ endpoint: `http://127.0.0.1:${enginePort}`, namespace: "default", token: "default", disableMetadataLookup: true });

export async function runNativeProbe(options: NativeProbeOptions): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {};
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => { checks[name] = detail === undefined ? ok : { ok, detail }; if (!ok) failures.push(`${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); };
  const runRoot = join(ROOT, ".work/rivet-eval", options.runId, "native");
  const storageDir = join(runRoot, "storage");
  const tmpDir = join(runRoot, "tmp");
  rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(storageDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  process.env["RIVETKIT_STORAGE_PATH"] = storageDir;
  const enginePort = await freePort();
  const httpPort = await freePort();
  const linuxRows = fixtureRows("frames/linux-normal.stb2");
  const u64Rows = fixtureRows("frames/u64-boundaries.stb2");
  const started = performance.now();
  const timings: Record<string, number> = {};
  const time = async (name: string, fn: () => Promise<void>) => { const at = performance.now(); await fn(); timings[name] = Math.round(performance.now() - at); };

  const control = new DatabaseSync(":memory:");
  for (const statement of SCHEMA) control.exec(statement);
  const controlInsert = (rows: readonly Record<string, string>[]) => { for (const row of rows) control.prepare("INSERT OR IGNORE INTO samples (host_id, boot_id, seq, at_ms, mono_ms, cpu_total, payload) VALUES (?, ?, ?, ?, ?, ?, ?)").run(row["hostId"], row["bootId"], row["seq"], Number(row["atMs"]), Number(row["monoMs"]), row["cpuTotal"], row["payload"]); };

  let handle = await startRegistry(enginePort, storageDir, httpPort);
  let client = await clientFor(enginePort);
  let actor_ = client.probe.getOrCreate(["r4-linux"]);
  try {
    const baseline = await actor_.counts();
    check("freshActorEmpty", baseline.count === 0, baseline);
    await time("ingestLinux", async () => { await actor_.ingest(linuxRows as never); });
    await time("ingestU64", async () => { await actor_.ingest(u64Rows as never); });
    const ingested = await actor_.counts();
    controlInsert(linuxRows); controlInsert(u64Rows);
    const controlCount = Number((control.prepare("SELECT COUNT(*) AS n FROM samples").get() as { n: number }).n);
    const controlBytes = Number((control.prepare("SELECT SUM(LENGTH(payload)) AS b FROM samples").get() as { b: number }).b);
    check("insertMatchesNodeControl", ingested.count === controlCount && ingested.payloadBytes === controlBytes, { actor: ingested, control: { count: controlCount, payloadBytes: controlBytes } });

    const replay = await actor_.ingest(linuxRows as never);
    check("duplicateIngestIgnored", replay.written === 0, replay);

    let rollbackThrew = false;
    try { await actor_.failingTransaction(); } catch { rollbackThrew = true; }
    const afterRollback = await actor_.counts();
    check("failedTransactionRollsBack", rollbackThrew && afterRollback.count === ingested.count, { count: afterRollback.count });

    const rollup1 = await actor_.upsertRollup(1_793_510_400_000, 2);
    const rollup2 = await actor_.upsertRollup(1_793_510_400_000, 3);
    check("rollupAccumulates", rollup1.samples === 2 && rollup2.samples === 5, { first: rollup1, second: rollup2 });

    const scheduled = await actor_.scheduleMaintenance(250);
    let fired: readonly string[] = [];
    for (let attempt = 0; attempt < 50 && fired.length === 0; attempt += 1) { await new Promise(resolveWait => setTimeout(resolveWait, 100)); fired = (await actor_.scheduleState()).fired; }
    check("scheduledTickFired", fired.includes("probe"), { scheduled, fired });

    await actor_.setMarker("parent");
    const parentId = await actor_.resolve();
    const forkA = await client.probe.fork(parentId, { key: ["r4-fork-a"], input: "a" });
    const forkB = await client.probe.fork(parentId, { key: ["r4-fork-b"], input: "b" });
    const forked = await Promise.all([forkA.counts(), forkB.counts()]);
    check("forkStartsWithParentStorage", forked.every(result => result.count === ingested.count && result.payloadBytes === ingested.payloadBytes), forked);
    await Promise.all([forkA.setMarker("a"), forkB.setMarker("b")]);
    const advanced = await actor_.ingest(linuxRows.map(row => ({ ...row, seq: String(Number(row["seq"]) + 60) })) as never);
    const markers = await Promise.all([forkA.marker(), forkB.marker(), actor_.marker()]);
    const afterAdvanced = await actor_.counts();
    const forksAfter = await Promise.all([forkA.counts(), forkB.counts()]);
    check("forkMutationsAreIsolated", markers[0]!.marker === "a" && markers[1]!.marker === "b" && markers[2]!.marker === "parent" && afterAdvanced.count === ingested.count + 2 && forksAfter.every(result => result.count === ingested.count), { markers, parentCount: afterAdvanced.count, forkCounts: forksAfter });
    void advanced;
    await handle.registry.shutdown();

    const enginePort2 = await freePort();
    handle = await startRegistry(enginePort2, storageDir, httpPort);
    client = await clientFor(enginePort2);
    actor_ = client.probe.getOrCreate(["r4-linux"]);
    const restarted = await actor_.counts();
    const restartedMarker = await actor_.marker();
    const restartedRollup = await actor_.upsertRollup(1_793_510_400_000, 0);
    check("durableAcrossRestart", restarted.count === afterAdvanced.count && restarted.payloadBytes === afterAdvanced.payloadBytes, { before: afterAdvanced, after: restarted });
    check("markerSurvivesRestart", restartedMarker.marker === "parent", restartedMarker);
    check("rollupSurvivesRestart", restartedRollup.samples === 5, restartedRollup);
    const tree = processTree(process.pid);
    const workerd = tree.processes.filter(row => /workerd/u.test(row.command));
    check("noWorkerd", workerd.length === 0, workerd.map(row => row.command));
    await handle.registry.shutdown();
  } finally {
    await handle.registry.shutdown().catch(() => {});
    control.close();
  }
  const failedCount = failures.length;
  return {
    command: "native",
    result: failedCount === 0 ? "pass" : "fail",
    reason: failedCount === 0 ? null : failures.join("; "),
    checks,
    failures,
    limits: {
      stateDir: runRoot,
      unproven: [
        "sleep/wake not exposed on the action API surface probed; hibernation not timed",
        "commitTicket/whenDurable are not exposed on RawAccess; durability demonstrated behaviorally via engine restart, not via an acknowledgment API",
        "actor schedule delivery verified (one shot); cron API not exercised",
        "no application integration (Stats core not ported); comparison against Node control is same-fixture only",
      ],
    },
    timings,
    run: { elapsedMs: Math.round(performance.now() - started) },
  };
}

if (import.meta.main) {
  const runId = process.argv[2] ?? `native-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const result = await runNativeProbe({ runId });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.result === "pass" ? 0 : result.result === "fail" ? 1 : 2);
}
