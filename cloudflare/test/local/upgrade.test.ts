import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { windowStartMs } from "../../src/projects/metrics.ts";
import { RECORDED_AT_MS, scenario } from "../../local/scenario.ts";
import { addHost, ingestFixture } from "../../local/seed.ts";
import { SCRATCH, productionProjects, startStack, type Stack } from "../../local/stack.ts";
import { CLOUDFLARE_ROOT } from "../../local/topology.ts";

const BASELINE = resolve(process.env["BASELINE_WORKTREE"] ?? join(CLOUDFLARE_ROOT, "../.work/wt/baseline"));
const BUILT = "cloudflare/.cloudflare/output/v0/workers/default";
const OBSERVE_BUILT = "cloudflare/observe-worker/.cloudflare/output/v0/workers/default";
const BUILD = "git worktree add --detach .work/wt/baseline a5918ea~1 && cd .work/wt/baseline && pnpm install --frozen-lockfile --offline && cd cloudflare && pnpm build && pnpm run build:observe";
const missing = [BUILT, OBSERVE_BUILT].filter(path => !existsSync(join(BASELINE, path, "worker.config.json")));
const T = RECORDED_AT_MS;
const PROJECT_HISTORY = `/api/v1/projects/stuff/history?from=${windowStartMs(T)}&to=${T}&kinds=worker,routes,r2,collector`;

interface Snapshot {
  readonly hosts: unknown;
  readonly latest: unknown;
  readonly projects: readonly (readonly [string, unknown])[];
  readonly etag: string | null;
  readonly frame: Uint8Array;
}

async function snapshot(stack: Stack, hostId: string): Promise<Snapshot> {
  const history = await stack.fetch(PROJECT_HISTORY);
  assert.equal(history.status, 200);
  return {
    hosts: await (await stack.fetch("/api/v1/hosts")).json(),
    latest: await (await stack.fetch(`/api/v1/hosts/${hostId}/latest`)).json(),
    projects: (await (await stack.fetch("/api/v1/projects")).json() as { id: string; collector: unknown }[]).map(project => [project.id, project.collector] as const),
    etag: history.headers.get("etag"),
    frame: new Uint8Array(await history.arrayBuffer())
  };
}

await test("the candidate opens state written by the build before schema version 8 and keeps hosts, samples, and history frames", { skip: missing.length === 0 ? false : `no baseline build at ${BASELINE} (${missing.join(", ")}); from the repo root run: ${BUILD}` }, async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const persist = mkdtempSync(join(SCRATCH, "upgrade-"));
  try {
    const baseline = await startStack({ nowMs: T, persist, statsOutput: join(BASELINE, BUILT), observeOutput: join(BASELINE, OBSERVE_BUILT) });
    let host: { hostId: string; token: string };
    let before: Snapshot;
    try {
      host = await addHost(baseline);
      assert.equal(await ingestFixture(baseline, host, T - 60_000), 200);
      assert.equal(await baseline.collect(scenario(productionProjects(baseline.stats), T)), "ok");
      before = await snapshot(baseline, host.hostId);
      assert.equal((await baseline.fetch("/api/v1/services")).status, 404, "the baseline predates services");
    } finally {
      await baseline.dispose();
    }
    const candidate = await startStack({ nowMs: T, persist });
    try {
      const after = await snapshot(candidate, host.hostId);
      assert.deepEqual(after.hosts, before.hosts);
      assert.deepEqual(after.latest, before.latest);
      const baselineIds = new Set(before.projects.map(([id]) => id));
      assert.deepEqual(after.projects.filter(([id]) => baselineIds.has(id)), before.projects, "every baseline project keeps its collector state");
      assert.ok(before.etag !== null && after.etag !== null);
      assert.notEqual(after.etag, before.etag, "coverage semantics invalidate the baseline cache entry");
      assert.deepEqual(after.frame, before.frame);
      const refreshed = await candidate.fetch(PROJECT_HISTORY, { headers: { "If-None-Match": before.etag } });
      assert.equal(refreshed.status, 200, "a baseline ETag cannot suppress the candidate representation");
      assert.deepEqual(new Uint8Array(await refreshed.arrayBuffer()), after.frame);
      const unchanged = await candidate.fetch(PROJECT_HISTORY, { headers: { "If-None-Match": after.etag } });
      assert.equal(unchanged.status, 304);
      const created = await candidate.fetch("/api/v1/admin/services", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "api", hostIds: [host.hostId] }) });
      assert.equal(created.status, 201, await created.clone().text());
      const services = await (await candidate.fetch("/api/v1/services")).json() as { services: { name: string }[] };
      assert.deepEqual(services.services.map(service => service.name), ["api"]);
    } finally {
      await candidate.dispose();
    }
  } finally {
    rmSync(persist, { recursive: true, force: true });
  }
});
