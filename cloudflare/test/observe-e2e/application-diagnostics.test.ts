import test from "node:test";
import assert from "node:assert/strict";
import { encode } from "@jridgewell/sourcemap-codec";
import { parseStack } from "../../src/observe/core/stack.ts";
import { accessHeaders, start, until } from "./harness.ts";
import type { ExternalEventRecord } from "../../src/observe/ingest/model.ts";

await test("the application composition forwards caught errors without tracing or tails", async () => {
  const harness = await start("attached", { PROJECTS: "[" }, undefined, "wall", "v1", true);
  try {
    assert.equal((await harness.stats("/api/v1/projects", { headers: await accessHeaders() })).status, 503);
    const events = await until(async () => (await harness.observe("/external") as { events: ExternalEventRecord[] }).events, items => items.some(item => item.event.error?.code === "projects.config"), "the application error event");
    const event = events.find(item => item.event.error?.code === "projects.config")!.event;
    assert.equal(event.outcome, "error");
    assert.equal(event.diagnostics?.version, 1);
    assert.equal(event.diagnostics?.message, "");
    assert.ok((event.diagnostics?.frames.length ?? 0) > 0);
    const frame = parseStack(event.diagnostics!.frames.join("\n"))[0]!;
    const mappings: number[][][] = Array.from({ length: frame.line }, () => []);
    mappings[frame.line - 1]!.push([frame.column - 1, 0, 9, 0, 0]);
    const map = JSON.stringify({ version: 3, sources: ["src/orange.ts"], names: ["mappedError"], mappings: encode(mappings) });
    const artifact = await (await harness.mf.getWorker("stats-observe")).fetch(`https://observe/stats/artifacts/v1/${frame.file}`, { method: "PUT", body: map });
    assert.equal(artifact.status, 201);
    const response = await harness.stats("/api/observe/stats/issues", { headers: await accessHeaders() });
    assert.equal(response.status, 200);
    const issues = await response.json() as { items: { operation: string; frame: string | null }[] };
    assert.ok(issues.items.some(issue => issue.operation === "projects.config" && issue.frame === "mappedError (src/orange.ts:10)"));
  } finally { await harness.dispose(); }
});
