import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { EvidenceExhausted, Outbox, appendRotating, contentCheck, healthCheck, httpCheck, parseContentTargets, parseTargets, stateOutsideCandidate, tcpCheck } from './observer.mjs';

test('outbox persists, deduplicates after restart and resolves without delivery', () => {
  const dir = mkdtempSync(resolve('.work/tmp/observer-'));
  try {
    new Outbox(dir).transition('health', true);
    const restarted = new Outbox(dir);
    restarted.transition('health', true);
    restarted.transition('health', false);
    new Outbox(dir).transition('health', false);
    const records = readFileSync(resolve(dir, 'alerts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(r => [r.condition, r.transition, r.delivery]), [['health', 'open', 'unconfigured'], ['health', 'resolve', 'unconfigured']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('state must be outside the candidate, which may be unreachable to the observer', () => {
  const dir = mkdtempSync(resolve('.work/tmp/observer-'));
  try {
    const candidate = resolve(dir, 'candidate'), state = resolve(dir, 'state'), locked = resolve(dir, 'locked');
    mkdirSync(resolve(candidate, 'state'), { recursive: true });
    mkdirSync(state);
    mkdirSync(resolve(locked, 'vm'), { recursive: true });
    assert.throws(() => stateOutsideCandidate(resolve(candidate, 'state'), candidate), /outside candidate/);
    assert.throws(() => stateOutsideCandidate(candidate, candidate), /outside candidate/);
    assert.equal(stateOutsideCandidate(state, candidate), realpathSync(state));
    assert.throws(() => stateOutsideCandidate(state, resolve(dir, 'missing')), { code: 'ENOENT' });
    chmodSync(locked, 0o000);
    try {
      assert.equal(stateOutsideCandidate(state, resolve(locked, 'vm')), realpathSync(state));
    } finally { chmodSync(locked, 0o700); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('named checks parse strictly and report reachability', async () => {
  assert.deepEqual(parseTargets(undefined, 'http'), []);
  assert.deepEqual(parseTargets('forge=https://example.test/api/forge/v1/health', 'http'), [['forge', 'https://example.test/api/forge/v1/health']]);
  assert.deepEqual(parseTargets('forge-ssh=100.98.145.91:12222', 'tcp'), [['forge-ssh', { host: '100.98.145.91', port: 12222 }]]);
  for (const [value, kind] of [['health=https://x.test', 'http'], ['Forge=https://x.test', 'http'], ['a=ftp://x.test', 'http'], ['a=https://x.test,a=https://y.test', 'http'], ['=https://x.test', 'http'], ['ssh=host', 'tcp'], ['ssh=host:70000', 'tcp']]) {
    assert.throws(() => parseTargets(value, kind), /invalid/, value);
  }
  const server = createServer((request, response) => { response.statusCode = request.url === '/ok' ? 200 : 503; response.end(); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    assert.deepEqual(await httpCheck(`http://127.0.0.1:${port}/ok`), { ok: true });
    assert.deepEqual(await httpCheck(`http://127.0.0.1:${port}/down`), { ok: false });
    assert.deepEqual(await tcpCheck({ host: '127.0.0.1', port }), { ok: true });
  } finally { await new Promise(done => server.close(done)); }
  assert.deepEqual(await tcpCheck({ host: '127.0.0.1', port }), { ok: false });
  assert.deepEqual(await httpCheck(`http://127.0.0.1:${port}/ok`), { ok: false });
});

test('the installer passes optional named checks through and rejects other extras', () => {
  const dir = mkdtempSync(resolve('.work/tmp/observer-'));
  try {
    const fixed = [process.execPath, '/opt/o/observer.mjs', '/var/lib/o', '/vm', '/opt/o/statsctl', 'lisa', 'https://stats.test/health', '60'];
    const run = (output: string, extra: string[]) => spawnSync('sh', ['deploy/observer/install.sh', 'openrc', 'deploy/observer/openrc.template', output, ...fixed, ...extra], { encoding: 'utf8' });
    const ok = run(resolve(dir, 'ok'), ['--http', 'forge=https://forge.test/health', '--tcp', 'forge-ssh=10.0.0.1:12222']);
    assert.equal(ok.status, 0, ok.stderr);
    const rendered = readFileSync(resolve(dir, 'ok'), 'utf8');
    assert.match(rendered, /'\\''--http'\\'' '\\''forge=https:\/\/forge\.test\/health'\\'' '\\''--tcp'\\'' '\\''forge-ssh=10\.0\.0\.1:12222'\\''/);
    assert.notEqual(run(resolve(dir, 'bad'), ['--health', 'x']).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('content checks verify full bodies, digests and truncation by path', async () => {
  const body = 'z'.repeat(100_000);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const server = createServer((request, response) => {
    if (request.url === '/truncated') { response.writeHead(200, { 'content-length': String(body.length) }); response.write(body.slice(0, 1000)); response.destroy(); return; }
    response.writeHead(request.url === '/missing' ? 404 : 200, { 'content-length': String(body.length), 'cf-cache-status': 'HIT' });
    response.end(body);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    const target = (path: string, digest?: string) => ({ name: 'x', path: 'direct', url: `http://origin.test:${port}${path}`, resolve: '127.0.0.1', ...(digest ? { sha256: digest } : {}) });
    const good = await contentCheck(target('/blob', sha256));
    assert.equal(good.ok, true);
    assert.equal(good.bytes, body.length);
    assert.equal(good.cache, 'HIT');
    assert.equal(good.path, 'direct');
    assert.equal((await contentCheck(target('/blob', '0'.repeat(64)))).ok, false);
    const truncated = await contentCheck(target('/truncated'));
    assert.equal(truncated.ok, false);
    assert.equal((await contentCheck(target('/missing'))).ok, false);
  } finally { await new Promise(done => server.close(done)); }
  assert.throws(() => parseContentTargets('[{"name":"a","url":"https://x.test","path":"cdn"}]'), /path public or direct/);
  assert.throws(() => parseContentTargets('[{"name":"a","url":"https://x.test","path":"public","sha256":"zz"}]'), /invalid sha256/);
});

test('evidence rotates with a digest checkpoint and prunes old files', () => {
  const dir = mkdtempSync(resolve('.work/tmp/observer-'));
  try {
    const path = resolve(dir, 'content.jsonl');
    for (let index = 0; index < 4; index++) appendRotating(path, { index, pad: 'p'.repeat(100) }, { rotateBytes: 300, rotatedLimit: 2, reserveBytes: 0 });
    const rotated = readdirSync(dir).filter(name => name.startsWith('content-'));
    assert.equal(rotated.length, 1);
    const head = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]!);
    assert.equal(head.checkpoint.rotatedTo, rotated[0]);
    assert.equal(head.checkpoint.sha256, createHash('sha256').update(readFileSync(resolve(dir, rotated[0]!))).digest('hex'));
    writeFileSync(resolve(dir, 'content-x.jsonl'), '');
    for (let index = 0; index < 20; index++) appendRotating(path, { index, pad: 'p'.repeat(100) }, { rotateBytes: 300, rotatedLimit: 2, reserveBytes: 0 });
    assert.ok(readdirSync(dir).filter(name => name.startsWith('content-')).length <= 2);
    assert.throws(() => appendRotating(resolve(dir, 'other.jsonl'), {}, { reserveBytes: Number.MAX_SAFE_INTEGER }), EvidenceExhausted);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public and direct content paths use separate connections', async () => {
  const sockets = new Set();
  const server = createServer((request, response) => { sockets.add(request.socket); response.end('ok'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    const url = `http://127.0.0.1:${port}/blob`;
    assert.equal((await contentCheck({ name: 'a', path: 'public', url })).ok, true);
    assert.equal((await contentCheck({ name: 'b', path: 'direct', url })).ok, true);
    assert.equal(sockets.size, 2);
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});

test('Stats health requires the contract and rejects redirects and wrong services', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/ok' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: request.url === '/degraded' ? 'degraded' : 'ok', service: request.url === '/wrong' ? 'other' : 'stats', checks: {} }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    for (const [path, ok] of [['ok', true], ['degraded', true], ['redirect', false], ['wrong', false]] as const) {
      assert.equal((await healthCheck(`http://127.0.0.1:${port}/${path}`)).ok, ok);
    }
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});

test('content target intervals are positive seconds', () => {
  assert.equal(parseContentTargets('[{"name":"a","url":"https://x.test","path":"public","intervalS":300}]')[0].intervalS, 300);
  assert.throws(() => parseContentTargets('[{"name":"a","url":"https://x.test","path":"public","intervalS":0}]'), /interval/);
});

test('main continues alert transitions when evidence reaches its reserve', async () => {
  const dir = mkdtempSync(resolve('.work/tmp/observer-'));
  const state = resolve(dir, 'state');
  const candidate = resolve(dir, 'candidate');
  mkdirSync(state);
  mkdirSync(candidate);
  const preload = resolve(dir, 'preload.mjs');
  writeFileSync(preload, "import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; fs.statfsSync = () => ({ bavail: 0, bsize: 4096 }); syncBuiltinESMExports();\n");
  const ctl = resolve(dir, 'statsctl');
  writeFileSync(ctl, '#!/bin/sh\nprintf \'{"payload":{"hosts":[]}}\\n\'\n');
  chmodSync(ctl, 0o700);
  const server = createServer((_request, response) => { response.writeHead(503); response.end(); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  const child = spawn(process.execPath, ['--import', preload, 'deploy/observer/observer.mjs', '--state-dir', state, '--candidate-dir', candidate, '--statsctl', ctl, '--hosts', 'h', '--health', `http://127.0.0.1:${port}/health`, '--interval-s', '0.05'], { stdio: 'ignore' });
  try {
    const deadline = Date.now() + 5000;
    let alerts = '';
    while (Date.now() < deadline) {
      try { alerts = readFileSync(resolve(state, 'alerts.jsonl'), 'utf8'); } catch {}
      if (alerts.includes('"health"')) break;
      await new Promise(done => setTimeout(done, 25));
    }
    assert.match(alerts, /"condition":"health","transition":"open"/);
    assert.match(alerts, /"condition":"evidence-space","transition":"open"/);
    await new Promise(done => setTimeout(done, 200));
    assert.equal(readFileSync(resolve(state, 'exhaustion.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally {
    child.kill('SIGTERM');
    await new Promise(done => child.once('exit', done));
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content scheduling slows large bodies and respects target intervals', async () => {
  const dir = mkdtempSync(resolve('.work/tmp/observer-'));
  const state = resolve(dir, 'state'), candidate = resolve(dir, 'candidate');
  mkdirSync(state); mkdirSync(candidate);
  const ctl = resolve(dir, 'statsctl');
  writeFileSync(ctl, '#!/bin/sh\nprintf \'{"payload":{"hosts":[]}}\\n\'\n');
  chmodSync(ctl, 0o700);
  const counts = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = request.url!;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    response.end(path === '/large' ? 'x'.repeat(300_000) : 'ok');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  const targets = resolve(dir, 'targets.json');
  writeFileSync(targets, JSON.stringify(['large', 'small', 'custom'].map(name => ({ name, path: 'public', url: `http://127.0.0.1:${port}/${name}`, ...(name === 'custom' ? { intervalS: 300 } : {}) }))));
  const child = spawn(process.execPath, ['deploy/observer/observer.mjs', '--state-dir', state, '--candidate-dir', candidate, '--statsctl', ctl, '--hosts', 'h', '--health', `http://127.0.0.1:${port}/health`, '--interval-s', '0.05', '--content-file', targets, '--content-interval-s', '0.05'], { stdio: 'ignore' });
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (counts.get('/small') ?? 0) < 3) await new Promise(done => setTimeout(done, 25));
    assert.ok((counts.get('/small') ?? 0) >= 3);
    assert.equal(counts.get('/large'), 1);
    assert.equal(counts.get('/custom'), 1);
  } finally {
    child.kill('SIGTERM');
    await new Promise(done => child.once('exit', done));
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a main failure exits even while the content loop is active', async () => {
  const dir = mkdtempSync(resolve('.work/tmp/observer-'));
  const state = resolve(dir, 'state'), candidate = resolve(dir, 'candidate');
  mkdirSync(state); mkdirSync(candidate);
  const preload = resolve(dir, 'preload.mjs'), targets = resolve(dir, 'targets.json');
  writeFileSync(preload, "import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; fs.statfsSync = () => { throw new Error('statfs failed'); }; syncBuiltinESMExports();\n");
  const server = createServer(() => {});
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  writeFileSync(targets, JSON.stringify([{ name: 'pending', path: 'public', url: `http://127.0.0.1:${port}/` }]));
  const child = spawn(process.execPath, ['--import', preload, 'deploy/observer/observer.mjs', '--state-dir', state, '--candidate-dir', candidate, '--statsctl', '/unused', '--hosts', 'h', '--health', `http://127.0.0.1:${port}/health`, '--interval-s', '1', '--content-file', targets], { stdio: 'ignore' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('exit', (code, signal) => done({ code, signal })));
    assert.deepEqual(result, { code: 1, signal: null });
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
});
