import { describe, expect, it } from "vitest";
import { gatewayDecision } from "../src/cloudflare/gateway.ts";

describe("gateway identity", () => {
  it("accepts users and tagged nodes with the secret", () => {
    for (const identity of ["user:person@example.com", "tags:tag:server,tag:build-1"]) {
      expect(gatewayDecision(new Headers({ "Stats-Gateway-Secret": "secret", "Stats-Tailnet-Identity": identity }), "secret")).toEqual({ ok: true });
    }
  });
  it("rejects forged identities and malformed identities", () => {
    for (const secret of [undefined, "wrong"]) {
      const headers = new Headers({ "Stats-Tailnet-Identity": "user:person", "Tailscale-User-Login": "person", ...(secret === undefined ? {} : { "Stats-Gateway-Secret": secret }) });
      expect(gatewayDecision(headers, "secret")).toMatchObject({ ok: false, status: 401 });
    }
    for (const identity of ["user:", "user:a b", "user:a,b", "tags:tag:A", "tags:tag:a,", `user:${"a".repeat(512)}`]) {
      expect(gatewayDecision(new Headers({ "Stats-Gateway-Secret": "secret", "Stats-Tailnet-Identity": identity }), "secret")).toMatchObject({ ok: false, status: 401 });
    }
    expect(gatewayDecision(new Headers(), undefined)).toMatchObject({ ok: false, status: 503 });
    expect(gatewayDecision(new Headers(), "")).toMatchObject({ ok: false, status: 503 });
  });
});
