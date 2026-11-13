import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { inventory, ROOT, selectTests } from "../../scripts/test-suites.ts";

await test("discovery owns new suite files and rejects unowned, missing, and unmatched tests", () => {
  const root = mkdtempSync(resolve(ROOT, "../.work/tmp/test-selection-"));
  const plant = (file: string): void => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), ""); };
  try {
    for (const entry of inventory()) plant(entry.file);
    plant("test/ingest/new-conformance.test.ts");
    const entries = inventory(root);
    const [selected] = selectTests(entries, { files: ["test/ingest/new-conformance.test.ts"] });
    assert.equal(selected!.runner, "node");
    assert.deepEqual(selected!.prerequisites, []);
    assert.throws(() => selectTests(entries, { files: ["test/ingest/nonexistent.test.ts"] }), /unmatched/u);
    assert.throws(() => selectTests(entries, { suites: ["nonexistent"] }), /unknown suite/u);
    plant("test/unregistered/something.test.ts");
    assert.throws(() => inventory(root), /unowned test/u);
    rmSync(join(root, "test/unregistered"), { recursive: true });
    rmSync(join(root, "test/node/parity.test.ts"));
    assert.throws(() => inventory(root), /declared test does not exist/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("focused ingest execution selects one file without compiling Workers", () => {
  const result = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--file", "test/ingest/conformance.test.ts"], { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /selected 1\//u);
  assert.match(result.stderr, /tests \d+/u);
  assert.doesNotMatch(result.stderr, /vite v|workerd|building .*environment/u);
  const unmatched = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--file", "test/ingest/conformance.test.ts", "--name", "no-test-has-this-name"], { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 15_000 });
  assert.equal(unmatched.status, 1, unmatched.stdout + unmatched.stderr);
  assert.match(unmatched.stderr, /unmatched test name filter/u);
});

await test("package scripts preserve the pinned Node and ignore a host shell that resets PATH", () => {
  const scratch = mkdtempSync(resolve(ROOT, "../.work/tmp/script-shell-"));
  try {
    const shell = join(scratch, "host-shell");
    writeFileSync(shell, '#!/bin/sh\necho HOST_SHELL_MUST_NOT_RUN >&2\nexit 99\n');
    chmodSync(shell, 0o755);
    const result = spawnSync("pnpm", ["--dir", ROOT, "test:binary"], { env: { ...process.env, SHELL: shell }, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stderr, /HOST_SHELL_MUST_NOT_RUN|use Node v/u);
    assert.match(result.stdout, /node completed/u);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
