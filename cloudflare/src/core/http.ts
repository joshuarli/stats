import type { RuntimeCapabilities } from "./capabilities.ts";
import { bearerToken } from "../auth.ts";
import { HISTORY_CONTENT_TYPE } from "../binary/history.ts";
import { readLimitedText } from "../body.ts";
import { INGEST_PATH, RETIRED_INGEST_PATHS, mediaProblem } from "../ingest/http.ts";
import { MAX_BODY_BYTES } from "../limits.ts";
import { MAX_ARTIFACT_BYTES } from "../observe/core/limits.ts";
import { MAX_BATCH_BYTES } from "../observe/ingest/model.ts";
import { isObservedService, OBSERVED_SERVICES } from "../observe/services.ts";
import { MAX_MARKER_BODY_BYTES } from "./installation/services.ts";

export type AuthDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 503; readonly message: string };

export type ObserveService = (target: string, init?: RequestInit) => Promise<Response>;

export interface StatsTarget {
  readonly capabilities: RuntimeCapabilities;
  readonly authorize: (request: Request) => Promise<AuthDecision>;
  readonly authorizeIngest: (service: string, token: string) => Promise<boolean>;
  readonly serviceExists: (service: string) => Promise<boolean>;
  readonly installation: (request: Request) => Promise<Response>;
  readonly assets: (request: Request) => Promise<Response>;
  readonly observe: ObserveService | null;
}

const SECURITY: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()"
};

const ASSET_CACHE = "private, max-age=31536000, immutable";
const OBSERVE_PREFIX = "/api/observe";
const MAX_OBSERVE_BODY_BYTES = 256;
const SERVICE_MARKER_PATH = /^\/ingest\/services\/[^/]+\/deployments$/u;
const SERVICE_DEPLOYMENTS_SUFFIX = /^\/services\/[^/]+\/deployments$/u;

function secure(response: Response, cacheControl = "no-store"): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY)) headers.set(name, value);
  headers.set("Cache-Control", cacheControl);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function acceptedCoding(header: string | null): "br" | "gzip" | null {
  if (header === null) return null;
  const weights = new Map<string, number>();
  for (const part of header.split(",")) {
    const [coding = "", ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith("q="));
    weights.set(coding.trim(), quality === undefined ? 1 : Number(quality.slice(2)));
  }
  const allows = (coding: string) => (weights.get(coding) ?? weights.get("*") ?? 0) > 0;
  return allows("br") ? "br" : allows("gzip") ? "gzip" : null;
}

function negotiated(request: Request, response: Response): Response {
  if (response.status !== 200 && response.status !== 304) return response;
  const headers = new Headers(response.headers);
  headers.append("Vary", "Accept-Encoding");
  const coding = response.status === 200 && headers.get("Content-Type") === HISTORY_CONTENT_TYPE ? acceptedCoding(request.headers.get("Accept-Encoding")) : null;
  if (coding !== null) headers.set("Content-Encoding", coding);
  return new Response(response.status === 304 ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}

function error(status: number, code: string, message: string): Response {
  return secure(Response.json({ error: { code, message } }, { status }));
}

function denied(decision: Extract<AuthDecision, { ok: false }>): Response {
  return error(decision.status, decision.status === 503 ? "unavailable" : "unauthorized", decision.message);
}

function logIngestRejection(code: string): void {
  console.error(JSON.stringify({ event: "ingest_rejected", code }));
}

function internal(request: Request, path: string): Request {
  const url = new URL(request.url);
  return new Request(`https://installation${path}${url.search}`, request);
}

function crossSiteWrite(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) return true;
  return request.headers.get("Sec-Fetch-Site") === "cross-site";
}

