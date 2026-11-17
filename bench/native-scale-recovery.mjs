import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const { values } = parseArgs({ options: { "auth-file": { type: "string" }, output: { type: "string" } } });
assert.ok(values["auth-file"] && values.output && !existsSync(values.output));
const auth = JSON.parse(readFileSync(values["auth-file"], "utf8"));
const headers = { "Stats-Gateway-Secret": auth.secret };
const controller = new AbortController(), records = [], gates = [];
const receipt = { condition: "ordinary Engine-only TERM/start; application remains alive", cyclesRequired: 10, readyLimitMs: 15000, exactData: "canonical stored observation-event table SHA-256 and full fixed-window summary", records, gates, error: null };
let closing = false, signal, started = false;
for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) process.once(name, () => { signal = name; controller.abort(); });
const pause = ms => new Promise((done, reject) => {
  const aborted = () => { clearTimeout(timer); reject(new Error("recovery interrupted")); };
  const timer = setTimeout(() => { controller.signal.removeEventListener("abort", aborted); done(); }, ms);
  controller.signal.addEventListener("abort", aborted, { once: true });
  if (controller.signal.aborted) aborted();
});
async function action(path, budget = 120000) {
  const response = await fetch(`http://127.0.0.1:18790${path}`, { headers, signal: closing ? AbortSignal.timeout(budget) : AbortSignal.any([controller.signal, AbortSignal.timeout(budget)]) });
  assert.equal(response.status, 200, "private recovery action failed; protected server evidence retained");
  return response.json();
}
async function gate(host, post, cycle) {
  let exitCode = 0, output = "";
  try {
    const result = await exec(host === "mac" ? "perf-gate-ready" : "ssh", host === "mac" ? (post ? ["-1"] : []) : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "lisa", "/home/josh/.local/bin/perf-gate-ready", ...(post ? ["-1"] : [])], { timeout: 15000, ...(closing ? {} : { signal: controller.signal }) }); output = result.stdout;
  } catch (error) { exitCode = Number.isInteger(error.code) ? error.code : -1; output = error.stderr ?? "gate unavailable"; }
  gates.push({ host, post, cycle, exitCode });
  writeFileSync(`${values.output}.${cycle}-${host}-${post ? "post" : "pre"}.log`, output, { mode: 0o600 });
  return exitCode === 0;
}
const external = snapshot => {
  const table = snapshot.observation.tables.find(table => table.name === "observe_external_events");
  assert.ok(table?.rows >= 203950 && /^[a-f0-9]{64}$/u.test(table.sha256));
  return table;
};
try {
  started = true;
  receipt.fixture = (await action("/start?variant=disabled&round=0")).fixture;
  assert.equal(receipt.fixture.profiling, false);
  receipt.summary = await action("/verify-summary");
  assert.ok(receipt.summary.ready && receipt.summary.exact);
  receipt.snapshot = await action("/snapshot");
  const expected = external(receipt.snapshot);
  await pause(60000);
  for (let cycle = 1; cycle <= 10; cycle++) {
    const pre = await Promise.all([gate("mac", false, cycle), gate("lisa", false, cycle)]);
    assert.ok(pre.every(Boolean), "perf gate deferred: host busy");
    const row = { cycle, attempts: [] }; records.push(row);
    const start = performance.now();
    try {
      row.stop = await action("/engine/stop", 15000);
      assert.ok(row.stop.stopped && (row.stop.status.code === 0 || row.stop.status.signal === "SIGTERM"));
      const remaining = () => Math.max(1, Math.floor(15000 - (performance.now() - start)));
      row.start = await action("/engine/start", remaining());
      while (performance.now() - start < 15000) {
        const result = await action("/verify-summary", Math.min(2000, remaining()));
        row.attempts.push({ afterMs: performance.now() - start, ...result });
        if (result.ready) { row.summary = result; break; }
        await pause(50);
      }
      row.shutdownToVerifiedMs = performance.now() - start;
      assert.ok(row.summary?.exact && row.shutdownToVerifiedMs < 15000);
      assert.equal(row.summary.sha256, receipt.summary.sha256);
      assert.equal(row.summary.appPid, receipt.summary.appPid, "application restarted during Engine-only recovery");
      assert.deepEqual(row.summary.appProcesses, receipt.summary.appProcesses, "application child processes changed during Engine-only recovery");
    } finally {
      const post = await Promise.all([gate("mac", true, cycle), gate("lisa", true, cycle)]);
      row.hostGatesPassed = [...pre, ...post].every(Boolean);
    }
    assert.ok(row.hostGatesPassed, "perf gate deferred: host busy");
    row.snapshot = await action("/snapshot");
    assert.deepEqual(external(row.snapshot), expected, "canonical acknowledged rows changed across Engine recovery");
    assert.deepEqual(row.snapshot.observation.schema, receipt.snapshot.observation.schema);
    assert.deepEqual(row.snapshot.installation, receipt.snapshot.installation, "canonical Installation state changed across Engine recovery");
    row.exactRows = true;
    writeFileSync(`${values.output}.progress.json`, JSON.stringify(receipt) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ cycle, exactRows: true, events: expected.rows, withinReadinessLimit: true }));
    if (cycle !== 10) await pause(60000);
  }
} catch (error) { receipt.error = String(error); }
finally {
  closing = true;
  if (started) { try { await action("/stop"); } catch { receipt.error ??= "private recovery cleanup failed"; } }
  receipt.valid = !receipt.error && records.length === 10 && records.every(row => row.exactRows && row.hostGatesPassed && row.shutdownToVerifiedMs < 15000);
  writeFileSync(values.output, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ valid: receipt.valid, cycles: records.length, error: receipt.error }));
  if (!receipt.valid) process.exitCode = 1;
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
}
