import type { IssueState, TraceFilter, WindowQuery } from "../core/store.ts";
import { OPERATION_IDS, type OperationId } from "../producer/channel.ts";
import type { ObserveService } from "../core/service.ts";
import { MAX_ARTIFACT_BYTES, MAX_LABEL_BYTES, MAX_PAGE_SIZE, MAX_ROLLOUTS_PER_BATCH, OPERATION_BUCKET_MS, RETENTION_MS } from "../core/limits.ts";
import { ARTIFACT_FILE, VERSION, type ObservedRollout, type VersionLabel } from "../core/model.ts";
import { decodeBatch } from "../ingest/codec.ts";
import { MAX_BATCH_BYTES, type ExternalFilter } from "../ingest/model.ts";
import { readLimitedText } from "../../body.ts";


const FINGERPRINT = /^[0-9a-f]{64}$/u;
const TRACE_ID = /^[0-9a-f]{32}$/u;
const CURSOR = /^\d{1,16}\.[0-9a-f]{1,64}$/u;
const MAX_BODY_BYTES = 256;
const MAX_ROLLOUT_BODY_BYTES = 256 * 1024;
const MAX_LABELS = 600;

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

function milliseconds(values: Map<string, string>, key: string): number | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  if (!/^\d{1,16}$/u.test(value)) throw new BadRequest(`invalid ${key}`);
  return Number(value);
}

function label(values: Map<string, string>, key: string): string | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  if (value === "" || new TextEncoder().encode(value).length > MAX_LABEL_BYTES) throw new BadRequest(`invalid ${key}`);
  return value;
}

function exploreFilter(values: Map<string, string>): { fromMs?: number; toMs?: number; route?: string } {
  const filter: { fromMs?: number; toMs?: number; route?: string } = {};
  const fromMs = milliseconds(values, "from");
  const toMs = milliseconds(values, "to");
  const route = label(values, "route");
  if (fromMs !== undefined) filter.fromMs = fromMs;
  if (toMs !== undefined) filter.toMs = toMs;
  if (route !== undefined) filter.route = route;
  return filter;
}

function windowQuery(values: Map<string, string>): WindowQuery {
  const fromMs = milliseconds(values, "from");
  const toMs = milliseconds(values, "to");
  if (fromMs === undefined || toMs === undefined) throw new BadRequest("from and to are required");
  if (fromMs % OPERATION_BUCKET_MS !== 0 || toMs % OPERATION_BUCKET_MS !== 0) throw new BadRequest(`from and to must align to ${OPERATION_BUCKET_MS} ms`);
  if (toMs <= fromMs) throw new BadRequest("to must be after from");
  if (toMs - fromMs > RETENTION_MS) throw new BadRequest(`window must not exceed ${RETENTION_MS} ms`);
  const operation = values.get("operation");
  const workloadClass = label(values, "class");
  if (operation !== undefined && !(OPERATION_IDS as readonly string[]).includes(operation)) throw new BadRequest("invalid operation");
  if (workloadClass !== undefined && operation === undefined) throw new BadRequest("class requires operation");
  return { fromMs, toMs, ...(operation === undefined ? {} : { operation: operation as OperationId }), ...(workloadClass === undefined ? {} : { workloadClass }) };
}

function traceFilter(values: Map<string, string>): TraceFilter {
  const filter: { -readonly [K in keyof TraceFilter]: TraceFilter[K] } = { ...page(values), ...exploreFilter(new Map([...values].filter(([key]) => key === "from" || key === "to"))) };
  const minWallMs = milliseconds(values, "minWall");
  const maxWallMs = milliseconds(values, "maxWall");
  if (minWallMs !== undefined) filter.minWallMs = minWallMs;
  if (maxWallMs !== undefined) filter.maxWallMs = maxWallMs;
  const order = values.get("order");
  if (order !== undefined) {
    if (order !== "recent" && order !== "slowest") throw new BadRequest("order must be recent or slowest");
    filter.order = order;
  }
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

function fields(value: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BadRequest(`${what} must be an object`);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new BadRequest(`${what} has an unexpected field`);
  return value as Record<string, unknown>;
}

function textOrNull(value: unknown, what: string): string | null {
  if (value === null || typeof value === "string") return value;
  throw new BadRequest(`${what} must be a string or null`);
}

function text(value: unknown, what: string): string {
  if (typeof value === "string") return value;
  throw new BadRequest(`${what} must be a string`);
}

function number(value: unknown, what: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new BadRequest(`${what} must be a number`);
}

function array(value: unknown, limit: number, what: string): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new BadRequest(`${what} must be an array of at most ${limit}`);
  return value;
}

