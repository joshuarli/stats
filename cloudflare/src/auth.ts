export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function generateHostId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `h_${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function generateToken(): string {
  return `nft_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function bearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer (nft_[A-Za-z0-9_-]{43})$/u.exec(header);
  return match?.[1] ?? null;
}
