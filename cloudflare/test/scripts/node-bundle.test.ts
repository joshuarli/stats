import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRATCH = resolve(ROOT, "../.work/tmp");

await test("the shipped Node bundle serves without workspace dependencies", { timeout: 60_000 }, async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const scratch = mkdtempSync(join(SCRATCH, "node-bundle-test-"));
  try {
    const bundle = join(scratch, "bundle");
    const build = spawnSync(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.node.config.ts", "--outDir", bundle], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
    assert.equal(build.status, 0, `${build.error ?? ""}\n${build.stdout}\n${build.stderr}`);

    const stage = join(scratch, "app/cloudflare");
    const entry = join(stage, "src/node/main.mjs");
    const assets = join(stage, ".cloudflare/output/v0/workers/default/assets");
    const data = join(scratch, "data");
    mkdirSync(join(stage, "src/node"), { recursive: true });
    mkdirSync(assets, { recursive: true });
    mkdirSync(data);
    copyFileSync(join(bundle, "main.mjs"), entry);
    const index = "<!doctype html><title>packaged stats</title>";
    writeFileSync(join(assets, "index.html"), index);

    const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${stage}`, `--allow-fs-read=${data}`, `--allow-fs-write=${data}`, "--allow-net", entry], {
      cwd: stage,
      env: { STATS_DATA_DIR: data, STATS_LISTEN: "127.0.0.1:0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      killSignal: "SIGKILL"
    });
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    try {
      const port = await new Promise<number>((resolvePort, reject) => {
        child.stdout.on("data", () => {
          const match = /"event":"listening","host":"127\.0\.0\.1","port":(\d+)/u.exec(output);
          if (match !== null) resolvePort(Number(match[1]));
        });
        void exited.then(code => reject(new Error(`bundle exited ${code}: ${output}`)), reject);
      });
      const origin = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(`${origin}/health`)).status, 200);
      assert.equal((await fetch(origin)).status, 401);
      const dashboard = await fetch(origin, { headers: { "Tailscale-User-Login": "bundle@example.com" } });
      assert.equal(dashboard.status, 200);
      assert.equal(await dashboard.text(), index);
      const hosts = await fetch(`${origin}/api/v1/hosts`, { headers: { "Tailscale-User-Login": "bundle@example.com" } });
      assert.equal(hosts.status, 200);
      child.kill("SIGTERM");
      assert.equal(await exited, 0, output);
      assert.match(output, /"event":"stopped"/u);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
