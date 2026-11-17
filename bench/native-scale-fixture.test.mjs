import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const mode of ["prepare", "ingest-cost"]) test(`external ${mode} rejects a production namespace before creating state`, { skip: process.platform !== "linux" || !existsSync("/.dockerenv") }, () => {
  const root = mkdtempSync("/bench/native-scale-safety-");
  try {
    const target = join(root, "fixture");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./native-scale-fixture.mjs", import.meta.url)), "--root", target, "--image", "stats:6cc06db247a3", "--mode", mode], { encoding: "utf8", timeout: 5000, env: { ...process.env, RIVET_ENDPOINT: "http://127.0.0.1:44794", RIVET_NAMESPACE: "stats-prod", RIVET_NODE_VERSION: "24" } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /external preparation requires a dedicated fixture namespace/u);
    assert.equal(existsSync(target), false);
  } finally { rmSync(root, { recursive: true }); }
});
