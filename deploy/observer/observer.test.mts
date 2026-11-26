import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { EvidenceExhausted, Outbox, appendRotating, contentCheck, httpCheck, parseContentTargets, parseTargets, stateOutsideCandidate, tcpCheck } from './observer.mjs';

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

test('evidence rotates with a digest checkpoint and stops at its limits', () => {
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
    assert.throws(() => { for (let index = 0; index < 20; index++) appendRotating(path, { index, pad: 'p'.repeat(100) }, { rotateBytes: 300, rotatedLimit: 2, reserveBytes: 0 }); }, EvidenceExhausted);
    assert.throws(() => appendRotating(resolve(dir, 'other.jsonl'), {}, { reserveBytes: Number.MAX_SAFE_INTEGER }), EvidenceExhausted);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
