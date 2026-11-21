import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { Outbox, httpCheck, parseTargets, stateOutsideCandidate, tcpCheck } from './observer.mjs';

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
    const fixed = [process.execPath, '/opt/o/observer.mjs', '/var/lib/o', '/vm', '/opt/o/statsctl', 'lisa', 'https://stats.test/health', '/etc/o/c.json', '60'];
    const run = (output: string, extra: string[]) => spawnSync('sh', ['deploy/observer/install.sh', 'openrc', 'deploy/observer/openrc.template', output, ...fixed, ...extra], { encoding: 'utf8' });
    const ok = run(resolve(dir, 'ok'), ['--http', 'forge=https://forge.test/health', '--tcp', 'forge-ssh=10.0.0.1:12222']);
    assert.equal(ok.status, 0, ok.stderr);
    const rendered = readFileSync(resolve(dir, 'ok'), 'utf8');
    assert.match(rendered, /'\\''--http'\\'' '\\''forge=https:\/\/forge\.test\/health'\\'' '\\''--tcp'\\'' '\\''forge-ssh=10\.0\.0\.1:12222'\\''/);
    assert.notEqual(run(resolve(dir, 'bad'), ['--health', 'x']).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
