import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { test } from "node:test";

const REPO = resolve(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);

test("the pinned OpenOrange candidate passes the required parity corpus offline", { timeout: 900_000 }, async () => {
  const runId = `rivet-eval-parity-${process.pid}-${Date.now()}`;
  let report: { result?: string; reason?: string | null };
  try {
    const { stdout } = await execFileAsync(process.execPath, [join(REPO, "experiments/rivet/openorange/parity.mts"), runId], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    report = JSON.parse(stdout) as typeof report;
  } catch (error) {
    const detail = error instanceof Error ? ("stdout" in error ? String((error as { stdout?: string }).stdout ?? "") : error.message) : String(error);
    throw new Error(`parity did not produce a pass result; candidate bootstrap missing? run node scripts/rivet-eval.mjs bootstrap first.\n${detail}`);
  }
  assert.equal(report.result, "pass", `parity failed: ${report.reason ?? ""}`);
});
