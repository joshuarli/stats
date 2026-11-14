import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, deploymentOf, resolveOrigin } from "../../src/cli/auth.ts";
import { REGISTRY } from "../../src/cli/commands/index.ts";
import { identityProxy, startNode } from "./node-server.ts";
import { fakeOrigin, runCli } from "./support.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRATCH = resolve(ROOT, "../.work/tmp");

await test("the deployment table decides the target", () => {
  assert.equal(deploymentOf(DEFAULT_ORIGIN, {}).target, "orange");
  assert.equal(deploymentOf("http://127.0.0.1:18790", {}).target, "orange");
  assert.equal(deploymentOf("http://[::1]:18790", {}).target, "orange");
  assert.equal(deploymentOf("http://threadripper.tailcf741.ts.net:18790", {}).target, "node");
  assert.equal(deploymentOf("https://threadripper.tailcf741.ts.net", {}).target, "node");
  assert.equal(deploymentOf("http://threadripper:18790", {}).target, "node");
  assert.throws(() => deploymentOf("https://example.com", {}), /STATSCTL_TARGET/u);
  assert.equal(deploymentOf("https://example.com", { STATSCTL_TARGET: "orange" }).target, "orange");
  assert.equal(deploymentOf("http://127.0.0.1:18790", { STATSCTL_TARGET: "node" }).target, "node");
  assert.throws(() => deploymentOf(DEFAULT_ORIGIN, { STATSCTL_TARGET: "cloudflare" }), /orange or node/u);
  assert.equal(resolveOrigin("http://threadripper:18790", {}), "http://threadripper:18790");
  assert.throws(() => resolveOrigin("http://example.com", {}), /https/u);
});

await test("an unknown origin without STATSCTL_TARGET exits 2 before any request", async () => {
  const run = await runCli(["projects", "--origin", "https://example.com", "--json"]);
  assert.equal(run.code, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /STATSCTL_TARGET/u);
});

await test("an orange-only command against a Node origin exits 2 before any request", async () => {
  const origin = await fakeOrigin((_request, response) => { response.statusCode = 200; response.end("{}"); });
  try {
    const orangeOnly = REGISTRY.commands.filter(command => !command.targets.includes("node"));
    assert.deepEqual(orangeOnly.map(command => command.name).sort(), ["backup export", "backup fence", "backup import", "backup objects", "compare", "cost", "deployments", "health", "observe deployment", "observe issues", "observe operations", "observe rollouts", "observe routes", "observe traces", "projects", "snapshot"]);
    for (const command of orangeOnly) {
      const argv = [...command.name.split(" "), "--origin", "http://threadripper:18790", "--json", ...Object.entries(command.options).flatMap(([name, spec]) => spec.type === "string" && spec.required === true ? [`--${name}`, "x"] : [])];
      const run = await runCli(argv);
      assert.equal(run.code, 2, `${command.name}: ${run.stdout}${run.stderr}`);
      assert.equal((JSON.parse(run.stdout) as { error: { code: string } }).error.code, "unsupported_on_target", command.name);
    }
    assert.equal(origin.seen.length, 0);
  } finally {
    await origin.close();
  }
});

await test("check ingest passes against the Node server behind an identity-adding proxy and sends no credential", async () => {
  const dataDir = mkdtempSync(join(SCRATCH, "target-node-"));
  const node = await startNode(dataDir);
  const seen: IncomingMessage["headers"][] = [];
  const proxy = await identityProxy(node.port, seen);
  try {
    const origin = `http://localhost:${(proxy.address() as AddressInfo).port}`;
    assert.equal(deploymentOf(origin, { STATSCTL_TARGET: "node" }).target, "node");
    const created = await fetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "synthetic-check" }) });
    assert.equal(created.status, 201);
    const host = await created.json() as { hostId: string; token: string };
    const file = join(dataDir, "credential.json");
    writeFileSync(file, JSON.stringify(host));
    chmodSync(file, 0o600);
    seen.length = 0;
    const run = await runCli(["check", "ingest", "--credential-file", file, "--origin", origin, "--json"], { STATSCTL_TARGET: "node" });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const document = JSON.parse(run.stdout) as { payload: { ok: boolean; steps: { name: string; ok: boolean }[] } };
    assert.ok(document.payload.ok);
    assert.ok(document.payload.steps.every(step => step.ok));
    assert.ok(seen.length >= 4);
    for (const headers of seen) assert.equal(headers["cf-access-token"], undefined);
    assert.ok(!run.stdout.includes(host.token) && !run.stderr.includes(host.token));
  } finally {
    proxy.close();
    node.child.kill("SIGTERM");
    await new Promise(resolveExit => node.child.once("exit", resolveExit));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