async function readRollouts(request: Request): Promise<{ rollouts: ObservedRollout[]; labels: VersionLabel[] }> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new BadRequest("application/json required");
  const body = await readLimitedText(request, MAX_ROLLOUT_BODY_BYTES);
  if (body === null) throw new BadRequest("body too large");
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new BadRequest("body must be valid JSON"); }
  const root = fields(parsed, ["rollouts", "versions"], "body");
  const rollouts = array(root["rollouts"], MAX_ROLLOUTS_PER_BATCH, "rollouts").map(raw => {
    const item = fields(raw, ["id", "atMs", "source", "message", "shares"], "rollout");
    return {
      id: text(item["id"], "rollout id"), atMs: number(item["atMs"], "rollout time"), source: text(item["source"], "rollout source"), message: textOrNull(item["message"], "rollout message"),
      shares: array(item["shares"], 4, "shares").map(rawShare => { const share = fields(rawShare, ["version", "percent"], "share"); return { version: text(share["version"], "share version"), percent: number(share["percent"], "share percent") }; })
    };
  });
  const labels = array(root["versions"], MAX_LABELS, "versions").map(raw => {
    const item = fields(raw, ["version", "label", "message"], "version");
    return { version: text(item["version"], "version"), label: textOrNull(item["label"], "version label"), message: textOrNull(item["message"], "version message") };
  });
  return { rollouts, labels };
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

