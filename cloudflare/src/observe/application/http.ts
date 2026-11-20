import { APPLICATION_EVENTS_SERVICE, postApplicationEvent, type ApplicationEventSinkOptions } from "./sink.ts";
import { APPLICATION_SUMMARY_PATH, readTimings } from "./timing.ts";
import { UI_JOURNEY_PATH } from "./journey.ts";

function requestOperation(request: Request): string {
  const path = new URL(request.url).pathname;
  const route = path === "/ingest/v2/batches" ? "host-ingest"
    : /^\/ingest\/services\/[^/]+\/deployments$/u.test(path) ? "deploy-mark"
    : APPLICATION_SUMMARY_PATH.test(path) ? "application-summary"
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
  if (path === "/health" || path === UI_JOURNEY_PATH || (path.startsWith("/ingest/observe/") || path.startsWith("/ingest/metrics/"))) return run();
  const started = options.monotonic();
  const atMs = options.now();
  let status = 500;
  let cancelled = false;
  let work: Record<string, number> = {};
  const parent = /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/u.exec(request.headers.get("traceparent") ?? "");
  const trace = parent !== null && !/^0+$/u.test(parent[1]!) && !/^0+$/u.test(parent[2]!) ? { traceId: parent[1]!, spanId: parent[2]! } : undefined;
  try {
    let response = await run();
    status = response.status;
    if (APPLICATION_SUMMARY_PATH.test(path)) {
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
    postApplicationEvent({ schemaVersion: 1, eventId: crypto.randomUUID(), atMs, operation: requestOperation(request), outcome: cancelled ? "cancelled" : status >= 500 ? "error" : "ok", durationMs, work: cancelled ? {} : { http_status: status, ...work }, release: options.release, service: options.service ?? APPLICATION_EVENTS_SERVICE, ...(trace === undefined ? {} : { trace }) }, options);
  }
}
