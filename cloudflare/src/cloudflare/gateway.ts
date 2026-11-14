import type { AuthDecision } from "../core/http.ts";

export const GATEWAY_SECRET_HEADER = "Stats-Gateway-Secret";
export const GATEWAY_IDENTITY_HEADER = "Stats-Tailnet-Identity";
const IDENTITY = /^(?:user:[^\s,]+|tags:tag:[a-z0-9-]+(?:,tag:[a-z0-9-]+)*)$/u;
const MAX_IDENTITY_CHARS = 512;

export function gatewayDecision(headers: Headers, secret: string | undefined): AuthDecision {
  if (secret === undefined || secret === "") return { ok: false, status: 503, message: "gateway identity is not configured" };
  const supplied = headers.get(GATEWAY_SECRET_HEADER);
  const expectedBytes = new TextEncoder().encode(secret);
  const suppliedBytes = new TextEncoder().encode(supplied ?? "");
  let difference = expectedBytes.length ^ suppliedBytes.length;
  for (let i = 0; i < expectedBytes.length; i++) difference |= expectedBytes[i]! ^ (suppliedBytes[i] ?? 0);
  if (supplied === null || difference !== 0) return { ok: false, status: 401, message: "gateway identity is required" };
  const identity = headers.get(GATEWAY_IDENTITY_HEADER);
  if (identity === null || identity.length > MAX_IDENTITY_CHARS || !IDENTITY.test(identity)) return { ok: false, status: 401, message: "gateway identity is required" };
  return { ok: true };
}
