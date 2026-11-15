import { APPLICATION_EVENTS_SERVICE, postApplicationEvent, type ApplicationEventSinkOptions } from "./sink.ts";

const SUMMARY_PATH = /^\/api\/observe\/[a-z][a-z0-9-]{0,31}\/external\/telemetry\/summary$/u;
const READ_TIMINGS: Readonly<Record<string, string>> = { "app-store": "store_us", "app-query": "query_us", "app-issues": "issues_us", "app-read": "read_us", "app-encode": "encode_us" };

function readTimings(header: string | null): Record<string, number> {
  const work: Record<string, number> = {};
  if (header === null || header.length > 512) return work;
  for (const entry of header.split(",")) {
    const match = /^(app-[a-z]+);dur=(\d+(?:\.\d{1,3})?)$/u.exec(entry.trim());
    if (match === null || READ_TIMINGS[match[1]!] === undefined) continue;
    const us = Math.round(Number(match[2]) * 1000);
    if (Number.isSafeInteger(us) && us >= 0 && us <= 86_400_000_000) work[READ_TIMINGS[match[1]!]!] = us;
  }
  return work;
}

function requestOperation(request: Request): string {
  const path = new URL(request.url).pathname;
  const route = path === "/ingest/v2/batches" ? "host-ingest"
    : /^\/ingest\/services\/[^/]+\/deployments$/u.test(path) ? "deploy-mark"
    : SUMMARY_PATH.test(path) ? "application-summary"
    : /^\/api\/observe\/[a-z][a-z0-9-]{0,31}\/external(?:\/telemetry|\/operations)?$/u.test(path) ? "application-events"
    : path.startsWith("/api/observe/") ? "observe"
    : /^\/api\/v1\/admin(?:\/|$)/u.test(path) ? "admin"
    : /^\/api\/v1\/hosts(?:\/|$)/u.test(path) ? "hosts"
    : /^\/api\/v1\/services\/[^/]+\/deployments\/[^/]+\/comparison$/u.test(path) ? "service-comparison"
    : /^\/api\/v1\/services\/[^/]+\/deployments$/u.test(path) ? "service-deployments"
    : /^\/api\/v1\/services(?:\/|$)/u.test(path) ? "services"
    : /^\/api\/v1\/projects(?:\/|$)/u.test(path) ? "projects"
    : path === "/api/v1/capabilities" ? "capabilities"
    : path.startsWith("/api/") ? "api-other"
    : path === "/" || path === "/index.html" ? "dashboard"
    : path.startsWith("/assets/") ? "asset" : "other";
  const method = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method) ? request.method.toLowerCase() : "other";
  return `http.${method}.${route}`;
}

/** Records response-header wall time using bounded route labels, without URLs, bodies or credentials. */
export async function captureApplicationRequest(request: Request, run: () => Promise<Response>, options: ApplicationEventSinkOptions & { readonly monotonic: () => number }): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health" || path.startsWith("/ingest/observe/")) return run();
  const started = options.monotonic();
  const atMs = options.now();
  let status = 500;
  let cancelled = false;
  let work: Record<string, number> = {};
  try {
    let response = await run();
    status = response.status;
    if (SUMMARY_PATH.test(path)) {
      work = readTimings(response.headers.get("Server-Timing"));
      const url = new URL(request.url);
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      const windowMs = Number(to) - Number(from);
      if (from !== null && to !== null && Number.isSafeInteger(windowMs) && windowMs > 0 && windowMs <= 1e12) work["requested_window_ms"] = windowMs;
      const headers = new Headers(response.headers);
      headers.append("Server-Timing", `app-total;dur=${Math.max(0, options.monotonic() - started).toFixed(3)}`);
      response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  } catch (error) {
    cancelled = request.signal.aborted;
    throw error;
  } finally {
    const durationMs = Math.min(86_400_000, Math.max(0, Math.round(options.monotonic() - started)));
    postApplicationEvent({ schemaVersion: 1, eventId: crypto.randomUUID(), atMs, operation: requestOperation(request), outcome: cancelled ? "cancelled" : status >= 500 ? "error" : "ok", durationMs, work: cancelled ? {} : { http_status: status, ...work }, release: options.release, service: options.service ?? APPLICATION_EVENTS_SERVICE }, options);
  }
}
