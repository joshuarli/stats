import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { test } from "node:test";

const REPO = resolve(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);

await test("the pinned native Rivet actor probe passes locally with persisted SQLite", { timeout: 900_000 }, async () => {
  const runId = `rivet-eval-native-${process.pid}-${Date.now()}`;
  let report: { result?: string; reason?: string | null };
  try {
    const { stdout } = await execFileAsync(process.execPath, [join(REPO, "experiments/rivet/native/probe.mts"), runId], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    const tail = stdout.lastIndexOf("\n{");
    report = JSON.parse(tail === -1 ? stdout : stdout.slice(tail + 1)) as typeof report;
  } catch (error) {
    const detail = error instanceof Error ? ("stdout" in error ? String((error as { stdout?: string }).stdout ?? "") : error.message) : String(error);
    throw new Error(`native probe did not produce a pass result; candidate bootstrap missing? run node scripts/rivet-eval.mjs bootstrap first.\n${detail}`);
  }
  assert.equal(report.result, "pass", `native probe failed: ${report.reason ?? ""}`);
});
