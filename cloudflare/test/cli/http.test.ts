import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "../../src/cli/exit.ts";
import { createHttpClient, HISTORY_BODY_LIMIT, type HttpClient } from "../../src/cli/http.ts";
import { fakeOrigin, sendJson, TOKEN } from "./support.ts";

async function client(origin: string, overrides: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HttpClient> {
  return createHttpClient({ origin, signal: overrides.signal ?? new AbortController().signal, credential: async () => ({ header: "cf-access-token", value: TOKEN }), backoffMs: 1, ...overrides });
}

async function failure(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CommandError, String(error));
    return error;
  }
  throw new Error("expected a CommandError");
}

await test("conditional requests send If-None-Match and surface 304, and every attempt is counted", async () => {
  const origin = await fakeOrigin((request, response) => {
    if (request.headers["if-none-match"] === '"v1"') return void response.writeHead(304, { etag: '"v1"' }).end();
    response.writeHead(200, { "content-type": "application/json", etag: '"v1"' });
    response.end("[1]");
  });
  try {
    const http = await client(origin.origin);
    const first = await http.getJson("/x", value => value);
    assert.deepEqual(first, { kind: "ok", value: [1], etag: '"v1"' });
    const second = await http.getJson("/x", value => value, { ifNoneMatch: '"v1"' });
    assert.deepEqual(second, { kind: "not-modified", etag: '"v1"' });
    assert.equal(http.requests(), 2);
  } finally {
    await origin.close();
  }
});

await test("an unsolicited 304 is not accepted as data", async () => {
  const origin = await fakeOrigin((_, response) => { response.writeHead(304).end(); });
  try {
    const error = await failure((await client(origin.origin)).getJson("/x", value => value));
    assert.equal(error.exit, 3);
  } finally {
    await origin.close();
  }
});

await test("a stalled response times out after bounded retries", async () => {
  const origin = await fakeOrigin(() => undefined);
  try {
    const http = await client(origin.origin, { timeoutMs: 40 });
    const error = await failure(http.getJson("/x", value => value));
    assert.equal(error.code, "timeout");
    assert.equal(http.requests(), 3);
  } finally {
    await origin.close();
  }
});

await test("cancellation stops a request without retrying", async () => {
  const origin = await fakeOrigin(() => undefined);
  try {
    const controller = new AbortController();
    const http = await client(origin.origin, { signal: controller.signal });
    const pending = failure(http.getJson("/x", value => value));
    setTimeout(() => controller.abort(), 30);
    assert.equal((await pending).code, "cancelled");
    assert.equal(http.requests(), 1);
  } finally {
    await origin.close();
  }
});

await test("history bytes are capped at 8 MiB while streaming, JSON at 1 MiB", async () => {
  const origin = await fakeOrigin((request, response) => {
    const size = request.url === "/big" ? HISTORY_BODY_LIMIT + 1 : HISTORY_BODY_LIMIT;
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(new Uint8Array(size).fill(1));
  });
  try {
    const http = await client(origin.origin);
    const ok = await http.getBytes("/exact");
    assert.equal(ok.kind === "ok" && ok.value.byteLength, HISTORY_BODY_LIMIT);
    assert.equal((await failure(http.getBytes("/big"))).code, "body_too_large");
    assert.equal((await failure(http.getJson("/exact", value => value))).code, "body_too_large");
  } finally {
    await origin.close();
  }
});

await test("a request can never leave the configured origin", async () => {
  const http = await client("http://127.0.0.1:9");
  for (const path of ["//evil.example/x", "http://evil.example/x", "relative"]) {
    await assert.rejects(http.getJson(path, value => value), TypeError);
  }
  assert.equal(http.requests(), 0);
});

await test("a JSON body decode failure names the path and is a contract failure", async () => {
  const origin = await fakeOrigin((_, response) => { sendJson(response, { a: 1 }); });
  try {
    const error = await failure((await client(origin.origin)).getJson("/x", () => { throw new Error("invalid thing"); }));
    assert.equal(error.code, "contract");
    assert.match(error.message, /\/x .*invalid thing/u);
  } finally {
    await origin.close();
  }
});

await test("a per-call body limit lets a JSON body larger than the default decode, and the default still refuses it", async () => {
  const size = 1.5 * 1024 * 1024;
  const origin = await fakeOrigin((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ pad: "x".repeat(size) }));
  });
  try {
    const http = await client(origin.origin);
    assert.equal((await failure(http.getJson("/window", value => value))).code, "body_too_large");
    const wide = await http.getJson("/window", value => (value as { pad: string }).pad.length, { bodyLimit: HISTORY_BODY_LIMIT });
    assert.deepEqual(wide, { kind: "ok", value: size, etag: null });
  } finally {
    await origin.close();
  }
});
