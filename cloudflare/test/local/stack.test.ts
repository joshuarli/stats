import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import { SCRATCH, ephemeralPrefix, openStatsWorker, startStack } from "../../local/stack.ts";
import { plantBeside, plantStatsOutput } from "./support.ts";

const HEALTH_ROUTE = `if (path === "/health" && request.method === "GET")`;

function stackDirectories(): Set<string> {
  return new Set(readdirSync(SCRATCH).filter(name => name.startsWith(ephemeralPrefix(process.pid))));
}

await test("a restart does not depend on getting its previous port back", async () => {
  const stack = await startStack({ nowMs: null });
  await stack.stop();
  const holder = createServer();
  await new Promise<void>(resolve => holder.listen(Number(new URL(stack.origin).port), "127.0.0.1", resolve));
  try {
    const restarted = await stack.restart({ nowMs: null });
    assert.equal((await restarted.anonymous("/health")).status, 200);
    await restarted.dispose();
  } finally {
    await new Promise(resolve => holder.close(resolve));
  }
});

await test("a stack whose runtime fails to start leaves no scratch directory", async () => {
  const broken = plantStatsOutput(() => "this is not javascript (");
  try {
    const before = stackDirectories();
    await assert.rejects(startStack({ nowMs: null, statsOutput: broken.output }));
    assert.deepEqual([...stackDirectories()].filter(name => !before.has(name)), []);
  } finally {
    broken.remove();
  }
});

await test("a stats test worker fails its disposal on an undeclared outbound request", async () => {
  const planted = plantStatsOutput(plantBeside(HEALTH_ROUTE, `if (path === "/planted-outbound") return fetch("https://example.com/");`));
  try {
    const worker = openStatsWorker({ testNowMs: String(Date.now()), statsOutput: planted.output });
    let disposed = false;
    try {
      await (await worker.mf.dispatchFetch("https://stats.example/planted-outbound")).arrayBuffer();
      disposed = true;
      await assert.rejects(worker.dispose(), /unexpected outbound requests from the local stack: https:\/\/example\.com\//u);
    } finally {
      if (!disposed) await worker.dispose().catch(() => undefined);
    }
  } finally {
    planted.remove();
  }
});
