import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { isNative, nativeRoutes, selectRoutes, accountNetwork, validSamples } from '../../scripts/bench-native-routes.mjs';
import { createBenchServer } from '../../scripts/bench-native-server.mjs';
import { createNetworkTracker, summarizeNetwork } from '../../scripts/bench-network.mjs';

await test('native route selection uses service names and concrete readiness states', () => {
  const capabilities = { projectSource: 'services', applicationEvents: true, analyticsCollection: false, cloudflareDeployments: false, tailEvents: false };
  assert.equal(isNative(capabilities), true);
  assert.equal(isNative({ ...capabilities, projectSource: 'cloudflare' }), false);
  assert.equal(isNative(null), false);
  const routes = nativeRoutes('http://127.0.0.1:1234', 'api / v1');
  const selected = selectRoutes(routes, 'project');
  assert.ok(selected[0]);
  assert.equal(selected[0].hash, '#/project/api%20%2F%20v1');
  assert.match(routes[0].ready, /h2.*Application overview/u);
  assert.match(routes[1].ready, /Recent application events.*No recent events/u);
  assert.match(routes[2].ready, /Application signals.*uplot/u);
  assert.match(routes[3].ready, /issues/u);
  assert.throws(() => selectRoutes(routes, 'unknown'), /Unknown/u);
  assert.equal(selectRoutes(routes, null), routes);
});

await test('completed responses include real error bodies and non-2xx failures', async () => {
  const page = new EventEmitter();
  const tracker = createNetworkTracker(page, 'http://127.0.0.1:8000');
  for (const [path, status, body] of [['/api/ok', 200, 'hello'], ['/api/fail', 503, 'bad'], ['/api/redirect', 302, 'go'], ['/api/cached', 304, 'ignored']] as const) {
    const entry = { url: () => `http://127.0.0.1:8000${path}`, method: () => 'GET', response: async () => ({ status: () => status, body: async () => new TextEncoder().encode(body) }) };
    page.emit('request', entry); page.emit('requestfinished', entry);
  }
  await tracker.waitForQuiet(0, 500);
  const records = tracker.snapshot();
  const summary = accountNetwork(records, summarizeNetwork(records));
  assert.equal(summary.apiBytes, 10);
  assert.equal(summary.successfulRequests, 2);
  const cached = records.find((record: { status: number }) => record.status === 304);
  assert.ok(cached);
  assert.equal(cached.bytes, 0);
  const cachedSummary = accountNetwork([cached], summarizeNetwork([cached]));
  assert.deepEqual(cachedSummary.failedRequests, []);
  assert.equal(validSamples([{ failedRequests: cachedSummary.failedRequests, readyMs: 50 }]).length, 1);
  assert.deepEqual(validSamples([{ failedRequests: summary.failedRequests, readyMs: 1 }, { failedRequests: [], readyMs: 50 }]), [{ failedRequests: [], readyMs: 50 }]);
  assert.deepEqual(summary.failedRequests, [{ path: '/api/fail', status: 503 }, { path: '/api/redirect', status: 302 }]);
});

await test('loopback proxy serves assets and forwards only bounded read requests without credentials', async () => {
  const scratch = resolve('.work/tmp');
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(resolve(scratch, 'bench-proxy-'));
  await writeFile(resolve(dir, 'index.html'), 'asset');
  let seen: { method: string | undefined; authorization: string | undefined; cookie: string | undefined; path: string | undefined } | undefined;
  const upstream = createServer((req, res) => {
    seen = { method: req.method, authorization: req.headers.authorization, cookie: req.headers.cookie, path: req.url };
    if (req.url === '/api/slow') return;
    if (req.url === '/api/large') { res.end('123456789'); return; }
    res.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end('failure');
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const instance = await createBenchServer({ assetsDir: dir, upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, timeoutMs: 80, maxBytes: 8 });
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  try {
    assert.equal(await (await fetch(base)).text(), 'asset');
    const result = await fetch(`${base}/api/test?q=1`, { headers: { authorization: 'secret', cookie: 'secret' } });
    assert.equal(result.status, 503); assert.equal(await result.text(), 'failure');
    assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(seen, { method: 'GET', authorization: undefined, cookie: undefined, path: '/api/test?q=1' });
    assert.equal((await fetch(`${base}/api/test`, { method: 'HEAD' })).status, 503);
    assert.equal(seen?.method, 'HEAD');
    assert.equal((await fetch(`${base}/api/test`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/unknown`)).status, 404);
    assert.equal((await fetch(`${base}/api/large`)).status, 502);
    assert.equal((await fetch(`${base}/api/slow`)).status, 502);
    const badHost = await new Promise<number | undefined>((done, reject) => { const req = request(`${base}/health`, { headers: { host: 'evil.example' } }, res => { res.resume(); done(res.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(badHost, 403);
  } finally { await instance.close(); upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())); await rm(dir, { recursive: true, force: true }); }
});

await test('native and legacy readiness selectors wait for their actual content', async () => {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const routes = nativeRoutes('http://127.0.0.1', 'stats');
    await page.setContent('<h2>Application overview</h2><table aria-label="Recent application events"></table><section aria-label="Application signals"><div class="uplot"></div></section><div id="issues"><p class="observe-empty">No issues</p></div><div aria-label="Cost ledger"></div>');
    for (const route of routes) assert.equal(await page.locator(route.ready).count(), 1);
    assert.equal(await page.locator('[aria-label="Cost ledger"]').count(), 1);
    await page.setContent('<div class="empty-state">No recent events in this window</div>');
    assert.equal(await page.locator(routes[1].ready).count(), 1);
    assert.equal(await page.locator(routes[0].ready).count(), 0);
  } finally { await browser.close(); }
});
