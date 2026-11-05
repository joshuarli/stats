import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCRATCH, startStack } from "../../local/stack.ts";
import { STATS_OUTPUT } from "../../local/topology.ts";

const HEALTH_ROUTE = `if (path === "/health" && request.method === "GET")`;

await test("an outbound request the scenario did not declare fails the run and names the URL", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const planted = mkdtempSync(join(SCRATCH, "planted-"));
  try {
    cpSync(STATS_OUTPUT, planted, { recursive: true });
    const bundle = join(planted, "bundle/index.js");
    const source = readFileSync(bundle, "utf8");
    assert.equal(source.split(HEALTH_ROUTE).length, 2, "the built bundle has one health route to plant beside");
    writeFileSync(bundle, source.replace(HEALTH_ROUTE, `if (path === "/planted-outbound") return fetch("https://example.com/");\n\t${HEALTH_ROUTE}`));
    const stack = await startStack({ nowMs: null, statsOutput: planted });
    const response = await stack.anonymous("/planted-outbound");
    await response.arrayBuffer();
    assert.deepEqual(stack.outbound.unexpected().map(request => request.url), ["https://example.com/"]);
    await assert.rejects(stack.dispose(), /unexpected outbound requests from the local stack: https:\/\/example\.com\/ \(during startup\)/u);
  } finally {
    rmSync(planted, { recursive: true, force: true });
  }
});
