import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const execute = promisify(execFile);
const { values } = parseArgs({ options: { samples: { type: "string", default: "200" }, image: { type: "string" }, version: { type: "string" }, output: { type: "string" } } });
const samples = Number(values.samples), version = Number(values.version);
assert.ok(Number.isSafeInteger(samples) && samples >= 5 && samples <= 2000);
assert.ok(Number.isSafeInteger(version) && version > 0);
assert.match(values.image ?? "", /^stats:[a-f0-9]{12}$/u);
assert.ok(values.output && !existsSync(values.output));
const controller = new AbortController(), records = [], gates = [];
let session, deployment, closing = false, interrupted, error;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) process.once(signal, () => { interrupted = signal; controller.abort(); });
async function command(file, args, input) {
  const pending = execute(file, args, { timeout: 90000, maxBuffer: 1024 * 1024, ...(closing ? {} : { signal: controller.signal }) });
  pending.child.stdin.end(input ?? "");
  return (await pending).stdout.trim();
}
const browser = (args, input) => command("agent-browser", ["--session", session, ...args], input);
const decode = text => { const data = JSON.parse(text); return typeof data === "string" ? JSON.parse(data) : data; };
const selected = async () => JSON.parse(await command("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "josh@lisa", "doas -n /opt/openorange/bin/oo deployment stats"]));
async function gate(host, post) {
  let code = 0;
  try { await command(host === "mac" ? "perf-gate-ready" : "ssh", host === "mac" ? (post ? ["-1"] : []) : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "josh@lisa", "sh", "/home/josh/.work/stats-perf-campaign/perf-gate-ready", ...(post ? ["-1"] : [])]); } catch (failure) { code = typeof failure.code === "number" ? failure.code : -1; }
  gates.push({ host, post, exitCode: code });
  return code === 0;
}
const probe = readFileSync(new URL("./project-navigation-probe.js", import.meta.url), "utf8");
try {
  deployment = await selected();
  assert.deepEqual(deployment, { image: values.image, version });
  session = await command("agent-browser", ["session", "id", "--scope", "worktree", "--prefix", "stats-navigation"]);
  if (!await gate("mac", false) || !await gate("lisa", false)) throw new Error("perf gate deferred: host busy");
  for (let sample = 0; sample < samples; sample++) {
    if (sample > 0) await browser(["open", "about:blank"]);
    await browser([...(sample === 0 ? ["--init-script", fileURLToPath(new URL("./live-project-probe.js", import.meta.url))] : []), "open", "https://stats.17166969.xyz/#/project/stats"]);
    let result;
    const deadline = Date.now() + 90000;
    do { result = decode(await browser(["eval", "--stdin"], probe)); if (!result.done) await new Promise(done => setTimeout(done, 100)); } while (!result.done && Date.now() < deadline);
    records.push({ sample, ...result });
    assert.ok(result.done && result.ok, result.error ?? "navigation did not settle");
    assert.ok(records.length === 1 || records.at(-2).timeOrigin !== result.timeOrigin, "open must create a new document");
    if (records.length % 25 === 0) console.log(JSON.stringify({ completed: records.length, samples }));
  }
} catch (failure) { error = String(failure); }
finally {
  closing = true;
  if (interrupted) error ??= `interrupted by ${interrupted}`;
  if (gates.some(gate => !gate.post)) { await gate("mac", true); await gate("lisa", true); }
  try { if (deployment) assert.deepEqual(await selected(), deployment); } catch { error ??= "selected deployment changed or could not be checked"; }
  try { if (session) await browser(["close"]); } catch { error ??= "browser teardown failed"; }
  const percentile = (key, p) => { const sorted = records.filter(row => row.ok).map(row => row[key]).sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * p) - 1] ?? null; };
  const summary = Object.fromEntries(["healthMs", "chartsMs"].map(key => [key, { p50: percentile(key, .5), p95: percentile(key, .95), p99: percentile(key, .99) }]));
  const valid = !error && gates.length === 4 && gates.every(gate => gate.exitCode === 0) && records.length === samples && records.every(row => row.ok);
  const adequateSamples = valid && samples >= 200;
  const pass = adequateSamples && summary.healthMs.p95 < 1000 && summary.chartsMs.p95 < 2000;
  writeFileSync(values.output, JSON.stringify({ valid, adequateSamples, pass, source: "new production document per sample; normal HTTP asset cache; no client summary survives navigation; awake actor, no disk-cold claim", deployment, gates, summary, records, ...(error ? { error } : {}) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ valid, adequateSamples, pass, summary, gates, ...(error ? { error } : {}) }));
  if (!valid || adequateSamples && !pass) process.exitCode = 1;
  if (interrupted) process.exitCode = 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 }[interrupted]);
}
