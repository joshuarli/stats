import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const SCRIPT = `
import { DurableObject } from "cloudflare:workers";
import { tracing } from "cloudflare:workers";
const trace = () => { const span = tracing.getActiveSpan(); return span === undefined ? null : span.spanContext(); };
export class Probe extends DurableObject {
  async fetch() { return Response.json({ trace: trace() }); }
  async seen() { return { trace: trace() }; }
}
export default {
  async fetch(request, env) {
    const mode = new URL(request.url).searchParams.get("mode");
    const stub = env.PROBE.getByName("probe");
    const caller = trace();
    const object = mode === "rpc" ? await stub.seen() : await (await stub.fetch("https://probe/")).json();
    return Response.json({ caller, object: object.trace });
  }
};`;

interface Seen { readonly caller: { readonly traceId: string; readonly spanId: string } | null; readonly object: { readonly traceId: string; readonly spanId: string } | null }

async function observe(mode: "fetch" | "rpc", dir: string): Promise<Seen[]> {
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({ workers: [{
      name: "caller", modules: true, script: SCRIPT, compatibilityDate: "2026-10-30", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { PROBE: { className: "Probe", useSQLite: true } }, tails: ["sink"]
    }, { name: "sink", modules: true, script: "export default { tail() {} };", compatibilityDate: "2026-10-30" }] }),
    resourcePersistencePath: join(dir, mode)
  });
  try {
    const seen: Seen[] = [];
    for (let index = 0; index < 5; index++) seen.push(await (await mf.dispatchFetch(`http://caller/?mode=${mode}&n=${index}`)).json() as Seen);
    return seen;
  } finally {
    await mf.dispose();
  }
}

const dir = mkdtempSync(join(tmpdir(), "determinism-"));
for (const mode of ["fetch", "rpc"] as const) {
  await test(`a Durable Object ${mode} invocation reports its caller's trace id`, async () => {
    const seen = await observe(mode, dir);
    for (const entry of seen) {
      assert.ok(entry.caller !== null && entry.object !== null, "tracing exposes an active span in both invocations");
      assert.match(entry.caller.traceId, /^(?!0{32})[0-9a-f]{32}$/u);
      assert.match(entry.object.spanId, /^(?!0{16})[0-9a-f]{16}$/u);
      assert.equal(entry.object.traceId, entry.caller.traceId);
      assert.notEqual(entry.object.spanId, entry.caller.spanId);
    }
    assert.equal(new Set(seen.map(entry => entry.caller?.traceId)).size, seen.length, "separate requests have separate traces");
  });
}
rmSync(dir, { recursive: true, force: true });
