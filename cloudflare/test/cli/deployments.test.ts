import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT } from "../../src/cli/exit.ts";
import { authorized, deploymentHistory, fakeOrigin, runCli, sendJson, tokenEnv } from "./support.ts";

const BASE = 1_699_999_800_000;
const HOUR = 3_600_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const wire = (n: number, atMs: number, extra: Record<string, unknown> = {}) => ({ id: uuid(n), atMs, source: "wrangler", message: null, deferred: false, versions: [{ id: uuid(100 + n), percentage: 100 }], ...extra });

interface Listed { id: string; comparable: { window: string; overlaps: string[]; baselineKnown: boolean; clean: boolean }[] }

async function listed(deployments: unknown[], sync?: unknown): Promise<{ code: number | null; payload: { deployments: Listed[]; sync: { ageMs: number | null } | null }; stdout: string }> {
  const origin = await fakeOrigin((request, response) => {
    if (!authorized(request)) return void response.writeHead(401).end();
    sendJson(response, deploymentHistory("stats", { deployments, ...(sync === undefined ? {} : { sync }) }));
  });
  try {
    const run = await runCli(["deployments", "--project", "stats", "--json", "--origin", origin.origin], tokenEnv());
    const parsed = JSON.parse(run.stdout) as { payload: { deployments: Listed[]; sync: { ageMs: number | null } | null } };
    return { code: run.code, payload: parsed.payload, stdout: run.stdout };
  } finally {
    await origin.close();
  }
}

const cell = (item: Listed, window: string) => item.comparable.find(entry => entry.window === window)!;

await test("deployments lists newest first and marks which comparison windows are clean", async () => {
  const run = await listed([
    wire(1, BASE - 30 * HOUR), wire(2, BASE - 5 * HOUR), wire(3, BASE), wire(4, BASE + 20 * 60_000), wire(5, BASE + 10 * HOUR)
  ]);
  assert.equal(run.code, EXIT.ok);
  assert.deepEqual(run.payload.deployments.map(item => item.id), [5, 4, 3, 2, 1].map(uuid));
  const [e, d, c, b, a] = run.payload.deployments as [Listed, Listed, Listed, Listed, Listed];

  assert.equal(cell(e, "1h").clean, true);
  assert.equal(cell(e, "6h").clean, true);
  assert.deepEqual(cell(e, "24h").overlaps, [uuid(4), uuid(3), uuid(2)]);
  assert.equal(cell(e, "24h").clean, false);

  assert.deepEqual(cell(d, "1h").overlaps, [uuid(3)]);
  assert.deepEqual(cell(c, "1h").overlaps, [uuid(4)]);
  assert.deepEqual(cell(c, "6h").overlaps, [uuid(4), uuid(2)]);

  assert.equal(cell(b, "1h").clean, true);
  assert.equal(cell(b, "6h").overlaps.length, 2);

  assert.equal(cell(a, "1h").baselineKnown, false);
  assert.equal(cell(a, "1h").clean, false);
});

await test("a previous deployment exactly at the start of the before window is the baseline, not an overlap", async () => {
  const at = BASE + 10 * HOUR;
  const run = await listed([wire(1, at - HOUR), wire(2, at)]);
  const second = run.payload.deployments[0]!;
  assert.equal(second.id, uuid(2));
  assert.deepEqual(cell(second, "1h").overlaps, []);
  assert.equal(cell(second, "1h").clean, true);
});

await test("deployments reports sync age and exits 4 when the history does not decode", async () => {
  const fresh = await listed([wire(1, BASE)]);
  assert.equal(typeof fresh.payload.sync?.ageMs, "number");
  const origin = await fakeOrigin((_, response) => { sendJson(response, { projectId: "other" }); });
  try {
    const run = await runCli(["deployments", "--project", "stats", "--json", "--origin", origin.origin], tokenEnv());
    assert.equal(run.code, EXIT.transport);
    assert.equal((JSON.parse(run.stdout) as { error: { code: string } }).error.code, "contract");
  } finally {
    await origin.close();
  }
});
