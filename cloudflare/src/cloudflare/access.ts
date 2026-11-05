const CLOCK_LEEWAY_SECONDS = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;

interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly n?: string;
  readonly e?: string;
}

interface Jwks {
  readonly keys: Jwk[];
}

interface AccessClaims {
  readonly iss: string;
  readonly aud: string | string[];
  readonly exp: number;
  readonly nbf?: number;
}

export type AccessResult =
  | { readonly ok: true; readonly claims: AccessClaims }
  | { readonly ok: false; readonly status: 401 | 503; readonly message: string };

let cache: { readonly team: string; readonly keys: Jwks; readonly expiresAt: number } | null = null;

function decodePart(value: string): Uint8Array {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJson<T>(value: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(decodePart(value))) as T;
  } catch {
    return null;
  }
}

async function loadJwks(env: Env): Promise<Jwks | null> {
  if (env.ENVIRONMENT === "test" && env.ACCESS_JWKS_JSON !== undefined) {
    try {
      return JSON.parse(env.ACCESS_JWKS_JSON) as Jwks;
    } catch {
      return null;
    }
  }
  const team = env.ACCESS_TEAM_DOMAIN;
  if (team === undefined || team.length === 0) return null;
  if (cache !== null && cache.team === team && cache.expiresAt > Date.now()) return cache.keys;
  try {
    const response = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const keys = await response.json<Jwks>();
    if (!Array.isArray(keys.keys)) return null;
    cache = { team, keys, expiresAt: Date.now() + JWKS_TTL_MS };
    return keys;
  } catch {
    return null;
  }
}

export async function verifyAccess(request: Request, env: Env): Promise<AccessResult> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (token === null) return { ok: false, status: 401, message: "Cloudflare Access assertion is required" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 401, message: "malformed Access assertion" };
  const header = decodeJson<{ alg?: string; kid?: string }>(parts[0]!);
  const claims = decodeJson<AccessClaims>(parts[1]!);
  if (header === null || claims === null || header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, status: 401, message: "invalid Access assertion" };
  const jwks = await loadJwks(env);
  if (jwks === null) return { ok: false, status: 503, message: "Access verification is unavailable" };
  const jwk = jwks.keys.find(candidate => candidate.kid === header.kid && candidate.kty === "RSA");
  if (jwk === undefined || jwk.n === undefined || jwk.e === undefined) return { ok: false, status: 401, message: "unknown Access key" };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodePart(parts[2]!) as unknown as BufferSource, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, status: 401, message: "invalid Access signature" };
  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN ?? ""}` || env.ACCESS_AUD === undefined || !audience.includes(env.ACCESS_AUD)) return { ok: false, status: 401, message: "Access assertion is not for this audience" };
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_LEEWAY_SECONDS <= now) return { ok: false, status: 401, message: "Access assertion has expired" };
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - CLOCK_LEEWAY_SECONDS > now)) return { ok: false, status: 401, message: "Access assertion is not active" };
  return { ok: true, claims };
}
