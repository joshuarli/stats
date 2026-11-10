import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCRATCH, startStack } from "../../local/stack.ts";
import { CLOUDFLARE_ROOT } from "../../local/topology.ts";
import { parseProducerVars } from "../../local/worker-producer.ts";

const NAME = "profile-vars-fixture";
const FIXTURE = join(CLOUDFLARE_ROOT, "test/fixtures/profile/built");
const BUNDLE = `export default {
  fetch(request, env) {
    const name = new URL(request.url).searchParams.get("name");
    return Response.json({ value: name === null ? null : (env[name] ?? null) });
  }
};
`;

function plant(name: string): string {
  mkdirSync(SCRATCH, { recursive: true });
  const output = mkdtempSync(join(SCRATCH, `producer-vars-${name}-`));
  mkdirSync(join(output, "bundle"));
  writeFileSync(join(output, "bundle/index.js"), BUNDLE);
  writeFileSync(join(output, "worker.config.json"), JSON.stringify({
    name: NAME,
    compatibilityDate: "2026-10-30",
    compatibilityFlags: ["nodejs_compat"],
    env: { GREETING: { type: "text", value: "built greeting" } },
    exports: {},
    manifest: { type: "partial", mainModule: "index.js", modules: {} }
  }));
  return output;
}

async function value(origin: string, name: string): Promise<unknown> {
  const response = await fetch(`${origin}/?name=${encodeURIComponent(name)}`);
  assert.equal(response.status, 200);
  return (await response.json() as { value: unknown }).value;
}

await test("producer vars refuse a missing separator, an empty or malformed name, and duplicates", () => {
  assert.throws(() => parseProducerVars(["GREETING"]), /needs NAME=VALUE/u);
  assert.throws(() => parseProducerVars(["=value"]), /is not a producer var name/u);
  assert.throws(() => parseProducerVars(["lower=value"]), /is not a producer var name/u);
  assert.throws(() => parseProducerVars(["1LEADING=value"]), /is not a producer var name/u);
  assert.throws(() => parseProducerVars([`${"A".repeat(65)}=value`]), /is not a producer var name/u);
  assert.throws(() => parseProducerVars(["SECRET=first", "SECRET=second"]), /SECRET is given more than once/u);
  assert.deepEqual(parseProducerVars(["EMPTY=", "EQUALS=a=b"]), { EMPTY: "", EQUALS: "a=b" });
});

await test("producer vars override a built text binding and add new ones", async () => {
  const output = plant("host");
  try {
    const vars = parseProducerVars(["GREETING=injected greeting", "NEW_VAR=added value"]);
    const stack = await startStack({ nowMs: null, workerProducers: [{ dir: output, service: NAME, vars }] });
    try {
      const origin = stack.workerProducers[0]!.origin;
      assert.equal(await value(origin, "GREETING"), "injected greeting");
      assert.equal(await value(origin, "NEW_VAR"), "added value");
      assert.equal(await value(origin, "ABSENT"), null);
    } finally {
      await stack.dispose();
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

await test("the checked-in fixture producer serves an injected text binding", async () => {
  const vars = parseProducerVars(["GREETING=injected greeting"]);
  const stack = await startStack({ nowMs: null, workerProducers: [{ dir: FIXTURE, service: "profile-fixture-vars", vars }] });
  try {
    const response = await fetch(`${stack.workerProducers[0]!.origin}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "injected greeting");
  } finally {
    await stack.dispose();
  }
});

await test("the local-stack CLI refuses a malformed --producer-var before starting the stack", () => {
  const run = (entry: string) => spawnSync(process.execPath, ["scripts/local-stack.mjs", "run", "--producer-worker", "/nonexistent", "--producer-var", entry, "--", "true"], { cwd: CLOUDFLARE_ROOT, encoding: "utf8" });
  for (const entry of ["GREETING", "=value", "lower=value"]) {
    const result = run(entry);
    assert.equal(result.status, 2, `${entry}: ${result.stderr}`);
    assert.match(result.stderr, /local-stack: /u);
  }
});
