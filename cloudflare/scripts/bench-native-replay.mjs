#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openNodeInstallation } from '../src/node/installation.ts';
import { createStatsServer, observeHandler } from '../src/node/server.ts';
import { openAssets } from '../src/node/assets.ts';
import { createBenchServer } from './bench-native-server.mjs';

const usage = 'usage: node scripts/bench-native-replay.mjs --events FILE --baseline ASSETS --candidate ASSETS [--service NAME]';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log(usage); process.exit(0); }
const value = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const eventsFile = value('--events'), baselineAssets = value('--baseline'), candidateAssets = value('--candidate');
const serviceName = value('--service') ?? 'stats';
if (!eventsFile || !baselineAssets || !candidateAssets) throw new Error(usage);
const source = await readFile(eventsFile);
const events = JSON.parse(source.toString()).events?.map(row => row.event);
if (!Array.isArray(events) || events.length === 0 || events.length > 5000 || events.some(event => event.service !== serviceName || !Number.isSafeInteger(event.atMs))) throw new Error('invalid captured event window');
const now = Math.max(...events.map(event => event.atMs)) + 1000;
if (!Number.isSafeInteger(now)) throw new Error('invalid captured clock');
const scratch = resolve(import.meta.dirname, '../../.work/tmp');
await mkdir(scratch, { recursive: true });
const directory = await mkdtemp(resolve(scratch, 'native-replay-'));
let installation, backend;
const proxies = [];
async function close() {
  for (const proxy of proxies) await proxy.close();
  if (backend) { backend.closeAllConnections(); await new Promise(done => backend.close(done)); }
  installation?.close();
  await rm(directory, { recursive: true, force: true });
}
try {
  installation = openNodeInstallation({ path: resolve(directory, 'stats.sqlite'), projects: '[]', clock: { now: () => now }, probeFetch: async () => ({ status: 200, body: null }) });
  const host = await installation.core.createHost('captured-stats-host');
  if (!host.ok) throw new Error('replay host provisioning failed');
  const post = (route, body, token) => installation.core.fetch(new Request('https://installation' + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
  const service = await post('/admin/services', { name: serviceName, hostIds: [host.value.hostId] });
  if (service.status !== 201) throw new Error('replay service provisioning failed');
  const { deployToken } = await service.json();
  const marker = await post(`/services/${serviceName}/deployments`, { markerId: 'capture-release', version: 'captured', hostIds: [host.value.hostId] }, deployToken);
  if (marker.status !== 201) throw new Error('replay marker provisioning failed');
  for (let start = 0; start < events.length; start += 100) await installation.observe.forService(serviceName).ingestExternal(serviceName, events.slice(start, start + 100));
  backend = createStatsServer({ installation: request => installation.core.fetch(request), observe: observeHandler(installation), assets: await openAssets(candidateAssets), transport: 'tcp' });
  await new Promise(done => backend.listen(0, '127.0.0.1', done));
  const upstream = `http://127.0.0.1:${backend.address().port}`;
  const fixtureFetch = (url, init) => fetch(url, { ...init, headers: { ...init.headers, 'Tailscale-User-Login': 'captured-replay@localhost' } });
  const origins = {};
  for (const [name, assetsDir] of [['baseline', baselineAssets], ['candidate', candidateAssets]]) {
    const proxy = await createBenchServer({ assetsDir, upstream, fetchImpl: fixtureFetch });
    proxies.push(proxy);
    origins[name] = { origin: `http://127.0.0.1:${proxy.server.address().port}`, assets: await realpath(assetsDir) };
  }
  console.log(JSON.stringify({ ...origins, now, service: serviceName, eventCount: events.length, sourceSha256: createHash('sha256').update(source).digest('hex'), node: process.version }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void close().then(() => process.exit(0), () => process.exit(1)); });
} catch (error) { await close(); throw error; }
