import test from "node:test";
import assert from "node:assert/strict";
import { encode } from "@jridgewell/sourcemap-codec";
import { createSymbolicator } from "../../src/observe/core/symbolicate.ts";
import { createObserveService } from "../../src/observe/core/service.ts";
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACTS } from "../../src/observe/core/limits.ts";
import { prepareInvocation } from "../../src/observe/core/model.ts";
import { database, T0, worker } from "./support.ts";

const MAP = JSON.stringify({ version: 3, file: "index.js", sources: ["../../../src/deployments/collector.ts"], names: ["request"], mappings: encode([[[0, 0, 0, 0]], [], [[4, 0, 57, 10, 0]]]) });

await test("bundle frames resolve to their original file, line, and function, and anything else stays generated", () => {
  const symbolicate = createSymbolicator((version, file) => version === "v1" && file === "index.js" ? MAP : null);
  const [mapped, unmappedLine, otherFile] = symbolicate([
    { fn: "a", file: "index.js", line: 3, column: 5 },
    { fn: "b", file: "index.js", line: 2, column: 1 },
    { fn: "c", file: "chunk.js", line: 3, column: 5 }
  ], "v1");
  assert.deepEqual(mapped!.original, { fn: "request", file: "src/deployments/collector.ts", line: 58, column: 11 });
  assert.equal(unmappedLine!.original, null);
  assert.equal(otherFile!.original, null);
  assert.equal(symbolicate([{ fn: "a", file: "index.js", line: 3, column: 5 }], null)[0]!.original, null);
  assert.equal(symbolicate([{ fn: "a", file: "index.js", line: 3, column: 5 }], "v2")[0]!.original, null);
});

await test("maps are immutable per version and file, validated, and bounded in number", async () => {
  let now = T0;
  const db = database();
  const service = createObserveService(db, { now: () => now, databaseBytes: () => 0 });
  assert.deepEqual(await service.artifact({ version: "v1", file: "index.js", map: MAP }), { result: "accepted" });
  assert.deepEqual(await service.artifact({ version: "v1", file: "index.js", map: MAP }), { result: "duplicate" });
  assert.deepEqual(await service.artifact({ version: "v1", file: "index.js", map: MAP.replace("request", "other") }), { result: "conflict" });
  assert.ok("problem" in await service.artifact({ version: "v1", file: "../index.js", map: MAP }));
  assert.ok("problem" in await service.artifact({ version: "v2", file: "index.js", map: "not json" }));
  assert.ok("problem" in await service.artifact({ version: "v2", file: "index.js", map: JSON.stringify({ version: 2, mappings: "", sources: [] }) }));
  assert.ok("problem" in await service.artifact({ version: "v2", file: "index.js", map: `${MAP}${" ".repeat(MAX_ARTIFACT_BYTES)}` }));
  for (let n = 0; n < MAX_ARTIFACTS + 2; n++) { now += 1; await service.artifact({ version: `v${n + 10}`, file: "index.js", map: MAP }); }
  service.cleanup();
  const kept = db.rows<{ version: string }>("SELECT version FROM observe_artifacts ORDER BY uploaded_at").map(row => row.version);
  assert.deepEqual(kept, Array.from({ length: MAX_ARTIFACTS }, (_, n) => `v${n + 12}`));
});

await test("errors that arrived before their map resolve once it is registered", async () => {
  const db = database();
  const service = createObserveService(db, { now: () => T0 + 1000, databaseBytes: () => 0 });
  const prepared = await prepareInvocation(worker(1, { version: "v1", errors: [{ source: "caught", operation: "deployments.poll", name: "Error", message: "x", stack: "    at request (index.js:3:5)" }] }), { safeNames: new Set() });
  service.ingest([prepared], []);
  const fingerprint = (await service.issues({})).items[0]!.fingerprint;
  assert.equal((await service.occurrences(fingerprint, {})).items[0]!.frames[0]!.original, null);
  await service.artifact({ version: "v1", file: "index.js", map: MAP });
  assert.equal((await service.occurrences(fingerprint, {})).items[0]!.frames[0]!.original?.file, "src/deployments/collector.ts");
  assert.equal((await service.issues({})).items[0]!.frame, "request (src/deployments/collector.ts:58)");
  assert.equal((await service.issue(fingerprint))!.frame, "request (src/deployments/collector.ts:58)");
  const trace = await service.trace((await service.traces({})).items[0]!.traceId!);
  assert.equal(trace?.occurrences[0]?.frames[0]?.original?.line, 58);
});
