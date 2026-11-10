import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCRATCH } from "../../local/stack.ts";
import { readWorkerProducer } from "../../local/worker-producer.ts";

const BASE = {
  name: "profile-fixture",
  compatibilityDate: "2026-10-30",
  compatibilityFlags: ["nodejs_compat"],
  env: {},
  exports: {},
  manifest: { type: "partial", mainModule: "index.js", modules: {} }
};

const planted: string[] = [];

function plant(name: string, config: Record<string, unknown>): string {
  mkdirSync(SCRATCH, { recursive: true });
  const output = mkdtempSync(join(SCRATCH, `producer-refusal-${name}-`));
  writeFileSync(join(output, "worker.config.json"), JSON.stringify(config));
  planted.push(output);
  return output;
}

await test("the built-worker producer refuses names and bindings it cannot host", () => {
  try {
    const output = plant("ok", BASE);
    const withEnv = (env: Record<string, unknown>) => ({ ...BASE, env });
    assert.throws(() => readWorkerProducer(output, "stats", 41001), /stats is already an observed service/u);
    assert.throws(() => readWorkerProducer(output, "Nan oshop", 41001), /is not a service name/u);
    assert.throws(() => readWorkerProducer(plant("kv", withEnv({ CACHE: { type: "kv", id: "x" } })), "profile-fixture", 41001), /binding type "kv"/u);
    assert.throws(() => readWorkerProducer(plant("worker", withEnv({ OTHER: { type: "worker", worker: "other" } })), "profile-fixture", 41001), /is a worker binding/u);
    assert.throws(() => readWorkerProducer(plant("cron", { ...BASE, triggers: [{ type: "scheduled", schedule: "*/5 * * * *" }] }), "profile-fixture", 41001), /cron triggers/u);
    assert.throws(() => readWorkerProducer(plant("tail", { ...BASE, tailConsumers: [{ worker: "elsewhere" }] }), "profile-fixture", 41001), /tails into elsewhere/u);
    assert.equal(readWorkerProducer(output, "profile-fixture", 41001).origin, "http://127.0.0.1:41001");
  } finally {
    for (const output of planted) rmSync(output, { recursive: true, force: true });
  }
});
