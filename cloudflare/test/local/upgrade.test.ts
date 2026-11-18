import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { windowStartMs } from "../../src/projects/metrics.ts";
import { RECORDED_AT_MS, scenario } from "../../local/scenario.ts";
import { addHost, ingestFixture } from "../../local/seed.ts";
import { SCRATCH, productionProjects, startStack, type Stack } from "../../local/stack.ts";
import { CLOUDFLARE_ROOT, readTestVars } from "../../local/topology.ts";

const baselineWorktree = process.env["BASELINE_WORKTREE"];
const BASELINE = resolve(baselineWorktree ?? join(CLOUDFLARE_ROOT, "../.work/wt/baseline"));
const BUILT = "cloudflare/.cloudflare/output/v0/workers/default";
const OBSERVE_BUILT = "cloudflare/observe-worker/.cloudflare/output/v0/workers/default";
const missing = [BUILT, OBSERVE_BUILT].filter(path => !existsSync(join(BASELINE, path, "worker.config.json")));
const baselineError = `no baseline build at ${BASELINE} (${missing.join(", ")}); follow the legacy build steps in .github/workflows/ci.yml`;
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

async function startBaseline(persist: string): Promise<Stack> {
  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_JWKS_JSON } = readTestVars(join(BASELINE, "cloudflare/wrangler.test.jsonc"));
  assert.ok(ACCESS_TEAM_DOMAIN && ACCESS_AUD && ACCESS_JWKS_JSON, "legacy Access test bindings are required");
  const signer = await import(pathToFileURL(join(BASELINE, "cloudflare/test/access-token.ts")).href) as { accessToken(): Promise<string> };
  const token = await signer.accessToken();
  const stack = await startStack({
    nowMs: T,
    persist,
    statsOutput: join(BASELINE, BUILT),
    observeOutput: join(BASELINE, OBSERVE_BUILT),
    testBindings: { ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_JWKS_JSON }
  });
  return {
    ...stack,
    fetch: (path, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      headers.set("cf-access-jwt-assertion", token);
      return stack.fetch(path, { ...init, headers: Object.fromEntries(headers) });
    }
  };
}

await test("the candidate opens state written by the build before schema version 8 and keeps hosts, samples, and history frames", { skip: baselineWorktree === undefined && missing.length > 0 ? baselineError : false }, async () => {
  assert.equal(missing.length, 0, baselineError);
  mkdirSync(SCRATCH, { recursive: true });
  const persist = mkdtempSync(join(SCRATCH, "upgrade-"));
  try {
    const baseline = await startBaseline(persist);
    let host: { hostId: string; token: string };
    let before: Snapshot;
    try {
      assert.equal((await baseline.anonymous("/api/v1/hosts")).status, 401);
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
