import { HISTORY_CONTENT_TYPE } from "../../binary/history.ts";
import type { ErrorCode } from "../../codes.ts";
import type { HistoryQuery } from "../../aggregate.ts";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function opaqueTag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
}

export function etagMatches(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) return false;
  return header.split(",").some(value => value.trim() === "*" || opaqueTag(value) === etag);
}

export function notModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { ETag: etag } });
}

export function historyEtag(scope: string, version: number | null, window: string, kinds: string): string {
  return `"${scope}:${version ?? "none"}:${window}:${kinds}:stc1"`;
}

export function frameResponse(frame: Uint8Array<ArrayBuffer>, etag: string): Response {
  return new Response(frame, { headers: { "Content-Type": HISTORY_CONTENT_TYPE, ETag: etag } });
}

export function historyWindowKey(query: HistoryQuery): string {
  return "range" in query ? `range=${query.range}` : `from=${query.fromMs}&to=${query.toMs}`;
}

export function failure(code: ErrorCode, message: string, status: number, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, status, headers);
}

export function validName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  for (const character of name) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 0x7f) return false;
  }
  return true;
}