function isJson(request: Request): boolean {
  return (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

function logMarkerRejection(code: string): void {
  console.error(JSON.stringify({ event: "deploy_mark_rejected", code }));
}

async function markDeployment(request: Request, target: StatsTarget, path: string): Promise<Response> {
  if (bearerToken(request.headers.get("authorization")) === null) {
    logMarkerRejection("unauthorized");
    return error(401, "unauthorized", "a service deploy token is required");
  }
  if (crossSiteWrite(request)) {
    logMarkerRejection("forbidden");
    return error(403, "forbidden", "cross-origin request");
  }
  if (!isJson(request)) {
    logMarkerRejection("unsupported_media_type");
    return error(415, "unsupported_media_type", "application/json required");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_MARKER_BODY_BYTES) {
    logMarkerRejection("too_large");
    return error(413, "too_large", "marker exceeds the body cap");
  }
  return secure(await target.installation(internal(request, path.slice("/ingest".length))));
}

async function observe(request: Request, target: StatsTarget, path: string): Promise<Response> {
  const decision = await target.authorize(request);
  if (!decision.ok) return denied(decision);
  const serviceName = /^\/api\/observe\/([a-z][a-z0-9-]{0,31})(?:\/|$)/u.exec(path)?.[1];
  if (serviceName !== undefined && !isObservedService(serviceName) && !await target.serviceExists(serviceName)) return error(404, "not_found", "unknown observed service");
  if (target.observe === null) return error(503, "unavailable", "observability is not available on this target");
  const url = new URL(request.url);
  const service = `https://observe${path.slice(OBSERVE_PREFIX.length)}${url.search}`;
  if (request.method === "GET") return secure(await target.observe(service));
  const write = request.method === "POST" && /^\/api\/observe\/[a-z][a-z0-9-]{0,31}\/issues\/[0-9a-f]{64}\/state$/u.test(path) ? MAX_OBSERVE_BODY_BYTES
    : request.method === "PUT" && /^\/api\/observe\/[a-z][a-z0-9-]{0,31}\/artifacts\/[^/]+\/[^/]+$/u.test(path) ? MAX_ARTIFACT_BYTES
    : null;
  if (write === null) return error(405, "invalid_request", "method not allowed");
  if (request.headers.get("Origin") !== url.origin) return error(403, "forbidden", "cross-origin request");
  const body = await readLimitedText(request, write);
  if (body === null) return error(413, "too_large", "body exceeds the cap");
  return secure(await target.observe(service, { method: request.method, headers: { "Content-Type": request.headers.get("Content-Type") ?? "" }, body }));
}

const OBJECT_ROUTE = /^\/admin\/objects\/(installation|observe:([a-z][a-z0-9-]{0,31}))(\/[a-z/]+)$/u;

async function maintainObject(request: Request, target: StatsTarget, suffix: string): Promise<Response> {
  if (suffix === "/admin/objects") {
    if (request.method !== "GET") return error(405, "invalid_request", "GET required");
    const listed = await target.installation(internal(request, "/services"));
    if (!listed.ok) return error(503, "unavailable", "the service list is unavailable");
    const registered = ((await listed.json()) as { services: readonly { name: string }[] }).services.map(service => service.name);
    const services = [...new Set([...OBSERVED_SERVICES, ...registered])].sort();
    return Response.json({ objects: ["installation", ...(target.observe === null ? [] : services.map(service => `observe:${service}`))] });
  }
  const match = OBJECT_ROUTE.exec(suffix);
  if (match === null) return error(404, "not_found", "unknown object route");
  if (request.method === "POST" && !isJson(request)) return error(415, "unsupported_media_type", "application/json required");
  const rest = match[3]!;
  if (match[2] === undefined) return target.installation(internal(request, `/admin${rest}`));
  if (target.observe === null) return error(503, "unavailable", "observability is not available on this target");
  const search = new URL(request.url).search;
  return target.observe(`https://observe/${match[2]}/admin${rest}${search}`, {
    method: request.method,
    headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
    ...(request.method === "GET" ? {} : { body: request.body, duplex: "half" })
  } as RequestInit);
}

export async function handleStatsRequest(request: Request, target: StatsTarget): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health" && request.method === "GET") return secure(Response.json({ ok: true, service: "stats" }));
  if (path.startsWith(`${OBSERVE_PREFIX}/`)) return observe(request, target, path);
  if (RETIRED_INGEST_PATHS.has(path)) {
    logIngestRejection("gone");
    return error(410, "gone", "this ingest protocol was removed; upgrade the agent to one that posts to /ingest/v2/batches");
  }
  if (path === INGEST_PATH) {
    if (request.method !== "POST") return error(405, "invalid_request", "POST required");
    if (bearerToken(request.headers.get("authorization")) === null) {
      logIngestRejection("unauthorized");
      return error(401, "unauthorized", "a host bearer token is required");
    }
    const media = mediaProblem(request.headers);
    if (media !== null) {
      logIngestRejection("invalid_request");
      return error(415, "invalid_request", media);
    }
    const declared = request.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
      logIngestRejection("too_large");
      return error(413, "too_large", "batch exceeds the body cap");
    }
    return secure(await target.installation(internal(request, "/ingest")));
  }
  if (request.method === "POST" && SERVICE_MARKER_PATH.test(path)) return markDeployment(request, target, path);
  if (path.startsWith("/ingest/observe/")) {
    const match = /^\/ingest\/observe\/v1\/([a-z][a-z0-9-]{0,31})\/batches$/u.exec(path);
    if (match === null) return error(404, "not_found", "unknown ingest route");
    if (request.method !== "POST") return error(405, "invalid_request", "POST required");
    const token = bearerToken(request.headers.get("authorization"));
    if (token === null) return error(401, "unauthorized", "a service ingest token is required");
    if (!await target.authorizeIngest(match[1]!, token)) return error(401, "unauthorized", "ingest credential rejected");
    if (!isJson(request)) return error(415, "unsupported_media_type", "application/json required");
    const declared = request.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_BATCH_BYTES) return error(413, "too_large", "batch exceeds the body cap");
    if (target.observe === null) return error(503, "unavailable", "observability is not available on this target");
    return secure(await target.observe(`https://observe/${match[1]}/ingest/observe/v1/batches`, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
      body: request.body,
      duplex: "half"
    } as RequestInit));
  }
  if (path.startsWith("/api/v1/")) {
    const decision = await target.authorize(request);
    if (!decision.ok) return denied(decision);
    if (crossSiteWrite(request)) return error(403, "forbidden", "cross-origin request");
    const suffix = path.slice("/api/v1".length);
    if (suffix === "/capabilities") return request.method === "GET" ? secure(Response.json(target.capabilities)) : error(405, "invalid_request", "GET required");
    if (suffix === "/admin/objects" || suffix.startsWith("/admin/objects/")) return secure(await maintainObject(request, target, suffix));
    if (!/^\/(hosts|admin\/hosts|projects|services|admin\/services)(\/[A-Za-z0-9:_-]+)*$/u.test(suffix)) return error(404, "not_found", "unknown API route");
    if (request.method === "POST" && SERVICE_DEPLOYMENTS_SUFFIX.test(suffix)) return error(405, "invalid_request", "post deploy markers to /ingest/services/NAME/deployments");
    if (request.method === "POST" && (suffix === "/admin/hosts" || suffix === "/admin/services") && !isJson(request)) return error(415, "unsupported_media_type", "application/json required");
    const response = await target.installation(internal(request, suffix));
    return secure(suffix.endsWith("/history") ? negotiated(request, response) : response);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return error(405, "invalid_request", "method not allowed");
  const decision = await target.authorize(request);
  if (!decision.ok) return denied(decision);
  return secure(await target.assets(request), path.startsWith("/assets/") ? ASSET_CACHE : "no-store");
}