export async function handleApi(request: Request, path: string, store: ObserveService, service: string, nowMs: number = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (path === "/ingest/observe/v1/batches") {
      if (request.method !== "POST") return failure(405, "invalid_request", "method not allowed");
      params(url, []);
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "application/json required");
      const declared = request.headers.get("content-length");
      if (declared !== null && Number(declared) > MAX_BATCH_BYTES) return failure(413, "too_large", `batch exceeds ${MAX_BATCH_BYTES} bytes`);
      const body = await readLimitedText(request, MAX_BATCH_BYTES);
      if (body === null) return failure(413, "too_large", `batch exceeds ${MAX_BATCH_BYTES} bytes`);
      const decoded = decodeBatch(body, { service, nowMs });
      if (!decoded.ok) return failure(400, decoded.code, decoded.message);
      const result = await store.ingestExternal(service, decoded.batch.events);
      if (!result.ok) return result.code === "rate_limited" ? failure(429, "rate_limited", "too many batches in this minute") : failure(409, "event_conflict", "an event id was already stored with different content");
      return json({ accepted: result.accepted, duplicate: result.duplicate }, result.accepted > 0 ? 202 : 200);
    }
    const artifact = /^\/artifacts\/([^/]+)\/([^/]+)$/u.exec(path);
    if (artifact !== null) {
      if (request.method !== "PUT") return failure(405, "invalid_request", "method not allowed");
      if (!VERSION.test(artifact[1]!) || !ARTIFACT_FILE.test(artifact[2]!)) throw new BadRequest("invalid version or file name");
      params(url, []);
      const map = await readLimitedText(request, MAX_ARTIFACT_BYTES);
      if (map === null) return failure(413, "too_large", `source map exceeds ${MAX_ARTIFACT_BYTES} bytes`);
      const outcome = await store.artifact({ version: artifact[1]!, file: artifact[2]!, map });
      if ("problem" in outcome) throw new BadRequest(outcome.problem);
      if (outcome.result === "conflict") return failure(409, "conflict", "a different map is already registered for this version and file");
      return json({ result: outcome.result }, outcome.result === "accepted" ? 201 : 200);
    }
    if (request.method === "POST" && path === "/rollouts") {
      params(url, []);
      const { rollouts, labels } = await readRollouts(request);
      return json(await store.rollouts(rollouts, labels));
    }
    if (request.method === "POST") {
      const state = /^\/issues\/([0-9a-f]{64})\/state$/u.exec(path);
      if (state === null) return failure(405, "invalid_request", "method not allowed");
      params(url, []);
      return await store.setIssueState(state[1]!, await readState(request)) ? new Response(null, { status: 204 }) : failure(404, "not_found", "issue not found");
    }
    if (request.method !== "GET") return failure(405, "invalid_request", "method not allowed");
    if (path === "/issues") {
      const values = params(url, ["state", "introducedIn", "cursor", "limit"]);
      const state = values.get("state");
      const introducedIn = values.get("introducedIn");
      if (introducedIn !== undefined && !VERSION.test(introducedIn)) throw new BadRequest("invalid version");
      return json(await store.issues({ ...page(values), ...(state === undefined ? {} : { state: issueState(state) }), ...(introducedIn === undefined ? {} : { introducedIn }) }));
    }
    const issue = /^\/issues\/([^/]+)$/u.exec(path);
    if (issue !== null) {
      if (!FINGERPRINT.test(issue[1]!)) throw new BadRequest("invalid issue id");
      params(url, []);
      const value = await store.issue(issue[1]!);
      return value === null ? failure(404, "not_found", "issue not found or expired") : json(value);
    }
    const occurrences = /^\/issues\/([^/]+)\/occurrences$/u.exec(path);
    if (occurrences !== null) {
      if (!FINGERPRINT.test(occurrences[1]!)) throw new BadRequest("invalid issue id");
      return json(await store.occurrences(occurrences[1]!, page(params(url, ["cursor", "limit"]))));
    }
    if (path === "/traces") return json(await store.traces(traceFilter(params(url, ["label", "version", "failed", "from", "to", "minWall", "maxWall", "order", "cursor", "limit"]))));
    if (path === "/explore") return json(await store.explore(exploreFilter(params(url, ["from", "to", "route"]))));
    if (path === "/objects") return json(await store.objects(exploreFilter(params(url, ["from", "to"]))));
    if (path === "/window") return json(await store.window(windowQuery(params(url, ["from", "to", "operation", "class"]))));
    if (path === "/external") {
      const values = params(url, ["from", "to", "limit"]);
      const filter: { -readonly [K in keyof ExternalFilter]: ExternalFilter[K] } = {};
      const fromMs = milliseconds(values, "from");
      const toMs = milliseconds(values, "to");
      if (fromMs !== undefined) filter.fromMs = fromMs;
      if (toMs !== undefined) filter.toMs = toMs;
      const limit = values.get("limit");
      if (limit !== undefined) {
        const value = Number(limit);
        if (!/^\d{1,4}$/u.test(limit) || value < 1 || value > 5000) throw new BadRequest("invalid limit");
        filter.limit = value;
      }
      return json({ events: await store.external(service, filter) });
    }
    const trace = /^\/traces\/([^/]+)$/u.exec(path);
    if (trace !== null) {
      if (!TRACE_ID.test(trace[1]!)) throw new BadRequest("invalid trace id");
      params(url, []);
      const detail = await store.trace(trace[1]!);
      return detail === null ? failure(404, "not_found", "trace not found or expired") : json(detail);
    }
    const impact = /^\/rollouts\/([^/]+)\/impact$/u.exec(path);
    if (impact !== null) {
      if (!VERSION.test(impact[1]!)) throw new BadRequest("invalid rollout id");
      params(url, []);
      const value = await store.impact(impact[1]!);
      return value === null ? failure(404, "not_found", "rollout not recorded") : json(value);
    }
    if (path === "/health") {
      params(url, []);
      return json(await store.health());
    }
    return failure(404, "not_found", "unknown observe route");
  } catch (error) {
    if (error instanceof BadRequest) return failure(400, "invalid_request", error.message);
    if (error instanceof RangeError) return failure(400, "invalid_request", error.message);
    throw error;
  }
}
