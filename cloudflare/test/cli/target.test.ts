import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORIGIN, deploymentOf, resolveOrigin } from "../../src/cli/auth.ts";
import { REGISTRY } from "../../src/cli/commands/index.ts";
import { fakeOrigin, runCli } from "./support.ts";

await test("the deployment table decides the target", () => {
  assert.equal(deploymentOf(DEFAULT_ORIGIN, {}).target, "node");
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
    assert.deepEqual(orangeOnly.map(command => command.name).sort(), [
      "compare", "cost", "deployments", "health", "observe deployment", "observe issues",
      "observe operations", "observe rollouts", "observe routes", "observe traces", "projects", "snapshot",
    ]);
    for (const command of orangeOnly) {
      const argv = [...command.name.split(" "), "--origin", origin.origin, "--json", ...Object.entries(command.options).flatMap(([name, spec]) => spec.type === "string" && spec.required === true ? [`--${name}`, "x"] : [])];
      const run = await runCli(argv, { STATSCTL_TARGET: "node" });
      assert.equal(run.code, 2, `${command.name}: ${run.stdout}${run.stderr}`);
      assert.equal((JSON.parse(run.stdout) as { error: { code: string } }).error.code, "unsupported_on_target", command.name);
    }
    assert.equal(origin.seen.length, 0);
    assert.equal(origin.connections(), 0);
  } finally {
    await origin.close();
  }
});
