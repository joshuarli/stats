import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { attributeSamples, checkNeeds, parsePs, parsePsCpuMs, runWorkload, workloadMembers } from "./workload.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = () => {
  const base = join(root, ".work/tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "workload-test-"));
};

test("ps CPU time parses macOS and procps formats", () => {
  assert.equal(parsePsCpuMs("0:01.25"), 1250);
  assert.equal(parsePsCpuMs("01:02:03"), 3_723_000);
  assert.equal(parsePsCpuMs("2-00:00:01"), 172_801_000);
  assert.throws(() => parsePsCpuMs("soon"));
});

test("membership follows the process group and processes started in other groups", () => {
  const rows = [
    "  10    1   10  2048 0:01.00 /usr/bin/python3",
    "  12   11   12  8192 0:09.00 /opt/Google Chrome for Testing",
    "  11   10   10  4096 0:02.50 node",
    "  13    1   13  1024 0:00.10 unrelated",
    "  14    1   10   512 0:00.20 orphan",
  ].join("\n");
  const known = new Set();
  assert.deepEqual(workloadMembers(parsePs(rows), 10, known).map(p => [p.pid, p.command, p.rssBytes, p.cpuMs]), [
    [10, "python3", 2_097_152, 1000],
    [12, "Google Chrome for Testing", 8_388_608, 9000],
    [11, "node", 4_194_304, 2500],
    [14, "orphan", 524_288, 200],
  ]);
  const reparented = "  12    1   12  8192 0:09.50 /opt/Google Chrome for Testing\n  13    1   13  1024 0:00.10 unrelated";
  assert.deepEqual(workloadMembers(parsePs(reparented), 10, known).map(p => p.pid), [12]);
});

test("attribution keeps each process's last CPU, its running name and the concurrent group peak", () => {
  const result = attributeSamples([
    [{ pid: 1, command: "node", cpuMs: 100, rssBytes: 10 }, { pid: 2, command: "node", cpuMs: 50, rssBytes: 30 }],
    [{ pid: 1, command: "node", cpuMs: 300, rssBytes: 20 }, { pid: 3, command: "workerd", cpuMs: 400, rssBytes: 5 }, { pid: 2, command: "<defunct>", cpuMs: 60, rssBytes: 0 }],
    [{ pid: 3, command: "(workerd)", cpuMs: 410, rssBytes: 0 }, { pid: 4, command: "(chrome-headless-)", cpuMs: 7, rssBytes: 0 }],
  ]);
  assert.equal(result.peakGroupRssBytes, 40);
  assert.deepEqual(result.commands, [
    { command: "workerd", processes: 1, cpuMs: 410, peakRssBytes: 5 },
    { command: "node", processes: 2, cpuMs: 360, peakRssBytes: 30 },
    { command: "chrome-headless-", processes: 1, cpuMs: 7, peakRssBytes: 0 },
  ]);
});

test("a workload's CPU includes descendants, including those in their own process group", async () => {
  const dir = scratch();
  try {
    const burn = "const end = Date.now() + 1500; let x = 0; while (Date.now() < end) x++; const keep = Buffer.alloc(64 * 1024 * 1024, 1); setTimeout(() => keep.length, 200);";
    const parent = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(burn)}], { detached: true, stdio: "inherit" }); c.on("exit", () => console.log("done"));`;
    const result = await runWorkload({ root, command: ["node", "-e", parent], resourcePath: join(dir, "resources.json"), attribute: true });
    assert.equal(result.exit, 0);
    assert.match(result.output, /done/u);
    const { waited, attribution } = result.resources;
    assert.ok(waited.userCpuMs + waited.systemCpuMs >= 1200, `descendant CPU missing: ${JSON.stringify(waited)}`);
    assert.ok(waited.peakProcessRssBytes >= 64 * 1024 * 1024);
    const node = attribution.commands.find(c => c.command === "node");
    assert.equal(node.processes, 2);
    assert.ok(node.cpuMs >= 500, JSON.stringify(attribution));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an uninstrumented run records waited usage without sampling", async () => {
  const dir = scratch();
  try {
    const result = await runWorkload({ root, command: ["node", "-e", "process.exit(3)"], resourcePath: join(dir, "resources.json") });
    assert.equal(result.exit, 3);
    assert.equal(result.resources.attribution, undefined);
    assert.equal(typeof result.resources.waited.userCpuMs, "number");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("preflight rejects changed fixtures and stale installs and records identities", () => {
  const dir = scratch();
  try {
    const git = (...args) => assert.equal(spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" }).status, 0);
    git("init", "-q");
    mkdirSync(join(dir, "fixtures"));
    writeFileSync(join(dir, "fixtures/a.json"), "{}\n");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "---\nlockfileVersion: '9.0'\nenv: {}\n\n---\nlockfileVersion: '9.0'\nproject: {}\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "fixture");
    mkdirSync(join(dir, "node_modules/.pnpm"), { recursive: true });
    writeFileSync(join(dir, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: '9.0'\nproject: {}\n");

    const clean = checkNeeds(dir, [{ tracked: "fixtures" }, { install: true }]);
    assert.deepEqual(clean.errors, []);
    assert.match(clean.identities[0].object, /^[0-9a-f]{40}$/u);
    assert.equal(clean.identities[1].kind, "install");

    writeFileSync(join(dir, "fixtures/extra.json"), "{}\n");
    writeFileSync(join(dir, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: '9.0'\nproject: {old: true}\n");
    const stale = checkNeeds(dir, [{ tracked: "fixtures" }, { install: true }, { tracked: "missing.json" }]);
    assert.deepEqual(stale.errors, [
      "fixtures differs from HEAD; restore or commit the fixture before measuring",
      "installed dependencies do not match pnpm-lock.yaml; run pnpm install --frozen-lockfile",
      "missing.json is not tracked; restore the committed fixture",
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
