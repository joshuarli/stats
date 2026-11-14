import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { GATEWAY_IDENTITY_HEADER, GATEWAY_SECRET_HEADER } from "../../cloudflare/src/cloudflare/gateway.ts";
import type { ExternalEventRecord } from "../../cloudflare/src/observe/ingest/model.ts";
import { generate } from "./generate.mts";
import { freePort, startSession, type Session } from "./session.mts";

await test("OpenOrange persists caught-error diagnostics without platform tails", async () => {
  const root = resolve(import.meta.dirname, "../../.work/tmp", `orange-diagnostics-${process.pid}`);
  mkdirSync(root, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  const generated = generate(root, { kind: "dev", release: "diagnostics", gatewaySecret: secret, nowMs: null });
  const config = JSON.parse(readFileSync(generated.stats, "utf8")) as { vars: Record<string, string> };
  config.vars["PROJECTS"] = "[";
  writeFileSync(generated.stats, JSON.stringify(config), { mode: 0o600 });
  const headers = { [GATEWAY_SECRET_HEADER]: secret, [GATEWAY_IDENTITY_HEADER]: "tags:tag:ci" };
  let session: Session | undefined;
  const events = async (): Promise<ExternalEventRecord[]> => {
    const response = await fetch(`${session!.origin}/api/observe/stats/external`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as { events: ExternalEventRecord[] }).events;
  };
  try {
    session = await startSession(root, await freePort());
    assert.equal((await fetch(`${session.origin}/api/v1/projects`, { headers })).status, 503);
    let caught: ExternalEventRecord | undefined;
    const deadline = Date.now() + 10_000;
    while (caught === undefined && Date.now() < deadline) {
      caught = (await events()).find(item => item.event.error?.code === "projects.config");
      if (caught === undefined) await new Promise(done => setTimeout(done, 50));
    }
    assert.ok(caught, "the caught configuration error reaches the observation object");
    assert.equal(caught.event.outcome, "error");
    assert.equal(caught.event.release, "diagnostics");
    assert.equal(caught.event.diagnostics?.version, 1);
    assert.equal(caught.event.diagnostics?.message, "");
    assert.ok((caught.event.diagnostics?.frames.length ?? 0) > 0);
    const issues = await fetch(`${session.origin}/api/observe/stats/issues`, { headers });
    assert.equal(issues.status, 200);
    assert.ok((await issues.json() as { items: { operation: string }[] }).items.some(item => item.operation === "projects.config"));
    await session.stop();
    session = await startSession(root, await freePort());
    const restored = (await events()).find(item => item.event.eventId === caught.event.eventId);
    assert.deepEqual(restored?.event.diagnostics, caught.event.diagnostics);
  } finally {
    await session?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
