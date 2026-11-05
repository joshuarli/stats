import type { AuthDecision } from "../core/http.ts";

export const TAILSCALE_LOGIN_HEADER = "Tailscale-User-Login";

const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu;

export function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  if (address === "::1") return true;
  const ipv4 = MAPPED_IPV4.exec(address)?.[1] ?? address;
  return /^127\.\d+\.\d+\.\d+$/u.test(ipv4);
}

export function tailscaleDecision(peer: string | undefined, headers: Headers, allowedLogins: ReadonlySet<string>): AuthDecision {
  if (!isLoopback(peer)) return { ok: false, status: 401, message: "requests must arrive through tailscale serve on loopback" };
  const login = headers.get(TAILSCALE_LOGIN_HEADER);
  if (login === null || login === "") return { ok: false, status: 401, message: "a Tailscale identity is required" };
  if (!allowedLogins.has(login)) return { ok: false, status: 401, message: "this Tailscale login is not allowed" };
  return { ok: true };
}
