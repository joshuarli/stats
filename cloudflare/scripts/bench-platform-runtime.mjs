#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generateToken, tokenHash } from '../src/auth.ts';
import { GATEWAY_IDENTITY_HEADER, GATEWAY_SECRET_HEADER } from '../src/cloudflare/gateway.ts';
import { createProducer } from '../../packages/producer/src/index.ts';
import { createBridgeServer } from '../../packages/platform-bridge/src/server.ts';
import { generate } from '../../deploy/orange/generate.mts';
import { freePort, startSession } from '../../deploy/orange/session.mts';

const { values } = parseArgs({ options: { events: { type: 'string' }, actors: { type: 'string' }, out: { type: 'string' } } });
if (!values.events || !values.actors || !values.out) throw new Error('usage: node cloudflare/scripts/bench-platform-runtime.mjs --events FILE --actors FILE --out FILE');
const source = readFileSync(values.events), events = JSON.parse(source.toString()).events?.map(row => row.event);
assert.ok(Array.isArray(events) && events.length > 0 && events.length <= 5000 && events.every(event => event.service === 'stats'));
const scratch = resolve(import.meta.dirname, '../../.work/tmp'); mkdirSync(scratch, { recursive: true });
const output = resolve(values.out);
if (!output.startsWith(scratch + '/')) throw new Error('benchmark output must be under repository .work/tmp');
mkdirSync(dirname(output), { recursive: true });
const root = mkdtempSync(resolve(scratch, 'platform-overhead-'));
const from = Math.min(...events.map(event => event.atMs)), to = Math.max(...events.map(event => event.atMs)) + 1;
const actors = JSON.parse(readFileSync(values.actors, 'utf8'));
const samplingPpm = 100000;
const instances = [];
let bridge, producer;
const headers = { [GATEWAY_SECRET_HEADER]: randomBytes(32).toString('hex'), [GATEWAY_IDENTITY_HEADER]: 'user:platform-bench@example.com', 'content-type': 'application/json' };
const ingestToken = generateToken(), otlpToken = randomBytes(32).toString('base64url');
const gate = flag => {
  const result = spawnSync('perf-gate-ready', flag ? [flag] : [], { encoding: 'utf8' });
  writeFileSync(output + (flag ? '.post-gate.log' : '.pre-gate.log'), JSON.stringify({ exitCode: result.status }) + '\n', { mode: 0o600 });
  if (result.error) throw new Error('perf gate unavailable');
  if (result.status !== 0) throw new Error(result.status === 75 ? 'perf gate deferred: host busy' : 'perf gate failed');
};
try {
  const activePort = await freePort();
  producer = createProducer({ endpoint: `http://127.0.0.1:${activePort}`, service: 'stats-platform', token: ingestToken, release: 'bridge-bench', queueLimit: 128, batchSize: 64, timeoutMs: 5000, maxRetries: 1 });
  bridge = createBridgeServer({ producer, token: otlpToken, policy: { resourceService: 'stats-runtime-bench', openorangeVersion: '1.0.2', rivetkitVersion: '3.1.2-rc.1', nativeVersion: '3.1.1', samplePpm: samplingPpm, actors } });
  await new Promise(done => bridge.server.listen(0, '127.0.0.1', done));
  const collector = `http://127.0.0.1:${bridge.server.address().port}/v1/traces`;
  for (const name of ['disabled', 'sampled']) {
    const directory = resolve(root, name); mkdirSync(directory);
    const generated = generate(directory, { kind: 'dev', release: 'platform-bench', gatewaySecret: headers[GATEWAY_SECRET_HEADER], nowMs: null });
    const config = JSON.parse(readFileSync(generated.stats, 'utf8')); config.vars.PLATFORM_BRIDGE_TOKEN_SHA256 = await tokenHash(ingestToken);
    writeFileSync(generated.stats, JSON.stringify(config), { mode: 0o600 });
    const session = await startSession(directory, name === 'sampled' ? activePort : await freePort(), { environment: name === 'disabled' ? { OTEL_SDK_DISABLED: 'true' } : { OTEL_SDK_DISABLED: 'false', OTEL_SERVICE_NAME: 'stats-runtime-bench', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector, OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${otlpToken}`, OTEL_TRACES_SAMPLER: 'parentbased_traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.1', OTEL_BSP_MAX_QUEUE_SIZE: '256', OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '64', OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '1000', OTEL_RESOURCE_ATTRIBUTES: 'service.version=platform-bench,openorange.version=1.0.2' } });
    instances.push({ name, session });
    const post = (path, body, token) => fetch(session.origin + path, { method: 'POST', headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const hostResponse = await post('/api/v1/admin/hosts', { name: 'captured-host' }); assert.equal(hostResponse.status, 201);
    const host = await hostResponse.json();
    const serviceResponse = await post('/api/v1/admin/services', { name: 'stats', hostIds: [host.hostId], healthUrl: `${session.origin}/health` }); assert.equal(serviceResponse.status, 201);
    const service = await serviceResponse.json();
    const maxBytes = Math.max(...events.map(event => Buffer.byteLength(JSON.stringify(event))));
    const size = Math.min(64, Math.floor(60000 / (maxBytes + 1))); assert.ok(size >= 1);
    for (let start = 0; start < events.length; start += size) {
      const batch = events.slice(start, start + size), response = await post('/ingest/observe/v1/stats/batches', { events: batch }, service.ingestToken);
      assert.equal(response.status, 202); const result = await response.json(); assert.equal(result.accepted + result.duplicate, batch.length);
    }
  }
  const read = async item => {
    const response = await fetch(`${item.session.origin}/api/observe/stats/external/telemetry/summary?from=${from}&to=${to}`, { headers });
    assert.equal(response.status, 200); const value = await response.json(); assert.equal(value.totals.events, events.length); return value;
  };
  const expected = await read(instances[0]); assert.deepEqual(await read(instances[1]), expected);
  for (let n = 0; n < 3; n++) for (const instance of instances) assert.deepEqual(await read(instance), expected);
  const delivered = Date.now() + 15000;
  while (producer.stats().sent === 0 && Date.now() < delivered) { await producer.flush(); await new Promise(done => setTimeout(done, 100)); }
  assert.ok(producer.stats().sent > 0, 'the sampled runtime must actually export and deliver observations');
  gate();
  const results = [];
  for (let round = 0; round < 5; round++) {
    const totals = new Map(instances.map(item => [item.name, []]));
    for (let n = 0; n < 8; n++) {
      for (const instance of (round % 2 ? [...instances].reverse() : instances)) {
        const start = performance.now(), value = await read(instance), ms = performance.now() - start;
        assert.deepEqual(value, expected); totals.get(instance.name).push(ms);
      }
      await new Promise(done => setTimeout(done, 250));
    }
    for (const [name, samples] of totals) results.push({ round, name, meanMs: samples.reduce((sum, n) => sum + n, 0) / samples.length, samples });
  }
  gate('-1');
  await producer.flush();
  const result = { node: process.version, workload: 'native Orange HTTP summary reads with concurrent native export and producer delivery', events: events.length, sourceSha256: createHash('sha256').update(source).digest('hex'), samplingPpm, results, receiver: bridge.counters(), producer: producer.stats(), harnessMemory: process.memoryUsage(), failures: 0 };
  writeFileSync(output, JSON.stringify(result) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ events: result.events, results: results.map(({ samples, ...row }) => row), receiver: result.receiver, producer: result.producer }));
} finally {
  for (const item of instances.reverse()) await item.session.stop();
  if (bridge) { bridge.server.closeAllConnections(); await new Promise(done => bridge.server.close(done)); }
  await producer?.shutdown();
  rmSync(root, { recursive: true, force: true });
}
