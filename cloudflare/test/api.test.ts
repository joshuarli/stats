import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, getHosts, getSummary } from "../src/client/api";

const signal = new AbortController().signal;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dashboard decoding", () => {
  it("keeps the decoder error on a malformed response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: readonly [string, unknown, string][] = [
      ["missing hosts", {}, "expected an array"],
      ["missing host field", { hosts: [{}] }, "expected a string"],
      ["wrong field type", { hosts: [{ hostId: "h_0123456789abcdef0123456789abcdef", name: "alpha", createdAtMs: "now", revoked: false, lastReceivedAtMs: null, online: true }] }, "expected a finite number"]
    ];
    for (const [name, body, message] of cases) {
      vi.stubGlobal("fetch", async () => Response.json(body));
      const error = await getHosts(signal).catch((failure: unknown) => failure);
      expect(error, name).toBeInstanceOf(ApiFailure);
      expect((error as ApiFailure).cause, name).toBeInstanceOf(Error);
      expect(((error as ApiFailure).cause as Error).message, name).toBe(message);
    }
    expect(log).toHaveBeenCalledTimes(cases.length);
  });
});

describe("conditional history reads", () => {
  it("reuses the cached body when the server answers 304", async () => {
    const hostId = "h_0123456789abcdef0123456789abcdef";
    const summary = { hostId, range: "1h", kind: "summary", fromMs: 0, toMs: 60_000, resolution: "raw", stepMs: 15_000, points: [] };
    const seen: Headers[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      seen.push(new Headers(init?.headers));
      return calls === 1
        ? new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json", ETag: '"v1"' } })
        : new Response(null, { status: 304 });
    });

    const first = await getSummary(hostId, { range: "1h" }, signal);
    const second = await getSummary(hostId, { range: "1h" }, signal);
    expect(second).toEqual(first);
    expect(seen[1]?.get("if-none-match")).toBe('"v1"');
  });
});
