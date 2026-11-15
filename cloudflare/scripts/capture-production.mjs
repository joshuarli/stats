import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readHistory } from '../test/support/history.ts';

const root = join(process.cwd(), '.work/tmp/preview-production');
const state = join(process.cwd(), '.work/tmp/preview-capture-state.json');
const now = Date.now();
const windows = { '1h': 3600000, '6h': 21600000, '24h': 86400000 };
await mkdir(root, { recursive: true, mode: 0o700 });
await writeFile(state, JSON.stringify({ status: 'capture-in-progress', capturedAtMs: now }), { mode: 0o600 });
async function get(path) {
  const response = await fetch(`https://stats.17166969.xyz${path}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return response.headers.get('content-type')?.includes('application/vnd.stats.history') ? readHistory(bytes) : JSON.parse(bytes);
}
async function save(name, value) { await writeFile(join(root, name), JSON.stringify(value), { mode: 0o600 }); }
const capabilities = await get('/api/v1/capabilities');
const hosts = await get('/api/v1/hosts');
const services = await get('/api/v1/services');
await save('capabilities.json', capabilities); await save('hosts.json', hosts); await save('services.json', services);
for (const service of services.services) {
  await save(`${service.name}-deployments.json`, await get(`/api/v1/services/${service.name}/deployments`));
  for (const [range, duration] of Object.entries(windows)) {
    const query = `from=${now-duration}&to=${now}`;
    for (const [suffix, endpoint] of [['summary', '/summary'], ['recent', '']]) {
      await save(`${service.name}-${suffix}-${range}.json`, await get(`/api/observe/${service.name}/external/telemetry${endpoint}?${query}`));
    }
  }
}
const host = hosts.hosts.find(entry => entry.name === 'lisa');
if (!host) throw new Error('representative host unavailable');
await save('host-system.json', await get(`/api/v1/hosts/${host.hostId}/system`));
for (const [range, duration] of Object.entries(windows)) {
  for (const kind of ['summary', 'disks', 'nets', 'filesystems', 'block']) {
    await save(`host-${kind}-${range}.json`, await get(`/api/v1/hosts/${host.hostId}/history?from=${now-duration}&to=${now}&kind=${kind}`));
  }
}
await save('capture.json', { capturedAtMs: now, hostId: host.hostId, windows });
await writeFile(state, JSON.stringify({ status: 'capture-complete', capturedAtMs: now }), { mode: 0o600 });
console.log(`captured ${services.services.length} services and ${hosts.hosts.length} hosts at ${new Date(now).toISOString()}`);
