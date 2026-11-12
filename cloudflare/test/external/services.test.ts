import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { processOwner } from "../../scripts/processes.ts";

await test("real Tansu and Niceforge telemetry, degraded delivery, and deploy receipt scenarios", { timeout: 300_000 }, async () => {
  const tansu = process.env["TANSU_DIR"];
  const niceforge = process.env["NICEFORGE_DIR"];
  assert.ok(tansu !== undefined && niceforge !== undefined, "set TANSU_DIR and NICEFORGE_DIR to prepared checkouts; see docs/testing.md");
  const owner = processOwner("external-services");
  try {
    const rust = await owner.run("tansu", "cargo", ["test", "--test", "telemetry", "--test", "telemetry_degraded", "--test", "deploy_state"], { cwd: tansu, env: process.env });
    const tansuOutput = readFileSync(rust.logPath, "utf8");
    for (const name of ["a_note_save_and_search_publish_operation_records_with_the_release", "a_marker_is_recorded_once_and_a_failed_post_retries_with_the_same_id", "a_save_succeeds_when_stats_is_unreachable_and_drops_stay_bounded"]) assert.ok(tansuOutput.includes(name), name);
    assert.match(tansuOutput, /test result: ok/u);
    const node = await owner.run("niceforge", "pnpm", ["exec", "vitest", "run", "--config", "vitest.forge-hosted.config.ts", "tests/forge/hosted/telemetry.hosted.ts", "--reporter=verbose"], { cwd: niceforge, env: process.env });
    const niceforgeOutput = readFileSync(node.logPath, "utf8");
    assert.match(niceforgeOutput, /records health and operation observations with the release and no content or credentials/u);
    assert.match(niceforgeOutput, /1 passed/u);
    assert.match(niceforgeOutput, /Test Files/u);
  } finally { await owner.close(); }
});
