import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { test } from "node:test";

const REPO = resolve(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);

await test("the pinned OpenOrange candidate runs the real Stats path and keeps history across restart", { timeout: 600_000 }, async () => {
  const runId = `rivet-eval-test-${process.pid}-${Date.now()}`;
  let report: { result?: string; reason?: string | null };
  try {
    const { stdout } = await execFileAsync(process.execPath, [join(REPO, "experiments/rivet/openorange/pilot.mts"), runId], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    report = JSON.parse(stdout) as typeof report;
  } catch (error) {
    const detail = error instanceof Error ? ("stdout" in error ? String((error as { stdout?: string }).stdout ?? "") : error.message) : String(error);
    throw new Error(`pilot did not produce a pass result; candidate bootstrap missing? run node scripts/rivet-eval.mjs bootstrap first.\n${detail}`);
  }
  assert.equal(report.result, "pass", `pilot failed: ${report.reason ?? ""}`);
});
