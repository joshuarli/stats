import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { startStack } from "../../local/stack.ts";
import { CLOUDFLARE_ROOT } from "../../local/topology.ts";

const BUILT = join(CLOUDFLARE_ROOT, "test/fixtures/profile/built");
const SERVICE = "profile-fixture";
const INSERT_REQUESTS = 4;
const ROWS_PER_INSERT = 5;
const SCAN_REQUESTS = 2;
const SCAN_ROWS = 3;
const MEDIA_REQUESTS = 1;
const ROOT_REQUESTS = 2;

interface Percentiles {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly total: number;
}

interface ProfileOperation {
  readonly operation: string;
  readonly stage: "worker" | "object";
  readonly invocations: number;
  readonly failed: number;
  readonly cpuMs: Percentiles;
  readonly wallMs: Percentiles;
  readonly rows: { readonly read: number; readonly written: number; readonly statements: number };
  readonly r2: { readonly classA: number; readonly classB: number } | null;
}

interface ProfileWindow {
  readonly operations: readonly ProfileOperation[];
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function drive(origin: string): Promise<void> {
  for (let index = 0; index < INSERT_REQUESTS; index += 1) {
    const response = await fetch(`${origin}/insert?count=${ROWS_PER_INSERT}`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  for (let index = 0; index < SCAN_REQUESTS; index += 1) {
    const response = await fetch(`${origin}/scan?limit=${SCAN_ROWS}`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  for (let index = 0; index < MEDIA_REQUESTS; index += 1) {
    const response = await fetch(`${origin}/media`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  for (let index = 0; index < ROOT_REQUESTS; index += 1) {
    const response = await fetch(`${origin}/`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
}

function operation(profile: ProfileWindow, stage: "worker" | "object", name: string): ProfileOperation {
  const found = profile.operations.find(candidate => candidate.stage === stage && candidate.operation === name);
  assert.ok(found, `${stage} ${name} is missing from ${profile.operations.map(entry => `${entry.stage}:${entry.operation}`).join(", ")}`);
  return found;
}

await test("the profile reports exactly what the fixture producer did", async () => {
  const stack = await startStack({ nowMs: null, workerProducers: [{ dir: BUILT, service: SERVICE }] });
  try {
    await drive(stack.workerProducers[0]!.origin);
    const workforce = INSERT_REQUESTS + SCAN_REQUESTS + MEDIA_REQUESTS + ROOT_REQUESTS;
    const expected = workforce + INSERT_REQUESTS + SCAN_REQUESTS;
    const from = Date.now() - 60_000;
    const deadline = Date.now() + 30_000;
    let profile: ProfileWindow = { operations: [] };
    for (;;) {
      profile = await stack.observe(SERVICE, `/profile?from=${from}&to=${Date.now() + 60_000}`) as ProfileWindow;
      const total = profile.operations.reduce((sum, entry) => sum + entry.invocations, 0);
      if (total === expected || Date.now() > deadline) break;
      await sleep(250);
    }
    assert.deepEqual(
      profile.operations.map(entry => `${entry.stage}:${entry.operation}`).sort(),
      ["object:store.insert", "object:store.scan", "worker:http.insert", "worker:http.media", "worker:http.root", "worker:http.scan"]
    );
    assert.equal(profile.operations.reduce((sum, entry) => sum + entry.invocations, 0), expected);

    const insert = operation(profile, "object", "store.insert");
    assert.equal(insert.invocations, INSERT_REQUESTS);
    assert.equal(insert.rows.written, INSERT_REQUESTS * ROWS_PER_INSERT);
    assert.equal(insert.rows.statements, INSERT_REQUESTS * ROWS_PER_INSERT);
    assert.equal(insert.rows.read, 0);
    assert.equal(insert.failed, 0);

    const scan = operation(profile, "object", "store.scan");
    assert.equal(scan.invocations, SCAN_REQUESTS);
    assert.equal(scan.rows.read, SCAN_REQUESTS * SCAN_ROWS);
    assert.equal(scan.rows.statements, SCAN_REQUESTS);
    assert.equal(scan.failed, 0);

    const media = operation(profile, "worker", "http.media");
    assert.equal(media.invocations, MEDIA_REQUESTS);
    assert.deepEqual(media.r2, { classA: MEDIA_REQUESTS, classB: MEDIA_REQUESTS });

    for (const [stage, name, count] of [["worker", "http.insert", INSERT_REQUESTS], ["worker", "http.scan", SCAN_REQUESTS], ["worker", "http.root", ROOT_REQUESTS]] as const) {
      const entry = operation(profile, stage, name);
      assert.equal(entry.invocations, count, name);
      assert.ok(entry.cpuMs.total >= 0, name);
      assert.ok(entry.cpuMs.p50 === null || entry.cpuMs.p95 === null || entry.cpuMs.p50 <= entry.cpuMs.p95, name);
    }
  } finally {
    await stack.dispose();
  }
});
