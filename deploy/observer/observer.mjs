import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, statfsSync, unlinkSync } from 'node:fs';
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
export const ROTATE_BYTES = 64 * 1024 * 1024;
export const ROTATED_LIMIT = 64;
export const RESERVE_BYTES = 512 * 1024 * 1024;
const CONTENT_CONCURRENCY = 4;
export class EvidenceExhausted extends Error { name = 'EvidenceExhausted'; }
function digestFile(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function appendRotating(path, record, { rotateBytes = ROTATE_BYTES, rotatedLimit = ROTATED_LIMIT, reserveBytes = RESERVE_BYTES } = {}) {
  if (!Number.isSafeInteger(rotatedLimit) || rotatedLimit < 1) throw new Error('rotated limit must be positive');
  const directory = dirname(path);
  const fs = statfsSync(directory);
  if (fs.bavail * fs.bsize < reserveBytes) throw new EvidenceExhausted('evidence volume below its reserve');
  let size = 0;
  try { size = statSync(path).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (size >= rotateBytes) {
    const base = path.replace(/\.jsonl$/, '');
    const rotated = readdirSync(directory).filter(name => name.startsWith(`${base.slice(directory.length + 1)}-`) && name.endsWith('.jsonl'));
    rotated.sort();
    while (rotated.length >= rotatedLimit) unlinkSync(resolve(directory, rotated.shift()));
    let target = `${base}-${new Date().toISOString().replace(/[-:.]/g, '')}.jsonl`;
    while (rotated.includes(target.slice(directory.length + 1))) target = target.replace(/\.jsonl$/, '0.jsonl');
    const sha256 = digestFile(path);
    renameSync(path, target);
    appendDurable(path, { at: new Date().toISOString(), checkpoint: { rotatedTo: target.slice(directory.length + 1), bytes: size, sha256 } });
  }
  appendDurable(path, record);
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
    child.on('close', code => { clearTimeout(timer); let value; try { value = JSON.parse(output); } catch {} const payload = value?.payload; const valid = Array.isArray(payload?.hosts); resolveResult({ ok: code === 0 && valid, result: value }); });
  });
}
export function stateOutsideCandidate(state, candidate) {
  const statePath = realpathSync(state);
  let candidatePath;
  try { candidatePath = realpathSync(candidate); } catch (error) {
    if (error.code !== 'EACCES') throw error;
    candidatePath = resolve(candidate);
  }
  if (statePath === candidatePath || statePath.startsWith(candidatePath + sep)) throw new Error('state directory must be outside candidate stack');
  return statePath;
}
const RESERVED = new Set(['hosts', 'health']);
export function parseTargets(value, kind) {
  if (value === undefined) return [];
  const names = new Set();
  return value.split(',').map(entry => {
    const at = entry.indexOf('=');
    const name = entry.slice(0, at), target = entry.slice(at + 1);
    if (at < 1 || !/^[a-z][a-z0-9-]*$/.test(name) || RESERVED.has(name) || names.has(name)) throw new Error(`invalid --${kind} check name in ${JSON.stringify(entry)}`);
    names.add(name);
    if (kind === 'http') {
      let url;
      try { url = new URL(target); } catch { throw new Error(`invalid --http URL for ${name}`); }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`invalid --http URL for ${name}`);
      return [name, target];
    }
    const match = /^(.+):(\d{1,5})$/.exec(target);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error(`invalid --tcp address for ${name}`);
    return [name, { host: match[1], port: Number(match[2]) }];
  });
}
export async function httpCheck(url) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'manual' }); return { ok: response.ok }; } catch { return { ok: false }; }
}
export async function healthCheck(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || response.body === null) {
      await response.body?.cancel();
      return { ok: false };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) { await reader.cancel(); return { ok: false }; }
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
    const status = x => x === 'ok' || x === 'degraded' || x === 'down';
    const checks = object(value.checks) && Object.values(value.checks).every(check => object(check) && status(check.status) && (check.ms === undefined || (Number.isSafeInteger(check.ms) && check.ms >= 0)) && (check.detail === undefined || typeof check.detail === 'string'));
    return { ok: value.service === 'stats' && (value.status === 'ok' || value.status === 'degraded') && checks && (value.release === undefined || typeof value.release === 'string') };
  } catch { return { ok: false }; }
}
export function parseContentTargets(text) {
  const targets = JSON.parse(text);
  if (!Array.isArray(targets)) throw new Error('content targets must be an array');
  const names = new Set();
  return targets.map(target => {
    if (!target || typeof target.name !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(target.name) || names.has(target.name)) throw new Error('invalid content target name');
    names.add(target.name);
    const url = new URL(target.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`invalid content URL for ${target.name}`);
    if (target.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(target.sha256)) throw new Error(`invalid sha256 for ${target.name}`);
    if (target.resolve !== undefined && !/^\d{1,3}(\.\d{1,3}){3}$/.test(target.resolve)) throw new Error(`invalid resolve address for ${target.name}`);
    if (target.intervalS !== undefined && (!Number.isFinite(target.intervalS) || target.intervalS <= 0)) throw new Error(`invalid interval for ${target.name}`);
    if (!['public', 'direct'].includes(target.path)) throw new Error(`content target ${target.name} needs path public or direct`);
    return { name: target.name, url: url.href, path: target.path, ...(target.sha256 ? { sha256: target.sha256 } : {}), ...(target.resolve ? { resolve: target.resolve } : {}), ...(target.intervalS === undefined ? {} : { intervalS: target.intervalS }) };
  });
}
const PATH_AGENTS = new Map();
function pathAgent(target, secure) {
  const key = `${secure ? 'https' : 'http'}:${target.path}:${target.resolve ?? ''}`;
  let agent = PATH_AGENTS.get(key);
  if (agent === undefined) {
    agent = secure ? new HttpsAgent({ keepAlive: true, maxSockets: 8 }) : new HttpAgent({ keepAlive: true, maxSockets: 8 });
    PATH_AGENTS.set(key, agent);
  }
  return agent;
}
export function contentCheck(target, timeoutMs = 120000) {
  return new Promise(resolveResult => {
    const url = new URL(target.url);
    const started = performance.now();
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const lookup = target.resolve === undefined ? undefined : (_host, options, callback) => options?.all ? callback(null, [{ address: target.resolve, family: 4 }]) : callback(null, target.resolve, 4);
    let settled = false;
    const finish = result => { if (!settled) { settled = true; resolveResult({ path: target.path, ms: Math.round(performance.now() - started), ...result }); } };
    const req = request(url, { method: 'GET', agent: pathAgent(target, url.protocol === 'https:'), headers: { 'user-agent': 'stats-observer', 'accept-encoding': 'identity' }, ...(lookup ? { lookup } : {}) }, res => {
      const ttfbMs = Math.round(performance.now() - started);
      const hash = createHash('sha256');
      let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
      res.on('end', () => {
        const sha256 = hash.digest('hex');
        const length = res.headers['content-length'];
        const complete = res.complete && (length === undefined || Number(length) === bytes);
        const digestOk = target.sha256 === undefined || target.sha256 === sha256;
        finish({ ok: res.statusCode === 200 && complete && digestOk, status: res.statusCode, ttfbMs, bytes, sha256, complete, digestOk,
          cache: res.headers['cf-cache-status'] ?? null, servedBy: res.headers['x-stuff-served-by'] ?? null, etag: res.headers.etag ?? null });
      });
      res.on('error', error => finish({ ok: false, status: res.statusCode, ttfbMs, bytes, error: error.code ?? error.name }));
      res.on('aborted', () => finish({ ok: false, status: res.statusCode, ttfbMs, bytes, error: 'aborted' }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', error => finish({ ok: false, error: error.code ?? error.name }));
    req.end();
  });
}
async function contentLoop(statePath, targets, intervalMs, outbox, rotatedLimit) {
  let exhausted = false;
  const nextCheck = new Map();
  const largeTargets = new Set();
  for (;;) {
    const round = new Date().toISOString();
    const results = [];
    let next = 0;
    const due = targets.filter(target => (nextCheck.get(target.name) ?? 0) <= Date.now());
    await Promise.all(Array.from({ length: Math.min(CONTENT_CONCURRENCY, due.length) }, async () => {
      while (next < due.length) {
        const target = due[next++];
        const result = await contentCheck(target);
        if (result.bytes !== undefined) {
          if (result.bytes > 256 * 1024) largeTargets.add(target.name); else if (result.ok) largeTargets.delete(target.name);
        }
        nextCheck.set(target.name, Date.now() + (target.intervalS === undefined ? (largeTargets.has(target.name) ? 300000 : intervalMs) : target.intervalS * 1000));
        results.push([target, result]);
      }
    }));
    for (const [target, result] of results) {
      try {
        appendRotating(resolve(statePath, 'content.jsonl'), { at: new Date().toISOString(), round, condition: target.name, ...result }, { rotatedLimit });
        exhausted = false;
      } catch (error) {
        if (!(error instanceof EvidenceExhausted)) throw error;
        if (!exhausted) appendDurable(resolve(statePath, 'evidence.jsonl'), { at: new Date().toISOString(), condition: 'content-evidence', ok: false, exhausted: error.message });
        exhausted = true;
      }
      outbox.transition(`content:${target.name}`, !result.ok);
    }
    await delay(intervalMs);
  }
}
export function tcpCheck({ host, port }) {
  return new Promise(resolveResult => {
    const socket = connect({ host, port, timeout: 10000 });
    const finish = ok => { socket.destroy(); resolveResult({ ok }); };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
export async function main(args) {
  const config = Object.fromEntries(args.reduce((pairs, value, index) => { if (index % 2 === 0) pairs.push([value.replace(/^--/, ''), args[index + 1]]); return pairs; }, []));
  const { 'state-dir': state, 'candidate-dir': candidate, statsctl, hosts, health, 'interval-s': interval } = config;
  if (![state, candidate, statsctl, hosts, health, interval].every(Boolean) || !Number.isFinite(Number(interval)) || Number(interval) <= 0) throw new Error('all paths and options are required');
  const httpTargets = parseTargets(config.http, 'http'), tcpTargets = parseTargets(config.tcp, 'tcp');
  if (new Set([...httpTargets, ...tcpTargets].map(([name]) => name)).size !== httpTargets.length + tcpTargets.length) throw new Error('--http and --tcp check names must be distinct');
  const contentTargets = config['content-file'] === undefined ? [] : parseContentTargets(readFileSync(config['content-file'], 'utf8'));
  const contentInterval = Number(config['content-interval-s'] ?? '10');
  if (!Number.isFinite(contentInterval) || contentInterval <= 0) throw new Error('--content-interval-s must be positive');
  const rotatedLimit = Number(config['retained-count'] ?? ROTATED_LIMIT);
  if (!Number.isSafeInteger(rotatedLimit) || rotatedLimit < 1) throw new Error('--retained-count must be a positive integer');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const statePath = stateOutsideCandidate(state, candidate);
  const outbox = new Outbox(statePath);
  if (contentTargets.length > 0) contentLoop(statePath, contentTargets, contentInterval * 1000, outbox, rotatedLimit).catch(error => { console.error(`content loop failed: ${error.message}`); process.exit(1); });
  let exhausted = false;
  for (;;) {
    const fs = statfsSync(statePath);
    outbox.transition('evidence-space', fs.bavail * fs.bsize < RESERVE_BYTES * 2);
    const checks = [['hosts', () => command(statsctl, ['check', 'hosts', '--hosts', hosts, '--json'])], ['health', () => healthCheck(health)],
      ...httpTargets.map(([name, url]) => [name, () => httpCheck(url)]), ...tcpTargets.map(([name, address]) => [name, () => tcpCheck(address)])];
    for (const [condition, check] of checks) {
      const result = await check();
      try {
        appendRotating(resolve(statePath, 'evidence.jsonl'), { at: new Date().toISOString(), condition, ...result }, { rotatedLimit });
        exhausted = false;
      } catch (error) {
        if (!(error instanceof EvidenceExhausted)) throw error;
        if (!exhausted) appendDurable(resolve(statePath, 'exhaustion.jsonl'), { at: new Date().toISOString(), condition: 'evidence', ok: false, exhausted: error.message });
        exhausted = true;
      }
      outbox.transition(condition, !result.ok);
    }
    await delay(Number(interval) * 1000);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
