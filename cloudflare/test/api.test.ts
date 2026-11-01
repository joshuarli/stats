import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, getHosts } from "../src/client/api";

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
