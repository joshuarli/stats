import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class Outbox {
  constructor(directory) {
    this.path = resolve(directory, 'alerts.jsonl');
    this.open = new Set();
    let lines = '';
    try { lines = readFileSync(this.path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (lines && !lines.endsWith('\n')) throw new Error('incomplete alert outbox');
    for (const line of lines.split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.transition === 'open') this.open.add(record.condition);
      else if (record.transition === 'resolve') this.open.delete(record.condition);
      else throw new Error('invalid alert transition');
    }
  }
  transition(condition, failed) {
    if (this.open.has(condition) === failed) return;
    appendDurable(this.path, { at: new Date().toISOString(), condition, transition: failed ? 'open' : 'resolve', delivery: 'unconfigured' });
    if (failed) this.open.add(condition); else this.open.delete(condition);
  }
}
export function appendDurable(path, record) {
  const fd = openSync(path, 'a', 0o600);
  try { appendFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function command(file, args) {
  return new Promise(resolveResult => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { if (output.length < 65536) output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('error', () => { clearTimeout(timer); resolveResult({ ok: false }); });
    child.on('close', code => { clearTimeout(timer); let value; try { value = JSON.parse(output); } catch {} const payload = value?.payload; const valid = args[1] === 'ingest' ? payload?.ok === true : Array.isArray(payload?.hosts); resolveResult({ ok: code === 0 && valid, result: value }); });
  });
}
export async function main(args) {
  const config = Object.fromEntries(args.reduce((pairs, value, index) => { if (index % 2 === 0) pairs.push([value.replace(/^--/, ''), args[index + 1]]); return pairs; }, []));
  const { 'state-dir': state, 'candidate-dir': candidate, statsctl, hosts, health, 'credential-file': credential, 'interval-s': interval } = config;
  if (![state, candidate, statsctl, hosts, health, credential, interval].every(Boolean) || !Number.isFinite(Number(interval)) || Number(interval) <= 0) throw new Error('all paths and options are required');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const statePath = realpathSync(state), candidatePath = realpathSync(candidate);
  if (statePath === candidatePath || statePath.startsWith(candidatePath + sep)) throw new Error('state directory must be outside candidate stack');
  const outbox = new Outbox(statePath);
  let lastIngest = 0;
  try {
    const evidence = readFileSync(resolve(statePath, 'evidence.jsonl'), 'utf8');
    if (evidence && !evidence.endsWith('\n')) throw new Error('incomplete evidence');
    for (const line of evidence.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.condition === 'ingest') lastIngest = Math.max(lastIngest, Date.parse(entry.at));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (;;) {
    const checks = [['hosts', () => command(statsctl, ['check', 'hosts', '--hosts', hosts, '--json'])], ['health', async () => {
      try { const response = await fetch(health, { signal: AbortSignal.timeout(15000), redirect: 'manual' }); return { ok: response.ok }; } catch { return { ok: false }; }
    }]];
    if (Date.now() - lastIngest >= 300000) {
      checks.push(['ingest', () => {
        lastIngest = Date.now();
        appendDurable(resolve(statePath, 'evidence.jsonl'), { at: new Date(lastIngest).toISOString(), condition: 'ingest', attempt: true });
        return command(statsctl, ['check', 'ingest', '--credential-file', credential, '--json']);
      }]);
    }
    for (const [condition, check] of checks) {
      const result = await check();
      appendDurable(resolve(statePath, 'evidence.jsonl'), { at: new Date().toISOString(), condition, ...result });
      outbox.transition(condition, !result.ok);
    }
    await delay(Number(interval) * 1000);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
