import assert from "node:assert/strict";
import { test } from "node:test";
import { startStack } from "../../local/stack.ts";
import { plantBeside, plantStatsOutput } from "./support.ts";

const HEALTH_ROUTE = `if (path === "/health" && request.method === "GET")`;

await test("an outbound request the scenario did not declare fails the run and names the URL", async () => {
  const planted = plantStatsOutput(plantBeside(HEALTH_ROUTE, `if (path === "/planted-outbound") return fetch("https://example.com/");`));
  try {
    const stack = await startStack({ nowMs: null, statsOutput: planted.output });
    let disposed = false;
    try {
      await (await stack.anonymous("/planted-outbound")).arrayBuffer();
      assert.deepEqual(stack.outbound.unexpected().map(request => request.url), ["https://example.com/"]);
      disposed = true;
      await assert.rejects(stack.dispose(), /unexpected outbound requests from the local stack: https:\/\/example\.com\/ \(during startup\)/u);
    } finally {
      if (!disposed) await stack.dispose().catch(() => undefined);
    }
  } finally {
    planted.remove();
  }
});
