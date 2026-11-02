import { privateJwk } from "./access-key";

const encoder = new TextEncoder();

export function b64url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export async function accessToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  const headerValue = { alg: "RS256", kid: "test-key", typ: "JWT", ...header };
  const claimValues = { iss: "https://test.cloudflareaccess.com", aud: "test-aud", exp: seconds + 3600, nbf: seconds - 10, iat: seconds - 10, ...claims };
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signed = `${b64url(JSON.stringify(headerValue))}.${b64url(JSON.stringify(claimValues))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signed));
  return `${signed}.${b64url(new Uint8Array(signature))}`;
}
