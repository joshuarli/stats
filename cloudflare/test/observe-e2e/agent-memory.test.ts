import assert from "node:assert/strict";
import test from "node:test";

import { start, until, type Page, type TraceSummary } from "./harness.ts";

await test("the real usr-memories bundle publishes its operation message through stats-observe", async () => {
  if (process.env.AGENT_MEMORY_DIR === undefined) return;
  const harness = await start("attached");
  try {
    const response = await harness.memories("/api/v1/status");
    assert.equal(response.status, 200, await response.clone().text());
    const page = await until(
      () => harness.observeService("usr-memories", "/traces?limit=100") as Promise<Page<TraceSummary>>,
      value => value.items.length > 0,
      "a usr-memories trace",
    );
    assert.equal(page.items[0]?.label, "GET /api/v1/status");
    assert.equal(page.items[0]?.status, 200);
  } finally {
    await harness.dispose();
  }
});
