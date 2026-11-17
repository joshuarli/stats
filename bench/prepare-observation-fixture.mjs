import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { root: { type: "string" }, template: { type: "string" }, image: { type: "string" }, sha256: { type: "string" }, namespace: { type: "string" } } });
assert.equal(process.platform, "linux");
const root = resolve(values.root ?? ""), template = resolve(values.template ?? "");
assert.ok(root.startsWith("/bench/") && template.startsWith("/bench/") && !existsSync(root));
assert.match(values.namespace ?? "", /^stats-scale-sta128-[a-z0-9-]+$/u);
assert.match(values.image ?? "", /^stats:[a-f0-9]{12}$/u);
const binary = readFileSync(join(template, "engine/rivet-engine"));
assert.equal(createHash("sha256").update(binary).digest("hex"), values.sha256);
mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "engine"), { mode: 0o700 }); mkdirSync(join(root, "fixture"), { mode: 0o700 });
copyFileSync(join(template, "engine/rivet-engine"), join(root, "engine/rivet-engine"));
const config = JSON.parse(readFileSync(join(template, "engine/config.json"), "utf8"));
config.storage.log_directory = join(root, "engine/depot/log");
config.object_storage.primary.file_system.path = join(root, "engine/depot/objects");
writeFileSync(join(root, "engine/config.json"), JSON.stringify(config), { mode: 0o600 });
const auth = { engineToken: randomBytes(32).toString("hex"), secret: randomBytes(32).toString("hex") };
writeFileSync(join(root, "engine/runtime-auth.json"), JSON.stringify(auth), { mode: 0o600 });
copyFileSync(join(template, "fixture/corpus-10x.json"), join(root, "fixture/corpus-10x.json"));
const receipt = { binarySha256: values.sha256, sourceImage: values.image, namespace: values.namespace, freshEngine: true, freshDepot: true, timeoutMs: 1800000, attempt: 1, budget: 1, startedAt: new Date().toISOString(), status: null, timedOut: false };
const owners = [];
let signal;
function start(name, script, args, env = {}) {
  const output = openSync(join(root, `${name}.log`), "a", 0o600);
  let child;
  try { child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", output, output] }); }
  finally { closeSync(output); }
  const owner = { child, done: false };
  owner.exit = new Promise(done => { child.once("exit", (code, signal) => { owner.done = true; done({ code, signal }); }); child.once("error", error => { owner.done = true; done({ error: error.code }); }); });
  owners.push(owner); return owner;
}
async function stop(owner) {
  if (owner.done) return;
  owner.child.kill("SIGTERM");
  const timer = setTimeout(() => owner.child.kill("SIGKILL"), 130000);
  try { await owner.exit; } finally { clearTimeout(timer); }
}
for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) process.once(name, () => { signal = name; for (const owner of owners) if (!owner.done) owner.child.kill("SIGTERM"); });
let timeout;
try {
  const engine = start("engine-owner", new URL("./native-scale-engine.mjs", import.meta.url).pathname, ["--root", join(root, "engine"), "--binary", join(root, "engine/rivet-engine"), "--sha256", values.sha256]);
  timeout = setTimeout(() => { receipt.timedOut = true; for (const owner of owners) if (!owner.done) owner.child.kill("SIGTERM"); }, receipt.timeoutMs);
  const headers = { authorization: `Bearer ${auth.engineToken}`, "content-type": "application/json" };
  async function request(path, method = "GET", body) {
    const response = await fetch(`http://127.0.0.1:44794${path}`, { method, headers, signal: AbortSignal.timeout(5000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200); return response.json();
  }
  const deadline = Date.now() + 120000;
  let namespaces;
  while (!namespaces && !engine.done && !signal && !receipt.timedOut && Date.now() < deadline) {
    try { namespaces = await request("/namespaces"); } catch { await new Promise(done => setTimeout(done, 100)); }
  }
  assert.ok(namespaces && !engine.done && !signal && !receipt.timedOut, "fresh Engine readiness failed");
  assert.ok(!namespaces.namespaces.some(item => item.name === values.namespace));
  await request("/namespaces", "POST", { name: values.namespace });
  for (const pool of ["default", "services"]) await request(`/pools/${pool}?namespace=${values.namespace}`, "PUT", {});
  assert.ok(!signal && !receipt.timedOut && !engine.done, "preparation cancelled before import");
  const fixture = start("prepare", new URL("./native-scale-fixture.mjs", import.meta.url).pathname, ["--root", join(root, "fixture"), "--mode", "prepare", "--image", values.image, "--runtime-auth-file", join(root, "engine/runtime-auth.json"), "--import-delay-ms", "250"], { RIVET_ENDPOINT: "http://127.0.0.1:44794", RIVET_NAMESPACE: values.namespace, RIVET_NODE_VERSION: "24" });
  receipt.status = await Promise.race([fixture.exit, engine.exit.then(() => { throw new Error("private Engine exited during import"); })]);
  assert.equal(receipt.status.code, 0); assert.ok(!receipt.timedOut && !signal);
  const proof = JSON.parse(readFileSync(join(root, "fixture/native-scale-preparation.json"), "utf8"));
  assert.equal(proof.events, 203950); assert.ok(proof.restoredSummaryEqual && proof.referenceWindows.every(window => window.completeReferenceEqual));
  receipt.exactReference = true;
} catch (error) { receipt.error = String(error); process.exitCode = 1; }
finally {
  clearTimeout(timeout);
  for (const owner of owners.reverse()) await stop(owner);
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(root, "preparation-receipt.json"), JSON.stringify(receipt) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(receipt));
}
if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
