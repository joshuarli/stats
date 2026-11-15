import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { root: { type: "string" }, binary: { type: "string" }, sha256: { type: "string" } } });
assert.equal(process.platform, "linux");
assert.ok(existsSync("/.dockerenv") && values.root && values.binary && /^[a-f0-9]{64}$/u.test(values.sha256 ?? ""));
const root = resolve(values.root), binary = resolve(values.binary);
assert.ok(root.startsWith("/bench/") && binary.startsWith(root + "/"));
assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"), values.sha256);
let auth;
try {
  auth = JSON.parse(readFileSync(join(root, "runtime-auth.json"), "utf8"));
  assert.ok(auth && typeof auth.engineToken === "string" && /^[A-Za-z0-9_-]{32,128}$/u.test(auth.engineToken));
} catch { throw new Error("could not read protected fixture Engine credentials"); }
const configPath = join(root, "config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
const endpoint = new URL(config.topology.datacenters.default.public_url);
assert.equal(endpoint.hostname, "127.0.0.1"); assert.equal(endpoint.protocol, "http:");
assert.equal(config.guard.host, "127.0.0.1");
assert.equal(config.api_peer.host, "127.0.0.1");
assert.equal(config.metrics.host, "127.0.0.1");
for (const directory of [config.storage.log_directory, config.object_storage.primary.file_system.path]) {
  assert.ok(resolve(directory).startsWith(root + "/"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
const stdout = openSync(join(root, "engine-stdout.log"), "a", 0o600), stderr = openSync(join(root, "engine-stderr.log"), "a", 0o600);
let child, done, stop, stopPromise, signal, ended = false;
try {
  child = spawn(binary, ["--config", configPath], { cwd: root, env: { ...process.env, RIVET__AUTH__ADMIN_TOKEN: auth.engineToken }, stdio: ["ignore", stdout, stderr] });
  done = new Promise(resolve => {
    child.once("exit", (code, signal) => { ended = true; resolve({ code, signal }); });
    child.once("error", error => { ended = true; resolve({ error: error.code ?? "spawn_failed" }); });
  });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  stop = () => stopPromise ??= (async () => {
    if (ended) return done;
    child.kill("SIGTERM");
    let timer;
    const result = await Promise.race([done, new Promise(resolve => { timer = setTimeout(() => resolve(null), 120000); })]);
    clearTimeout(timer);
    if (result !== null) return result;
    child.kill("SIGKILL");
    return done;
  })();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) process.once(name, () => { signal = name; void stop(); });
  const attempts = [], started = performance.now(), deadline = Date.now() + 120000;
  let ready = false;
  while (!ready && !signal && !ended && Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/namespaces", endpoint), { headers: { authorization: `Bearer ${auth.engineToken}` }, signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      attempts.push({ afterMs: performance.now() - started, status: response.status });
      ready = response.status === 200;
      assert.ok(ready || [500, 502, 503, 504].includes(response.status), "unexpected private Engine readiness status");
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      attempts.push({ afterMs: performance.now() - started, error: error.name });
    }
    if (!ready) await pause(100);
  }
  writeFileSync(join(root, "readiness.json"), JSON.stringify({ ready, diagnostic: true, timingAcceptance: false, binarySha256: values.sha256, attempts }) + "\n", { mode: 0o600 });
  if (!ready) { await stop(); throw new Error("private Engine readiness failed; protected evidence retained"); }
  writeFileSync(join(root, "engine.pid"), String(child.pid) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ready, binarySha256: values.sha256, endpoint: endpoint.origin }));
  const outcome = await done;
  if (signal) process.exitCode = 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 }[signal]);
  else if (outcome.error || outcome.signal || outcome.code !== 0) process.exitCode = 1;
} finally {
  if (stop) await stop();
  closeSync(stdout); closeSync(stderr);
}
