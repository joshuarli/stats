import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("an Engine that exits before readiness fails cleanly without leaking credentials", { skip: process.platform !== "linux" || !existsSync("/.dockerenv") }, () => {
  const root = mkdtempSync("/bench/native-engine-failure-");
  const credential = "fixture-engine-test-credential-0123456789";
  try {
    const binary = join(root, "exit-engine"), program = "#!/bin/sh\nexit 7\n";
    writeFileSync(binary, program, { mode: 0o700 });
    writeFileSync(join(root, "runtime-auth.json"), JSON.stringify({ engineToken: credential }), { mode: 0o600 });
    const config = { topology: { datacenters: { default: { public_url: "http://127.0.0.1:44990" } } }, guard: { host: "127.0.0.1" }, api_peer: { host: "127.0.0.1" }, metrics: { host: "127.0.0.1" }, storage: { log_directory: join(root, "log") }, object_storage: { primary: { file_system: { path: join(root, "objects") } } } };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./native-scale-engine.mjs", import.meta.url)), "--root", root, "--binary", binary, "--sha256", createHash("sha256").update(program).digest("hex")], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private Engine readiness failed/u);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/u);
    assert.ok(!result.stdout.includes(credential) && !result.stderr.includes(credential));
    const evidence = JSON.parse(readFileSync(join(root, "readiness.json"), "utf8"));
    assert.equal(evidence.ready, false);
    assert.equal(evidence.timingAcceptance, false);
  } finally { rmSync(root, { recursive: true }); }
});
