import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_CONTENT_TYPE } from "../src/binary/history";
import { ApiFailure, getHosts, getSummary } from "../src/client/api";
import { encodeHistory } from "./support/history";

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
  const hostId = "h_0123456789abcdef0123456789abcdef";
  const summary = { hostId, range: "1h", kind: "summary", fromMs: 0, toMs: 60_000, resolution: "raw", stepMs: 15_000, points: [{ atMs: 15_000, coverageMs: 15_000, partial: false, cpu: { user: 4, system: 1, idle: 95 } }] };
  const frame = (etag: string) => new Response(encodeHistory(summary), { headers: { "Content-Type": HISTORY_CONTENT_TYPE, ETag: etag } });

  it("reuses the decoded history when the server answers 304", async () => {
    const seen: Headers[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      seen.push(new Headers(init?.headers));
      return calls === 1 ? frame('"v1"') : new Response(null, { status: 304 });
    });

    const first = await getSummary(hostId, { range: "1h" }, signal);
    const second = await getSummary(hostId, { range: "1h" }, signal);
    expect(second).toBe(first);
    expect(first.table.cells("cpu.user")).toEqual([4]);
    expect(seen[0]?.get("if-none-match")).toBeNull();
    expect(seen[1]?.get("if-none-match")).toBe('"v1"');
  });

  it("refuses a response that is not a history frame", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("<html>sign in</html>", { headers: { "Content-Type": "text/html" } }));
    const login = await getSummary(hostId, { range: "1h" }, signal).catch((failure: unknown) => failure);
    expect(login).toBeInstanceOf(ApiFailure);

    vi.stubGlobal("fetch", async () => new Response(encodeHistory(summary).slice(0, 40), { headers: { "Content-Type": HISTORY_CONTENT_TYPE } }));
    const truncated = await getSummary(hostId, { range: "1h" }, signal).catch((failure: unknown) => failure);
    expect(truncated).toBeInstanceOf(ApiFailure);
    expect(((truncated as ApiFailure).cause as Error).message).toContain("stats columns");
    expect(log).toHaveBeenCalledTimes(1);
  });
});
