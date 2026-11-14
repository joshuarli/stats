import type { AuthDecision } from "../core/http.ts";

const TAILSCALE_LOGIN_HEADER = "Tailscale-User-Login";

const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu;

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  if (address === "::1") return true;
  const ipv4 = MAPPED_IPV4.exec(address)?.[1] ?? address;
  return /^127\.\d+\.\d+\.\d+$/u.test(ipv4);
}

export type Peer = { readonly kind: "tcp"; readonly address: string | undefined } | { readonly kind: "unix" };

export function tailscaleDecision(peer: Peer, headers: Headers): AuthDecision {
  if (peer.kind === "tcp" && !isLoopback(peer.address)) return { ok: false, status: 401, message: "requests must arrive through tailscale serve on loopback" };
  const login = headers.get(TAILSCALE_LOGIN_HEADER);
  if (login === null || login === "") return { ok: false, status: 401, message: "a Tailscale identity is required" };
  return { ok: true };
}
