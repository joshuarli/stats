import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

await test("cancelling application startup stops the private Engine and application", { skip: process.platform !== "linux" || !existsSync("/.dockerenv"), timeout: 45000 }, async () => {
  const root = mkdtempSync("/bench/overhead-cancel-");
  const auth = { secret: "a".repeat(64), engineToken: "b".repeat(64) };
  const engine = '#!/usr/bin/env node\nconst http=require("node:http");http.createServer((q,s)=>s.writeHead(200,{"content-type":"application/json"}).end("{}" )).listen(44794,"127.0.0.1");\n';
  const worker = 'export default {fetch(){return new Response("not ready",{status:503})}};';
  const sha256 = data => createHash("sha256").update(data).digest("hex");
  for (const directory of ["engine", "fixture/native-scale-state"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "engine/rivet-engine"), engine, { mode: 0o700 });
  writeFileSync(join(root, "engine/config.json"), JSON.stringify({ storage: { log_directory: join(root, "engine/log") }, object_storage: { primary: { file_system: { path: join(root, "engine/objects") } } }, guard: { host: "127.0.0.1" }, api_peer: { host: "127.0.0.1" }, metrics: { host: "127.0.0.1" }, topology: { datacenters: { default: { public_url: "http://127.0.0.1:44794" } } } }));
  writeFileSync(join(root, "fixture/corpus-10x.json"), JSON.stringify({ events: [] }));
  writeFileSync(join(root, "fixture/native-scale-preparation.json"), JSON.stringify({ events: 203950, restoredSummaryEqual: true, runtimeSources: { stats: sha256(worker), observe: sha256(worker) }, namespace: "stats-scale-cancel", nodeVersion: 24 }));
  const state = join(root, "fixture/native-scale-state");
  writeFileSync(join(state, "fixture-auth.json"), JSON.stringify(auth));
  for (const name of ["stats", "observe"]) {
    const main = join(state, `${name}.mjs`); writeFileSync(main, worker);
    writeFileSync(join(state, `${name}.jsonc`), JSON.stringify({ name, main, no_bundle: true, compatibility_date: "2026-10-30", vars: {} }));
  }
  const child = spawn(process.execPath, [new URL("./observation-overhead-server.mjs", import.meta.url).pathname, "--root", root, "--engine-sha256", sha256(engine)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise(done => child.once("exit", (code, signal) => done({ code, signal })));
  const headers = { "Stats-Gateway-Secret": auth.secret };
  const poll = async condition => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (condition()) return; const log = join(root, "engine-study.stderr.log"); assert.equal(child.exitCode, null, output + (existsSync(log) ? readFileSync(log, "utf8") : "")); await new Promise(done => setTimeout(done, 20)); }
    assert.fail("startup condition timed out: " + output);
  };
  try {
    await poll(() => output.includes('"ready":true'));
    assert.equal((await fetch("http://127.0.0.1:8790/stop")).status, 401);
    const pending = fetch("http://127.0.0.1:8790/start?variant=disabled&round=0", { headers }).then(response => response.status);
    await poll(() => JSON.parse(readFileSync(join(root, "runtime-pids.json"), "utf8")).length === 2);
    const pids = JSON.parse(readFileSync(join(root, "runtime-pids.json"), "utf8"));
    const stopped = await fetch("http://127.0.0.1:8790/stop", { headers });
    assert.equal(stopped.status, 200);
    assert.equal(await pending, 500);
    assert.deepEqual(await exited, { code: 0, signal: null });
    for (const { pid } of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.ok(!output.includes(auth.secret) && !output.includes(auth.engineToken));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
});

await test("a copied Engine configuration cannot reopen storage outside the study root", { skip: process.platform !== "linux" || !existsSync("/.dockerenv") }, () => {
  const root = mkdtempSync("/bench/overhead-storage-");
  try {
    mkdirSync(join(root, "engine"));
    writeFileSync(join(root, "engine/config.json"), JSON.stringify({ storage: { log_directory: "/bench/another-study/log" }, object_storage: { primary: { file_system: { path: "/bench/another-study/objects" } } } }));
    const result = spawnSync(process.execPath, [new URL("./observation-overhead-server.mjs", import.meta.url).pathname, "--root", root, "--engine-sha256", "c".repeat(64)], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private Engine storage must belong to the selected study root/u);
    assert.equal(existsSync(join(root, "runtime-pids.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
