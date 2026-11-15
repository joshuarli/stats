import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readHistory } from '../support/history.ts';

interface ProductionCapture {
  [window: string]: unknown;
  capture: { capturedAtMs: number; hostId: string };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await Promise.race([exited, new Promise<never>((_, reject) => { const limit = setTimeout(() => reject(new Error('preview did not exit')), 4000); limit.unref(); })]); } finally { clearTimeout(timer); }
}

await test('preview serves captured native windows and rejects uncaptured requests', async () => {
  const data = JSON.parse(await readFile(new URL('../ui/captures/production/data.json', import.meta.url), 'utf8')) as ProductionCapture;
  const port = 4199;
  const child = spawn(process.execPath, ['scripts/preview.mjs'], { cwd: new URL('../..', import.meta.url), env: { ...process.env, PREVIEW_PORT: String(port) }, stdio: 'pipe' });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.on('data', () => resolve()); child.once('exit', code => reject(new Error(`preview exited ${code}`))); });
    const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
    assert.deepEqual(await (await get('/api/v1/capabilities')).json(), data.capabilities);
    assert.deepEqual(await (await get('/api/v1/hosts')).json(), data.hosts);
    assert.deepEqual(await (await get('/api/v1/services')).json(), data.services);
    const now = data.capture.capturedAtMs;
    const path = `/api/observe/stats/external/telemetry/summary?from=${now - 3600000}&to=${now}`;
    assert.deepEqual(await (await get(path)).json(), data['stats-summary-1h']);
    for (const [range, duration] of [['6h', 21600000], ['24h', 86400000]] as const) {
      assert.deepEqual(await (await get(`/api/observe/stats/external/telemetry/summary?from=${now - duration}&to=${now}`)).json(), data[`stats-summary-${range}`]);
    }
    assert.equal((await get(`/api/observe/stats/external/telemetry/summary?from=${now - 3600001}&to=${now}`)).status, 404);
    assert.equal((await get('/api/observe/unknown/external/telemetry')).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ingest/ui-journey`, { method: 'POST' })).status, 404);
    assert.deepEqual(await (await get(`/api/observe/stats/external/telemetry?from=${now - 3600000}&to=${now}`)).json(), data['stats-recent-1h']);
    assert.deepEqual(await (await get('/api/v1/services/stats/deployments')).json(), data['stats-deployments']);
    const history = await get(`/api/v1/hosts/${data.capture.hostId}/history?range=1h&kind=summary`);
    assert.equal(history.status, 200);
    assert.equal((await get(`/api/v1/hosts/${data.capture.hostId}/history?range=1h&from=${now - 21600000}&to=${now}&kind=summary`)).status, 404);
    assert.deepEqual(readHistory(await history.arrayBuffer()), data['host-summary-1h']);
  } finally { await stop(child); }
});

await test('legacy profile serves Cloudflare capabilities and project fixtures', async () => {
  const child = spawn(process.execPath, ['scripts/preview.mjs'], { cwd: new URL('../..', import.meta.url), env: { ...process.env, PREVIEW_PORT: '4197', PREVIEW_PROFILE: 'legacy' }, stdio: 'pipe' });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.on('data', () => resolve()); child.once('exit', code => reject(new Error(`preview exited ${code}`))); });
    const capabilities = await (await fetch('http://127.0.0.1:4197/api/v1/capabilities')).json() as { projectSource: string };
    assert.equal(capabilities.projectSource, 'cloudflare');
    const projects = await (await fetch('http://127.0.0.1:4197/api/v1/projects')).json() as unknown[];
    assert.ok(projects.length > 0);
  } finally { await stop(child); }
});
