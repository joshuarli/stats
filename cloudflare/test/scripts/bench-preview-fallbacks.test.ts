import assert from "node:assert/strict";
import test from "node:test";

const modulePath = new URL("../../scripts/bench-preview-fallbacks.mjs", import.meta.url).href;
const { attachPreviewFallbacks } = await import(modulePath) as {
  attachPreviewFallbacks: (page: unknown, services: unknown[], missing: { services: boolean; deployments: boolean }) => Promise<void>;
};

await test("preview fallbacks leave history responses to the origin and supply missing services", async () => {
  let matcher: RegExp | undefined;
  let handler: ((route: unknown) => Promise<void>) | undefined;
  const page = { route: async (pattern: RegExp, callback: (route: unknown) => Promise<void>) => { matcher = pattern; handler = callback; } };
  await attachPreviewFallbacks(page, [{ name: "web" }], { services: true, deployments: true });
  assert.ok(matcher);
  assert.ok(handler);
  assert.equal(matcher.test("http://localhost/api/v1/hosts/one/history?range=1h"), false);
  assert.equal(matcher.test("http://localhost/api/v1/projects/one/history?range=1h"), false);

  const fulfilled: { status?: number; body?: string; response?: unknown }[] = [];
  const upstream = { status: () => 404 };
  await handler({
    request: () => ({ url: () => "http://localhost/api/v1/services" }),
    fetch: async () => upstream,
    fulfill: async (value: (typeof fulfilled)[number]) => { fulfilled.push(value); }
  });
  assert.equal(fulfilled[0]?.status, 200);
  assert.deepEqual(JSON.parse(fulfilled[0]?.body ?? ""), { services: [{ name: "web" }] });

  await handler({
    request: () => ({ url: () => "http://localhost/api/v1/services/web/deployments" }),
    fetch: async () => upstream,
    fulfill: async (value: (typeof fulfilled)[number]) => { fulfilled.push(value); }
  });
  assert.equal(fulfilled[1]?.status, 200);
  assert.equal((JSON.parse(fulfilled[1]?.body ?? "") as { projectId: string }).projectId, "web");

  const available = { status: () => 200 };
  await handler({
    request: () => ({ url: () => "http://localhost/api/v1/services" }),
    fetch: async () => available,
    fulfill: async (value: (typeof fulfilled)[number]) => { fulfilled.push(value); }
  });
  assert.equal(fulfilled[2]?.response, available);
});

await test("available service endpoints are not intercepted", async () => {
  const patterns: RegExp[] = [];
  const page = { route: async (pattern: RegExp) => { patterns.push(pattern); } };
  await attachPreviewFallbacks(page, [], { services: false, deployments: false });
  assert.equal(patterns.length, 0);
  await attachPreviewFallbacks(page, [], { services: true, deployments: false });
  assert.equal(patterns[0]?.test("http://localhost/api/v1/services"), true);
  assert.equal(patterns[0]?.test("http://localhost/api/v1/services/web/deployments"), false);
  await attachPreviewFallbacks(page, [], { services: false, deployments: true });
  assert.equal(patterns[1]?.test("http://localhost/api/v1/services"), false);
  assert.equal(patterns[1]?.test("http://localhost/api/v1/services/web/deployments"), true);
});
