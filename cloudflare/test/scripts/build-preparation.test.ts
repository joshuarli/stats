import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processOwner } from "../../scripts/processes.ts";
import { startStack } from "../../local/stack.ts";
import { devWorkspace } from "../support/dev-workspace.ts";
import type { BuiltArtifact } from "../../scripts/ensure-build.ts";

await test("build consumers share complete generations and recover from edits, failure, corruption and a dead owner", { timeout: 60_000 }, async () => {
  const workspace = devWorkspace();
  const owner = processOwner("build-test");
  const record = (target: string) => JSON.parse(readFileSync(join(workspace.repo, ".work/tmp/builds", `${target}.json`), "utf8")) as BuiltArtifact;
  const build = (name: string, env = process.env) => owner.run(name, process.execPath, ["scripts/ensure-build.ts"], { cwd: workspace.root, env, stream: false });
  try {
    const concurrent = await Promise.all([build("first"), build("second")]);
    assert.equal(concurrent.map(result => readFileSync(result.logPath, "utf8")).join("").match(/building ssr environment/gu)?.length, 2);
    const first = record("stats");
    const observe = record("observe");
    const unchanged = await build("unchanged");
    assert.doesNotMatch(readFileSync(unchanged.logPath, "utf8"), /building ssr environment/u);
    assert.equal(record("stats").output, first.output);

    const source = join(workspace.root, "src/core/http.ts");
    const original = readFileSync(source, "utf8");
    writeFileSync(join(workspace.root, "src/core/dev-probe.ts"), 'export const devProbe = "untracked";\n');
    writeFileSync(source, `import { devProbe } from "./dev-probe.ts";\n${original.replace('{ ok: true, service: "stats" }', '{ ok: true, service: "stats", devProbe }')}`);
    await build("dirty");
    const dirty = record("stats");
    assert.notEqual(dirty.identity, first.identity);
    assert.equal(record("observe").identity, observe.identity);
    const stack = await startStack({ nowMs: null, statsOutput: join(dirty.output, "v0/workers/default"), observeOutput: join(observe.output, "v0/workers/default") });
    try {
      assert.equal((await (await stack.anonymous("/health")).json() as { devProbe: string }).devProbe, "untracked");
      writeFileSync(source, "export const = ;");
      await assert.rejects(build("failure"), /exited/u);
      assert.equal(record("stats").output, dirty.output);
      assert.equal((await stack.anonymous("/health")).status, 200);
    } finally { await stack.dispose(); }
    writeFileSync(source, original);

    const configured = await build("configured", { ...process.env, STATS_DOMAIN: "dev-loop.example" });
    assert.match(readFileSync(configured.logPath, "utf8"), /stats miss/u);
    assert.match(readFileSync(join(record("stats").output, "v0/workers/default/worker.config.json"), "utf8"), /dev-loop\.example/u);
    writeFileSync(join(record("stats").output, "v0/workers/default/bundle/index.js"), "invalid");
    const repaired = await build("repair", { ...process.env, STATS_DOMAIN: "dev-loop.example" });
    assert.match(readFileSync(repaired.logPath, "utf8"), /stats miss/u);

    const lock = join(workspace.repo, ".work/tmp/builds/stats.sqlite");
    const script = `import { acquireOwnership } from ${JSON.stringify(join(workspace.root, "scripts/ownership.ts"))}; await acquireOwnership(${JSON.stringify(lock)}, new AbortController().signal); console.log("held"); setInterval(() => {}, 1000);`;
    const holder = owner.start("dead-owner", process.execPath, ["--input-type=module", "-e", script], { stream: false });
    await new Promise<void>((done, reject) => { holder.child.stdout!.once("data", () => done()); void holder.done.catch(reject); });
    holder.kill("SIGKILL");
    await holder.done.catch(() => {});
    await build("recovered");
    assert.equal(record("stats").target, "stats");

    const config = join(workspace.root, "vite.config.ts");
    const configSource = readFileSync(config, "utf8");
    writeFileSync(config, configSource.replace("plugins: [solid(),", 'plugins: [{ name: "hold-build", buildStart() { console.log("BUILD_HELD"); setInterval(() => {}, 1000); return new Promise(() => {}); } }, solid(),'));
    const interrupted = owner.start("interrupted", process.execPath, ["scripts/ensure-build.ts", "--target", "stats"], { cwd: workspace.root, env: process.env, stream: false });
    await new Promise<void>((done, reject) => {
      let output = "";
      const observe = (chunk: Buffer): void => { output += String(chunk); if (output.includes("BUILD_HELD")) done(); };
      interrupted.child.stdout!.on("data", observe);
      interrupted.child.stderr!.on("data", observe);
      void interrupted.done.catch(reject);
    });
    interrupted.kill("SIGTERM");
    await assert.rejects(interrupted.done, /exited/u);
    writeFileSync(config, configSource);
    await build("after-interrupt");
  } finally { await owner.close(); workspace.remove(); }
});
