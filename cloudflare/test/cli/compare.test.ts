import assert from "node:assert/strict";
import { test } from "node:test";
import { comparisonBounds } from "../../src/deployments/compare.ts";
import { buildComparisonSpec } from "../../src/compare/spec.ts";
import { EXIT } from "../../src/cli/exit.ts";
import { authorized, deploymentHistory, fakeOrigin, runCli, sendJson, type FakeOrigin, type Handler } from "./support.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OLD = { id: uuid(1), atMs: 1_699_000_000_000, source: "wrangler", message: null, deferred: false, versions: [{ id: uuid(101), percentage: 100 }] };
const NEW = { id: uuid(2), atMs: 1_699_500_000_000, source: "wrangler", message: null, deferred: false, versions: [{ id: uuid(102), percentage: 100 }] };

function comparisonBody(id: string, atMs: number, window: "1h" | "6h" | "24h", overrides: Record<string, unknown> = {}) {
  const { before, after } = comparisonBounds(atMs, window);
  return {
    deploymentId: id, window, before, after, readyAtMs: after.toMs + 600_000, beforeInvocations: 500, afterInvocations: 480,
    spec: buildComparisonSpec({ before: { deploymentId: null, versionIds: [], ...before }, after: { deploymentId: id, versionIds: [], ...after } }),
    reasons: ["Waiting for the full post-deployment window and analytics settlement."], reasonCodes: ["not-ready"], deferredObjects: false, analyticsInvocations: { before: [], after: [] }, warnings: ["Heuristic signals."],
    metrics: [{ metric: "worker.cpu", label: "Worker CPU / invocation", unit: "ms", before: 1.5, after: 1.2, delta: -0.3, deltaPercent: -20, verdict: "improved" }], ...overrides
  };
}

function handler(overrides: { comparison?: Handler } = {}): Handler {
  return (request, response, seen) => {
    if (!authorized(request)) return void response.writeHead(401).end();
    const url = request.url ?? "";
    if (url === "/api/v1/projects/stats/deployments") return sendJson(response, deploymentHistory("stats", { deployments: [OLD, NEW] }));
    const match = /^\/api\/v1\/projects\/stats\/deployments\/([^/]+)\/comparison\?window=(1h|6h|24h)$/u.exec(url);
    if (match !== null) {
      if (overrides.comparison !== undefined) return overrides.comparison(request, response, seen);
      const found = [OLD, NEW].find(item => item.id === match[1]);
      if (found === undefined) return void response.writeHead(404).end();
      return sendJson(response, comparisonBody(found.id, found.atMs, match[2] as "1h"));
    }
    response.writeHead(404).end();
  };
}

async function withOrigin(handle: Handler, body: (origin: FakeOrigin) => Promise<void>): Promise<void> {
  const origin = await fakeOrigin(handle);
  try {
    await body(origin);
  } finally {
    await origin.close();
  }
}

const run = (origin: FakeOrigin, args: readonly string[]) => runCli(["compare", "--project", "stats", ...args, "--json", "--origin", origin.origin], {});

await test("latest resolves once to the newest id and the comparison request uses it", async () => {
  await withOrigin(handler(), async origin => {
    const result = await run(origin, ["--deployment", "latest", "--window", "6h"]);
    assert.equal(result.code, EXIT.ok, result.stderr);
    assert.deepEqual(origin.seen.map(seen => seen.url), [
      "/api/v1/projects/stats/deployments",
      `/api/v1/projects/stats/deployments/${NEW.id}/comparison?window=6h`
    ]);
    const parsed = JSON.parse(result.stdout) as { payload: { kind: string; requested: string; resolvedDeploymentId: string }; identities: { deploymentIds: string[] }; windows: unknown[] };
    assert.equal(parsed.payload.kind, "descriptive");
    assert.equal(parsed.payload.requested, "latest");
    assert.equal(parsed.payload.resolvedDeploymentId, NEW.id);
    assert.deepEqual(parsed.identities.deploymentIds, [NEW.id]);
    assert.equal(parsed.windows.length, 2);
  });
});

await test("an explicit id skips history, and withheld verdicts still exit 0", async () => {
  await withOrigin(handler(), async origin => {
    const result = await run(origin, ["--deployment", OLD.id]);
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(origin.seen.map(seen => seen.url), [`/api/v1/projects/stats/deployments/${OLD.id}/comparison?window=1h`]);
  });
});

await test("text output labels the comparison descriptive and points to verify", async () => {
  await withOrigin(handler(), async origin => {
    const result = await runCli(["compare", "--project", "stats", "--deployment", NEW.id, "--origin", origin.origin], {});
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout, /descriptive comparison, not acceptance; run `statsctl verify`/u);
    assert.match(result.stdout, /Waiting for the full post-deployment window/u);
  });
});

await test("an invalid window or deployment id exits 2 without a request", async () => {
  await withOrigin(handler(), async origin => {
    for (const args of [["--deployment", "latest", "--window", "7d"], ["--deployment", "latest", "--window", "2h"], ["--deployment", "not-an-id"]]) {
      const result = await run(origin, args);
      assert.equal(result.code, EXIT.usage, args.join(" "));
    }
    assert.equal(origin.seen.length, 0);
  });
});

await test("latest with no recorded deployments exits 4", async () => {
  await withOrigin((_, response) => { sendJson(response, deploymentHistory("stats")); }, async origin => {
    const result = await run(origin, ["--deployment", "latest"]);
    assert.equal(result.code, EXIT.transport);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "no_deployments");
  });
});

await test("a comparison for a different deployment or window fails decoding with exit 4", async () => {
  const wrong = handler({ comparison: (_, response) => { sendJson(response, comparisonBody(OLD.id, OLD.atMs, "1h")); } });
  await withOrigin(wrong, async origin => {
    const result = await run(origin, ["--deployment", NEW.id]);
    assert.equal(result.code, EXIT.transport);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "contract");
  });
  const truncatedWindow = handler({ comparison: (_, response) => { sendJson(response, comparisonBody(NEW.id, NEW.atMs, "1h", { before: { fromMs: 1, toMs: 2 } })); } });
  await withOrigin(truncatedWindow, async origin => {
    assert.equal((await run(origin, ["--deployment", NEW.id])).code, EXIT.transport);
  });
});
