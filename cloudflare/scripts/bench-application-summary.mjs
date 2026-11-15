#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { InstallationCore } from '../src/core/installation/installation.ts';
import { nodeSqlScopes } from '../src/node/sql.ts';
import { createStatsServer } from '../src/node/server.ts';
import { initializeStore } from '../src/observe/core/store.ts';
import { handleApi } from '../src/observe/http/api.ts';
import { readApplicationSummary as candidate, readApplicationSummaryTimed } from '../src/observe/application/telemetry.ts';

const { values } = parseArgs({ options: { baseline: { type: 'string' }, events: { type: 'string' }, repeat: { type: 'string', default: '1' }, rounds: { type: 'string', default: '5' }, implementation: { type: 'string' } } });
if (!values.baseline || !values.events) throw new Error('usage: node scripts/bench-application-summary.mjs --baseline FILE --events FILE [--repeat 1..10] [--rounds 5..20] [--implementation baseline|candidate]');
const repeat = Number(values.repeat), rounds = Number(values.rounds), iterations = 10;
assert.ok(Number.isInteger(repeat) && repeat >= 1 && repeat <= 10);
assert.ok(Number.isInteger(rounds) && rounds >= 5 && rounds <= 20);
assert.ok(values.implementation === undefined || ['baseline', 'candidate'].includes(values.implementation));
const { readApplicationSummary: baseline } = await import(pathToFileURL(resolve(values.baseline)).href);
const source = readFileSync(values.events), captured = JSON.parse(source.toString()).events?.map(row => row.event);
assert.ok(Array.isArray(captured) && captured.length > 0 && captured.length <= 5000);
assert.ok(captured.every(event => event.service === 'stats' && Number.isSafeInteger(event.atMs)));
const now = Math.max(...captured.map(event => event.atMs)) + 1000;
const fromMs = Math.min(...captured.map(event => event.atMs));
const filter = { fromMs, toMs: now };
const db = new DatabaseSync(':memory:'), sql = nodeSqlScopes(db).open();
const clock = { now: () => now };
const core = new InstallationCore({ sql: nodeSqlScopes(db), clock, scheduler: { pending: async () => null, at: async () => {} }, operations: { invocation: () => {}, operation: () => {} }, probesServices: false }, { projects: () => '[]', deploymentsEnabled: () => false });
let server;
try {
  core.initialize(); initializeStore(sql);
  db.prepare('INSERT INTO services (name, token_hash, ingest_token_hash, host_ids, created_at_ms) VALUES (?, ?, ?, ?, ?)').run('stats', 'benchmark', 'benchmark', '[]', now);
  const insert = db.prepare('INSERT INTO observe_external_events VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let copy = 0; copy < repeat; copy++) for (const event of captured) insert.run(event.service, `${copy}:${event.eventId}`, now, event.atMs, 'application', JSON.stringify(event));
  db.exec('COMMIT');
  const expected = baseline(sql, 'stats', now, filter);
  assert.equal(expected.totals?.events, captured.length * repeat);
  let read = baseline;
  const store = { applicationSummary: async (service, window) => read === candidate ? readApplicationSummaryTimed(sql, service, now, window, () => performance.now()) : ({ data: read(sql, service, now, window), queryMs: 0, issuesMs: 0, readMs: 0 }) };
  server = createStatsServer({ installation: request => core.fetch(request), assets: async () => new Response(null, { status: 404 }), transport: 'tcp', observe: (target, init) => {
    const url = new URL(target), path = url.pathname.replace(/^\/stats/u, '');
    return handleApi(new Request(`https://observe${path}${url.search}`, init), path, store, 'stats', now);
  } });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/api/observe/stats/external/telemetry/summary?from=${fromMs}&to=${now}`;
  const request = async () => {
    const response = await fetch(url, { headers: { 'Tailscale-User-Login': 'benchmark@localhost' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  };
  for (const name of values.implementation === undefined ? ['baseline', 'candidate'] : [values.implementation]) { read = name === 'baseline' ? baseline : candidate; for (let n = 0; n < 3; n++) await request(); }
  const results = [];
  for (let round = 0; round < rounds; round++) for (const name of (round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])) {
    if (values.implementation !== undefined && name !== values.implementation) continue;
    read = name === 'baseline' ? baseline : candidate;
    const cpu = process.cpuUsage(), start = performance.now();
    for (let n = 0; n < iterations; n++) await request();
    const ms = (performance.now() - start) / iterations, used = process.cpuUsage(cpu);
    results.push({ round, name, ms, cpuMs: (used.user + used.system) / 1000 / iterations });
  }
  console.log(JSON.stringify({ node: process.version, mode: 'node-http-loopback-in-memory-sqlite', capturedEvents: captured.length, events: captured.length * repeat, sourceSha256: createHash('sha256').update(source).digest('hex'), fromMs, toMs: now, iterations, results, memory: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS, outputBytes: Buffer.byteLength(JSON.stringify(expected)), failures: 0 }));
} finally {
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  db.close();
}
