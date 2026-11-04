import type { IssueState, TraceFilter } from "../core/store.ts";
import { MAX_LABEL_BYTES, MAX_PAGE_SIZE } from "../core/limits.ts";
import type { ObservationStore } from "./store-object.ts";

type Store = Pick<ObservationStore, "issues" | "occurrences" | "setIssueState" | "traces" | "trace" | "health">;

const FINGERPRINT = /^[0-9a-f]{64}$/u;
const TRACE_ID = /^[0-9a-f]{32}$/u;
const CURSOR = /^\d{1,16}\.[0-9a-f]{1,64}$/u;
const VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_BODY_BYTES = 256;

class BadRequest extends Error {}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function params(url: URL, allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || values.has(key)) throw new BadRequest(`unexpected query parameter ${key}`);
    values.set(key, value);
  }
  return values;
}

function page(values: Map<string, string>): { cursor?: string; limit?: number } {
  const result: { cursor?: string; limit?: number } = {};
  const cursor = values.get("cursor");
  if (cursor !== undefined) {
    if (!CURSOR.test(cursor)) throw new BadRequest("invalid cursor");
    result.cursor = cursor;
  }
  const limit = values.get("limit");
  if (limit !== undefined) {
    const value = Number(limit);
    if (!/^\d{1,3}$/u.test(limit) || value < 1 || value > MAX_PAGE_SIZE) throw new BadRequest("invalid limit");
    result.limit = value;
  }
  return result;
}

function issueState(value: unknown): IssueState {
  if (value === "open" || value === "resolved") return value;
  throw new BadRequest("state must be open or resolved");
}

function traceFilter(values: Map<string, string>): TraceFilter {
  const filter: { -readonly [K in keyof TraceFilter]: TraceFilter[K] } = page(values);
  const label = values.get("label");
  if (label !== undefined) {
    if (label === "" || new TextEncoder().encode(label).length > MAX_LABEL_BYTES) throw new BadRequest("invalid label");
    filter.label = label;
  }
  const version = values.get("version");
  if (version !== undefined) {
    if (!VERSION.test(version)) throw new BadRequest("invalid version");
    filter.version = version;
  }
  const failed = values.get("failed");
  if (failed !== undefined) {
    if (failed !== "true" && failed !== "false") throw new BadRequest("failed must be true or false");
    filter.failed = failed === "true";
  }
  return filter;
}

async function readState(request: Request): Promise<IssueState> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new BadRequest("application/json required");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new BadRequest("body too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequest("body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Object.keys(body).some(key => key !== "state")) throw new BadRequest("body must be {\"state\": ...}");
  return issueState((body as { state?: unknown }).state);
}

export async function handleApi(request: Request, store: Store): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (request.method === "POST") {
      const state = /^\/issues\/([0-9a-f]{64})\/state$/u.exec(path);
      if (state === null) return failure(405, "invalid_request", "method not allowed");
      params(url, []);
      return await store.setIssueState(state[1]!, await readState(request)) ? new Response(null, { status: 204 }) : failure(404, "not_found", "issue not found");
    }
    if (request.method !== "GET") return failure(405, "invalid_request", "method not allowed");
    if (path === "/issues") {
      const values = params(url, ["state", "cursor", "limit"]);
      const state = values.get("state");
      return json(await store.issues({ ...page(values), ...(state === undefined ? {} : { state: issueState(state) }) }));
    }
    const occurrences = /^\/issues\/([^/]+)\/occurrences$/u.exec(path);
    if (occurrences !== null) {
      if (!FINGERPRINT.test(occurrences[1]!)) throw new BadRequest("invalid issue id");
      return json(await store.occurrences(occurrences[1]!, page(params(url, ["cursor", "limit"]))));
    }
    if (path === "/traces") return json(await store.traces(traceFilter(params(url, ["label", "version", "failed", "cursor", "limit"]))));
    const trace = /^\/traces\/([^/]+)$/u.exec(path);
    if (trace !== null) {
      if (!TRACE_ID.test(trace[1]!)) throw new BadRequest("invalid trace id");
      params(url, []);
      const detail = await store.trace(trace[1]!);
      return detail === null ? failure(404, "not_found", "trace not found or expired") : json(detail);
    }
    if (path === "/health") {
      params(url, []);
      return json(await store.health());
    }
    return failure(404, "not_found", "unknown observe route");
  } catch (error) {
    if (error instanceof BadRequest) return failure(400, "invalid_request", error.message);
    throw error;
  }
}
