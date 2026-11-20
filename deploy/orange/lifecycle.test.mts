import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { generate } from "./generate.mts";
import { freePort, startSession, type Session } from "./session.mts";

const scratch = resolve(import.meta.dirname, "../../.work/tmp");
const fixture = resolve(import.meta.dirname, "fixtures/lifecycle.mjs");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

await test("fixture: native actor eviction, overdue alarm and interrupted identity replay", async () => {
  mkdirSync(scratch, { recursive: true });
  const state = join(scratch, `orange-lifecycle-${process.pid}-${randomBytes(6).toString("hex")}`);
  const secret = randomBytes(32).toString("hex");
  const marker = randomBytes(12).toString("hex");
  const generated = generate(state, { kind: "dev", release: "lifecycle", gatewaySecret: secret, nowMs: null });
  const descriptor = JSON.parse(readFileSync(generated.stats, "utf8"));
  descriptor.main = fixture;
  descriptor.durable_objects.bindings = descriptor.durable_objects.bindings.filter((binding: { name: string }) => binding.name !== "METRICS");
  descriptor.migrations[0].new_sqlite_classes = ["Installation"];
  descriptor.vars.MARKER = marker;
  writeFileSync(generated.stats, JSON.stringify(descriptor));
  const headers = { "Stats-Gateway-Secret": secret, "Stats-Tailnet-Identity": "user:lifecycle@example.com", "Content-Type": "application/json" };
  let session: Session | undefined;
  const start = async () => {
    const next = await startSession(state, await freePort());
    session = next;
    assert.ok(next.readyMs < 15_000, `local readiness ${next.readyMs}ms`);
    console.log(`fixture local readiness: ${next.readyMs}ms`);
    return next;
  };
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${session!.origin}${path}`, { ...init, headers });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<{ generation?: string; rows: { identity: string; value: string }[] }>;
  };
  try {
    session = await start();
    assert.equal((await fetch(`${session.origin}/read`)).status, 401);
    const ack = await request("/write", { method: "POST", body: JSON.stringify({ identity: "ack", value: "exact" }) });
    assert.deepEqual(ack.rows, [{ identity: "ack", value: "exact" }]);
    const before = await request("/read");
    assert.equal(typeof before.generation, "string");
    let after = before;
    const evictionDeadline = Date.now() + 45_000;
    await pause(12_000);
    while (Date.now() < evictionDeadline) {
      after = await request("/read");
      if (after.generation !== before.generation) break;
      await pause(12_000);
    }
    assert.notEqual(after.generation, before.generation, "actor must actually be evicted");
    assert.deepEqual(after.rows, before.rows);
    await request(`/alarm?at=${Date.now() + 5000}`);
    await session.stop();
    session = undefined;
    await pause(6000);
    session = await start();
    const deadline = Date.now() + 30_000;
    while (!session.logs.some(line => line.includes(`LIFECYCLE_ALARM_${marker}`)) && Date.now() < deadline) await pause(100);
    assert.ok(session.logs.some(line => line.includes(`LIFECYCLE_ALARM_${marker}`)), `overdue alarm did not fire before actor read:\n${session.logs.slice(-30).join("\n")}`);
    const alarmState = await request("/read");
    assert.deepEqual(alarmState.rows, [{ identity: "ack", value: "exact" }, { identity: "alarm", value: "fired" }]);
    const controller = new AbortController();
    const pending = request("/write", { method: "POST", signal: controller.signal, body: JSON.stringify({ identity: "pending", value: "exact", delay: 5000 }) });
    const rejected = assert.rejects(pending);
    const pendingDeadline = Date.now() + 10_000;
    while (!session.logs.some(line => line.includes(`LIFECYCLE_PENDING_${marker}`)) && Date.now() < pendingDeadline) await pause(50);
    assert.ok(session.logs.some(line => line.includes(`LIFECYCLE_PENDING_${marker}`)), "pending request reached actor");
    controller.abort();
    await rejected;
    await session.stop();
    session = await start();
    const replay = await request("/write", { method: "POST", body: JSON.stringify({ identity: "pending", value: "exact" }) });
    assert.deepEqual(replay.rows, [{ identity: "ack", value: "exact" }, { identity: "alarm", value: "fired" }, { identity: "pending", value: "exact" }]);
    assert.deepEqual((await request("/write", { method: "POST", body: JSON.stringify({ identity: "pending", value: "exact" }) })).rows, replay.rows);
  } finally {
    await session?.stop();
    const processes = execFileSync("ps", ["-A", "-o", "uid=,args="], { encoding: "utf8" });
    assert.ok(!processes.split("\n").some(line => line.includes("rivet-engine --config ") && line.includes(`${state}/`)), "owned Engine must exit");
    rmSync(state, { recursive: true, force: true });
  }
});
