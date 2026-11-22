import { spawnSync } from 'node:child_process';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (index % 2 === 0) pairs.push([value.replace(/^--/, ''), args[index + 1]]);
  return pairs;
}, []));
const rollout = options.rollout ?? process.env.STATS_ROLLOUT;
const config = options['ssh-config'] ?? process.env.STANDBY_SSH_CONFIG;
const host = options.host ?? process.env.STATS_ROLLOUT_HOST;
const credential = options['credential-file'] ?? process.env.STATS_CHECK_CREDENTIAL_FILE;
const statsctl = options.statsctl ?? process.env.STATSCTL;
const targetKind = options['target-kind'];
const release = process.env.ROLLOUT_RELEASE;
const digest = process.env.ROLLOUT_DIGEST;
const steps = [];
const checks = {};
function run(name, executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error(`${name} failed`);
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error(`${name} returned invalid JSON`); }
  steps.push({ name, ok: true });
  return value;
}
function observe(name) {
  const value = run(name, rollout, ['observe', '--target-kind', targetKind, '--host', host, '--ssh-config', config, '--json']);
  const valid = value.selected === release && value.running === release && value.digest === digest && value.healthy === true &&
    (targetKind !== 'native-app' || value.collector_running === release) &&
    Array.isArray(value.processes) && value.processes.length === 1 && Number.isInteger(value.processes[0].pid) &&
    typeof value.processes[0].started_at === 'number';
  if (!valid) throw new Error(`${name} identity mismatch`);
  return value.processes[0];
}
let ok = false;
try {
  if (![rollout, config, host, credential, statsctl, release, digest].every(value => typeof value === 'string' && value.length)) throw new Error('missing required input');
  if (targetKind !== 'native' && targetKind !== 'native-app') throw new Error('target kind must be native or native-app');
  const before = observe('observe-before');
  checks.identity = true;
  const result = run('ingest', statsctl, ['check', 'ingest', '--credential-file', credential, '--json']);
  if (result.payload?.ok !== true) throw new Error('ingest readback failed');
  checks.ingest = true;
  const after = observe('observe-after');
  if (before.pid !== after.pid || before.started_at !== after.started_at) throw new Error('process changed during check');
  checks.stable = true;
  ok = true;
} catch (error) {
  steps.push({ name: 'failure', ok: false, detail: error.message });
}
console.log(JSON.stringify({ ok, release: release ?? null, digest: digest ?? null, checks, steps }));
if (!ok) process.exitCode = 1;
