import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSymbolicator } from "../../src/observe/core/symbolicate.ts";
import { ROOT } from "./harness.ts";

const BUNDLE = join(ROOT, ".cloudflare/output/v0/workers/default/bundle/index.js");

await test("a throw site in the built stats bundle maps back to the source line that throws", () => {
  const bundle = readFileSync(BUNDLE, "utf8");
  const map = readFileSync(`${BUNDLE}.map`, "utf8");
  const needle = 'throw new Error("invalid_response")';
  const offset = bundle.indexOf(needle);
  assert.ok(offset > 0, "the bundle contains the deployment collector's throw");
  const before = bundle.slice(0, offset).split("\n");
  const line = before.length;
  const column = before.at(-1)!.length + 1;
  const [frame] = createSymbolicator(() => map)([{ fn: null, file: "index.js", line, column }], "any-version");
  assert.ok(frame?.original !== null && frame?.original !== undefined, "the frame resolves");
  assert.equal(frame.original.file, "src/deployments/collector.ts");
  const sourceLine = readFileSync(join(ROOT, frame.original.file), "utf8").split("\n")[frame.original.line - 1] ?? "";
  assert.ok(sourceLine.includes("invalid_response"), `line ${frame.original.line} is "${sourceLine.trim()}"`);
});
