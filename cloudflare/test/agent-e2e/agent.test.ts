import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { accessToken } from "../access-token.ts";
import { agentDeliversABatch } from "./flow.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const VARS = (JSON.parse(readFileSync(join(ROOT, "wrangler.test.jsonc"), "utf8")) as { vars: Record<string, string> }).vars;

await test("the real agent binary delivers a binary batch that the real Worker and Durable Object store", async () => {
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [{
        name: "stats",
        modules: true,
        scriptPath: join(ROOT, ".cloudflare/output/v0/workers/default/bundle/index.js"),
        compatibilityDate: "2026-10-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { ...VARS, TEST_NOW_MS: String(Date.now()) },
        durableObjects: { INSTALLATION: { className: "Installation", useSQLite: true } }
      }]
    }),
    host: "127.0.0.1",
    port: 0
  });
  try {
    await agentDeliversABatch({
      origin: (await mf.ready).origin,
      credentials: { "cf-access-jwt-assertion": await accessToken() },
      request: async (url, init) => await mf.dispatchFetch(url, init as Parameters<typeof mf.dispatchFetch>[1]) as unknown as Response
    });
  } finally {
    await mf.dispose();
  }
});
