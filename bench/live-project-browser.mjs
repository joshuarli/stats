import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const exec = promisify(execFile);
const { values } = parseArgs({ options: { 'per-range': { type: 'string' }, output: { type: 'string' }, image: { type: 'string' }, version: { type: 'string' } } });
const count = Number(values['per-range']);
assert.ok(Number.isSafeInteger(count) && count >= 5 && count <= 2000 && count % 5 === 0 && values.output);
assert.ok(!existsSync(values.output), 'output already exists');
assert.match(values.image ?? '', /^stats:[a-f0-9]{12}$/u);
const version = Number(values.version); assert.ok(Number.isSafeInteger(version) && version > 0);
let session;
const ranges = ['1h', '6h', '24h', '7d'];
const records = [], gates = [];
let viewport, deployment;
const controller = new AbortController();
let closing = false, interrupted;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) process.once(signal, () => { interrupted = signal; controller.abort(); });
async function command(file, args, input) {
  const pending = exec(file, args, { timeout: 90000, maxBuffer: 2 * 1024 * 1024, ...(closing ? {} : { signal: controller.signal }) });
  pending.child.stdin.end(input ?? '');
  return (await pending).stdout.trim();
}
const browser = (args, input) => command('agent-browser', ['--session', session, ...args], input);
async function gate(host, post) {
  let exitCode = 0;
  try { await command(host === 'mac' ? 'perf-gate-ready' : 'ssh', host === 'mac' ? (post ? ['-1'] : []) : ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'josh@lisa', 'sh', '/home/josh/.work/stats-perf-campaign/perf-gate-ready', ...(post ? ['-1'] : [])]); } catch (error) { exitCode = typeof error.code === 'number' ? error.code : -1; }
  gates.push({ host, post, exitCode });
  return exitCode === 0;
}
function decode(output) { const value = JSON.parse(output); return typeof value === 'string' ? JSON.parse(value) : value; }
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * p) - 1] ?? null; }
function save(error) {
  const summary = Object.fromEntries(ranges.map(range => { const samples = records.filter(row => row.target === range); const good = samples.filter(row => row.ok).map(row => row.targetResult); const phases = samples.flatMap(row => [row.seedResult, row.targetResult].filter(Boolean)); const metric = key => ({ p95: percentile(good.map(row => row[key]), .95), p99: percentile(good.map(row => row[key]), .99) }); return [range, { attempted: samples.length, successful: good.length, failed: samples.length - good.length, cancellations: phases.flatMap(row => row.events).filter(event => event.outcome === 'cancelled').length, errors: phases.flatMap(row => row.events).filter(event => event.outcome === 'error').length, clickToCompleteMs: metric('clickToCompleteMs'), journeyMs: metric('journeyMs'), phases: Object.fromEntries([...new Set(good.flatMap(row => Object.keys(row.work)))].sort().map(key => [key, { p95Us: percentile(good.map(row => row.work[key]).filter(Number.isFinite), .95), p99Us: percentile(good.map(row => row.work[key]).filter(Number.isFinite), .99) }])) }]; }));
  const valid = !error && gates.length === 4 && gates.every(gate => gate.exitCode === 0) && ranges.every(range => summary[range].successful === count && summary[range].failed === 0);
  writeFileSync(values.output, JSON.stringify({ valid, adequateSamples: valid && count >= 200, countPerRange: count, deployment, viewport, source: 'production awake project navigation followed by uncached range selection', gates, summary, records, ...(error ? { error } : {}) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ valid, adequateSamples: valid && count >= 200, gates, summary, ...(error ? { error } : {}) }));
  return valid;
}
let error;
try {
  session = await command('agent-browser', ['session', 'id', '--scope', 'worktree', '--prefix', 'stats-live-reads-corrected']);
  deployment = JSON.parse(await command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'josh@lisa', 'doas -n /opt/openorange/bin/oo deployment stats']));
  assert.equal(deployment.image, values.image); assert.equal(deployment.version, version);
  await browser(['--init-script', fileURLToPath(new URL('./live-project-probe.js', import.meta.url)), 'open', 'https://stats.17166969.xyz']);
  viewport = decode(await browser(['eval', '--stdin'], '({width:innerWidth,height:innerHeight,devicePixelRatio,browser:navigator.userAgent})'));
  if (!await gate('mac', false) || !await gate('lisa', false)) throw new Error('perf gate deferred: host busy');
  for (let round = 0; round < 5; round++) for (let i = 0; i < count / 5; i++) for (let offset = 0; offset < ranges.length; offset++) {
    const range = ranges[(round + offset) % ranges.length];
    await browser(['eval', '--stdin'], `window.liveProjectBench.status={done:false};window.liveProjectBench.run(${JSON.stringify(range)}).then(result=>{window.liveProjectBench.status={done:true,result}}).catch(error=>{window.liveProjectBench.status={done:true,error:String(error)}});'started'`);
    let status; const deadline = Date.now() + 150000;
    do { status = decode(await browser(['eval', '--stdin'], 'window.liveProjectBench.status')); if (!status.done) await new Promise(resolve => setTimeout(resolve, 200)); } while (!status.done && Date.now() < deadline);
    if (!status.done || status.error) throw new Error(status.error ?? 'sample deadline exceeded');
    records.push(status.result);
    if (!status.result.ok) throw new Error('sample validation failed');
  }
} catch (failure) { error = String(failure); }
finally {
  closing = true;
  if (interrupted) error ??= `run interrupted by ${interrupted}`;
  if (gates.some(gate => !gate.post)) { await gate('mac', true); await gate('lisa', true); }
  try { if (deployment) assert.deepEqual(JSON.parse(await command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'josh@lisa', 'doas -n /opt/openorange/bin/oo deployment stats'])), deployment); } catch { error ??= 'production deployment changed or could not be verified'; }
  try { if (session) await browser(['close']); } catch { error ??= 'browser close failed'; }
  if (!save(error)) process.exitCode = 1;
  if (interrupted) process.exitCode = 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 }[interrupted]);
}
